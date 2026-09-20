import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_NAMES,
  WINDOWS,
  bucketByWindow,
  minuteToMs,
  minutesAgo,
  propertyMinuteNow,
  windowIndexFor,
} from '../scripts/ga4-diagnose-lib.mjs';

const MY = 'Asia/Kuala_Lumpur';

test('dateHourMinute is read as a wall clock in the property timezone', () => {
  // Malaysia is UTC+8 all year, so 20:00 local is 12:00Z.
  assert.equal(new Date(minuteToMs('202609202000', MY)).toISOString(), '2026-09-20T12:00:00.000Z');
  assert.equal(new Date(minuteToMs('202609200000', MY)).toISOString(), '2026-09-19T16:00:00.000Z');
  assert.equal(new Date(minuteToMs('202601010730', MY)).toISOString(), '2025-12-31T23:30:00.000Z');
  // UTC property: no shift at all.
  assert.equal(new Date(minuteToMs('202609201234', 'UTC')).toISOString(), '2026-09-20T12:34:00.000Z');
  // A zone with DST must use the offset in force at that instant, not a guess.
  assert.equal(new Date(minuteToMs('202607011200', 'Europe/London')).toISOString(), '2026-07-01T11:00:00.000Z', 'BST');
  assert.equal(new Date(minuteToMs('202601011200', 'Europe/London')).toISOString(), '2026-01-01T12:00:00.000Z', 'GMT');
  // Malformed input must not silently become a real instant.
  for (const bad of ['', '2026092020', '20260920200x', null, undefined, '2026-09-20T20:00']) {
    assert.ok(Number.isNaN(minuteToMs(bad, MY)), `${JSON.stringify(bad)} must be NaN`);
  }
});

test('propertyMinuteNow and minutesAgo agree with each other', () => {
  const nowMs = Date.parse('2026-09-20T13:07:00Z');
  assert.equal(propertyMinuteNow(nowMs, MY), '202609202107');
  assert.equal(minutesAgo('202609202107', nowMs, MY), 0);
  assert.equal(minutesAgo('202609202007', nowMs, MY), 60);
  assert.equal(minutesAgo('202609201807', nowMs, MY), 180);
  // A minute stamped after "now" (clock skew) is negative, never a huge number.
  assert.equal(minutesAgo('202609202117', nowMs, MY), -10);
  assert.ok(Number.isNaN(minutesAgo('nonsense', nowMs, MY)));
});

test('window boundaries are half-open, so no minute lands in two windows', () => {
  // [180,150) [150,120) [120,90) [90,60) [60,30) [30,0)
  assert.equal(windowIndexFor(0), 5);
  assert.equal(windowIndexFor(29.9), 5);
  assert.equal(windowIndexFor(30), 4, '30 belongs to the older window, not both');
  assert.equal(windowIndexFor(59.9), 4);
  assert.equal(windowIndexFor(60), 3);
  assert.equal(windowIndexFor(179.9), 0);
  assert.equal(windowIndexFor(180), -1, 'older than the oldest window is dropped');
  assert.equal(windowIndexFor(-1), -1, 'the future is dropped');
  assert.equal(windowIndexFor(NaN), -1);
  // Every age in range lands in exactly one window.
  for (let age = 0; age < 180; age += 0.5) {
    const hits = WINDOWS.filter(([start, end]) => age < start && age >= end);
    assert.equal(hits.length, 1, `age ${age}`);
  }
});

test('bucketByWindow sums the right events into the right windows', () => {
  const nowMs = Date.parse('2026-09-20T13:00:00Z'); // 21:00 MYT
  const row = (stamp, event, count) => ({
    dimensionValues: [{ value: stamp }, { value: event }],
    metricValues: [{ value: String(count) }],
  });
  const totals = bucketByWindow([
    row('202609202055', 'add_to_cart', 3),      // 5 min ago  -> newest window
    row('202609202040', 'add_to_cart', 2),      // 20 min ago -> newest window
    row('202609202040', 'begin_checkout', 1),
    row('202609202015', 'add_to_cart', 7),      // 45 min ago -> 60-30
    row('202609201930', 'purchase', 4),         // 90 min ago -> 120-90
    row('202609201700', 'add_to_cart', 99),     // 240 min ago -> dropped
    row('202609202105', 'add_to_cart', 50),     // in the future -> dropped
    row('202609202050', 'scroll', 11),          // not a tracked event -> dropped
    row('bad-stamp', 'add_to_cart', 13),        // unparseable -> dropped
  ], nowMs, { timeZone: MY });

  const newest = totals[WINDOWS.length - 1];
  assert.equal(newest.add_to_cart, 5, '3 + 2 in the trailing 30 minutes');
  assert.equal(newest.begin_checkout, 1);
  assert.equal(totals[4].add_to_cart, 7, '60-30 window');
  assert.equal(totals[2].purchase, 4, '120-90 window');
  // Nothing leaked anywhere else.
  const grand = totals.reduce((sum, window) => sum + EVENT_NAMES.reduce((inner, name) => inner + window[name], 0), 0);
  assert.equal(grand, 5 + 1 + 7 + 4, 'out-of-range, future, unknown-event and malformed rows are all dropped');
  assert.deepEqual(bucketByWindow(null, nowMs, { timeZone: MY })[0], Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])));
});

test('the diagnostic asks about the exact bias that made the rule fire', () => {
  /* 2026-09-16: traffic flat, add_to_cart 2 → 19, begin_checkout 0 → 5 across
     consecutive trailing windows, and begin_checkout_zero paged on a storefront
     the owner confirms was fine. The point of the windows is to show whether
     the newest one is systematically thinner than the settled ones. */
  assert.equal(WINDOWS.at(-1)[1], 0, 'the newest window must reach up to now, the one the rule reads');
  assert.equal(WINDOWS[0][0], 180, 'three hours back gives enough settled windows to compare against');
  assert.ok(WINDOWS.every(([start, end]) => start - end === 30), 'every window is the same 30 minutes wide, or the columns are not comparable');
  assert.ok(EVENT_NAMES.includes('add_to_cart') && EVENT_NAMES.includes('begin_checkout'));
});
