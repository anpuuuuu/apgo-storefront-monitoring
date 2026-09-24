import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  appendCoverage,
  baselineForSlot,
  countsForWindow,
  coverageForDate,
  durationText,
  evaluateDropRules,
  isDailyStageFresh,
  isEmptyWindow,
  minuteToMs,
  nextEmptyState,
  nextRuleState,
  propertyMinuteNow,
  realertDelayHours,
  settledWindow,
  shouldRecordAlert,
  topScreensForEvent,
  watchVerdictLine,
} from '../scripts/ga4-anomaly-lib.mjs';

const SETTINGS = { consecutive_zeros: 2, max_gap_minutes: 45, min_gap_minutes: 15 };
const T0 = Date.parse('2026-09-08T06:00:00Z');
const minutes = (count) => count * 60_000;
const at = (offsetMinutes) => new Date(T0 + minutes(offsetMinutes)).toISOString();

test('adjacent abnormal windows count up to confirmation', () => {
  const first = nextRuleState(null, true, T0, SETTINGS);
  assert.equal(first.next.consecutive, 1);
  assert.equal(first.confirmed, false);
  assert.equal(first.next.gapMinutes, null);
  const second = nextRuleState(first.next, true, T0 + minutes(30), SETTINGS);
  assert.equal(second.next.consecutive, 2);
  assert.equal(second.confirmed, true);
  assert.equal(second.next.gapMinutes, 30);
  assert.equal(second.next.coverageGap, false);
});

test('a three-hour gap restarts the count instead of confirming', () => {
  const previous = { consecutive: 1, checkedAt: at(0), active: false, lastAlertedAt: 0 };
  const result = nextRuleState(previous, true, T0 + minutes(180), SETTINGS);
  assert.equal(result.next.consecutive, 1);
  assert.equal(result.confirmed, false);
  assert.equal(result.next.coverageGap, true);
});

test('a duplicate sample one minute later does not advance the count', () => {
  const previous = { consecutive: 1, checkedAt: at(0), active: false, lastAlertedAt: 0 };
  const result = nextRuleState(previous, true, T0 + minutes(1), SETTINGS);
  assert.equal(result.next.consecutive, 1);
  assert.equal(result.next.duplicate, true);
  assert.equal(result.confirmed, false);
  const fromZero = nextRuleState({ consecutive: 0, checkedAt: at(0) }, true, T0 + minutes(1), SETTINGS);
  assert.equal(fromZero.next.consecutive, 1);
});

test('a normal window resets the count and clears active', () => {
  const previous = { consecutive: 3, checkedAt: at(0), active: true, lastAlertedAt: T0 };
  const result = nextRuleState(previous, false, T0 + minutes(30), SETTINGS);
  assert.equal(result.next.consecutive, 0);
  assert.equal(result.next.active, false);
  assert.equal(result.confirmed, false);
});

test('shouldRecordAlert respects a flat realert window', () => {
  assert.equal(shouldRecordAlert({ active: false }, false, T0, 6), false);
  assert.equal(shouldRecordAlert({ active: false }, true, T0, 6), true);
  assert.equal(shouldRecordAlert({ active: true, lastAlertedAt: T0 - minutes(60) }, true, T0, 6), false);
  assert.equal(shouldRecordAlert({ active: true, lastAlertedAt: T0 - minutes(7 * 60) }, true, T0, 6), true);
});

test('escalating realert schedule: 1 h after the first page, 2 h, then every 3 h', () => {
  const schedule = [1, 2, 3];
  assert.deepEqual([1, 2, 3, 4, 9].map((count) => realertDelayHours(schedule, count)), [1, 2, 3, 3, 3]);
  assert.equal(realertDelayHours(6, 5), 6);
  assert.equal(realertDelayHours(undefined, 1), 6);
  const after = (count, minutesAgo) => shouldRecordAlert({ active: true, alertCount: count, lastAlertedAt: T0 - minutes(minutesAgo) }, true, T0, schedule);
  assert.equal(after(1, 59), false);
  assert.equal(after(1, 60), true, 'second page one hour after the first');
  assert.equal(after(2, 119), false);
  assert.equal(after(2, 120), true, 'third page two hours after the second');
  assert.equal(after(3, 179), false);
  assert.equal(after(3, 180), true);
  assert.equal(after(7, 180), true, 'then every three hours');
  // Replay of 2026-09-15: first page 00:46; under [1,2,3] the owner sees pages at 01:46, 03:46, 06:46 instead of one at 07:16.
});

