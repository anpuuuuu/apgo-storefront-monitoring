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


/* ------------------------------------------------------------------ *
   3. How often does begin_checkout hit zero on its own?

   begin_checkout_zero fires when a 30-minute window holds no checkouts,
   twice running, while add_to_cart is healthy. The baseline for that window
   is about 2.5 checkouts. If checkouts arrive independently, a window of
   zero is ordinary: at a rate of 2.5 the chance is about 8%, and two in a
   row about 0.7%. Running roughly 51 times a day that is one firing every
   three days by luck alone, which is exactly the observed false-alarm rate
   on 2026-09-16 to 09-18, three days the owner confirms were healthy.

   Rather than trust that arithmetic, replay the real rule over settled data
   and count what each "consecutive windows" setting would have cost.
 * ------------------------------------------------------------------ */

const DIST_DAYS = Number(process.env.DIAGNOSE_DIST_DAYS || 35);
const dist = await attempt('runReport(funnel by minute)', 'runReport', {
  dateRanges: [{ startDate: `${DIST_DAYS}daysAgo`, endDate: 'yesterday' }],
  dimensions: [{ name: 'dateHourMinute' }, { name: 'eventName' }],
  metrics: [{ name: 'eventCount' }],
  dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['add_to_cart', 'begin_checkout'] } } },
  limit: '200000',
});

if (dist.ok) {
  /* Aligned 30-minute slots keyed YYYYMMDD-HHMM, so a slot can be compared
     with the same clock slot on other days the way the rule's baseline does. */
  const slots = new Map();
  for (const row of dist.report.rows || []) {
    const stamp = row.dimensionValues?.[0]?.value || '';
    if (stamp.length !== 12) continue;
    const half = Number(stamp.slice(10, 12)) < 30 ? '00' : '30';
    const key = `${stamp.slice(0, 8)}-${stamp.slice(8, 10)}${half}`;
    if (!slots.has(key)) slots.set(key, { add_to_cart: 0, begin_checkout: 0 });
    const event = row.dimensionValues?.[1]?.value;
    if (event in slots.get(key)) slots.get(key)[event] += Number(row.metricValues?.[0]?.value || 0);
  }
  // Fill the gaps: a slot with no rows at all is a real zero, not missing data.
  const days = [...new Set([...slots.keys()].map((key) => key.slice(0, 8)))].sort();
  const ordered = [];
  for (const day of days) {
    for (let hour = 0; hour < 24; hour += 1) {
      for (const half of ['00', '30']) {
        const key = `${day}-${String(hour).padStart(2, '0')}${half}`;
        ordered.push({ key, clock: `${String(hour).padStart(2, '0')}${half}`, ...(slots.get(key) || { add_to_cart: 0, begin_checkout: 0 }) });
      }
    }
  }

  const checkouts = ordered.map((slot) => slot.begin_checkout);
  const zero = checkouts.filter((n) => n === 0).length;
  const mean = checkouts.reduce((sum, n) => sum + n, 0) / (checkouts.length || 1);
  console.log(`\n=== begin_checkout 每 30 分钟的分布（${days.length} 天，${ordered.length} 个窗口）===`);
  console.log(`  平均 ${mean.toFixed(2)} 次/窗口，其中 ${zero} 个窗口为 0（${(100 * zero / ordered.length).toFixed(1)}%）`);
  const histogram = new Map();
  for (const n of checkouts) histogram.set(Math.min(n, 8), (histogram.get(Math.min(n, 8)) || 0) + 1);
  for (const n of [...histogram.keys()].sort((a, b) => a - b)) {
    console.log(`   ${n === 8 ? '8+' : String(n).padStart(2)} 次: ${String(histogram.get(n)).padStart(4)}  ${'█'.repeat(Math.round(60 * histogram.get(n) / ordered.length))}`);
  }

  /* Replay the real rule. Baseline is the median of the same clock slot on the
     preceding days, exactly as baselineCounts does, and the gates are the
     configured ones. */
  const settings = config.ga4.realtime;
  const medianOf = (values) => {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const byClock = new Map();
  for (const slot of ordered) {
    if (!byClock.has(slot.clock)) byClock.set(slot.clock, []);
    byClock.get(slot.clock).push(slot);
  }
  const abnormal = ordered.map((slot, index) => {
    const history = (byClock.get(slot.clock) || []).filter((other) => other.key < slot.key).slice(-28);
    if (history.length < 4) return null;
    const baseline = medianOf(history.map((other) => other.begin_checkout));
    return slot.add_to_cart >= settings.begin_checkout_current_atc_min
      && baseline >= settings.begin_checkout_min_median
      && slot.begin_checkout === 0;
  });

  console.log(`\n=== begin_checkout_zero 要连续几个窗口才不像是碰巧 ===`);
  console.log(`  门槛：当前加购 ≥ ${settings.begin_checkout_current_atc_min}，基线结账 ≥ ${settings.begin_checkout_min_median}`);
  console.log('  连续窗口   会触发几次   平均多久一次');
  for (const need of [2, 3, 4, 5, 6]) {
    let run = 0;
    const hits = [];
    abnormal.forEach((value, index) => {
      if (value === null) { run = 0; return; }
      run = value ? run + 1 : 0;
      if (run === need) hits.push(ordered[index].key);
    });
    const perDay = hits.length / (days.length || 1);
    console.log(`      ${need}      ${String(hits.length).padStart(5)}      ${perDay > 0 ? `每 ${(1 / perDay).toFixed(1)} 天一次` : '从未'}   ${hits.join(' ')}`);
  }
  console.log('\n  这些天里店铺都是正常的，所以上面每一次触发都是误报。');
  console.log('  挑一个「平均多久一次」远长于你能容忍的频率的连续窗口数。');
}

console.log('\n（只读：未写 D1、未发 Telegram、未更新心跳）');
