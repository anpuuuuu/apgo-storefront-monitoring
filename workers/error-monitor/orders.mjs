/* First-party order heartbeat, push based. GA4 tells us whether tracking
   works; the order stream tells us whether commerce works, independent of
   consent banners, ad blockers or a broken pixel.

   Any platform that can send an HTTP request when an order is created feeds
   the same endpoint (Shopify Flow "Send HTTP request", a WooCommerce
   webhook, a custom backend, Make):

     POST /orders/event
     Authorization: Bearer <that site's ORDER_EVENT_TOKEN>
     { "siteId": "apgo-my", "orderId": "…", "createdAt": "<ISO 8601>", "test": false }

   Purchases are sparse (about one per 30 minutes at the afternoon peak, one
   per several hours at night), so a fixed-window count would swing between
   0 and 100%. Instead we measure "minutes since the last order" and compare
   it with what that hour of the week normally tolerates: the 90th percentile
   of the same measurement taken every 30 minutes over the last 28 days,
   times 1.5, clamped to [floor, cap]. Buckets with too little history fall
   back to a conservative bootstrap threshold, so the first weeks after a
   site starts pushing cannot page on a normal quiet night. */
import { ORDER_LIMITS, siteById, siteKey } from './config.mjs';
import { getState, logAlert, setState } from './db.mjs';
import { readLimitedText } from './errors.mjs';
import { bearerToken, secretMatches } from './security.mjs';
import { sendTelegram } from './telegram.mjs';
import { shouldAlertHeartbeat } from './uptime.mjs';

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/* Hour-of-day buckets split weekday/weekend in the store's timezone:
   'wd:14' is 14:00-14:59 Monday-Friday, 'we:14' Saturday/Sunday. */
export function bucketFor(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms));
  const weekday = parts.find((part) => part.type === 'weekday')?.value || 'Mon';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  return { key: `${weekend ? 'we' : 'wd'}:${String(hour).padStart(2, '0')}`, hour, weekend };
}

export function percentile(values, fraction) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

export function computeOrderBaseline(orderTimesMs, options) {
  const {
    nowMs, baselineDays, sampleMinutes, percentile: fraction, multiplier, floorMinutes, capMinutes, timeZone, minSamples, bootstrapMinutes,
  } = { ...ORDER_LIMITS, ...options };
  const orders = [...orderTimesMs].filter(Number.isFinite).sort((a, b) => a - b);
  const samples = new Map();
  let index = 0;
  for (let t = nowMs - baselineDays * 86_400_000; t <= nowMs; t += sampleMinutes * 60_000) {
    while (index < orders.length && orders[index] <= t) index += 1;
    if (index === 0) continue; // no order on record before this sample
    const ageMinutes = (t - orders[index - 1]) / 60_000;
    const { key } = bucketFor(t, timeZone);
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push(ageMinutes);
  }
  const buckets = {};
  for (const [key, ages] of samples) {
    const p = percentile(ages, fraction);
    const computed = Math.min(capMinutes, Math.max(floorMinutes, multiplier * p));
    const immature = ages.length < minSamples;
    buckets[key] = {
      n: ages.length,
      p90Minutes: round(p),
      immature,
      thresholdMinutes: round(immature ? Math.max(bootstrapMinutes, computed) : computed),
    };
  }
  const firstOrderAt = orders.length ? new Date(orders[0]).toISOString() : null;
  return { computedAt: new Date(nowMs).toISOString(), baselineDays, orderCount: orders.length, firstOrderAt, buckets };
}

export function evaluateOrderGap({ baseline, lastOrderAtMs, nowMs, timeZone, criticalMultiplier = ORDER_LIMITS.criticalMultiplier, bootstrapMinutes = ORDER_LIMITS.bootstrapMinutes }) {
  const { key } = bucketFor(nowMs, timeZone);
  const ageMinutes = Number.isFinite(lastOrderAtMs) ? (nowMs - lastOrderAtMs) / 60_000 : Number.POSITIVE_INFINITY;
  const bucket = baseline?.buckets?.[key];
  const thresholdMinutes = bucket ? bucket.thresholdMinutes : bootstrapMinutes;
  let severity = null;
  if (ageMinutes > thresholdMinutes * criticalMultiplier) severity = 'critical';
  else if (ageMinutes > thresholdMinutes) severity = 'warning';
  return {
    severity,
    ageMinutes: round(ageMinutes),
    thresholdMinutes,
    bucket: key,
    immature: !bucket || Boolean(bucket.immature),
  };
}