test('nextRuleState remembers when the abnormal streak started', () => {
  const first = nextRuleState(null, true, T0, SETTINGS);
  assert.equal(first.next.abnormalSince, at(0));
  const second = nextRuleState(first.next, true, T0 + minutes(30), SETTINGS);
  assert.equal(second.next.abnormalSince, at(0), 'kept across the streak');
  const healed = nextRuleState(second.next, false, T0 + minutes(60), SETTINGS);
  assert.equal(healed.next.abnormalSince, null);
  const restarted = nextRuleState({ ...second.next, checkedAt: at(60) }, true, T0 + minutes(240), SETTINGS);
  assert.equal(restarted.next.abnormalSince, at(240), 'a coverage gap restarts the streak clock');
});

test('durationText and topScreensForEvent format the alert evidence', () => {
  assert.equal(durationText(at(-95), T0), '1 小时 35 分钟');
  assert.equal(durationText(at(-120), T0), '2 小时');
  assert.equal(durationText(at(-7), T0), '7 分钟');
  assert.equal(durationText(null, T0), '');
  const report = { rows: [
    { dimensionValues: [{ value: 'add_to_cart' }, { value: 'APGO Atomic Crystal Merdeka Set' }], metricValues: [{ value: '4' }] },
    { dimensionValues: [{ value: 'add_to_cart' }, { value: 'APGO Kitchen Cleaner 500ml' }], metricValues: [{ value: '1' }] },
    { dimensionValues: [{ value: 'view_item' }, { value: 'APGO Kitchen Cleaner 500ml' }], metricValues: [{ value: '9' }] },
    { dimensionValues: [{ value: 'add_to_cart' }, { value: 'Empty' }], metricValues: [{ value: '0' }] },
  ] };
  assert.deepEqual(topScreensForEvent(report, 'add_to_cart'), [
    { screen: 'APGO Atomic Crystal Merdeka Set', count: 4 },
    { screen: 'APGO Kitchen Cleaner 500ml', count: 1 },
  ]);
  assert.deepEqual(topScreensForEvent({ rows: [] }, 'add_to_cart'), []);
});

test('appendCoverage keeps the newest entries within the cap', () => {
  const list = appendCoverage(Array.from({ length: 96 }, (_, index) => at(index)), at(200), 96);
  assert.equal(list.length, 96);
  assert.equal(list.at(-1), at(200));
  assert.equal(list[0], at(1));
  assert.deepEqual(appendCoverage(undefined, at(0)), [at(0)]);
});

test('coverageForDate counts distinct windows on the MYT calendar day', () => {
  const dayStartUtc = Date.parse('2026-09-06T16:00:00Z'); // 2026-09-07 00:00 MYT
  const full = Array.from({ length: 48 }, (_, index) => new Date(dayStartUtc + minutes(index * 30 + 5)).toISOString());
  assert.deepEqual(coverageForDate(full, '20260907', 'Asia/Kuala_Lumpur', 30), { windows: 48, expected: 48, ratio: 1 });
  const duplicates = [full[0], new Date(dayStartUtc + minutes(6)).toISOString(), full[1]];
  assert.equal(coverageForDate(duplicates, '20260907', 'Asia/Kuala_Lumpur', 30).windows, 2);
  const boundary = ['2026-09-06T15:50:00Z', '2026-09-06T16:10:00Z']; // 23:50 MYT on the 6th, 00:10 MYT on the 7th
  assert.equal(coverageForDate(boundary, '20260907', 'Asia/Kuala_Lumpur', 30).windows, 1);
  assert.equal(coverageForDate(boundary, '20260906', 'Asia/Kuala_Lumpur', 30).windows, 1);
  assert.equal(coverageForDate([], '20260907', 'Asia/Kuala_Lumpur', 30).ratio, 0);
});

