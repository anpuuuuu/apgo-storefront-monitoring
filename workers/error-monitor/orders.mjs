/* First-party order heartbeat, push based. GA4 tells us whether tracking
   works; the order stream tells us whether commerce works, independent of
   consent banners, ad blockers or a broken pixel.

   Any platform that can send an HTTP request when an order is created feeds
   the same endpoint (Shopify Flow "Send HTTP request", a WooCommerce
   webhook, a custom backend, Make):

     POST /orders/event
     Authorization: Bearer <that site's ORDER_EVENT_TOKEN>
     { "siteId": "apgo-my", "orderId": "…", "createdAt": "<ISO 8601>", "test": false }

   The measure is "minutes since the last order" against one flat threshold.
   That is blunt on purpose. An earlier version compared the gap with a
   per-hour-of-week percentile, which rang 11 times in three days the owner
   confirmed were healthy: the threshold moved every run, and "recovered"
   fired whenever it rose past a gap that had not actually ended.

   455 real orders say why nothing cleverer fits. Zero orders in a 4-hour
   window happens in 3.6% of all normal windows, and one hour-of-week bucket
   holds anywhere from 4 to 17 orders, so no count-based band separates a
   quiet evening from a broken checkout. What does separate them is length:
   the longest normal gap was 5h51m, and the only longer one, 8h01m, was the
   2026-09-15 free-shipping incident.

   So this is the slow, quiet backstop for "sales have actually stopped", and
   the funnel rules are the fast detector. On 09-15 GA4 paged at 00:46, five
   hours before this would have. */
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

/* No model, just what the order stream has actually done lately, so the
   margin between the configured threshold and real traffic stays visible in
   every heartbeat. */
export function summarizeOrderGaps(orderTimesMs, options = {}) {
  const { nowMs = Date.now(), observedGapDays } = { ...ORDER_LIMITS, ...options };
  const orders = [...orderTimesMs].filter(Number.isFinite).sort((a, b) => a - b);
  const since = nowMs - observedGapDays * 86_400_000;
  const gaps = [];
  for (let index = 1; index < orders.length; index += 1) {
    if (orders[index] < since) continue;
    gaps.push((orders[index] - orders[index - 1]) / 60_000);
  }
  return {
    computedAt: new Date(nowMs).toISOString(),
    observedGapDays,
    orderCount: orders.length,
    firstOrderAt: orders.length ? new Date(orders[0]).toISOString() : null,
    gapSamples: gaps.length,
    medianGapMinutes: gaps.length ? round(percentile(gaps, 0.5)) : null,
    p90GapMinutes: gaps.length ? round(percentile(gaps, 0.9)) : null,
    maxGapMinutes: gaps.length ? round(Math.max(...gaps)) : null,
  };
}

export function evaluateOrderGap({ lastOrderAtMs, nowMs, gapMinutes = ORDER_LIMITS.gapMinutes, criticalMultiplier = ORDER_LIMITS.criticalMultiplier }) {
  const ageMinutes = Number.isFinite(lastOrderAtMs) ? (nowMs - lastOrderAtMs) / 60_000 : Number.POSITIVE_INFINITY;
  let severity = null;
  if (ageMinutes > gapMinutes * criticalMultiplier) severity = 'critical';
  else if (ageMinutes > gapMinutes) severity = 'warning';
  return { severity, ageMinutes: round(ageMinutes), thresholdMinutes: gapMinutes };
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

/* Traffic never suppresses the alert; it changes what the alert tells the
   owner to look at. Orders stopped while people are still shopping points at
   checkout. Orders stopped while traffic stopped too points at the ads. */
export function trafficNote(traffic, nowMs, { maxAgeMinutes = 20 } = {}) {
  const checkedAtMs = Date.parse(traffic?.checkedAt || '');
  if (!Number.isFinite(checkedAtMs) || (nowMs - checkedAtMs) / 60_000 > maxAgeMinutes) {
    return '同时段流量：读不到（GA4 检查太旧或没跑）';
  }
  const current = Number(traffic?.current?.view_item);
  const baseline = Number(traffic?.baseline?.view_item);
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) {
    return '同时段流量：读不到（GA4 没给出可比的基线）';
  }
  const ratio = current / baseline;
  if (ratio >= 0.6) return `同时段流量正常（看商品 ${current}，平时 ${baseline}）→ 重点查结账`;
  return `同时段流量也只有平时的 ${Math.round(ratio * 100)}%（看商品 ${current}，平时 ${baseline}）→ 可能是广告停了或淡时段`;
}

