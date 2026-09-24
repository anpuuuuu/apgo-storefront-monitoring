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
import {
  appendCoverage,
  baselineForSlot,
  countsForWindow,
  durationText,
  isEmptyWindow,
  nextEmptyState,
  nextRuleState,
  settledWindow,
  shouldRecordAlert,
  topScreensForEvent,
  watchVerdictLine,
} from './ga4-anomaly-lib.mjs';
import { investigate } from './investigator.mjs';

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

/* The slot being judged, and the only clock this run cares about. Both sides
   of every comparison now come from one runReport over one hour-of-day, so
   current and baseline are the same measurement taken on different days. */
const window = settledWindow(Date.now(), {
  timeZone: config.ga4.timezone,
  lagMinutes: Number(settings.settled_lag_minutes) || 120,
  slotMinutes: Number(settings.window_minutes) || 30,
});

/* One query answers both sides, because the baseline only ever looks at the
   same hour of day. Without the hour filter this is 28 days x 1440 minutes x 5
   events and brushes the row cap, at which point GA4 truncates and the
   baseline quietly loses its most recent days; with it the answer is a few
   thousand rows. rowCount is checked below anyway. */
function funnelQuery() {
  return {
    dateRanges: [{ startDate: `${config.ga4.baseline_days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'dateHourMinute' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          eventFilter(),
          { filter: { fieldName: 'hour', stringFilter: { value: window.clock.slice(0, 2) } } },
        ],
      },
    },
    limit: '100000',
  };
}

/* What is left of the old deviation-band block: the purchase tracking
   cross-check, which arms on its own switch. The band rules it used to sit
   beside were retired on 2026-09-21; see the note above the rule list. */
const dropSettings = settings.drop || {};

/* What to check first. Store-side changes (shipping, discounts, stock,
   checkout settings, app/theme updates) cause most real hits; the 2026-09-15
   checkout incident was a free-shipping rule switched off by mistake. */
const RULE_ADVICE = {
  ga4_collection_zero: '先查：GA4 / Web Pixel 设置最近有没有改；主题或 app 有没有更新',
  add_to_cart_zero: '先查：广告商品的变体 / 库存 / 加购按钮；主题或 app 有没有更新',
  begin_checkout_zero: '先查：广告商品的运费（free shipping）、折扣、库存、结账设置最近有没有改',
  purchase_tracking_gap: '先查：Web Pixel / GA4 结账事件设置',
};

const RULE_TEXT = {
  ga4_collection_zero: 'GA4 完全收不到流量事件（网站巡检正常 → 大概率是 GA4 采集断了,广告数据正在缺失）',
  add_to_cart_zero: '「加入购物车」连续为 0（① 加购坏了→对照第1/2层巡检 ② GA4 采集断了）',
  begin_checkout_zero: '有人加购但「进入结账」连续为 0（结账入口可能坏了,建议手机实测走一遍结账）',
  purchase_tracking_gap: 'Shopify 刚收到订单但 GA4 连续两个窗口收不到 purchase（生意没坏，是结账追踪断了 → 检查 Web Pixel / GA4 结账事件）',
};

/* The tracking cross-check confirms over more windows than the zero rules:
   a single window with an order but no GA4 purchase is ordinary timing. */
const dropRuleSettings = { ...settings, consecutive_zeros: Number(dropSettings.consecutive_windows) || settings.consecutive_zeros };
// Orders from POS, draft orders and other untracked channels can legitimately
// have no GA4 purchase, so the tracking cross-check arms on its own switch.
const purchaseTrackingMode = dropSettings.purchase_tracking_mode || 'observe';

// Which pages were producing the events: one extra realtime query, only when
// an armed rule is about to page, cached for the run.
let screensPromise = null;
async function screensEvidence(eventName) {
  screensPromise ||= ga('runReport', {
    dateRanges: [{ startDate: window.startStamp.slice(0, 8), endDate: window.startStamp.slice(0, 8) }],
    dimensions: [{ name: 'eventName' }, { name: 'unifiedScreenName' }, { name: 'dateHourMinute' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: eventFilter(),
    limit: '5000',
  }).then((report) => ({
    ...report,
    // Keep only the slot under judgement, then drop the minute column so the
    // rows look the way topScreensForEvent expects.
    rows: (report.rows || [])
      .filter((row) => {
        const stamp = row.dimensionValues?.[2]?.value || '';
        return stamp.length === 12 && stamp >= window.startStamp && stamp < window.endStamp;
      })
      .map((row) => ({ ...row, dimensionValues: row.dimensionValues.slice(0, 2) })),
  })).catch((error) => ({ error: String(error?.message || error) }));
  const report = await screensPromise;
  if (report?.error) return '';
  const top = topScreensForEvent(report, eventName);
  return top.length ? `${eventName} 来自: ${top.map((row) => `${row.screen} (${row.count})`).join(' · ')}` : '';
}

async function updateRule(rule, abnormal, detail, ruleMode = mode, ruleSettings = settings) {
  const key = `ga4:realtime:${rule}`;
  const previous = await getState(key) || { consecutive: 0, active: false, lastAlertedAt: 0 };
  const now = Date.now();
  const { next, confirmed } = nextRuleState(previous, abnormal, now, ruleSettings, window);
  next.detail = detail;
  const schedule = settings.realert_schedule_hours || settings.realert_hours;
  const shouldRecord = shouldRecordAlert(previous, confirmed, now, schedule);

  if (shouldRecord) {
    next.active = true;
    next.lastAlertedAt = now;
    next.alertCount = (Number(previous.alertCount) || 0) + 1;
    next.firstAlertedAt = previous.active ? previous.firstAlertedAt : new Date(now).toISOString();
    const kind = ruleMode === 'armed' ? 'business_alert' : 'would_alert';
    await logAlert('layer4', kind, { rule, mode: ruleMode, alertCount: next.alertCount, abnormalSince: next.abnormalSince, ...detail });
    if (ruleMode === 'armed') {
      const ruleText = RULE_TEXT[rule] || rule;
      const since = durationText(next.abnormalSince, now);
      const header = next.alertCount > 1 ? `🟠 [第4层·业务指标] 仍在持续（第 ${next.alertCount} 次提醒，已持续 ${since}）` : `🟡 [第4层·业务指标] ${ruleText}`;
      const lines = [header];
      if (next.alertCount > 1) lines.push(ruleText);
      lines.push(`时段 ${window.clock.slice(0, 2)}:${window.clock.slice(2)}–${window.endStamp.slice(8, 10)}:${window.endStamp.slice(10)}（已结算，约 ${Math.round((now - window.endMs) / 60_000)} 分钟前）`);
      lines.push(`当前: ${JSON.stringify(detail.current)} / 平时同时段中位数: ${JSON.stringify(detail.baseline)}`);
      const evidenceEvent = rule.startsWith('begin_checkout') || rule === 'purchase_tracking_gap' ? 'add_to_cart' : 'view_item';
      const screens = await screensEvidence(evidenceEvent);
      if (screens) lines.push(screens);
      /* Never gates the alert, only the wording -- the same rule the order
         heartbeat follows for traffic. A probe with nothing to say must not
         be able to keep a real alert quiet. */
      lines.push(watchVerdictLine(await getState('probe:watch:log'), window, { nowMs: now }));
      if (RULE_ADVICE[rule]) lines.push(RULE_ADVICE[rule]);
      lines.push(process.env.RUN_URL || '');
      await telegram(lines.join('\n'));
      // First page only: walk the products shoppers are adding right now
      // through cart + shipping rates and post the evidence (silent 🔎).
      // Never throws; a slow store cannot delay the alert itself.
      if (next.alertCount === 1) {
        const report = await screensPromise;
        await investigate({ rule, ruleLabel: ruleText.split('（')[0], screens: report?.error ? [] : topScreensForEvent(report, evidenceEvent, 10) });
      }
    }
  }

  if (!abnormal && previous.active) {
    const lasted = durationText(previous.abnormalSince || previous.firstAlertedAt, now);
    await logAlert('layer4', 'recovery', { rule, lasted, ...detail });
    if (ruleMode === 'armed') {
      await telegram(`🟢 [第4层·业务指标] 已恢复：${RULE_TEXT[rule] ? RULE_TEXT[rule].split('（')[0] : rule}\n持续了 ${lasted || '不到一个窗口'}\n当前: ${JSON.stringify(detail.current)}\n${process.env.RUN_URL || ''}`, { silent: true });
    }
    next.alertCount = 0;
    next.firstAlertedAt = null;
  }
  await setState(key, next);
  return {
    rule, abnormal, confirmed, consecutive: next.consecutive, recorded: shouldRecord, mode: ruleMode,
    window: window.key, gapMinutes: next.gapMinutes, coverageGap: next.coverageGap, duplicate: next.duplicate,
  };
}

const [funnel, storefrontHealthy] = await Promise.all([ga('runReport', funnelQuery()), workerHealthy()]);

/* A truncated report looks exactly like a quiet store, which is the one
   failure this rewrite exists to prevent. Say so loudly rather than judging
   half a baseline. */
const truncated = Number(funnel.rowCount || 0) > (funnel.rows || []).length;

const current = countsForWindow(funnel, window, EVENT_NAMES);
if (simulated) current.add_to_cart = 0;
const baseline = baselineForSlot(funnel, window, EVENT_NAMES, median);

if (validateOnly) {
  console.log(JSON.stringify({ mode: 'validate', window, rows: (funnel.rows || []).length, rowCount: funnel.rowCount, truncated, current, baseline, storefrontHealthy }, null, 2));
  await heartbeat('layer4', { mode: 'validate', window: window.key, current, baseline });
  process.exit(0);
}

if (truncated) {
  await logAlert('layer4', 'data_quality', { rule: 'baseline_truncated', rowCount: funnel.rowCount, returned: (funnel.rows || []).length });
  await heartbeat('layer4', { status: 'error', window: window.key, note: 'baseline truncated', rowCount: funnel.rowCount });
  console.error(`基线被截断：GA4 报告有 ${funnel.rowCount} 行，只拿到 ${(funnel.rows || []).length} 行。不判断，直接退出。`);
  process.exit(0);
}

/* A window where every single event is zero, on a site Layer 1 says is up,
   is missing data rather than a dead storefront.

   2026-09-24 is the case: window 16:30-17:00 came back page_view 0 against a
   baseline of 180, add_to_cart 0 against 12.5, everything else 0 too — and
   add_to_cart_zero paged. Meanwhile the synthetic watch passed three times
   inside that window with real shipping rates, the storefront was serving the
   GA4 tag and firing page_view, and an order was placed at 17:24. The data
   simply had not arrived: querying the same period 19 minutes later showed 30
   page views where the alerting run had seen none. GA4's backlog ran past
   three hours that day against the 90 minutes measured on 09-20.

   Chasing the backlog with a bigger lag makes Layer 4 useless. Refusing to
   judge an empty window does not: a real storefront failure still puts people
   on the site, so page_view stays above zero and the funnel rules keep
   working. Every-event-zero is the one shape that cannot be a storefront
   problem, because a storefront cannot stop its own page views. If the site
   really is down, that is Layer 1's page, not this one's.

   Deliberately gated on storefrontHealthy: if Layer 1 is unhappy too, the
   zeros may be real and the rules should still speak. */
const emptyWindow = isEmptyWindow(current, baseline, EVENT_NAMES, {
  storefrontHealthy,
  pageViewMinMedian: Number(settings.page_view_min_median) || 10,
});

if (emptyWindow) {
  const emptyNext = nextEmptyState(await getState('ga4:realtime:empty'), window);
  const { consecutive } = emptyNext;
  await setState('ga4:realtime:empty', emptyNext);
  await logAlert('layer4', 'data_quality', {
    rule: 'window_empty',
    window: window.key,
    consecutive,
    baseline: { page_view: baseline.page_view },
  });

  /* Silence is right for a backlog and wrong for a tag that has been removed,
     and after enough consecutive empty windows the second becomes the better
     explanation. Still not a business alert: the wording has to say the
     storefront is probably fine, or it trains the owner to ignore the next
     real one. */
  const need = Number(settings.empty_window_notify_after) || 6;
  if (consecutive === need) {
    await telegram([
      `🟠 [第4层·数据质量] GA4 连续 ${consecutive} 个时段一条数据都没有`,
      `最近判断的时段 ${window.clock.slice(0, 2)}:${window.clock.slice(2)}，平时这个时段约 ${baseline.page_view} 次浏览`,
      '**这不是店坏了**：店铺是否正常由第1层和结账探测负责，它们没有报警。',
      '常见原因：GA4 处理积压（等等就会补上）、或者主题/app 更新把埋点拿掉了。',
      '要确认埋点：打开任一商品页，看 dataLayer 里还有没有 page_view 事件。',
      process.env.RUN_URL || '',
    ].join('\n'), { silent: true });
  }

  await heartbeat('layer4', { status: 'ok', window: window.key, note: 'window empty, not judged', consecutive });
  console.log(JSON.stringify({ event: 'ga4_window_empty', window: window.key, consecutive, baselinePageView: baseline.page_view }));
  process.exit(0);
}
await setState('ga4:realtime:empty', { consecutive: 0, windowKey: window.key, checkedAt: new Date().toISOString() });

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

/* The deviation-band rules add_to_cart_drop and begin_checkout_drop were
   retired on 2026-09-21. Replayed over 35 settled days:

     add_to_cart_drop    3 firings, and in all three the till kept ringing
                         (purchases at 100% of the slot median during the
                         firing, 500% and 600% in the window right after).
                         It also required current > 0, so the failure that
                         matters most -- add_to_cart at zero -- was the one
                         case it could not report. add_to_cart_zero already
                         covers that, and covers it for free.
     begin_checkout_drop 0 firings in 35 days, including both windows of the
                         2026-09-15 free-shipping incident. Never worked.

   The 9/15 signature was add_to_cart healthy or high with begin_checkout at
   zero -- people adding to cart, nobody able to check out. That is what the
   zero rules watch for, and what the band rules were measuring around
   without ever catching. evaluateDropRules stays in the library for the
   diagnostic, so the idea can be re-priced rather than re-argued. */

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

/* The order heartbeat runs in the Worker and has no view of traffic, so it
   cannot tell "nobody could check out" from "nobody came". Leave the latest
   window here for it to read. The reverse direction already exists:
   purchase_tracking_gap above reads orders:last, which the Worker writes. */
await setState('ga4:realtime:last', { checkedAt: new Date().toISOString(), window: window.key, windowClock: window.clock, current, baseline });

await heartbeat('layer4', { kind: 'realtime', mode, current, baseline, results });
console.log(JSON.stringify({ ok: true, kind: 'realtime', mode, current, baseline, storefrontHealthy, results }, null, 2));