test('isDailyStageFresh only skips a repeat of the same stage and date inside the window', () => {
  const twelveHours = 12 * 3_600_000;
  const primary = { stage: 'primary', targetDate: '20260907', generatedAt: at(0) };
  assert.equal(isDailyStageFresh(primary, 'primary', '20260907', T0 + minutes(300), twelveHours), true);
  assert.equal(isDailyStageFresh(primary, 'primary', '20260907', T0 + minutes(13 * 60), twelveHours), false);
  assert.equal(isDailyStageFresh(primary, 'primary', '20260908', T0 + minutes(10), twelveHours), false);
  assert.equal(isDailyStageFresh({ ...primary, stage: 'confirm' }, 'primary', '20260907', T0 + minutes(10), twelveHours), false);
  assert.equal(isDailyStageFresh({ targetDate: '20260907', generatedAt: at(0) }, 'confirm', '20260907', T0 + minutes(10), twelveHours), true);
  assert.equal(isDailyStageFresh(null, 'confirm', '20260907', T0, twelveHours), false);
});

/* evaluateDropRules no longer drives an alert -- add_to_cart_drop and
   begin_checkout_drop were retired on 2026-09-21. The function survives
   because scripts/ga4-diagnose.mjs replays it, so the idea can be re-priced
   against fresh data rather than re-argued, and these tests keep that replay
   honest. */
test('evaluateDropRules fires only on partial collapses with normal upstream volume', () => {
  const baseline = { page_view: 235, add_to_cart: 25, begin_checkout: 6 };
  const settings = { traffic_floor_ratio: 0.6, drop_ratio: 0.35, add_to_cart_min_median: 8, begin_checkout_min_median: 2, current_atc_min: 8 };

  const healthy = evaluateDropRules({ page_view: 215, add_to_cart: 17, begin_checkout: 19 }, baseline, settings);
  assert.deepEqual([healthy.add_to_cart_drop, healthy.begin_checkout_drop, healthy.trafficOk], [false, false, true]);

  const atcCollapsed = evaluateDropRules({ page_view: 220, add_to_cart: 6, begin_checkout: 2 }, baseline, settings);
  assert.equal(atcCollapsed.add_to_cart_drop, true);

  const trafficCollapsed = evaluateDropRules({ page_view: 60, add_to_cart: 3, begin_checkout: 1 }, baseline, settings);
  assert.equal(trafficCollapsed.add_to_cart_drop, false, 'a traffic drop is not an add-to-cart failure');
  assert.equal(trafficCollapsed.trafficOk, false);

  const zeroAtc = evaluateDropRules({ page_view: 220, add_to_cart: 0, begin_checkout: 0 }, baseline, settings);
  assert.equal(zeroAtc.add_to_cart_drop, false, 'zero stays with add_to_cart_zero');

  const checkoutCollapsed = evaluateDropRules({ page_view: 220, add_to_cart: 30, begin_checkout: 1 }, baseline, settings);
  assert.equal(checkoutCollapsed.begin_checkout_drop, true);
  assert.equal(checkoutCollapsed.baselineRatio, 0.24);
  assert.equal(checkoutCollapsed.currentRatio, 0.033);

  const fewAtc = evaluateDropRules({ page_view: 220, add_to_cart: 5, begin_checkout: 1 }, baseline, settings);
  assert.equal(fewAtc.begin_checkout_drop, false, 'below current_atc_min the ratio is too noisy');
  const zeroCheckout = evaluateDropRules({ page_view: 220, add_to_cart: 30, begin_checkout: 0 }, baseline, settings);
  assert.equal(zeroCheckout.begin_checkout_drop, false, 'zero stays with begin_checkout_zero');
  const thinBaseline = evaluateDropRules({ page_view: 220, add_to_cart: 30, begin_checkout: 1 }, { page_view: 235, add_to_cart: 25, begin_checkout: 1 }, settings);
  assert.equal(thinBaseline.begin_checkout_drop, false, 'baseline checkout median below the minimum');
});