export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 'ever';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours ? `${hours}h${String(rest).padStart(2, '0')}m` : `${rest}m`;
}

function localClock(ms, timeZone) {
  if (!Number.isFinite(ms)) return 'none on record';
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export function orderAlertText(site, evaluation, lastOrderAtMs, timeZone) {
  const icon = evaluation.severity === 'critical' ? '🔴' : '🟡';
  const bucketLabel = `${evaluation.bucket.startsWith('we') ? 'weekend' : 'weekday'} ${evaluation.bucket.slice(3)}:00`;
  const basis = evaluation.immature ? 'bootstrap threshold, baseline still maturing' : `${bucketLabel} ${timeZone}`;
  return `${icon} [${site.label}][Layer 4 · Orders] No orders for ${formatMinutes(evaluation.ageMinutes)} (expected ≤ ${formatMinutes(evaluation.thresholdMinutes)}; ${basis})\nLast order: ${localClock(lastOrderAtMs, timeZone)} ${timeZone}`;
}

/* ---- push endpoint --------------------------------------------------- */

export function parseOrderEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid JSON body' };
  const siteId = String(body.siteId || '').trim();
  const orderId = String(body.orderId ?? '').trim().slice(0, 120);
  const createdAtMs = Date.parse(String(body.createdAt || ''));
  if (!siteId) return { ok: false, error: 'siteId is required' };
  if (!orderId) return { ok: false, error: 'orderId is required' };
  if (!Number.isFinite(createdAtMs)) return { ok: false, error: 'createdAt must be ISO 8601' };
  const test = body.test === true || String(body.test).toLowerCase() === 'true';
  return { ok: true, event: { siteId, orderId, createdAtMs, test } };
}

/* Rolling list of {id, at} kept for retentionDays. Idempotent on orderId so
   a platform retry never counts twice. */
export function appendOrderLog(log, event, nowMs, { retentionDays = ORDER_LIMITS.retentionDays, cap = ORDER_LIMITS.logCap } = {}) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  if (entries.some((entry) => entry.id === event.orderId)) return { log: { entries, updatedAt: log?.updatedAt || null }, duplicate: true };
  const cutoff = nowMs - retentionDays * 86_400_000;
  const kept = entries.filter((entry) => Number(entry.at) >= cutoff);
  kept.push({ id: event.orderId, at: event.createdAtMs });
  kept.sort((a, b) => a.at - b.at);
  const trimmed = kept.length > cap ? kept.slice(kept.length - cap) : kept;
  return { log: { entries: trimmed, updatedAt: new Date(nowMs).toISOString() }, duplicate: false };
}

