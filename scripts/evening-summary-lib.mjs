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
  return Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : '无足够数据';
}

function localClock(ms, timeZone) {
  if (!Number.isFinite(ms)) return '无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
}

export function formatAbandonedCount(abandoned, cutoffLabel) {
  if (!abandoned || abandoned.status === 'disabled') return null;
  if (abandoned?.status === 'ok') {
    const qualifier = abandoned.precision === 'EXACT' ? '' : '至少 ';
    return `Shopify abandoned（已结算至 ${cutoffLabel}）：未恢复 ${qualifier}${abandoned.count} 个（聚合计数，不读取顾客名单）`;
  }
  if (abandoned?.status === 'error') return 'Shopify abandoned：读取失败（不按 0 计算）';
  return 'Shopify abandoned：尚未接通只读 Admin API';
}

export function formatEveningSummary({ label, reportDate, cutoffLabel, counts, orders, health, completionState, abandoned, timeZone }) {
  const checkout = Number(counts.begin_checkout || 0);
  const purchase = Number(counts.purchase || 0);
  const completion = checkout > 0 ? purchase / checkout : Number.NaN;
  const notCompleted = Math.max(0, checkout - purchase);
  const layerText = health.layers.map((row) => {
    const icon = row.status === 'ok' ? '✅' : row.status === 'failed' ? '❌' : '⏱️';
    return `${icon} ${row.layer}`;
  }).join(' · ');
  const healthy = health.monitoringOperational && health.checksPassing && !completionState?.active;
  return [
    `${healthy ? '🟢' : '🟠'} [${label}][22:00 每日报告] ${reportDate.slice(0, 4)}-${reportDate.slice(4, 6)}-${reportDate.slice(6, 8)}`,
    `监控自身：${health.monitoringOperational ? '正常运行' : '有心跳延迟'}；检查结果：${health.checksPassing ? '全部通过' : '有失败项'}`,
    `分层：${layerText || '读不到健康状态'}`,
    `订单：今天 ${orders.count} 单；最后一单 ${localClock(orders.lastAt, timeZone)} ${timeZone}`,
    `GA4（已结算至 ${cutoffLabel}）：进入结账 ${checkout}，购买 ${purchase}，完成率 ${percent(completion)}`,
    `GA4 未完成估算：${notCompleted} 次（${percent(checkout > 0 ? notCompleted / checkout : Number.NaN)}）`,
    formatAbandonedCount(abandoned, cutoffLabel),
    `快速完成率规则：${completionState?.active ? '异常仍在持续' : '未触发'}`,
  ].filter(Boolean).join('\n');
}
