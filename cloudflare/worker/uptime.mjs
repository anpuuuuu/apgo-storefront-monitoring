import { HEARTBEAT_LIMITS, LIMITS, UPTIME_TARGETS } from './config.mjs';
import { getState, listHeartbeats, logAlert, setState, writeHeartbeat } from './db.mjs';
import { sendTelegram } from './telegram.mjs';

async function probe(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), LIMITS.requestTimeoutMs);
  try {
    const response = await fetch(target.url, {
      headers: {
        accept: target.id === 'cart-api' ? 'application/json' : 'text/html',
        'user-agent': 'APGO-HealthCheck/2.0 Cloudflare-Cron',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    await target.validate(response);
    return { id: target.id, url: target.url, ok: true, status: response.status, latencyMs, error: '' };
  } catch (error) {
    return {
      id: target.id,
      url: target.url,
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout after 10s' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function updateTargetState(env, sample) {
  const key = `uptime:${sample.id}`;
  const state = (await getState(env.DB, key)) || {
    failures: 0,
    slowSamples: 0,
    incidentOpen: false,
    slowIncidentOpen: false,
    lastAlertMs: 0,
    lastSlowAlertMs: 0,
  };
  const now = Date.now();

  if (sample.ok) {
    if (state.incidentOpen) {
      await sendTelegram(env, `🟢 [Layer 1 Recovery] ${sample.id} has recovered\nHTTP ${sample.status} · ${sample.latencyMs} ms\n${sample.url}`);
      await logAlert(env.DB, 'layer1', 'recovery', sample);
    }
    state.failures = 0;
    state.incidentOpen = false;
  } else {
    state.failures += 1;
    const shouldAlert = state.failures >= LIMITS.failureThreshold && (
      !state.incidentOpen || now - state.lastAlertMs >= LIMITS.uptimeRealertMs
    );
    if (shouldAlert) {
      await sendTelegram(env, `🔴 [Layer 1] ${sample.id} failed ${state.failures} consecutive probes\n${sample.error}\n${sample.url}`);
      await logAlert(env.DB, 'layer1', 'down', { ...sample, failures: state.failures });
      state.incidentOpen = true;
      state.lastAlertMs = now;
    }
  }

  if (sample.ok && sample.latencyMs > LIMITS.slowMs) state.slowSamples += 1;
  else state.slowSamples = 0;

  if (state.slowSamples >= LIMITS.slowThreshold && (
    !state.slowIncidentOpen || now - state.lastSlowAlertMs >= LIMITS.uptimeRealertMs
  )) {
    await sendTelegram(env, `🟠 [Layer 1 Slow] ${sample.id} exceeded 5 seconds for ${state.slowSamples} probes\nLatest: ${sample.latencyMs} ms\n${sample.url}`);
    await logAlert(env.DB, 'layer1', 'slow', { ...sample, slowSamples: state.slowSamples });
    state.slowIncidentOpen = true;
    state.lastSlowAlertMs = now;
  } else if (sample.latencyMs <= LIMITS.slowMs) {
    state.slowIncidentOpen = false;
  }

  state.lastSample = sample;
  await setState(env.DB, key, state);
}

export function heartbeatSeverity(age, maxAge) {
  if (!(age > maxAge)) return null;
  return age > maxAge * 2 ? 'critical' : 'warning';
}

async function checkStaleHeartbeats(env) {
  const rows = await listHeartbeats(env.DB);
  const byLayer = new Map(rows.map((row) => [row.layer, row]));
  const now = Date.now();
  for (const [layer, maxAge] of Object.entries(HEARTBEAT_LIMITS)) {
    if (layer === 'layer1') continue;
    const row = byLayer.get(layer);
    const age = row ? now - Date.parse(row.observed_at) : Number.POSITIVE_INFINITY;
    const stateKey = `heartbeat-alert:${layer}`;
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
    const severity = heartbeatSeverity(effectiveAge, maxAge);
    const shouldAlert = severity && (
      !state.open
      || state.severity !== severity
      || now - state.lastAlertMs >= LIMITS.uptimeRealertMs
    );
    if (shouldAlert) {
      const critical = severity === 'critical';
      await sendTelegram(env, `${critical ? '🔴 [Monitoring Health]' : '🟠 [Monitoring Delayed]'} ${layer} heartbeat is ${critical ? 'stale' : 'delayed'}\nLast: ${row?.observed_at || 'never'}\nLimit: ${Math.round(maxAge / 60_000)} minutes`);
      await logAlert(env.DB, 'self-health', critical ? 'stale' : 'delayed', {
        layer,
        severity,
        last: row?.observed_at || null,
        maxAge,
        age: effectiveAge,
      });
      await setState(env.DB, stateKey, { ...state, open: true, severity, lastAlertMs: now });
    } else if (!severity && state.open) {
      await sendTelegram(env, `🟢 [Monitoring Recovery] ${layer} heartbeat resumed\n${row.observed_at}`);
      await logAlert(env.DB, 'self-health', 'recovery', { layer, observedAt: row.observed_at });
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

  const samples = await Promise.all(UPTIME_TARGETS.map(probe));
  for (const sample of samples) {
    await env.DB.prepare(
      `INSERT INTO uptime_samples
       (scheduled_time, target, ok, http_status, latency_ms, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(scheduledTime, sample.id, sample.ok ? 1 : 0, sample.status, sample.latencyMs, sample.error).run();
    await updateTargetState(env, sample);
  }

  await writeHeartbeat(env.DB, 'layer1', 'cloudflare-cron', 'ok', { scheduledTime, samples });
  await checkStaleHeartbeats(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM uptime_samples WHERE created_at < datetime('now', '-30 days')"),
    env.DB.prepare("DELETE FROM cron_executions WHERE created_at < datetime('now', '-7 days')"),
    env.DB.prepare("DELETE FROM js_errors WHERE created_at < datetime('now', '-30 days')"),
    env.DB.prepare("DELETE FROM alert_log WHERE created_at < datetime('now', '-90 days')"),
  ]);
  return { duplicate: false, samples };
}
