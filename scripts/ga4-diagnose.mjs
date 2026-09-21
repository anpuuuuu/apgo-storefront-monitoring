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
import { evaluateDropRules } from './ga4-anomaly-lib.mjs';
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
  dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENT_NAMES } } },
  limit: '250000',
});

if (dist.ok) {
  if (Number(dist.report.rowCount || 0) > (dist.report.rows || []).length) {
    console.log(`\n⚠ 分布查询被截断：${dist.report.rowCount} 行只拿到 ${(dist.report.rows || []).length} 行，下面的数字不完整。`);
  }
  /* Aligned 30-minute slots keyed YYYYMMDD-HHMM, so a slot can be compared
     with the same clock slot on other days the way the rule's baseline does. */
  const slots = new Map();
  for (const row of dist.report.rows || []) {
    const stamp = row.dimensionValues?.[0]?.value || '';
    if (stamp.length !== 12) continue;
    const half = Number(stamp.slice(10, 12)) < 30 ? '00' : '30';
    const key = `${stamp.slice(0, 8)}-${stamp.slice(8, 10)}${half}`;
    if (!slots.has(key)) slots.set(key, { page_view: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0 });
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
        ordered.push({ key, clock: `${String(hour).padStart(2, '0')}${half}`, ...(slots.get(key) || { page_view: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0 }) });
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

  /* ---------------------------------------------------------------- *
     The deviation-band rules run off the same pipeline, so moving the
     source to settled data moves them too. They were never replayed.
     Realtime under-reports the current window while the baseline is
     settled, which inflates every measured drop -- so the expectation
     is that settled data fires less. Expectations are not measurements.
   * ---------------------------------------------------------------- */
  const dropCfg = { ...settings, ...(settings.drop || {}) };
  const dropNeed = Number(settings.drop?.consecutive_windows) || 3;
  const dropVerdicts = ordered.map((slot) => {
    const history = (byClock.get(slot.clock) || []).filter((other) => other.key < slot.key).slice(-28);
    if (history.length < 4) return null;
    const base = {
      page_view: medianOf(history.map((other) => other.page_view)),
      add_to_cart: medianOf(history.map((other) => other.add_to_cart)),
      begin_checkout: medianOf(history.map((other) => other.begin_checkout)),
    };
    return { slot, base, verdict: evaluateDropRules(slot, base, dropCfg) };
  });

  console.log(`\n=== 降幅规则在已结算数据上会响几次（${days.length} 天）===`);
  console.log(`  门槛：流量 ≥ 基线 ${dropCfg.traffic_floor_ratio}、当前 ≤ 基线 ${dropCfg.drop_ratio}；连续 ${dropNeed} 个窗口`);
  for (const rule of ['add_to_cart_drop', 'begin_checkout_drop']) {
    let run = 0;
    const fired = [];
    let anyWindow = 0;
    for (const entry of dropVerdicts) {
      if (entry === null) { run = 0; continue; }
      const hit = entry.verdict[rule];
      if (hit) anyWindow += 1;
      run = hit ? run + 1 : 0;
      if (run === dropNeed) fired.push(entry);
    }
    const perDay = fired.length / (days.length || 1);
    console.log(`\n  ${rule}: 单窗口命中 ${anyWindow} 次，连续 ${dropNeed} 窗触发 ${fired.length} 次` +
      `（${perDay > 0 ? `每 ${(1 / perDay).toFixed(1)} 天一次` : '从未'}）`);
    for (const entry of fired.slice(0, 12)) {
      const { slot, base } = entry;
      console.log(`    ${slot.key}  浏览 ${slot.page_view}/${base.page_view}  加购 ${slot.add_to_cart}/${base.add_to_cart}  进结账 ${slot.begin_checkout}/${base.begin_checkout}`);
    }
  }
  /* Deliberately not "everything else is a false positive": the owner
     confirmed 9/16-9/18, nothing more. Silence is not confirmation, and
     assuming it is, is how a real incident gets filed as noise. */
  console.log('\n  9/15 是免运费真事故。老板只确认过 9/16–9/18 正常；别的日期要问过他才算误报，');
  console.log('  没人报修不等于当时没事。');

  /* ---------------------------------------------------------------- *
     Did the firings cost anything?

     The owner cannot say whether 9/2, 9/5 or 9/7 had a store-side
     change, which is fair -- nobody remembers a Tuesday evening three
     weeks on. So stop asking and read the till. A window where
     add_to_cart looks broken but purchases arrive at their usual rate
     did not cost money, whatever the rule thought. A window where
     purchases stopped is worth a phone call even now.

     Printed with the two windows either side, because a dip that
     recovers on its own reads completely differently from a dip that
     is the start of something.
   * ---------------------------------------------------------------- */
  const indexOf = new Map(ordered.map((slot, i) => [slot.key, i]));
  const ratio = (cur, base) => (base > 0 ? `${Math.round((100 * cur) / base)}%` : cur > 0 ? '新' : '-');
  const baselineAt = (slot) => {
    const history = (byClock.get(slot.clock) || []).filter((other) => other.key < slot.key).slice(-28);
    return {
      view_item: medianOf(history.map((o) => o.view_item)),
      add_to_cart: medianOf(history.map((o) => o.add_to_cart)),
      begin_checkout: medianOf(history.map((o) => o.begin_checkout)),
      purchase: medianOf(history.map((o) => o.purchase)),
    };
  };

  const interesting = new Map();
  for (const rule of ['add_to_cart_drop', 'begin_checkout_drop']) {
    let run = 0;
    for (const entry of dropVerdicts) {
      if (entry === null) { run = 0; continue; }
      run = entry.verdict[rule] ? run + 1 : 0;
      if (run === dropNeed) interesting.set(entry.slot.key, rule);
    }
  }
  // The one confirmed incident, as the control: whatever the rules do on a
  // real failure is the bar the false alarms have to be judged against.
  for (const slot of ordered) {
    if (slot.key.startsWith('20260915') && (slot.clock === '0030' || slot.clock === '0700')) {
      interesting.set(slot.key, '9/15 真事故');
    }
  }

  if (interesting.size) {
    console.log('\n=== 每次触发当下，钱有没有照常进来 ===');
    console.log('   (括号里是同时段中位数的百分比；成交才是唯一能证伪的那一栏)');
    for (const [key, label] of interesting) {
      const at = indexOf.get(key);
      if (at === undefined) continue;
      console.log(`\n  ${key}  [${label}]`);
      console.log('    时段        商品页        加购          进结账        成交');
      for (let i = Math.max(0, at - dropNeed - 1); i <= Math.min(ordered.length - 1, at + 2); i += 1) {
        const slot = ordered[i];
        const base = baselineAt(slot);
        const mark = i === at ? '►' : ' ';
        const cell = (cur, b) => `${String(cur).padStart(3)}/${String(b).padStart(5)} ${ratio(cur, b).padStart(5)}`;
        console.log(`   ${mark}${slot.clock}  ${cell(slot.view_item, base.view_item)}  ${cell(slot.add_to_cart, base.add_to_cart)}  ${cell(slot.begin_checkout, base.begin_checkout)}  ${cell(slot.purchase, base.purchase)}`);
      }
    }
    console.log('\n  读法：成交那栏接近 100% → 店在卖，规则响的是噪音，不是故障。');
    console.log('        成交塌了 → 不管老板记不记得，那天确实丢过钱。');
  }


  /* How close is a quiet-but-healthy window to the line? A rule that
     only just fails to fire is a rule that will fire next week. */
  const margins = dropVerdicts
    .filter((entry) => entry && entry.verdict.trafficOk && entry.base.add_to_cart >= dropCfg.add_to_cart_min_median && entry.slot.add_to_cart > 0)
    .map((entry) => entry.slot.add_to_cart / (dropCfg.drop_ratio * entry.base.add_to_cart));
  margins.sort((a, b) => a - b);
  if (margins.length) {
    const at = (q) => margins[Math.min(margins.length - 1, Math.floor(q * margins.length))];
    console.log(`\n  add_to_cart 离触发线有多近（1.0 = 正好触发，越小越危险，${margins.length} 个窗口）：`);
    console.log(`    最小 ${at(0).toFixed(2)}  p5 ${at(0.05).toFixed(2)}  p25 ${at(0.25).toFixed(2)}  中位 ${at(0.5).toFixed(2)}`);
    console.log(`    贴着线（1.0–1.3）的窗口有 ${margins.filter((m) => m >= 1 && m <= 1.3).length} 个。`);
  }

}

console.log('\n（只读：未写 D1、未发 Telegram、未更新心跳）');
