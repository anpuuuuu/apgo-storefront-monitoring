import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendCoverage,
  coverageForDate,
  isDailyStageFresh,
  nextRuleState,
  shouldRecordAlert,
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

test('shouldRecordAlert respects the realert window', () => {
  assert.equal(shouldRecordAlert({ active: false }, false, T0, 6), false);
  assert.equal(shouldRecordAlert({ active: false }, true, T0, 6), true);
  assert.equal(shouldRecordAlert({ active: true, lastAlertedAt: T0 - minutes(60) }, true, T0, 6), false);
  assert.equal(shouldRecordAlert({ active: true, lastAlertedAt: T0 - minutes(7 * 60) }, true, T0, 6), true);
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
