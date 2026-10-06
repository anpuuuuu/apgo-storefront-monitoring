import { STORE, buildAlert, localTime } from '../workers/alert-format.mjs';

import { propertyMinuteNow } from './ga4-anomaly-lib.mjs';

export function reportDateForEvening(nowMs, timeZone) {
  // GitHub's daily cron has historically arrived several hours late. Treat a
  // run up to 06:00 the next morning as the 22:00 report it was meant to send.
  return propertyMinuteNow(nowMs - 6 * 60 * 60_000, timeZone).slice(0, 8);
}

export function eventCountsThrough(report, reportDate, cutoffStamp, eventNames) {
  const counts = Object.fromEntries(eventNames.map((name) => [name, 0]));
  for (const row of report?.rows || []) {
    const stamp = row.dimensionValues?.[0]?.value || '';
    const eventName = row.dimensionValues?.[1]?.value || '';
    if (!stamp.startsWith(reportDate) || stamp >= cutoffStamp || !(eventName in counts)) continue;
    counts[eventName] += Number(row.metricValues?.[0]?.value || 0);
  }
  return counts;
}

export function orderStatsForDate(log, reportDate, timeZone) {
  const entries = (Array.isArray(log?.entries) ? log.entries : [])
    .filter((entry) => propertyMinuteNow(Number(entry.at), timeZone).startsWith(reportDate));
  const all = Array.isArray(log?.entries) ? log.entries : [];
  const lastAt = all.length ? Math.max(...all.map((entry) => Number(entry.at)).filter(Number.isFinite)) : null;
  return { count: entries.length, lastAt: Number.isFinite(lastAt) ? lastAt : null };
}

export function summarizeHealth(payload) {
  const layers = (payload?.sites || []).flatMap((site) => (site.layers || []).map((row) => ({
    siteId: site.siteId,
    layer: row.layer,
    status: row.missing || row.stale ? 'delayed' : (row.status === 'ok' ? 'ok' : 'failed'),
    ageSeconds: Number.isFinite(Number(row.ageSeconds)) ? Number(row.ageSeconds) : null,
  })));
  return {
    layers,
    monitoringOperational: layers.length > 0 && layers.every((row) => row.status !== 'delayed'),
    checksPassing: layers.length > 0 && layers.every((row) => row.status === 'ok'),
  };
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : '数据不够';
}

const PART_NAMES = {
  layer1: '网站检查',
  layer2: '购物流程测试',
  layer3: '网页错误收集',
  layer4: '业务指标',
  watch: '结账探测',
};

/* Wording rules carried over from the first version, because they are what
   keep the report honest: a figure that could not be read is never shown as
   zero, an aggregate count says it never read customer details, and Layer 1
   being throttled by Shopify is the monitor being limited, not the site
   failing. */
export function formatAbandonedCount(abandoned, cutoffLabel) {
  if (!abandoned || abandoned.status === 'disabled') return null;
  if (abandoned?.status === 'ok') {
    const qualifier = abandoned.precision === 'EXACT' ? '' : '至少 ';
    return `弃单：到 ${cutoffLabel} 为止有 ${qualifier}${abandoned.count} 个还没付款（只读总数，不读顾客资料）`;
  }
  if (abandoned?.status === 'error') return '弃单：这次读取失败（不当作 0）';
  return '弃单：还没接上 Shopify 后台的数据';
}

export function formatLayer1ProbeSummary(probes) {
  if (probes === null) return '网站检查：汇总读取失败（不当作 0）';
  const homepage = probes?.homepage;
  const cart = probes?.['cart-api'];
  if (!homepage && !cart) return '网站检查：今天没有记录';
  const homepageText = homepage
    ? `首页 ${homepage.successes}/${homepage.samples} 次正常${homepage.throttles ? `（被 Shopify 限流 ${homepage.throttles} 次，是限制监控，不是网站坏了）` : ''}`
    : '首页没有记录';
  const cartText = cart ? `购物车 ${cart.successes}/${cart.samples} 次正常` : '购物车没有记录';
  return `网站检查：${homepageText}；${cartText}`;
}

/* The 22:00 report. It is a report, not an alarm, so it never rings: green
   when the day was clean, yellow when something deserves a look tomorrow.
   It used to ring every evening, which is exactly how a phone learns to be
   ignored. */
export function eveningSummaryAlert({ label, reportDate, cutoffLabel, counts, orders, health, completionState, abandoned, layer1Probes, timeZone, nowMs = Date.now() }) {
  const checkout = Number(counts.begin_checkout || 0);
  const purchase = Number(counts.purchase || 0);
  const completion = checkout > 0 ? purchase / checkout : Number.NaN;
  const failedParts = health.layers.filter((row) => row.status === 'failed').map((row) => PART_NAMES[row.layer] || row.layer);
  const latePart = health.layers.filter((row) => row.status === 'delayed').map((row) => PART_NAMES[row.layer] || row.layer);
  const healthy = health.monitoringOperational && health.checksPassing && !completionState?.active;
  const store = !health.checksPassing
    ? '有检查没通过'
    : completionState?.active
      ? '付款完成率偏低还在持续'
      : !health.monitoringOperational ? '店铺正常，部分监控晚了' : STORE.fine;
  const day = `${reportDate.slice(4, 6)}/${reportDate.slice(6, 8)}`;
  return buildAlert({
    level: healthy ? 'ok' : 'watch',
    title: `今天的店铺总结（${day}）`,
    site: label,
    store,
    action: healthy ? '不用处理' : '明天有空看一下',
    lines: [
      `订单：今天 ${orders.count} 单${Number.isFinite(orders.lastAt) ? `，最后一单 ${localTime(orders.lastAt, timeZone)}` : ''}。`,
      `购买：进结账 ${checkout} 次、付款成功 ${purchase} 次，完成率 ${percent(completion)}（GA4 的数据算到 ${cutoffLabel}）。`,
      formatAbandonedCount(abandoned, cutoffLabel),
      formatLayer1ProbeSummary(layer1Probes),
      `监控：${health.monitoringOperational ? '都在正常运行' : `${latePart.join('、') || '部分'}晚了`}；检查：${health.checksPassing ? '全部通过' : `没通过的有 ${failedParts.join('、') || '（读不到是哪一项）'}`}。`,
      completionState?.active ? '「付款完成率偏低」的提醒还在持续。' : '',
    ],
    atMs: nowMs,
    timeZone,
    details: health.layers.map((row) => `${row.layer}: ${row.status}${row.ageSeconds === null ? '' : ` (${Math.round(row.ageSeconds / 60)} min)`}`),
  });
}

export function formatEveningSummary(options) {
  return eveningSummaryAlert(options).text;
}
