import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendOrderLog,
  bucketFor,
  computeOrderBaseline,
  evaluateOrderGap,
  formatMinutes,
  orderAlertText,
  parseOrderEvent,
  percentile,
} from '../workers/error-monitor/orders.mjs';

const TZ = 'Asia/Kuala_Lumpur';
const NOW = Date.parse('2026-09-08T06:00:00Z'); // Tuesday 14:00 MYT
const DAY = 86_400_000;

/* 28 days of synthetic orders: one every 30 minutes from 10:00 to 22:00 MYT,
   one every 3 hours overnight (23:00, 02:00, 05:00, 08:00), on every day of the week. */
function syntheticOrders(days = 28) {
  const times = [];
  const start = NOW - days * DAY;
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

test('mature baseline thresholds follow the hour: tight by day, loose at night, never below the floor', () => {
  const baseline = computeOrderBaseline(syntheticOrders(), { nowMs: NOW, timeZone: TZ });
  assert.equal(baseline.computedAt, new Date(NOW).toISOString());
  const day = baseline.buckets['wd:14'];
  const night = baseline.buckets['wd:04']; // 04:00-04:59, last order at 02:00
  assert.ok(day.n >= 30 && night.n >= 30, `samples per bucket ${day.n}/${night.n}`);
  assert.equal(day.immature, false);
  assert.ok(day.p90Minutes <= 30, `day p90 ${day.p90Minutes}`);
  assert.equal(day.thresholdMinutes, 90, 'daytime stays on the 90-minute floor');
  assert.equal(night.p90Minutes, 150);
  assert.equal(night.thresholdMinutes, 225);
  assert.ok(baseline.buckets['we:14'], 'weekend buckets exist');
});

test('a young baseline uses the bootstrap threshold until buckets have enough samples', () => {
  const young = computeOrderBaseline(syntheticOrders(2), { nowMs: NOW, timeZone: TZ });
  const day = young.buckets['wd:14'];
  assert.equal(day.immature, true);
  assert.equal(day.thresholdMinutes, 360, 'bootstrap beats the 90-minute floor while immature');
  const evaluation = evaluateOrderGap({ baseline: young, lastOrderAtMs: NOW - 4 * 60 * 60_000, nowMs: NOW, timeZone: TZ });
  assert.equal(evaluation.severity, null, '4 quiet hours do not page on a two-day-old baseline');
  assert.equal(evaluation.immature, true);
  const missing = evaluateOrderGap({ baseline: { buckets: {} }, lastOrderAtMs: NOW - 7 * 60 * 60_000, nowMs: NOW, timeZone: TZ });
  assert.equal(missing.thresholdMinutes, 360);
  assert.equal(missing.severity, 'warning');
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
  assert.equal(evaluateOrderGap({ baseline, lastOrderAtMs: null, nowMs: NOW, timeZone: TZ }).severity, 'critical', 'no order at all is critical');
});

test('alert text is human-readable and names the bucket or the bootstrap state', () => {
  assert.equal(formatMinutes(192), '3h12m');
  assert.equal(formatMinutes(45), '45m');
  const text = orderAlertText({ label: 'APGO MY' }, { severity: 'warning', ageMinutes: 192, thresholdMinutes: 100, bucket: 'wd:14', immature: false }, NOW - 192 * 60_000, TZ);
  assert.match(text, /^🟡 \[APGO MY\]\[Layer 4 · Orders\] No orders for 3h12m \(expected ≤ 1h40m; weekday 14:00 Asia\/Kuala_Lumpur\)/);
  assert.match(text, /Last order: Tue 10:48/);
  const young = orderAlertText({ label: 'APGO MY' }, { severity: 'critical', ageMinutes: 800, thresholdMinutes: 360, bucket: 'wd:14', immature: true }, NOW - 800 * 60_000, TZ);
  assert.match(young, /^🔴 .*bootstrap threshold, baseline still maturing/);
});

test('parseOrderEvent validates the platform-agnostic payload', () => {
  const ok = parseOrderEvent({ siteId: 'apgo-my', orderId: 12345, createdAt: '2026-09-08T05:20:00+08:00', test: 'false' });
  assert.deepEqual(ok, { ok: true, event: { siteId: 'apgo-my', orderId: '12345', createdAtMs: Date.parse('2026-09-08T05:20:00+08:00'), test: false } });
  assert.equal(parseOrderEvent({ siteId: 'apgo-my', orderId: '1', createdAt: '2026-09-08T05:20:00Z', test: true }).event.test, true);
  assert.equal(parseOrderEvent({ orderId: '1', createdAt: '2026-09-08T05:20:00Z' }).error, 'siteId is required');
  assert.equal(parseOrderEvent({ siteId: 'apgo-my', createdAt: '2026-09-08T05:20:00Z' }).error, 'orderId is required');
  assert.equal(parseOrderEvent({ siteId: 'apgo-my', orderId: '1', createdAt: 'yesterday' }).error, 'createdAt must be ISO 8601');
  assert.equal(parseOrderEvent(null).ok, false);
});

test('appendOrderLog is idempotent, sorted, and trims old entries', () => {
  const first = appendOrderLog(null, { orderId: 'a', createdAtMs: NOW - 60_000 }, NOW);
  assert.equal(first.duplicate, false);
  assert.equal(first.log.entries.length, 1);
  const retry = appendOrderLog(first.log, { orderId: 'a', createdAtMs: NOW - 60_000 }, NOW);
  assert.equal(retry.duplicate, true, 'a platform retry does not count twice');
  assert.equal(retry.log.entries.length, 1);
  const older = appendOrderLog(first.log, { orderId: 'b', createdAtMs: NOW - 120_000 }, NOW);
  assert.deepEqual(older.log.entries.map((entry) => entry.id), ['b', 'a'], 'late-arriving older order is sorted into place');
  const stale = appendOrderLog({ entries: [{ id: 'old', at: NOW - 40 * DAY }] }, { orderId: 'c', createdAtMs: NOW }, NOW);
  assert.deepEqual(stale.log.entries.map((entry) => entry.id), ['c'], 'entries beyond retention are dropped');
  const capped = appendOrderLog({ entries: Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, at: NOW - (10 - i) * 60_000 })) }, { orderId: 'new', createdAtMs: NOW }, NOW, { cap: 3 });
  assert.deepEqual(capped.log.entries.map((entry) => entry.id), ['e1', 'e2', 'new']);
});
