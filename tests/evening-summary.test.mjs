import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventCountsThrough,
  formatEveningSummary,
  orderStatsForDate,
  reportDateForEvening,
  summarizeHealth,
} from '../scripts/evening-summary-lib.mjs';

const TZ = 'Asia/Kuala_Lumpur';

test('a delayed early-morning run still reports the intended previous evening', () => {
  assert.equal(reportDateForEvening(Date.parse('2026-10-04T14:00:00Z'), TZ), '20261004');
  assert.equal(reportDateForEvening(Date.parse('2026-10-04T20:30:00Z'), TZ), '20261004');
});

test('event counts stop at the settled cutoff', () => {
  const report = { rows: [
    { dimensionValues: [{ value: '202610041959' }, { value: 'begin_checkout' }], metricValues: [{ value: '12' }] },
    { dimensionValues: [{ value: '202610042000' }, { value: 'purchase' }], metricValues: [{ value: '9' }] },
    { dimensionValues: [{ value: '202610031959' }, { value: 'purchase' }], metricValues: [{ value: '99' }] },
  ] };
  assert.deepEqual(eventCountsThrough(report, '20261004', '202610042000', ['begin_checkout', 'purchase']), {
    begin_checkout: 12,
    purchase: 0,
  });
});

test('order and health summaries distinguish a running monitor from a failed check', () => {
  const log = { entries: [
    { at: Date.parse('2026-10-04T01:00:00Z') },
    { at: Date.parse('2026-10-03T01:00:00Z') },
  ] };
  assert.equal(orderStatsForDate(log, '20261004', TZ).count, 1);
  const health = summarizeHealth({ sites: [{ siteId: 'apgo-my', layers: [
    { layer: 'layer1', status: 'ok', stale: false, ageSeconds: 60 },
    { layer: 'layer2', status: 'error', stale: false, ageSeconds: 600 },
  ] }] });
  assert.equal(health.monitoringOperational, true);
  assert.equal(health.checksPassing, false);
  const text = formatEveningSummary({
    label: 'APGO MY', reportDate: '20261004', cutoffLabel: '20:00',
    counts: { begin_checkout: 20, purchase: 10 }, orders: { count: 10, lastAt: log.entries[0].at },
    health, completionState: { active: false }, timeZone: TZ,
  });
  assert.match(text, /监控自身：正常运行；检查结果：有失败项/);
  assert.match(text, /完成率 50%/);
  assert.match(text, /不是 Shopify 精确 abandoned checkout 名单/);
});
