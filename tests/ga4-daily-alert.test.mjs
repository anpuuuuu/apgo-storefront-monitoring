import assert from 'node:assert/strict';
import test from 'node:test';

import { persistentDailyAnomalies, splitDailyAnomalies } from '../scripts/ga4-daily-alert-lib.mjs';

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
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/ga4-daily-funnel.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /issues\.push\(['"]revenue['"]\)/);
});
