#!/usr/bin/env node
/* Read-only GA4 diagnostic. Answers the two questions the alert-accuracy work
   is blocked on, and writes nothing: no D1, no heartbeat, no Telegram.

   1. Is the realtime window the rules read still filling up?

      scripts/ga4-anomaly.mjs compares `current`, from runRealtimeReport over
      the trailing 30 minutes, against `baseline`, from runReport over 28
      settled days. On 2026-09-16 traffic was flat (page_view 74-126) while
      add_to_cart swung 2 → 19 and begin_checkout 0 → 5 across consecutive
      windows, and an armed rule paged on a storefront the owner confirms was
      fine. Late-arriving events are the obvious explanation: begin_checkout
      happens later in a session than add_to_cart, so a trailing window cuts it
      harder, which biases the comparison towards firing.

      The realtime API cannot look back further than 29 minutes, so moving the
      window means moving to runReport. This prints what runReport says about
      six equal windows of today, oldest first. If the newest is systematically
      thinner than the settled ones while traffic is comparable, the data is
      still arriving and the window has to move back.

   2. What does Shopify put in GA4 item_id?

      The investigator matches realtime screen titles to product titles, which
      returned zero rows on its first real firing. Item-scoped dimensions name
      the products directly. If item_id carries something that maps to
      /products.json, the title matching can be deleted outright.

   Usage: mode `diagnose-ga4` in monitor-alerts.yml, or run directly with the
   same GA4 environment the other Layer 4 scripts use. */
import { config, ga } from './monitor-lib.mjs';
import { EVENT_NAMES, WINDOWS, bucketByWindow, minutesAgo, propertyMinuteNow } from './ga4-diagnose-lib.mjs';

const timeZone = config.ga4.timezone;
const nowMs = Date.now();
const pad = (value, width) => String(value).padStart(width);

function eventFilter() {
  return { filter: { fieldName: 'eventName', inListFilter: { values: EVENT_NAMES } } };
}

async function attempt(label, method, body) {
  try {
    return { ok: true, report: await ga(method, body) };
  } catch (error) {
    console.log(`${label}: FAILED ${String(error?.message || error).slice(0, 300)}`);
    return { ok: false, report: null };
  }
}

console.log(`\n=== GA4 诊断 · property timezone ${timeZone} · 现在 ${propertyMinuteNow(nowMs, timeZone)} ===`);

const realtime = await attempt('realtime', 'runRealtimeReport', {
  minuteRanges: [{ name: 'last30', startMinutesAgo: 29, endMinutesAgo: 0 }],
  dimensions: [{ name: 'eventName' }],
  metrics: [{ name: 'eventCount' }],
  dimensionFilter: eventFilter(),
});
if (realtime.ok) {
  const counts = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0]));
  for (const row of realtime.report.rows || []) {
    const name = row.dimensionValues?.[0]?.value;
    if (name in counts) counts[name] = Number(row.metricValues?.[0]?.value || 0);
  }
  console.log(`\n规则现在读的（realtime，最近 30 分钟）: ${EVENT_NAMES.map((name) => `${name}=${counts[name]}`).join('  ')}`);
}

const events = await attempt('runReport(dateHourMinute)', 'runReport', {
  dateRanges: [{ startDate: 'today', endDate: 'today' }],
  dimensions: [{ name: 'dateHourMinute' }, { name: 'eventName' }],
  metrics: [{ name: 'eventCount' }],
  dimensionFilter: eventFilter(),
  limit: '100000',
});
if (events.ok) {
  const totals = bucketByWindow(events.report.rows, nowMs, { timeZone });
  console.log('\n标准接口按窗口拆（同一份数据，越往下越新，每格都是 30 分钟）:');
  console.log(`${pad('分钟前', 12)} ${EVENT_NAMES.map((name) => pad(name, 15)).join(' ')}`);
  WINDOWS.forEach(([start, end], index) => {
    console.log(`${pad(`${start}-${end}`, 12)} ${EVENT_NAMES.map((name) => pad(totals[index][name], 15)).join(' ')}`);
  });
  console.log('\n判读：最新的 30-0 明显低于 60-30 而流量相当 → 标准接口对刚发生的数据也不全，窗口必须后移；');
  console.log('      两者相当 → 窗口后移可行，代价只有半小时的发现延迟。');
}

const itemsByMinute = await attempt('runReport(items by minute)', 'runReport', {
  dateRanges: [{ startDate: 'today', endDate: 'today' }],
  dimensions: [{ name: 'dateHourMinute' }, { name: 'itemName' }],
  metrics: [{ name: 'itemsAddedToCart' }],
  limit: '100000',
});
if (itemsByMinute.ok) {
  const rows = itemsByMinute.report.rows || [];
  const recent = new Map();
  for (const row of rows) {
    const age = minutesAgo(row.dimensionValues?.[0]?.value, nowMs, timeZone);
    if (!Number.isFinite(age) || age >= 90 || age < 0) continue;
    const key = `${age >= 30 ? '30-90' : '0-30'}|${row.dimensionValues?.[1]?.value || '(unset)'}`;
    recent.set(key, (recent.get(key) || 0) + Number(row.metricValues?.[0]?.value || 0));
  }
  console.log(`\n=== 最近 90 分钟被加购的商品（item 维度）=== 共 ${rows.length} 行`);
  const sorted = [...recent.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (!sorted.length) console.log('（这段时间没有加购）');
  for (const [key, count] of sorted) {
    const [bucket, name] = key.split('|');
    console.log(`  ${pad(`${bucket} 分钟前`, 14)} ${pad(count, 4)}  ${name}`);
  }
}

const itemIds = await attempt('runReport(itemId)', 'runReport', {
  dateRanges: [{ startDate: 'today', endDate: 'today' }],
  dimensions: [{ name: 'itemId' }, { name: 'itemName' }],
  metrics: [{ name: 'itemsAddedToCart' }],
  limit: '200',
});
if (itemIds.ok) {
  console.log('\n=== item_id 里是什么（决定调查员能否丢掉标题匹配）===');
  const rows = (itemIds.report.rows || [])
    .map((row) => ({
      id: row.dimensionValues?.[0]?.value || '(unset)',
      name: row.dimensionValues?.[1]?.value || '(unset)',
      count: Number(row.metricValues?.[0]?.value || 0),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  if (!rows.length) console.log('（今天没有加购）');
  for (const row of rows) console.log(`  ${pad(row.count, 4)}  item_id=${pad(row.id, 18)}  ${row.name}`);
  console.log('\n判读：item_id 若能对上 /products.json 的 product id 或 variant id，标题匹配整套可删。');
}

console.log('\n（只读：未写 D1、未发 Telegram、未更新心跳）');
