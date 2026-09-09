/* First-party order heartbeat. GA4 tells us whether tracking works; the
   Shopify order stream tells us whether commerce works, independent of
   consent banners, ad blockers or a broken pixel. Purchases are sparse (about
   one per 30 minutes at the afternoon peak, one per several hours at night),
   so a fixed-window count would swing between 0 and 100%. Instead we measure
   "minutes since the last order" and compare it with what that hour of the
   week normally tolerates: the 90th percentile of the same measurement taken
   every 30 minutes over the last 28 days, times 1.5, clamped to
   [floor, cap]. Nothing here alerts on a quiet night that is normally quiet. */
import { ORDER_LIMITS, siteKey } from './config.mjs';
import { getState, logAlert, setState } from './db.mjs';
import { sendTelegram } from './telegram.mjs';
import { shouldAlertHeartbeat } from './uptime.mjs';

const SHOPIFY_API_VERSION = '2026-07';
const MAX_BASELINE_PAGES = 10;

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
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
    nowMs, baselineDays, sampleMinutes, percentile: fraction, multiplier, floorMinutes, capMinutes, timeZone,
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
    buckets[key] = {
      n: ages.length,
      p90Minutes: round(p),
      thresholdMinutes: round(Math.min(capMinutes, Math.max(floorMinutes, multiplier * p))),
    };
  }
  return { computedAt: new Date(nowMs).toISOString(), baselineDays, orderCount: orders.length, buckets };
}

export function evaluateOrderGap({ baseline, lastOrderAtMs, nowMs, timeZone, criticalMultiplier = ORDER_LIMITS.criticalMultiplier }) {
  const { key } = bucketFor(nowMs, timeZone);
  const ageMinutes = Number.isFinite(lastOrderAtMs) ? (nowMs - lastOrderAtMs) / 60_000 : Number.POSITIVE_INFINITY;
  const bucket = baseline?.buckets?.[key];
  if (!bucket) return { severity: null, ageMinutes: round(ageMinutes), thresholdMinutes: null, bucket: key, reason: 'no_baseline_bucket' };
  let severity = null;
  if (ageMinutes > bucket.thresholdMinutes * criticalMultiplier) severity = 'critical';
  else if (ageMinutes > bucket.thresholdMinutes) severity = 'warning';
  return { severity, ageMinutes: round(ageMinutes), thresholdMinutes: bucket.thresholdMinutes, bucket: key };
}

export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours ? `${hours}h${String(rest).padStart(2, '0')}m` : `${rest}m`;
}

function localClock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export function orderAlertText(site, evaluation, lastOrderAtMs, timeZone) {
  const icon = evaluation.severity === 'critical' ? '🔴' : '🟡';
  const bucketLabel = `${evaluation.bucket.startsWith('we') ? 'weekend' : 'weekday'} ${evaluation.bucket.slice(3)}:00`;
  return `${icon} [${site.label}][Layer 4 · Orders] No Shopify orders for ${formatMinutes(evaluation.ageMinutes)} (expected ≤ ${formatMinutes(evaluation.thresholdMinutes)} for ${bucketLabel} ${timeZone})\nLast order: ${localClock(lastOrderAtMs, timeZone)} ${timeZone}`;
}

async function shopifyGraphql(site, token, query, variables = {}) {
  const response = await fetch(`https://${site.shopify.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token, 'user-agent': 'APGO-HealthCheck/2.0 Orders' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Shopify Admin HTTP ${response.status}`);
  if (body.errors?.length) throw new Error(`Shopify Admin GraphQL: ${body.errors.map((error) => error.message).join('; ').slice(0, 300)}`);
  return body.data;
}

/* Newest real order. Test orders are excluded; cancelled orders still prove
   that checkout worked, so they count. */
export async function fetchLatestOrder(site, token, client = shopifyGraphql) {
  const data = await client(site, token, `query LatestOrders {
    orders(first: 10, sortKey: CREATED_AT, reverse: true) { edges { node { createdAt test } } }
  }`);
  const node = (data?.orders?.edges || []).map((edge) => edge.node).find((order) => !order.test);
  return node ? Date.parse(node.createdAt) : null;
}

