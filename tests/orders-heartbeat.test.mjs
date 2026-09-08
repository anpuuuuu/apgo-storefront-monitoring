import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bucketFor,
  computeOrderBaseline,
  evaluateOrderGap,
  fetchBaselineOrderTimes,
  fetchLatestOrder,
  formatMinutes,
  orderAlertText,
  percentile,
} from '../workers/error-monitor/orders.mjs';

const TZ = 'Asia/Kuala_Lumpur';
const NOW = Date.parse('2026-09-08T06:00:00Z'); // Tuesday 14:00 MYT
const DAY = 86_400_000;

/* 28 days of synthetic orders: one every 30 minutes from 10:00 to 22:00 MYT,
   one every 3 hours overnight (23:00, 02:00, 05:00, 08:00), on every day of the week. */
function syntheticOrders() {
  const times = [];
  const start = NOW - 28 * DAY;
  for (let t = start; t <= NOW; t += 30 * 60_000) {
    const { hour } = bucketFor(t, TZ);
    const daytime = hour >= 10 && hour < 22;
    const minute = Math.round(((t / 60_000) % 60 + 60) % 60);
    if (daytime) times.push(t);
    else if (hour % 3 === 2 && minute === 0) times.push(t);
  }
  return times;
}

test('bucketFor splits weekday and weekend hours in the store timezone', () => {
  assert.deepEqual(bucketFor(NOW, TZ), { key: 'wd:14', hour: 14, weekend: false });
  assert.deepEqual(bucketFor(Date.parse('2026-09-06T02:30:00Z'), TZ), { key: 'we:10', hour: 10, weekend: true }); // Sunday
  assert.equal(bucketFor(Date.parse('2026-09-07T16:30:00Z'), TZ).key, 'wd:00'); // Tuesday 00:30 MYT
});

test('percentile uses nearest rank', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([], 0.9), null);
});

test('baseline thresholds follow the hour: tight by day, loose at night, never below the floor', () => {
  const baseline = computeOrderBaseline(syntheticOrders(), { nowMs: NOW, timeZone: TZ });
  assert.equal(baseline.computedAt, new Date(NOW).toISOString());
  const day = baseline.buckets['wd:14'];
  const night = baseline.buckets['wd:04']; // 04:00-04:59, last order at 02:00
  assert.ok(day.n >= 30 && night.n >= 30, `samples per bucket ${day.n}/${night.n}`);
  assert.ok(day.p90Minutes <= 30, `day p90 ${day.p90Minutes}`);
  assert.equal(day.thresholdMinutes, 90, 'daytime stays on the 90-minute floor');
  assert.equal(night.p90Minutes, 150);
  assert.equal(night.thresholdMinutes, 225);
  assert.ok(baseline.buckets['we:14'], 'weekend buckets exist');
});

test('threshold is capped and empty history yields no buckets', () => {
  const sparse = [NOW - 27 * DAY, NOW - 2 * DAY];
  const baseline = computeOrderBaseline(sparse, { nowMs: NOW, timeZone: TZ });
  assert.equal(baseline.buckets['wd:14'].thresholdMinutes, 720);
  assert.deepEqual(computeOrderBaseline([], { nowMs: NOW, timeZone: TZ }).buckets, {});
});

test('evaluateOrderGap warns and escalates against the current bucket only', () => {
  const baseline = computeOrderBaseline(syntheticOrders(), { nowMs: NOW, timeZone: TZ });
  assert.equal(evaluateOrderGap({ baseline, lastOrderAtMs: NOW - 40 * 60_000, nowMs: NOW, timeZone: TZ }).severity, null);
  const warning = evaluateOrderGap({ baseline, lastOrderAtMs: NOW - 120 * 60_000, nowMs: NOW, timeZone: TZ });
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.bucket, 'wd:14');
  assert.equal(warning.ageMinutes, 120);
  assert.equal(evaluateOrderGap({ baseline, lastOrderAtMs: NOW - 4 * 60 * 60_000, nowMs: NOW, timeZone: TZ }).severity, 'critical');

  const night = Date.parse('2026-09-07T20:00:00Z'); // Tuesday 04:00 MYT
  assert.equal(evaluateOrderGap({ baseline, lastOrderAtMs: night - 120 * 60_000, nowMs: night, timeZone: TZ }).severity, null, 'two quiet night hours are normal');
  assert.equal(evaluateOrderGap({ baseline: { buckets: {} }, lastOrderAtMs: NOW - 600 * 60_000, nowMs: NOW, timeZone: TZ }).reason, 'no_baseline_bucket');
  assert.equal(evaluateOrderGap({ baseline, lastOrderAtMs: null, nowMs: NOW, timeZone: TZ }).severity, 'critical', 'no order at all is critical');
});

test('alert text is human-readable and names the bucket', () => {
  assert.equal(formatMinutes(192), '3h12m');
  assert.equal(formatMinutes(45), '45m');
  const text = orderAlertText({ label: 'APGO MY' }, { severity: 'warning', ageMinutes: 192, thresholdMinutes: 100, bucket: 'wd:14' }, NOW - 192 * 60_000, TZ);
  assert.match(text, /^🟡 \[APGO MY\]\[Layer 4 · Orders\] No Shopify orders for 3h12m \(expected ≤ 1h40m for weekday 14:00 Asia\/Kuala_Lumpur\)/);
  assert.match(text, /Last order: Tue 10:48/);
});

test('Shopify fetchers skip test orders and paginate the baseline', async () => {
  const site = { shopify: { shopDomain: 'example.myshopify.com' } };
  const latest = await fetchLatestOrder(site, 'token', async () => ({
    orders: { edges: [{ node: { createdAt: '2026-09-08T05:50:00Z', test: true } }, { node: { createdAt: '2026-09-08T05:20:00Z', test: false } }] },
  }));
  assert.equal(latest, Date.parse('2026-09-08T05:20:00Z'));
  assert.equal(await fetchLatestOrder(site, 'token', async () => ({ orders: { edges: [] } })), null);

  const pages = [
    { orders: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, edges: [{ node: { createdAt: '2026-08-20T01:00:00Z', test: false } }, { node: { createdAt: '2026-08-20T02:00:00Z', test: true } }] } },
    { orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { createdAt: '2026-08-21T01:00:00Z', test: false } }] } },
  ];
  const seen = [];
  const times = await fetchBaselineOrderTimes(site, 'token', NOW - 28 * DAY, async (_site, _token, _query, variables) => { seen.push(variables); return pages.shift(); });
  assert.deepEqual(times, [Date.parse('2026-08-20T01:00:00Z'), Date.parse('2026-08-21T01:00:00Z')]);
  assert.equal(seen[0].after, null);
  assert.equal(seen[1].after, 'c1');
  assert.match(seen[0].query, /^created_at:>=2026-08-11T06:00:00\.000Z$/);
});
