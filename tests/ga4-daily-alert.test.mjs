import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { dailyIssues, persistentDailyAnomalies, splitDailyAnomalies } from '../scripts/ga4-daily-alert-lib.mjs';

const DAILY = JSON.parse(await readFile(new URL('../config/alerts-config.json', import.meta.url), 'utf8')).ga4.daily;
const counts = ([view_item, add_to_cart, begin_checkout, purchase]) => ({ view_item, add_to_cart, begin_checkout, purchase });
const steps = ([view_to_atc, atc_to_checkout, checkout_to_purchase]) => ({ view_to_atc, atc_to_checkout, checkout_to_purchase });

/* Every funnel flag the daily rule raised from 09-03 to 10-06, with the
   segment's real numbers from the D1 candidate summaries: today's views,
   add-to-carts, checkouts and purchases; the usual (same-weekday median) of
   each; the usual rate of each step; what the rule said then; what it says
   now. Days that flagged only revenue are left out: revenue is not a rule. */
const REPLAY = [
  ['09-04', 'device:desktop', [284, 21, 5, 0], [150.5, 54, 10, 4], [0.3792, 0.1662, 0.3818], ['view_to_atc'], ['view_to_atc']],
  ['09-07', 'device:desktop', [293, 70, 12, 2], [158.5, 21.5, 7.5, 4.5], [0.1373, 0.2045, 0.55], ['checkout_to_purchase'], []],
  ['09-07', 'product:laundry_products', [1259, 86, 42, 37], [1486.5, 221, 115, 49.5], [0.1435, 0.5618, 0.4054], ['view_to_atc'], ['view_to_atc']],
  ['09-11', 'device:desktop', [86, 36, 2, 1], [150.5, 37, 9, 3], [0.2669, 0.2053, 0.2818], ['atc_to_checkout'], ['atc_to_checkout']],
  ['09-14', 'product:laundry_products', [1202, 94, 62, 9], [1502, 152.5, 72.5, 42.5], [0.0942, 0.5618, 0.5361], ['checkout_to_purchase'], ['checkout_to_purchase']],
  ['09-15', 'country:Singapore', [359, 72, 10, 1], [1487, 196.5, 48, 10.5], [0.1169, 0.2453, 0.2233], ['checkout_to_purchase'], ['checkout_to_purchase']],
  ['09-15', 'device:tablet', [138, 23, 1, 0], [120, 17, 2, 0.5], [0.1184, 0.1357, 0.125], ['atc_to_checkout'], []],
  ['09-17', 'device:desktop', [148, 43, 5, 2], [99.5, 17.5, 4.5, 2.5], [0.1449, 0.2487, 0.4107], ['atc_to_checkout'], []],
  ['09-20', 'device:desktop', [117, 39, 2, 3], [106.5, 11, 6, 3], [0.131, 0.6283, 0.4857], ['atc_to_checkout'], []],
  ['09-20', 'product:laundry_products', [1446, 208, 48, 31], [1472.5, 224, 104.5, 38.5], [0.1524, 0.5161, 0.3451], ['atc_to_checkout'], ['atc_to_checkout']],
  ['09-21', 'product:other_products', [2619, 246, 181, 19], [4578.5, 683.5, 303.5, 78], [0.1318, 0.4938, 0.2492], ['checkout_to_purchase'], ['checkout_to_purchase']],
  ['09-22', 'country:Singapore', [273, 62, 16, 0], [1174, 159, 42.5, 10.5], [0.1438, 0.2237, 0.2233], ['checkout_to_purchase'], ['checkout_to_purchase']],
  ['09-23', 'country:Singapore', [84, 44, 2, 0], [1201, 157.5, 34, 7.5], [0.1308, 0.2171, 0.2184], ['atc_to_checkout'], ['atc_to_checkout']],
  ['09-25', 'product:laundry_products', [1097, 211, 123, 27], [1447.5, 217, 96.5, 53], [0.1585, 0.4388, 0.5463], ['checkout_to_purchase'], ['checkout_to_purchase']],
  ['09-29', 'device:desktop', [132, 41, 2, 0], [110, 11.5, 5, 2], [0.1133, 0.375, 0.4375], ['atc_to_checkout'], []],
  ['10-02', 'device:desktop', [149, 39, 22, 2], [135.5, 21.5, 4, 1], [0.1017, 0.2327, 0.2667], ['checkout_to_purchase'], []],
  ['10-06', 'device:desktop', [261, 111, 13, 3], [134, 34.5, 5, 3], [0.2078, 0.2554, 0.5], ['atc_to_checkout', 'checkout_to_purchase'], []],
];