export function orderAlertText(site, evaluation, lastOrderAtMs, timeZone, traffic = null, nowMs = Date.now()) {
  const icon = evaluation.severity === 'critical' ? '🔴' : '🟡';
  return [
    `${icon} [${site.label}][Layer 4 · Orders] 已经 ${formatMinutes(evaluation.ageMinutes)} 没有订单（超过 ${formatMinutes(evaluation.thresholdMinutes)} 就提醒）`,
    `上一单：${localClock(lastOrderAtMs, timeZone)} ${timeZone}`,
    trafficNote(traffic, nowMs),
  ].join('\n');
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
  if (mode === 'armed') await sendTelegram(env, text, { silent: true });
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
  const observed = summarizeOrderGaps(times, { nowMs });
  const lastOrderAtMs = Math.max(...times);
  await setState(env.DB, lastKey, { createdAt: new Date(lastOrderAtMs).toISOString(), receivedAt: push.lastReceivedAt || null, checkedAt: new Date(nowMs).toISOString() });

  const evaluation = evaluateOrderGap({ lastOrderAtMs, nowMs });
  const traffic = await getState(env.DB, siteKey(site.id, 'ga4:realtime:last'));
  const state = (await getState(env.DB, alertKey)) || { open: false, severity: null, lastAlertMs: 0, lastOrderAtMs: null };
  const detail = {
    siteId: site.id, mode, ...evaluation,
    lastOrderAt: new Date(lastOrderAtMs).toISOString(),
    orderCount: observed.orderCount, firstOrderAt: observed.firstOrderAt,
    observedMaxGapMinutes: observed.maxGapMinutes, observedP90GapMinutes: observed.p90GapMinutes,
  };
  /* Recovery means an order arrived, never that the threshold moved. The old
     rule declared "Orders resumed" three times on 2026-09-16 while the last
     order stayed at Wed 17:55, because it only asked whether the gap was under
     a threshold that had itself grown. */
  const resumed = state.open && Number.isFinite(Number(state.lastOrderAtMs)) && lastOrderAtMs > Number(state.lastOrderAtMs);
  if (shouldAlertHeartbeat(evaluation.severity, state, nowMs, ORDER_LIMITS.realertMs)) {
    await logAlert(env.DB, siteKey(site.id, 'layer4'), mode === 'armed' ? 'orders_gap' : 'would_alert', { rule: 'orders_gap', ...detail });
    if (mode === 'armed') await sendTelegram(env, orderAlertText(site, evaluation, lastOrderAtMs, timeZone, traffic, nowMs));
    await setState(env.DB, alertKey, { open: true, severity: evaluation.severity, lastAlertMs: nowMs, lastOrderAtMs });
  } else if (resumed) {
    await logAlert(env.DB, siteKey(site.id, 'layer4'), mode === 'armed' ? 'orders_recovery' : 'would_recover', { rule: 'orders_gap', ...detail });
    if (mode === 'armed') await sendTelegram(env, `🟢 [${site.label}][Layer 4 · Orders] 订单恢复了\n这一单：${localClock(lastOrderAtMs, timeZone)} ${timeZone}`, { silent: true });
    await setState(env.DB, alertKey, { open: false, severity: null, lastAlertMs: state.lastAlertMs, lastOrderAtMs });
  }

  // A long silence from the push source is ambiguous: no orders, or a broken
  // Flow. Say so separately instead of letting it masquerade as either.
  const receivedMs = Date.parse(push.lastReceivedAt || '');
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > ORDER_LIMITS.pushStaleMs) {
    await logAlert(env.DB, siteKey(site.id, 'self-health'), 'orders_push_stale', { siteId: site.id, lastReceivedAt: push.lastReceivedAt, ageMinutes: round((nowMs - receivedMs) / 60_000) });
    await notifyThrottled(env, site, 'push-stale', `🟠 [${site.label}][Layer 4 · Orders] No order events received for ${formatMinutes((nowMs - receivedMs) / 60_000)} — check the platform push (Shopify Flow) before reading this as zero sales`, nowMs, mode);
  }
  return { ok: true, mode, ...evaluation, orderCount: observed.orderCount, observedMaxGapMinutes: observed.maxGapMinutes };
}
