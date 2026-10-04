import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventCountsThrough,
  formatAbandonedCount,
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

test('Shopify abandoned reporting distinguishes counts, missing setup, and read failures', () => {
  assert.equal(formatAbandonedCount({ status: 'disabled' }, '20:00'), null);
  assert.match(formatAbandonedCount({ status: 'ok', count: 7, precision: 'EXACT' }, '20:00'), /未恢复 7 个/);
  assert.match(formatAbandonedCount({ status: 'ok', count: 10_000, precision: 'AT_LEAST' }, '20:00'), /至少 10000 个/);
  assert.match(formatAbandonedCount({ status: 'not_configured' }, '20:00'), /尚未接通/);
  assert.match(formatAbandonedCount({ status: 'error' }, '20:00'), /读取失败.*不按 0/);
});

test('the normal report omits the optional Shopify Admin line when it is disabled', () => {
  const text = formatEveningSummary({
    label: 'APGO MY', reportDate: '20261004', cutoffLabel: '20:00',
    counts: { begin_checkout: 20, purchase: 10 }, orders: { count: 10, lastAt: null },
    health: { monitoringOperational: true, checksPassing: true, layers: [] },
    completionState: { active: false }, abandoned: { status: 'disabled' }, timeZone: TZ,
  });
  assert.doesNotMatch(text, /Shopify abandoned/);
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
    health, completionState: { active: false }, abandoned: { status: 'ok', count: 4, precision: 'EXACT' }, timeZone: TZ,
  });
  assert.match(text, /监控自身：正常运行；检查结果：有失败项/);
  assert.match(text, /完成率 50%/);
  assert.match(text, /Shopify abandoned.*未恢复 4 个.*不读取顾客名单/);
});