export async function receiveOrderEvent(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  let raw;
  try { raw = await readLimitedText(request, ORDER_LIMITS.bodyBytes); }
  catch (error) { return json({ ok: false, error: 'payload too large' }, error?.status === 413 ? 413 : 400); }
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const parsed = parseOrderEvent(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const { event } = parsed;

  const site = siteById(event.siteId);
  if (!site?.orders?.tokenEnv) return json({ ok: false, error: 'unknown site or order events not enabled' }, 404);
  const expected = env[site.orders.tokenEnv];
  if (!expected) return json({ ok: false, error: 'order events not configured on the Worker' }, 503);
  if (!(await secretMatches(bearerToken(request), expected))) return json({ ok: false, error: 'unauthorized' }, 401);
  if (event.test) return new Response(null, { status: 204 });

  const nowMs = Date.now();
  const logKey = siteKey(site.id, 'orders:log');
  const { log, duplicate } = appendOrderLog(await getState(env.DB, logKey), event, nowMs);
  if (!duplicate) {
    await setState(env.DB, logKey, log);
    const lastKey = siteKey(site.id, 'orders:last');
    const last = (await getState(env.DB, lastKey)) || {};
    const lastMs = Date.parse(last.createdAt || '');
    if (!Number.isFinite(lastMs) || event.createdAtMs > lastMs) {
      await setState(env.DB, lastKey, { ...last, createdAt: new Date(event.createdAtMs).toISOString(), receivedAt: new Date(nowMs).toISOString(), checkedAt: last.checkedAt || new Date(nowMs).toISOString() });
    }
  }
  const pushKey = siteKey(site.id, 'orders:push');
  const push = (await getState(env.DB, pushKey)) || { count: 0 };
  await setState(env.DB, pushKey, { lastReceivedAt: new Date(nowMs).toISOString(), count: Number(push.count || 0) + 1 });
  return json({ ok: true, siteId: site.id, duplicate, orders: log.entries.length }, 202);
}

/* ---- scheduled evaluation -------------------------------------------- */

async function notifyThrottled(env, site, key, text, nowMs, mode) {
  const stateKey = siteKey(site.id, `orders:throttle:${key}`);
  const state = (await getState(env.DB, stateKey)) || {};
  if (nowMs < Number(state.untilMs || 0)) return false;
  await setState(env.DB, stateKey, { untilMs: nowMs + ORDER_LIMITS.failureNotifyMs, text: String(text).slice(0, 200) });
  if (mode === 'armed') await sendTelegram(env, text);
  return true;
}

export async function runOrderHeartbeat(env, site, nowMs = Date.now()) {
  const timeZone = site.orders?.timeZone || ORDER_LIMITS.timeZone;
  const mode = env.ORDERS_MODE === 'armed' ? 'armed' : 'observe';
  const logKey = siteKey(site.id, 'orders:log');
  const lastKey = siteKey(site.id, 'orders:last');
  const alertKey = siteKey(site.id, 'orders:alert');
  const pushKey = siteKey(site.id, 'orders:push');

  const log = await getState(env.DB, logKey);
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const push = (await getState(env.DB, pushKey)) || {};
  if (!entries.length) {
    // Nothing pushed yet: the site is catalogued but the platform side is not
    // wired. Record it (throttled), do not claim "no orders".
    if (await notifyThrottled(env, site, 'push-missing', `🟠 [${site.label}][Layer 4 · Orders] No order events have ever been received — the platform push (Shopify Flow) is not wired yet`, nowMs, mode)) {
      await logAlert(env.DB, siteKey(site.id, 'self-health'), 'orders_push_missing', { siteId: site.id, mode });
    }
    return { ok: true, mode, status: 'awaiting_first_push' };
  }

  const times = entries.map((entry) => Number(entry.at));
  const baseline = computeOrderBaseline(times, { nowMs, timeZone });
  const lastOrderAtMs = Math.max(...times);
  await setState(env.DB, lastKey, { createdAt: new Date(lastOrderAtMs).toISOString(), receivedAt: push.lastReceivedAt || null, checkedAt: new Date(nowMs).toISOString() });

  const evaluation = evaluateOrderGap({ baseline, lastOrderAtMs, nowMs, timeZone });
  const state = (await getState(env.DB, alertKey)) || { open: false, severity: null, lastAlertMs: 0 };
  const detail = { siteId: site.id, mode, ...evaluation, lastOrderAt: new Date(lastOrderAtMs).toISOString(), orderCount: baseline.orderCount, firstOrderAt: baseline.firstOrderAt };
  if (shouldAlertHeartbeat(evaluation.severity, state, nowMs, ORDER_LIMITS.realertMs)) {
    await logAlert(env.DB, siteKey(site.id, 'layer4'), mode === 'armed' ? 'orders_gap' : 'would_alert', { rule: 'orders_gap', ...detail });
    if (mode === 'armed') await sendTelegram(env, orderAlertText(site, evaluation, lastOrderAtMs, timeZone));
    await setState(env.DB, alertKey, { open: true, severity: evaluation.severity, lastAlertMs: nowMs });
  } else if (!evaluation.severity && state.open) {
    await logAlert(env.DB, siteKey(site.id, 'layer4'), mode === 'armed' ? 'orders_recovery' : 'would_recover', { rule: 'orders_gap', ...detail });
    if (mode === 'armed') await sendTelegram(env, `🟢 [${site.label}][Layer 4 · Orders] Orders resumed\nLast order: ${localClock(lastOrderAtMs, timeZone)} ${timeZone}`);
    await setState(env.DB, alertKey, { open: false, severity: null, lastAlertMs: state.lastAlertMs });
  }

  // A long silence from the push source is ambiguous: no orders, or a broken
  // Flow. Say so separately instead of letting it masquerade as either.
  const receivedMs = Date.parse(push.lastReceivedAt || '');
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > ORDER_LIMITS.pushStaleMs) {
    await logAlert(env.DB, siteKey(site.id, 'self-health'), 'orders_push_stale', { siteId: site.id, lastReceivedAt: push.lastReceivedAt, ageMinutes: round((nowMs - receivedMs) / 60_000) });
    await notifyThrottled(env, site, 'push-stale', `🟠 [${site.label}][Layer 4 · Orders] No order events received for ${formatMinutes((nowMs - receivedMs) / 60_000)} — check the platform push (Shopify Flow) before reading this as zero sales`, nowMs, mode);
  }
  return { ok: true, mode, ...evaluation, orderCount: baseline.orderCount };
}