/* ---------------------------------------------------------------- *
   The settled window: the rules read a 30-minute slot that has
   finished arriving, instead of runRealtimeReport's trailing half
   hour. Everything below pins the parts that used to be implicit.
 * ---------------------------------------------------------------- */

const TZ = 'Asia/Kuala_Lumpur';
const row = (stamp, event, count) => ({
  dimensionValues: [{ value: stamp }, { value: event }],
  metricValues: [{ value: String(count) }],
});
const medianOf = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

test('minuteToMs reads the wall clock in the property timezone', () => {
  // Malaysia is UTC+8 with no DST, so 13:00 local is 05:00 UTC.
  assert.equal(minuteToMs('202609211300', TZ), Date.parse('2026-09-21T05:00:00Z'));
  assert.ok(Number.isNaN(minuteToMs('2026092113', TZ)));
});

test('minuteToMs survives a DST boundary', () => {
  // London moves off BST at 02:00 on 2026-10-25. Both sides must land on
  // the instant they name, which a fixed offset would get an hour wrong.
  assert.equal(minuteToMs('202610250030', 'Europe/London'), Date.parse('2026-10-24T23:30:00Z'));
  assert.equal(minuteToMs('202610250330', 'Europe/London'), Date.parse('2026-10-25T03:30:00Z'));
});

test('propertyMinuteNow and minuteToMs are inverses', () => {
  const ms = Date.parse('2026-09-21T05:17:00Z');
  assert.equal(propertyMinuteNow(ms, TZ), '202609211317');
  assert.equal(minuteToMs(propertyMinuteNow(ms, TZ), TZ), ms);
});

test('settledWindow floors to a slot fully inside the settled zone', () => {
  const now = Date.parse('2026-09-21T06:47:00Z');
  const w = settledWindow(now, { timeZone: TZ });
  assert.equal(w.key, '202609211230');
  assert.equal(w.clock, '1230');
  assert.equal(w.endStamp, '202609211300');
  // Flooring to a slot boundary means the window END lands 90 to 119
  // minutes back and the START 120 to 149. That is the point of the 120:
  // the freshness probe found the 120-90 minute band complete and the
  // 90-60 band half filled, so 90 is the youngest edge worth judging.
  assert.ok((now - w.endMs) / 60_000 >= 90, 'nothing younger than the settled boundary');
  assert.ok((now - w.startMs) / 60_000 >= 120, 'the slot starts past the full lag');
});

test('the 19/49 cron reads each slot exactly once', () => {
  // The workflow runs at :19 and :49. With a 120-minute lag those land on
  // the :00 and :30 slots, so consecutive runs never re-read a slot and
  // never skip one -- which is what "two consecutive windows" depends on.
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const at = Date.parse('2026-09-21T06:19:00Z') + i * 30 * 60_000;
    seen.push(settledWindow(at, { timeZone: TZ }).key);
  }
  assert.deepEqual(seen, [
    '202609211200', '202609211230', '202609211300',
    '202609211330', '202609211400', '202609211430',
  ]);
});

test('settledWindow crosses midnight into the previous day', () => {
  // 01:05 local minus two hours is 23:05 the previous day.
  const w = settledWindow(Date.parse('2026-09-21T17:05:00Z'), { timeZone: TZ });
  assert.equal(w.key, '202609212300');
  assert.equal(w.endStamp, '202609212330');
  // And the last slot of the day has to roll the date forward on its end.
  const last = settledWindow(Date.parse('2026-09-21T17:35:00Z'), { timeZone: TZ });
  assert.equal(last.key, '202609212330');
  assert.equal(last.endStamp, '202609220000');
});