export async function fetchBaselineOrderTimes(site, token, sinceMs, client = shopifyGraphql) {
  const times = [];
  let after = null;
  for (let page = 0; page < MAX_BASELINE_PAGES; page += 1) {
    const data = await client(site, token, `query BaselineOrders($after: String, $query: String!) {
      orders(first: 250, after: $after, sortKey: CREATED_AT, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node { createdAt test } }
      }
    }`, { after, query: `created_at:>=${new Date(sinceMs).toISOString()}` });
    const connection = data?.orders;
    for (const edge of connection?.edges || []) if (!edge.node.test) times.push(Date.parse(edge.node.createdAt));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return times;
}

async function notifyThrottled(env, site, text, nowMs) {
  const key = siteKey(site.id, 'orders:notify-throttle');
  const state = (await getState(env.DB, key)) || {};
  if (nowMs < Number(state.untilMs || 0)) return false;
  await setState(env.DB, key, { untilMs: nowMs + ORDER_LIMITS.failureNotifyMs, text: String(text).slice(0, 200) });
  await sendTelegram(env, text);
  return true;
}

export async function runOrderHeartbeat(env, site, nowMs = Date.now(), client = shopifyGraphql) {
  const timeZone = site.shopify?.timeZone || ORDER_LIMITS.timeZone;
  const mode = env.ORDERS_MODE === 'armed' ? 'armed' : 'observe';
  const token = env[site.shopify?.adminTokenEnv || ''];
  if (!token) {
    await logAlert(env.DB, siteKey(site.id, 'self-health'), 'orders_check_failed', { siteId: site.id, reason: 'admin token missing', env: site.shopify?.adminTokenEnv });
    await notifyThrottled(env, site, `🔴 [${site.label}][Layer 4 · Orders] Shopify Admin token ${site.shopify?.adminTokenEnv || ''} is not configured on the Worker`, nowMs);
    return { ok: false, reason: 'token_missing' };
  }

  const baselineKey = siteKey(site.id, 'orders:baseline');
  const lastKey = siteKey(site.id, 'orders:last');
  const alertKey = siteKey(site.id, 'orders:alert');
  try {
    let baseline = await getState(env.DB, baselineKey);
    if (!baseline || nowMs - Date.parse(baseline.computedAt) > ORDER_LIMITS.baselineMaxAgeMs) {
      const times = await fetchBaselineOrderTimes(site, token, nowMs - ORDER_LIMITS.baselineDays * 86_400_000, client);
      baseline = computeOrderBaseline(times, { nowMs, timeZone });
      await setState(env.DB, baselineKey, baseline);
    }
    const lastOrderAtMs = await fetchLatestOrder(site, token, client);
    await setState(env.DB, lastKey, { createdAt: lastOrderAtMs ? new Date(lastOrderAtMs).toISOString() : null, checkedAt: new Date(nowMs).toISOString() });

    const evaluation = evaluateOrderGap({ baseline, lastOrderAtMs, nowMs, timeZone });
    const state = (await getState(env.DB, alertKey)) || { open: false, severity: null, lastAlertMs: 0 };
    const detail = { siteId: site.id, mode, ...evaluation, lastOrderAt: lastOrderAtMs ? new Date(lastOrderAtMs).toISOString() : null };
    if (shouldAlertHeartbeat(evaluation.severity, state, nowMs, ORDER_LIMITS.realertMs)) {
      await logAlert(env.DB, siteKey(site.id, 'layer4'), mode === 'armed' ? 'orders_gap' : 'would_alert', { rule: 'orders_gap', ...detail });
      if (mode === 'armed') await sendTelegram(env, orderAlertText(site, evaluation, lastOrderAtMs, timeZone));
      await setState(env.DB, alertKey, { open: true, severity: evaluation.severity, lastAlertMs: nowMs });
    } else if (!evaluation.severity && state.open) {
      await logAlert(env.DB, siteKey(site.id, 'layer4'), mode === 'armed' ? 'orders_recovery' : 'would_recover', { rule: 'orders_gap', ...detail });
      if (mode === 'armed') await sendTelegram(env, `🟢 [${site.label}][Layer 4 · Orders] Shopify orders resumed\nLast order: ${localClock(lastOrderAtMs, timeZone)} ${timeZone}`);
      await setState(env.DB, alertKey, { open: false, severity: null, lastAlertMs: state.lastAlertMs });
    }
    return { ok: true, mode, ...evaluation, baselineComputedAt: baseline.computedAt };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await logAlert(env.DB, siteKey(site.id, 'self-health'), 'orders_check_failed', { siteId: site.id, reason: message });
    await notifyThrottled(env, site, `🔴 [${site.label}][Layer 4 · Orders] Shopify order check failed\n${message}`, nowMs);
    return { ok: false, reason: message };
  }
}
