import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventCountsThrough,
  formatAbandonedCount,
  formatEveningSummary,
  formatLayer1ProbeSummary,
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
  assert.match(formatAbandonedCount({ status: 'ok', count: 7, precision: 'EXACT' }, '20:00'), /有 7 个还没付款/);
  assert.match(formatAbandonedCount({ status: 'ok', count: 10_000, precision: 'AT_LEAST' }, '20:00'), /至少 10000 个/);
  assert.match(formatAbandonedCount({ status: 'not_configured' }, '20:00'), /还没接上/);
  // A figure that could not be read is never shown as zero.
  assert.match(formatAbandonedCount({ status: 'error' }, '20:00'), /读取失败.*不当作 0/);
});

test('Layer 1 throttling is reported in the 22:00 summary instead of a standalone alert', () => {
  assert.equal(formatLayer1ProbeSummary({
    homepage: { samples: 33, successes: 20, throttles: 13 },
    'cart-api': { samples: 73, successes: 73, throttles: 0 },
  }), '网站检查：首页 20/33 次正常（被 Shopify 限流 13 次，是限制监控，不是网站坏了）；购物车 73/73 次正常');
  assert.match(formatLayer1ProbeSummary(null), /读取失败.*不当作 0/);
});

test('the normal report omits the optional Shopify Admin line when it is disabled', () => {
  const text = formatEveningSummary({
    label: 'APGO MY', reportDate: '20261004', cutoffLabel: '20:00',
    counts: { begin_checkout: 20, purchase: 10 }, orders: { count: 10, lastAt: null },
    health: { monitoringOperational: true, checksPassing: true, layers: [] },
    completionState: { active: false }, abandoned: { status: 'disabled' }, timeZone: TZ,
  });
  assert.doesNotMatch(text, /弃单/);
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
  // A monitor that is running but reporting a failed check is a different
  // thing from a monitor that has stopped, and the report keeps them apart.
  assert.match(text, /监控：都在正常运行；检查：没通过的有 购物流程测试/);
  assert.match(text, /完成率 50%/);
  assert.match(text, /弃单：.*有 4 个还没付款.*不读顾客资料/);
  // A day with a failed check is yellow and silent; a report never rings.
  assert.match(text, /^🟡 今天的店铺总结（10\/04）/);
});

test('a clean day is green, and the report never rings', async () => {
  const { eveningSummaryAlert } = await import('../scripts/evening-summary-lib.mjs');
  const clean = eveningSummaryAlert({
    label: 'APGO MY', reportDate: '20261004', cutoffLabel: '20:00',
    counts: { begin_checkout: 20, purchase: 14 }, orders: { count: 40, lastAt: Date.parse('2026-10-04T13:30:00Z') },
    health: { monitoringOperational: true, checksPassing: true, layers: [] },
    completionState: { active: false }, abandoned: { status: 'disabled' }, timeZone: TZ,
  });
  assert.match(clean.text, /^✅ 今天的店铺总结（10\/04）\nAPGO MY · 店铺正常｜不用处理/);
  assert.equal(clean.silent, true);
});