test('countsForWindow takes the slot and nothing either side of it', () => {
  const w = settledWindow(Date.parse('2026-09-21T06:47:00Z'), { timeZone: TZ });
  const report = { rows: [
    row('202609211229', 'add_to_cart', 99),   // one minute early
    row('202609211230', 'add_to_cart', 3),
    row('202609211245', 'add_to_cart', 4),
    row('202609211259', 'begin_checkout', 2),
    row('202609211300', 'add_to_cart', 99),   // the next slot
    row('202609201245', 'add_to_cart', 99),   // yesterday
  ] };
  assert.deepEqual(countsForWindow(report, w, ['add_to_cart', 'begin_checkout', 'purchase']), {
    add_to_cart: 7, begin_checkout: 2, purchase: 0,
  });
});

test('baselineForSlot takes the same clock slot on earlier days only', () => {
  const w = settledWindow(Date.parse('2026-09-21T06:47:00Z'), { timeZone: TZ });
  const report = { rows: [
    row('202609181235', 'begin_checkout', 2),
    row('202609191240', 'begin_checkout', 4),
    row('202609201230', 'begin_checkout', 6),
    row('202609201259', 'begin_checkout', 2),   // same day, same slot: sums to 8
    row('202609201330', 'begin_checkout', 99),  // different slot
    row('202609211245', 'begin_checkout', 99),  // the day under judgement
  ] };
  // Days are 2, 4, 8 -> median 4. Today is excluded, so a day can never be
  // its own baseline.
  assert.deepEqual(baselineForSlot(report, w, ['begin_checkout'], medianOf), { begin_checkout: 4 });
});

test('a slot with no rows counts as a real zero, not missing data', () => {
  const w = settledWindow(Date.parse('2026-09-21T06:47:00Z'), { timeZone: TZ });
  assert.deepEqual(countsForWindow({ rows: [] }, w, ['add_to_cart']), { add_to_cart: 0 });
  assert.deepEqual(countsForWindow({}, w, ['add_to_cart']), { add_to_cart: 0 });
});

test('a streak advances per slot, not per run', () => {
  const settings = { max_gap_minutes: 45, min_gap_minutes: 15, consecutive_zeros: 2 };
  const first = settledWindow(Date.parse('2026-09-21T06:19:00Z'), { timeZone: TZ });
  const second = settledWindow(Date.parse('2026-09-21T06:49:00Z'), { timeZone: TZ });
  assert.notEqual(first.key, second.key);

  const a = nextRuleState(null, true, Date.now(), settings, first);
  assert.equal(a.next.consecutive, 1);
  assert.equal(a.confirmed, false);

  // A retry, a manual dispatch or a late runner can read the same slot
  // twice. That is one observation, not two.
  const b = nextRuleState(a.next, true, Date.now(), settings, first);
  assert.equal(b.next.consecutive, 1);
  assert.equal(b.next.duplicate, true);
  assert.equal(b.confirmed, false);

  const c = nextRuleState(b.next, true, Date.now(), settings, second);
  assert.equal(c.next.consecutive, 2);
  assert.equal(c.confirmed, true);
});

test('a skipped slot restarts the streak', () => {
  const settings = { max_gap_minutes: 45, min_gap_minutes: 15, consecutive_zeros: 2 };
  const first = settledWindow(Date.parse('2026-09-21T06:19:00Z'), { timeZone: TZ });
  const third = settledWindow(Date.parse('2026-09-21T07:49:00Z'), { timeZone: TZ });
  const a = nextRuleState(null, true, Date.now(), settings, first);
  const b = nextRuleState(a.next, true, Date.now(), settings, third);
  assert.equal(b.next.coverageGap, true);
  assert.equal(b.next.consecutive, 1, 'an unobserved slot is not evidence of anything');
  assert.equal(b.confirmed, false);
});

test('without a window the run clock still decides, as it did before', () => {
  const settings = { max_gap_minutes: 45, min_gap_minutes: 15, consecutive_zeros: 2 };
  const t0 = Date.parse('2026-09-21T06:19:00Z');
  const a = nextRuleState(null, true, t0, settings);
  const b = nextRuleState(a.next, true, t0 + 30 * 60_000, settings);
  assert.equal(b.next.consecutive, 2);
  assert.equal(b.confirmed, true);
});