test('replaying every past flag: small segments and held counts drop out, real losses stay', () => {
  for (const [date, label, today, usual, usualRates, was, now] of REPLAY) {
    const issues = dailyIssues(counts(today), { ...counts(usual), ...steps(usualRates) }, DAILY);
    assert.deepEqual(issues, now, `${date} ${label}`);
    assert.ok(issues.every((issue) => was.includes(issue)), `${date} ${label} gained a flag`);
  }
  const flags = (column) => REPLAY.reduce((sum, row) => sum + row[column].length, 0);
  assert.equal(flags(5), 18);
  assert.equal(flags(6), 10);
});

test('a segment that is normally small is not judged, even on a day it is big enough', () => {
  // 09-07 desktop: purchases did fall, 2 against a usual 4.5, but a usual
  // rate built on 7.5 checkouts a day is noise.
  const usual = { ...counts([158.5, 21.5, 7.5, 4.5]), ...steps([0.1373, 0.2045, 0.55]) };
  assert.deepEqual(dailyIssues(counts([293, 70, 12, 2]), usual, DAILY), []);
  assert.deepEqual(dailyIssues(counts([293, 70, 12, 2]), { ...usual, begin_checkout: DAILY.checkout_min }, DAILY), ['checkout_to_purchase']);
});

test('a rate that falls while the count holds is more visitors, not a failure', () => {
  // 10-06 desktop: 111 add-to-carts and 13 checkouts against a usual 34.5
  // and 5. The add-to-cart → checkout rate halved, yet checkouts more than
  // doubled. Had checkouts dropped below usual, the same rate would count.
  const usual = { ...counts([134, 34.5, 5, 3]), ...steps([0.2078, 0.2554, 0.5]) };
  assert.deepEqual(dailyIssues(counts([261, 111, 13, 3]), usual, DAILY), []);
  assert.deepEqual(dailyIssues(counts([261, 111, 4, 3]), usual, DAILY), ['atc_to_checkout']);
});

test('checkout conversion can be armed independently of other observed issues', () => {
  const anomaly = {
    label: 'device:desktop',
    issues: ['checkout_to_purchase', 'atc_to_checkout'],
    current: { begin_checkout: 22, purchase: 2 },
    baseline: { checkout_to_purchase: 0.26 },
  };
  const split = splitDailyAnomalies([anomaly], {
    defaultMode: 'observe',
    issueModes: { checkout_to_purchase: 'armed' },
  });
  assert.deepEqual(split.armed[0].issues, ['checkout_to_purchase']);
  assert.deepEqual(split.observed[0].issues, ['atc_to_checkout']);
  assert.deepEqual(split.armed[0].current, anomaly.current);
});

test('the default mode remains backwards-compatible when no issue override exists', () => {
  const anomalies = [{ label: 'all', issues: ['view_to_atc'] }];
  assert.equal(splitDailyAnomalies(anomalies, { defaultMode: 'observe' }).observed.length, 1);
  assert.equal(splitDailyAnomalies(anomalies, { defaultMode: 'armed' }).armed.length, 1);
});

test('confirmation must repeat the same issue, not merely another issue on the same segment', () => {
  const primary = [{ label: 'device:desktop', issues: ['checkout_to_purchase', 'atc_to_checkout'] }];
  const confirmation = [{ label: 'device:desktop', issues: ['atc_to_checkout'] }];
  assert.deepEqual(persistentDailyAnomalies(primary, confirmation), [
    { label: 'device:desktop', issues: ['atc_to_checkout'] },
  ]);
});

test('daily funnel keeps absolute revenue out of anomaly generation', async () => {
  const source = await readFile(new URL('../scripts/ga4-daily-funnel.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /issues\.push\(['"]revenue['"]\)/);
});
