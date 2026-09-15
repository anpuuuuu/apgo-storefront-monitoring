import {
  config,
  ga,
  getState,
  setState,
  logAlert,
  heartbeat,
  median,
  requireEnv,
  telegram,
  workerHealthy,
} from './monitor-lib.mjs';
import { appendCoverage, evaluateDropRules, nextRuleState, shouldRecordAlert } from './ga4-anomaly-lib.mjs';

const validateOnly = process.env.VALIDATE_GA4 === 'true';
requireEnv({ needsD1: !validateOnly });

const EVENT_NAMES = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
const settings = config.ga4.realtime;
/* Realtime and daily checks arm independently: realtime zero-detection was
   reviewed and armed on 2026-09-03 (14-day observe: 1 plausible true event,
   2 night-window false positives removed by the min-median bump); the daily
   funnel stays in observe until the GA4 purchase-revenue gap is resolved.
   Falls back to the shared ga4.mode. */
const mode = settings.mode || config.ga4.mode;
const simulated = process.env.SIMULATE_ZERO === 'true';

function eventFilter() {
  return {
    filter: {
      fieldName: 'eventName',
      inListFilter: { values: EVENT_NAMES },
    },
  };
}

function realtimeCounts(report) {
  const counts = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0]));
  for (const row of report.rows || []) {
    counts[row.dimensionValues?.[0]?.value] = Number(row.metricValues?.[0]?.value || 0);
  }
  return counts;
}

function baselineCounts(report) {
  const nowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.ga4.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hour = nowParts.find((part) => part.type === 'hour').value;
  const minute = Number(nowParts.find((part) => part.type === 'minute').value);
  const half = minute < 30 ? 0 : 30;
  const byDate = new Map();

  for (const row of report.rows || []) {
    const timestamp = row.dimensionValues?.[0]?.value || '';
    const eventName = row.dimensionValues?.[1]?.value || '';
    if (timestamp.slice(8, 10) !== hour) continue;
    const sampleMinute = Number(timestamp.slice(10, 12));
    if (sampleMinute < half || sampleMinute >= half + 30) continue;
    const date = timestamp.slice(0, 8);
    if (!byDate.has(date)) byDate.set(date, Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])));
    byDate.get(date)[eventName] += Number(row.metricValues?.[0]?.value || 0);
  }

  return Object.fromEntries(EVENT_NAMES.map((eventName) => [
    eventName,
    median([...byDate.values()].map((sample) => sample[eventName] || 0)),
  ]));
}

/* Deviation-band rules arm separately from the zero rules: they start in
   observe (would_alert only) and are promoted after their own review, the
   same path the zero rules took. */
const dropSettings = settings.drop || {};
const dropMode = dropSettings.mode || 'observe';

const RULE_TEXT = {
  ga4_collection_zero: 'GA4 完全收不到流量事件（网站巡检正常 → 大概率是 GA4 采集断了,广告数据正在缺失）',
  add_to_cart_zero: '「加入购物车」连续为 0（① 加购坏了→对照第1/2层巡检 ② GA4 采集断了）',
  begin_checkout_zero: '有人加购但「进入结账」连续为 0（结账入口可能坏了,建议手机实测走一遍结账）',
  add_to_cart_drop: '流量正常但「加入购物车」塌到平时的 35% 以下（加购按钮/选项可能坏了 → 对照第1/2层巡检）',
  begin_checkout_drop: '加购正常但「进入结账」比例塌到平时的 35% 以下（结账入口可能坏了 → 手机实测走一遍结账）',
  purchase_tracking_gap: 'Shopify 刚收到订单但 GA4 连续两个窗口收不到 purchase（生意没坏，是结账追踪断了 → 检查 Web Pixel / GA4 结账事件）',
};

/* Deviation-band rules confirm over more windows than the zero rules: three
   days of full-coverage observe showed two begin_checkout_drop windows that
   healed on the very next sample; a third adjacent window would have caught
   neither. */
const dropRuleSettings = { ...settings, consecutive_zeros: Number(dropSettings.consecutive_windows) || settings.consecutive_zeros };
// Orders from POS, draft orders and other untracked channels can legitimately
// have no GA4 purchase, so the tracking cross-check arms on its own switch.
const purchaseTrackingMode = dropSettings.purchase_tracking_mode || dropMode;

async function updateRule(rule, abnormal, detail, ruleMode = mode, ruleSettings = settings) {
  const key = `ga4:realtime:${rule}`;
  const previous = await getState(key) || { consecutive: 0, active: false, lastAlertedAt: 0 };
  const { next, confirmed } = nextRuleState(previous, abnormal, Date.now(), ruleSettings);
  next.detail = detail;
  const shouldRecord = shouldRecordAlert(previous, confirmed, Date.now(), settings.realert_hours);

  if (shouldRecord) {
    next.active = true;
    next.lastAlertedAt = Date.now();
    const kind = ruleMode === 'armed' ? 'business_alert' : 'would_alert';
    await logAlert('layer4', kind, { rule, mode: ruleMode, ...detail });
    if (ruleMode === 'armed') {
      const ruleText = RULE_TEXT[rule] || rule;
      await telegram(`🟡 [第4层·业务指标] ${ruleText}\n当前: ${JSON.stringify(detail.current)} / 平时同时段中位数: ${JSON.stringify(detail.baseline)}\n${process.env.RUN_URL || ''}`);
    }
  }

  if (!abnormal && previous.active) await logAlert('layer4', 'recovery', { rule, ...detail });
  await setState(key, next);
  return {
    rule, abnormal, confirmed, consecutive: next.consecutive, recorded: shouldRecord, mode: ruleMode,
    gapMinutes: next.gapMinutes, coverageGap: next.coverageGap, duplicate: next.duplicate,
  };
}