test('the retired deviation-band rules stay retired', async () => {
  /* The thresholds are still in the config so the diagnostic can re-price
     the idea against fresh data. That makes re-arming them a one-word edit,
     which is exactly why the mode is pinned here: turning them back on
     should mean replacing this test and its evidence, not flipping a
     string. Over 35 settled days add_to_cart_drop fired three times with
     purchases at or above the slot median through every one, and
     begin_checkout_drop fired zero times -- including on 2026-09-15. */
  const config = JSON.parse(await readFile(new URL('../config/alerts-config.json', import.meta.url), 'utf8'));
  const drop = config.ga4.realtime.drop;
  assert.equal(drop.mode, 'retired');
  assert.equal(drop.retired_since, '2026-09-21');
  assert.match(drop._retired, /35 settled days/);
  // purchase_tracking_gap still lives in this block and is not retired with them.
  assert.equal(drop.purchase_tracking_mode, 'observe');
});

/* ---------------------------------------------------------------- *
   The empty-window guard, from the 2026-09-24 false positive.
 * ---------------------------------------------------------------- */

const EVENTS = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
const zero = { page_view: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0 };
const busy = { page_view: 180, view_item: 128, add_to_cart: 12.5, begin_checkout: 3, purchase: 1 };

test('a window where every event is zero is missing data, not a dead store', () => {
  /* The exact 2026-09-24 numbers. The synthetic watch passed three times
     inside this window, the storefront was firing page_view, and an order
     was placed at 17:24 -- the data had simply not arrived. */
  assert.equal(isEmptyWindow(zero, busy, EVENTS, { storefrontHealthy: true, pageViewMinMedian: 10 }), true);
});

test('one event surviving means the data did arrive, so judge it', () => {
  // A storefront cannot stop its own page views. Anything above zero
  // anywhere means the pipeline delivered, and the rules should speak.
  for (const name of EVENTS) {
    const current = { ...zero, [name]: 1 };
    assert.equal(
      isEmptyWindow(current, busy, EVENTS, { storefrontHealthy: true }),
      false,
      `${name} > 0 must not be suppressed`,
    );
  }
});

test('a quiet night is not suppressed, because there is nothing to suppress', () => {
  // Without a baseline worth the name, zero is just 3am.
  const sleepy = { ...busy, page_view: 4 };
  assert.equal(isEmptyWindow(zero, sleepy, EVENTS, { storefrontHealthy: true, pageViewMinMedian: 10 }), false);
});

test('when Layer 1 is unhappy too, the zeros may be real and the rules still speak', () => {
  /* This is the one case where every-event-zero can genuinely mean the
     storefront died. Suppressing it would turn the guard into a way to
     hide a real outage. */
  assert.equal(isEmptyWindow(zero, busy, EVENTS, { storefrontHealthy: false }), false);
});

test('empty windows count per slot, not per run', () => {
  const first = { key: '202609241630' };
  const second = { key: '202609241700' };
  const a = nextEmptyState(null, first);
  assert.equal(a.consecutive, 1);
  // A re-read of the same slot is one observation.
  assert.equal(nextEmptyState(a, first).consecutive, 1);
  assert.equal(nextEmptyState(a, second).consecutive, 2);
});

/* ---------------------------------------------------------------- *
   Carrying the checkout probe's verdict into the Layer 4 alert.
 * ---------------------------------------------------------------- */

const WINDOW = settledWindow(Date.parse('2026-09-24T10:51:00Z'), { timeZone: TZ });

