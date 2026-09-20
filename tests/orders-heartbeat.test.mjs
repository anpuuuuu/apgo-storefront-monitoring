import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendOrderLog,
  bucketFor,
  evaluateOrderGap,
  formatMinutes,
  orderAlertText,
  parseOrderEvent,
  percentile,
  summarizeOrderGaps,
  trafficNote,
} from '../workers/error-monitor/orders.mjs';
import { ORDER_LIMITS } from '../workers/error-monitor/config.mjs';

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

test('the gap threshold is one flat number, chosen from 455 real orders', () => {
  /* 2026-09-09 to 09-20: median gap 19 min, p90 1h19m, longest healthy gap
     5h51m, and the only longer one (8h01m) was the 09-15 free-shipping
     incident. Replaying the rule over those days fires once, on the
     incident; a 4-hour threshold fires nine times on days the owner
     confirmed were healthy. Anything tighter than the observed spread is
     noise, so the number is locked here with the evidence beside it. */
  assert.equal(ORDER_LIMITS.gapMinutes, 420);
  assert.ok(ORDER_LIMITS.gapMinutes > 5 * 60 + 51, "must clear the longest healthy gap");
  assert.ok(ORDER_LIMITS.gapMinutes < 8 * 60 + 1, "must still catch the 09-15 incident");
});

test('evaluateOrderGap warns past the threshold and escalates at twice it', () => {
  const at = (minutes) => evaluateOrderGap({ lastOrderAtMs: NOW - minutes * 60_000, nowMs: NOW });
  assert.equal(at(19).severity, null, "the median gap");
  assert.equal(at(5 * 60 + 51).severity, null, "the longest gap seen on a healthy day");
  assert.equal(at(420).severity, null, "exactly at the threshold is not yet late");
  assert.equal(at(421).severity, "warning");
  assert.equal(at(8 * 60 + 1).severity, "warning", "the 09-15 incident gap");
  assert.equal(at(841).severity, "critical", "past twice the threshold");
  assert.equal(at(421).ageMinutes, 421);
  assert.equal(at(421).thresholdMinutes, 420);
  // No order on record at all is the most serious reading there is.
  assert.equal(evaluateOrderGap({ lastOrderAtMs: null, nowMs: NOW }).severity, "critical");
  assert.equal(evaluateOrderGap({ lastOrderAtMs: NaN, nowMs: NOW }).severity, "critical");
  // The time of day no longer changes the verdict; that is the point.
  const night = Date.parse("2026-09-07T20:00:00Z");
  assert.equal(evaluateOrderGap({ lastOrderAtMs: night - 421 * 60_000, nowMs: night }).severity, "warning");
  assert.equal(evaluateOrderGap({ lastOrderAtMs: NOW - 421 * 60_000, nowMs: NOW, gapMinutes: 600 }).severity, null, "threshold is overridable");
});

test('summarizeOrderGaps reports the margin instead of setting the threshold', () => {
  const orders = [0, 20, 40, 100, 400].map((minutes) => NOW - (500 - minutes) * 60_000);
  const summary = summarizeOrderGaps(orders, { nowMs: NOW });
  assert.equal(summary.orderCount, 5);
  assert.equal(summary.gapSamples, 4);
  assert.equal(summary.maxGapMinutes, 300, "the 100 to 400 minute jump");
  // Gaps are 20, 20, 60, 300; percentile uses nearest rank, so the median is 20.
  assert.equal(summary.medianGapMinutes, 20);
  assert.equal(summary.firstOrderAt, new Date(orders[0]).toISOString());
  // Empty and single-order histories must not throw or invent a gap.
  assert.equal(summarizeOrderGaps([], { nowMs: NOW }).maxGapMinutes, null);
  assert.equal(summarizeOrderGaps([NOW], { nowMs: NOW }).gapSamples, 0);
  // Orders older than the window are excluded from the gap statistics.
  const old = summarizeOrderGaps([NOW - 40 * DAY, NOW - 39 * DAY, NOW - 60_000], { nowMs: NOW, observedGapDays: 28 });
  assert.equal(old.gapSamples, 1, "only the gap that ends inside the window");
  assert.equal(old.orderCount, 3, "but every order is still counted");
});

test('traffic changes what the alert points at, and never silences it', () => {
  /* Wade, 2026-09-20: still alert when traffic is down too, but say so, so
     the message separates "checkout is broken" from "the ads stopped". */
  const fresh = (current, baseline) => ({ checkedAt: new Date(NOW - 5 * 60_000).toISOString(), current: { view_item: current }, baseline: { view_item: baseline } });
  assert.match(trafficNote(fresh(120, 130), NOW), /流量正常.*重点查结账/);
  assert.match(trafficNote(fresh(30, 130), NOW), /只有平时的 23%.*广告停了/);
  assert.match(trafficNote(fresh(0, 130), NOW), /只有平时的 0%/);
  // Stale or unusable GA4 data says so rather than guessing either way.
  assert.match(trafficNote({ checkedAt: new Date(NOW - 60 * 60_000).toISOString(), current: { view_item: 5 }, baseline: { view_item: 130 } }, NOW), /读不到/);
  assert.match(trafficNote(null, NOW), /读不到/);
  assert.match(trafficNote(fresh(10, 0), NOW), /读不到/, "a zero baseline is not a 100% drop");
  assert.match(trafficNote({ checkedAt: "not a date" }, NOW), /读不到/);
});

test('the alert says how long, against what, and where to look', () => {
  assert.equal(formatMinutes(192), '3h12m');
  assert.equal(formatMinutes(45), '45m');
  const traffic = { checkedAt: new Date(NOW - 5 * 60_000).toISOString(), current: { view_item: 120 }, baseline: { view_item: 130 } };
  const text = orderAlertText({ label: 'APGO MY' }, { severity: 'warning', ageMinutes: 430, thresholdMinutes: 420 }, NOW - 430 * 60_000, TZ, traffic, NOW);
  assert.match(text, /^🟡 \[APGO MY\]\[Layer 4 · Orders\] 已经 7h10m 没有订单（超过 7h00m 就提醒）/);
  assert.match(text, /上一单：Tue 06:50/);
  assert.match(text, /流量正常/);
  const critical = orderAlertText({ label: 'APGO MY' }, { severity: 'critical', ageMinutes: 900, thresholdMinutes: 420 }, NOW - 900 * 60_000, TZ, null, NOW);
  assert.match(critical, /^🔴 /);
  assert.match(critical, /同时段流量：读不到/);
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
