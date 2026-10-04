import { HEARTBEAT_CRITICAL_LIMITS, HEARTBEAT_LIMITS, LIMITS, SITES, UPTIME_TARGETS, siteKey } from './config.mjs';
import { getState, listHeartbeats, logAlert, setState, writeHeartbeat } from './db.mjs';
import { sendTelegram } from './telegram.mjs';

async function probe(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), LIMITS.requestTimeoutMs);
  let response = null;
  try {
    response = await fetch(target.url, {
      headers: {
        accept: target.id.endsWith(':cart-api') ? 'application/json' : 'text/html',
        'user-agent': 'APGO-HealthCheck/2.0 Cloudflare-Cron',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    await target.validate(response);
    return { id: target.id, url: target.url, ok: true, status: response.status, latencyMs, error: '' };
  } catch (error) {
    const baseError = error?.name === 'AbortError' ? 'timeout after 10s' : String(error?.message || error);
    return {
      id: target.id,
      url: target.url,
      ok: false,
      // Keep the real status so a 429 can be told apart from a timeout or 5xx.
      status: response?.status || 0,
      latencyMs: Date.now() - started,
      error: response?.status === 429 ? `${baseError}${formatThrottleEvidence(response.headers)}` : baseError,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatThrottleEvidence(headers) {
  if (!headers || typeof headers.get !== 'function') return '';
  const evidence = [
    ['server', headers.get('server')],
    ['retry-after', headers.get('retry-after')],
    ['cf-ray', headers.get('cf-ray')],
    ['shopify-stage', headers.get('x-shopify-stage')],
  ].filter(([, value]) => value).map(([name, value]) => `${name}=${String(value).slice(0, 100)}`);
  return evidence.length ? ` · ${evidence.join(' · ')}` : '';
}

export function isThrottledSample(sample) {
  return !sample.ok && Number(sample.status) === 429;
}

export function shouldSkipUptimeProbe(state, now = Date.now()) {
  return Number(state?.nextProbeAtMs || 0) > now;
}

function throttleBackoffMs(consecutive, limits) {
  const base = Number(limits.throttleBackoffBaseMs || 15 * 60_000);
  const cap = Number(limits.throttleBackoffMaxMs || 60 * 60_000);
  return Math.min(cap, base * (2 ** Math.max(0, Number(consecutive || 1) - 1)));
}

/* Pure state machine for one probe result. Returns the next state and the
   events the caller should announce ('recovery', 'down', 'throttled',
   'slow'). A 429 is Shopify rate-limiting the probe, not the storefront
   failing: it never adds to `failures`. Each 429 backs the target off for
   15/30/60 minutes, and only a run of throttleThreshold observed 429s enters
   the six-hour digest. Observed 2026-09-09: 429 for exactly two probes
   every 20 minutes for three hours while /cart.js stayed 200 and recovery
   latency was ~130 ms — 18 Telegram messages for a limiter cycle. */
export function evaluateUptimeSample(previous, sample, now, limits = LIMITS) {
  const state = {
    failures: 0,
    throttled: 0,
    slowSamples: 0,
    incidentOpen: false,
    slowIncidentOpen: false,
    lastAlertMs: 0,
    lastSlowAlertMs: 0,
    throttleEpisodeOpen: false,
    throttleSamplesSinceDigest: 0,
    throttleEpisodesSinceDigest: 0,
    lastThrottleDigestMs: 0,
    nextProbeAtMs: 0,
    ...(previous || {}),
  };
  const events = [];
  const canAlert = !state.incidentOpen || now - Number(state.lastAlertMs || 0) >= limits.uptimeRealertMs;

  if (sample.ok) {
    // Before throttle backoff existed, a 429 could open a storefront incident.
    // Close that legacy state silently so the first successful probe after
    // deployment does not announce a misleading storefront recovery.
    const legacyThrottleIncident = state.incidentOpen && isThrottledSample(state.lastSample || {});
    if (state.incidentOpen && !legacyThrottleIncident) events.push('recovery');
    state.failures = 0;
    state.throttled = 0;
    state.throttleEpisodeOpen = false;
    state.nextProbeAtMs = 0;
    state.incidentOpen = false;
  } else if (isThrottledSample(sample)) {
    if (!state.throttleEpisodeOpen) state.throttleEpisodesSinceDigest += 1;
    state.throttleEpisodeOpen = true;
    state.throttleSamplesSinceDigest += 1;
    state.throttled += 1;
    state.failures = 0;
    state.nextProbeAtMs = now + throttleBackoffMs(state.throttled, limits);
    const digestDue = !state.lastThrottleDigestMs
      || now - Number(state.lastThrottleDigestMs) >= Number(limits.throttleDigestMs || 6 * 60 * 60_000);
    if (state.throttled >= limits.throttleThreshold && digestDue) {
      events.push('throttled');
      state.lastThrottleDigestMs = now;
    }
  } else {
    state.failures += 1;
    state.throttled = 0;
    state.throttleEpisodeOpen = false;
    state.nextProbeAtMs = 0;
    if (state.failures >= limits.failureThreshold && canAlert) {
      events.push('down');
      state.incidentOpen = true;
      state.lastAlertMs = now;
    }
  }

  if (sample.ok && sample.latencyMs > limits.slowMs) state.slowSamples += 1;
  else state.slowSamples = 0;

  if (state.slowSamples >= limits.slowThreshold && (
    !state.slowIncidentOpen || now - Number(state.lastSlowAlertMs || 0) >= limits.uptimeRealertMs
  )) {
    events.push('slow');
    state.slowIncidentOpen = true;
    state.lastSlowAlertMs = now;
  } else if (sample.latencyMs <= limits.slowMs) {
    state.slowIncidentOpen = false;
  }

  return { state, events };
}

async function updateTargetState(env, sample, siteSamples = []) {
  const key = `uptime:${sample.id}`;
  const site = SITES.find((entry) => sample.id.startsWith(`${entry.id}:`));
  const label = site?.label || sample.id.split(':')[0];
  const layer = siteKey(site?.id || 'unknown', 'layer1');
  const now = Date.now();
  const { state, events } = evaluateUptimeSample(await getState(env.DB, key), sample, now);

  for (const event of events) {
    if (event === 'recovery') {
      await sendTelegram(env, `🟢 [${label}][Layer 1 Recovery] ${sample.id} has recovered\nHTTP ${sample.status} · ${sample.latencyMs} ms\n${sample.url}`, { silent: true });
      await logAlert(env.DB, layer, 'recovery', sample);
    } else if (event === 'down') {
      await sendTelegram(env, `🔴 [${label}][Layer 1] ${sample.id} failed ${state.failures} consecutive probes\n${sample.error}\n${sample.url}`);
      await logAlert(env.DB, layer, 'down', { ...sample, failures: state.failures });
    } else if (event === 'throttled') {
      const cart = siteSamples.find((entry) => entry.id === `${site.id}:cart-api`);
      // A probe-only 429 is operational context, not a customer incident.
      // Keep the evidence in D1 for the 22:00 report instead of sending a
      // standalone Telegram message every six hours.
      await logAlert(env.DB, layer, 'throttled', {
        ...sample,
        throttled: state.throttled,
        samples: state.throttleSamplesSinceDigest,
        episodes: state.throttleEpisodesSinceDigest,
        nextProbeAt: new Date(state.nextProbeAtMs).toISOString(),
        cart: cart || null,
      });
      state.throttleSamplesSinceDigest = 0;
      state.throttleEpisodesSinceDigest = 0;
      // The next observed 429 starts the next digest's episode count even if
      // Shopify never returned a successful sample between the two digests.
      state.throttleEpisodeOpen = false;
    } else if (event === 'slow') {
      await sendTelegram(env, `🟠 [${label}][Layer 1 Slow] ${sample.id} exceeded 5 seconds for ${state.slowSamples} probes\nLatest: ${sample.latencyMs} ms\n${sample.url}`, { silent: true });
      await logAlert(env.DB, layer, 'slow', { ...sample, slowSamples: state.slowSamples });
    }
  }

  state.lastSample = sample;
  await setState(env.DB, key, state);
}

export function heartbeatSeverity(age, maxAge, criticalAge = maxAge * 2) {
  if (!(age > maxAge)) return null;
  return age > criticalAge ? 'critical' : 'warning';
}

export function shouldAlertHeartbeat(severity, state, now, realertMs) {
  return Boolean(severity) && (
    !state.open
    || state.severity !== severity
    || now - Number(state.lastAlertMs || 0) >= realertMs
  );
}

async function checkStaleHeartbeats(env) {
  const rows = await listHeartbeats(env.DB);
  const byLayer = new Map(rows.map((row) => [row.layer, row]));
  const now = Date.now();
  for (const site of SITES) for (const [layer, maxAge] of Object.entries(HEARTBEAT_LIMITS)) {
    if (layer === 'layer1' || !site.enabledLayers.includes(layer)) continue;
    const row = byLayer.get(siteKey(site.id, layer)) || byLayer.get(layer);
    const age = row ? now - Date.parse(row.observed_at) : Number.POSITIVE_INFINITY;
    const stateKey = siteKey(site.id, `heartbeat-alert:${layer}`);
    const state = (await getState(env.DB, stateKey)) || {
      open: false,
      severity: null,
      lastAlertMs: 0,
      missingSinceMs: null,
    };

    // A newly deployed monitor must first be given one complete heartbeat
    // window to report in. Otherwise the first Layer 1 cron run would alert
    // that Layers 2-4 are stale before their first scheduled execution.
    if (!row) {
      if (!state.missingSinceMs) {
        state.missingSinceMs = now;
        await setState(env.DB, stateKey, state);
        continue;
      }
    } else {
      state.missingSinceMs = null;
    }

    const effectiveAge = row ? age : now - state.missingSinceMs;
    const criticalAge = HEARTBEAT_CRITICAL_LIMITS[layer] || maxAge * 2;
    const severity = heartbeatSeverity(effectiveAge, maxAge, criticalAge);
    const shouldAlert = shouldAlertHeartbeat(severity, state, now, LIMITS.heartbeatRealertMs);
    if (shouldAlert) {
      const critical = severity === 'critical';
      await sendTelegram(env, `${critical ? `🔴 [${site.label}][Monitoring Health]` : `🟠 [${site.label}][Monitoring Delayed]`} ${layer} heartbeat is ${critical ? 'stale' : 'delayed'}\nLast: ${row?.observed_at || 'never'}\n${critical ? 'Critical' : 'Warning'} limit: ${Math.round((critical ? criticalAge : maxAge) / 60_000)} minutes`, { silent: !critical });
      await logAlert(env.DB, siteKey(site.id, 'self-health'), critical ? 'stale' : 'delayed', {
        siteId: site.id,
        layer,
        severity,
        last: row?.observed_at || null,
        maxAge,
        criticalAge,
        age: effectiveAge,
      });
      await setState(env.DB, stateKey, { ...state, open: true, severity, lastAlertMs: now });
    } else if (!severity && state.open) {
      await sendTelegram(env, `🟢 [${site.label}][Monitoring Recovery] ${layer} heartbeat resumed\n${row.observed_at}`, { silent: true });
      await logAlert(env.DB, siteKey(site.id, 'self-health'), 'recovery', { siteId: site.id, layer, observedAt: row.observed_at });
      await setState(env.DB, stateKey, { ...state, open: false, severity: null, lastAlertMs: state.lastAlertMs });
    } else {
      await setState(env.DB, stateKey, state);
    }
  }
}

export async function runScheduledUptime(env, scheduledTime) {
  const dedupe = await env.DB.prepare(
    'INSERT OR IGNORE INTO cron_executions (scheduled_time) VALUES (?1)'
  ).bind(scheduledTime).run();
  if (!dedupe.meta?.changes) return { duplicate: true, samples: [] };

  const now = Date.now();
  const samples = await Promise.all(UPTIME_TARGETS.map(async (target) => {
    const state = await getState(env.DB, `uptime:${target.id}`);
    if (shouldSkipUptimeProbe(state, now)) {
      return {
        id: target.id,
        url: target.url,
        ok: null,
        status: 0,
        latencyMs: 0,
        error: 'throttle backoff',
        skipped: true,
        nextProbeAt: new Date(Number(state.nextProbeAtMs)).toISOString(),
      };
    }
    return probe(target);
  }));
  for (const sample of samples) {
    if (sample.skipped) continue;
    await env.DB.prepare(
      `INSERT INTO uptime_samples
       (scheduled_time, target, ok, http_status, latency_ms, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(scheduledTime, sample.id, sample.ok ? 1 : 0, sample.status, sample.latencyMs, sample.error).run();
    const siteSamples = samples.filter((entry) => entry.id.startsWith(`${sample.id.split(':')[0]}:`));
    await updateTargetState(env, sample, siteSamples);
  }

  for (const site of SITES) {
    const siteSamples = samples.filter((sample) => sample.id.startsWith(`${site.id}:`));
    if (siteSamples.length) await writeHeartbeat(env.DB, site.id, 'layer1', 'cloudflare-cron', 'ok', { scheduledTime, samples: siteSamples });
  }
  await checkStaleHeartbeats(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM uptime_samples WHERE created_at < datetime('now', '-30 days')"),
    env.DB.prepare("DELETE FROM cron_executions WHERE created_at < datetime('now', '-7 days')"),
    env.DB.prepare("DELETE FROM js_errors WHERE created_at < datetime('now', '-30 days')"),
    env.DB.prepare("DELETE FROM alert_log WHERE created_at < datetime('now', '-90 days')"),
  ]);
  return { duplicate: false, samples };
}