test('the line reports what the probe saw around the window, not what it sees now', () => {
  /* The real 2026-09-24 timing: the probe ran at 08:25, 08:45 and 09:06 UTC
     against a window of 08:30-09:00. Only one of those is strictly inside,
     which is why the range is padded by a probe interval — three runs saying
     the store was buyable is the whole case for that alert being false, and
     one is thin. */
  const log = { entries: [
    { at: WINDOW.startMs - 5 * 60_000, status: 'ok' },   // 08:25, just before
    { at: WINDOW.startMs + 15 * 60_000, status: 'ok' },  // 08:45, inside
    { at: WINDOW.endMs + 6 * 60_000, status: 'ok' },     // 09:06, just after
  ] };
  const line = watchVerdictLine(log, WINDOW, { nowMs: Date.parse('2026-09-24T10:51:00Z') });
  assert.match(line, /覆盖该时段跑了 3 次/);
  assert.match(line, /优先查 GA4 埋点/);
});

test('the padding is one probe interval, not an open door', () => {
  // A run an hour either side says nothing about this window and must not be
  // counted as if it did.
  const far = { entries: [
    { at: WINDOW.startMs - 60 * 60_000, status: 'broken' },
    { at: WINDOW.endMs + 60 * 60_000, status: 'broken' },
  ] };
  assert.match(watchVerdictLine(far, WINDOW, { nowMs: WINDOW.endMs + 65 * 60_000 }), /该时段前后没有记录/);

  // And the boundary itself: exactly padMinutes out is in, a minute more is
  // out. What matters is that the run outside the range never gets counted as
  // covering the window — which of the two "not covering" wordings comes back
  // depends on its age and is not the point here.
  const edge = { entries: [{ at: WINDOW.startMs - 20 * 60_000, status: 'ok' }] };
  assert.match(watchVerdictLine(edge, WINDOW, {}), /覆盖该时段/);
  const past = { entries: [{ at: WINDOW.startMs - 21 * 60_000, status: 'ok' }] };
  assert.doesNotMatch(watchVerdictLine(past, WINDOW, { nowMs: WINDOW.endMs }), /覆盖该时段/);
});

test('a probe that failed inside the window points the other way', () => {
  const log = { entries: [
    { at: WINDOW.startMs + 60_000, status: 'broken' },
    { at: WINDOW.startMs + 600_000, status: 'ok' },
  ] };
  assert.match(watchVerdictLine(log, WINDOW, {}), /1\/2 次走不完结账/);
});

test('probes that could not measure say so instead of vouching for the store', () => {
  const log = { entries: [
    { at: WINDOW.startMs + 60_000, status: 'unmeasured' },
    { at: WINDOW.startMs + 600_000, status: 'unmeasured' },
  ] };
  assert.match(watchVerdictLine(log, WINDOW, {}), /都没测准/);
});

test('with nothing inside the window, the nearest run is offered with its age attached', () => {
  const now = Date.parse('2026-09-24T10:51:00Z');
  const log = { entries: [{ at: now - 25 * 60_000, status: 'ok' }] };
  const line = watchVerdictLine(log, WINDOW, { nowMs: now });
  assert.match(line, /该时段前后没有记录/);
  assert.match(line, /25 分钟前/);
});

test('a stale probe is not allowed to pose as evidence', () => {
  const now = Date.parse('2026-09-24T10:51:00Z');
  const log = { entries: [{ at: now - 5 * 3_600_000, status: 'ok' }] };
  assert.match(watchVerdictLine(log, WINDOW, { nowMs: now }), /太旧，不作数/);
});

test('no log at all is stated plainly, never silently omitted', () => {
  // A missing probe must read as "we do not know", never as reassurance.
  assert.match(watchVerdictLine(null, WINDOW, {}), /没有记录/);
  assert.match(watchVerdictLine({ entries: [] }, WINDOW, {}), /没有记录/);
});

test('the probe line is only ever a line, never a gate', () => {
  /* Guards the contract rather than the text: watchVerdictLine returns a
     string in every case, so no code path can read it as permission to stay
     quiet. The order heartbeat follows the same rule for traffic. */
  const cases = [null, { entries: [] }, { entries: [{ at: WINDOW.startMs + 1, status: 'ok' }] }, { entries: [{ at: 0, status: 'broken' }] }];
  for (const log of cases) {
    const line = watchVerdictLine(log, WINDOW, { nowMs: Date.parse('2026-09-24T10:51:00Z') });
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0);
  }
});