const [realtime, historical, storefrontHealthy] = await Promise.all([
  ga('runRealtimeReport', {
    minuteRanges: [{ name: 'last30', startMinutesAgo: 29, endMinutesAgo: 0 }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: eventFilter(),
  }),
  ga('runReport', {
    dateRanges: [{ startDate: `${config.ga4.baseline_days}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'dateHourMinute' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: eventFilter(),
    limit: '100000',
  }),
  workerHealthy(),
]);

const current = realtimeCounts(realtime);
if (simulated) current.add_to_cart = 0;
const baseline = baselineCounts(historical);

if (validateOnly) {
  console.log(JSON.stringify({ mode: 'validate', current, baseline, storefrontHealthy }, null, 2));
  await heartbeat('layer4', { mode: 'validate', current, baseline });
  process.exit(0);
}

const results = [];
results.push(await updateRule(
  'ga4_collection_zero',
  storefrontHealthy && baseline.page_view >= settings.page_view_min_median && current.page_view === 0,
  { current: { page_view: current.page_view }, baseline: { page_view: baseline.page_view }, storefrontHealthy }
));
results.push(await updateRule(
  'add_to_cart_zero',
  baseline.add_to_cart >= settings.add_to_cart_min_median && current.add_to_cart === 0,
  { current: { add_to_cart: current.add_to_cart }, baseline: { add_to_cart: baseline.add_to_cart } }
));
results.push(await updateRule(
  'begin_checkout_zero',
  current.add_to_cart >= settings.begin_checkout_current_atc_min
    && baseline.begin_checkout >= settings.begin_checkout_min_median
    && current.begin_checkout === 0,
  { current: { add_to_cart: current.add_to_cart, begin_checkout: current.begin_checkout }, baseline: { begin_checkout: baseline.begin_checkout } }
));

// Partial failures the zero rules cannot see: traffic is normal but ATC
// collapsed, or ATC is normal but the checkout ratio collapsed. Disjoint
// from the zero rules (current must be > 0) so an armed zero rule and an
// armed drop rule never page twice for the same window.
const drop = evaluateDropRules(current, baseline, dropSettings);
results.push(await updateRule(
  'add_to_cart_drop',
  drop.add_to_cart_drop,
  { current: { page_view: current.page_view, add_to_cart: current.add_to_cart }, baseline: { page_view: baseline.page_view, add_to_cart: baseline.add_to_cart }, trafficOk: drop.trafficOk },
  dropMode,
  dropRuleSettings,
));
results.push(await updateRule(
  'begin_checkout_drop',
  drop.begin_checkout_drop,
  {
    current: { add_to_cart: current.add_to_cart, begin_checkout: current.begin_checkout, checkout_ratio: drop.currentRatio },
    baseline: { add_to_cart: baseline.add_to_cart, begin_checkout: baseline.begin_checkout, checkout_ratio: drop.baselineRatio },
  },
  dropMode,
  dropRuleSettings,
));

// Cross-check against the Worker's Shopify order heartbeat: an order placed
// inside this window that GA4 did not see as a purchase is a tracking gap,
// not a business problem. Only evaluated when the Worker checked recently,
// so a stale orders:last cannot fabricate a gap.
const lastOrder = await getState('orders:last');
const orderCheckAgeMin = lastOrder?.checkedAt ? (Date.now() - Date.parse(lastOrder.checkedAt)) / 60_000 : null;
const lastOrderAgeMin = lastOrder?.createdAt ? (Date.now() - Date.parse(lastOrder.createdAt)) / 60_000 : null;
const orderCheckFresh = orderCheckAgeMin !== null && orderCheckAgeMin <= Number(dropSettings.purchase_tracking_check_max_age_minutes || 20);
results.push(await updateRule(
  'purchase_tracking_gap',
  orderCheckFresh
    && lastOrderAgeMin !== null
    && lastOrderAgeMin <= Number(dropSettings.purchase_tracking_order_minutes || 25)
    && baseline.purchase >= 1
    && current.purchase === 0,
  {
    current: { purchase: current.purchase, last_shopify_order_minutes: lastOrderAgeMin === null ? null : Math.round(lastOrderAgeMin) },
    baseline: { purchase: baseline.purchase },
    orderCheckFresh,
  },
  purchaseTrackingMode,
  dropRuleSettings,
));

// Rolling log of observed windows so the daily report can state how much of
// the day realtime actually watched (REALTIME_COVERAGE_LOW below 80%).
const coverageState = await getState('ga4:realtime:coverage');
await setState('ga4:realtime:coverage', { checkedAt: appendCoverage(coverageState?.checkedAt, new Date().toISOString()) });

await heartbeat('layer4', { kind: 'realtime', mode, current, baseline, results });
console.log(JSON.stringify({ ok: true, kind: 'realtime', mode, current, baseline, storefrontHealthy, results }, null, 2));
