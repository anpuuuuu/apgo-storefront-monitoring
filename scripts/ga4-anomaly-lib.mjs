/* Pure helpers for the Layer 4 realtime/daily scripts. No env or network
   access here so `node --test` can import them directly. */

import { buildAlert, duration } from '../workers/alert-format.mjs';

/* GA4 reports dateHourMinute as a wall clock in the property's reporting
   timezone. Read that zone's offset from the zone itself rather than assuming
   one, so the maths stays right if the property moves and so a zone with DST
   lines up on both sides of a transition. */
export function minuteToMs(stamp, timeZone) {
  const text = String(stamp);
  if (!/^\d{12}$/.test(text)) return NaN;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:00Z`;
  const asUtc = Date.parse(iso);
  if (!Number.isFinite(asUtc)) return NaN;
  const offsetAt = (ms) => {
    const label = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value || 'GMT+00:00';
    const match = label.match(/GMT([+-])(\d{2}):(\d{2})/);
    return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  };
  // Two passes: the offset must be read at the instant being named, not at the
  // UTC-shaped guess, or a DST boundary lands an hour out.
  const first = asUtc - offsetAt(asUtc) * 60_000;
  return asUtc - offsetAt(first) * 60_000;
}

export function propertyMinuteNow(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}`;
}

/* The most recent 30-minute slot that is old enough to have finished arriving.

   The rules used to read runRealtimeReport's trailing 30 minutes and compare it
   with a baseline built from settled runReport data — two different pipelines,
   which need not agree even with no lag: one aligned comparison on 2026-09-20
   put realtime 36% above the settled figure for the same window. Replaying the
   rule over 35 settled days produces one false alarm every 17.5 days while
   production on realtime produced one every three, so the noise is in the
   source, not the logic.

   The realtime API cannot look back past 29 minutes, so reading settled data
   means runReport, which on 2026-09-20 held nothing at all for the last 60
   minutes and only part of 90-60. Hence a lag of 90 minutes and a whole slot:
   detection moves from about an hour to about two, in exchange for six times
   fewer false alarms.

   The lag is 120 rather than 90 so the whole slot sits inside the settled
   zone. At 90 the slot would end 77 minutes back, and the 90-60 band was
   measured half-filled (46 page views against a typical 120), which would
   quietly reintroduce the very bias this replaces. */
export function settledWindow(nowMs, { timeZone, lagMinutes = 120, slotMinutes = 30 }) {
  const stamp = propertyMinuteNow(nowMs - lagMinutes * 60_000, timeZone);
  const minute = Number(stamp.slice(10, 12));
  const floored = `${stamp.slice(0, 10)}${String(Math.floor(minute / slotMinutes) * slotMinutes).padStart(2, '0')}`;
  const startMs = minuteToMs(floored, timeZone);
  return {
    key: floored,
    clock: floored.slice(8, 12),
    startStamp: floored,
    endStamp: propertyMinuteNow(startMs + slotMinutes * 60_000, timeZone),
    startMs,
    endMs: startMs + slotMinutes * 60_000,
    slotMinutes,
  };
}

/* A wider cohort ending at the newest settled slot. Checkout completion is
   not meaningful in a single 30-minute bucket: somebody can begin at 19:29
   and purchase at 19:34. A two-hour cohort keeps both events together while
   retaining the same settled-data boundary as the zero rules. */
export function rollingWindowEndingAt(window, { durationMinutes = 120, timeZone }) {
  const endMs = Number(window?.endMs);
  const startMs = endMs - Number(durationMinutes) * 60_000;
  const startStamp = propertyMinuteNow(startMs, timeZone);
  const endStamp = propertyMinuteNow(endMs, timeZone);
  return {
    key: `${startStamp}-${endStamp}`,
    clock: startStamp.slice(8, 12),
    startStamp,
    endStamp,
    startMs,
    endMs,
    slotMinutes: Number(window?.slotMinutes) || 30,
    durationMinutes: Number(durationMinutes),
  };
}

export function hoursForWindow(window, timeZone) {
  const values = new Set();
  for (let cursor = window.startMs; cursor < window.endMs; cursor += 30 * 60_000) {
    values.add(propertyMinuteNow(cursor, timeZone).slice(8, 10));
  }
  return [...values].sort();
}

/* Counts for one slot out of a dateHourMinute report. Half-open on the end so
   a minute never lands in two slots. */
export function countsForWindow(report, window, eventNames) {
  const counts = Object.fromEntries(eventNames.map((name) => [name, 0]));
  for (const row of report?.rows || []) {
    const stamp = row.dimensionValues?.[0]?.value || '';
    if (stamp.length !== 12 || stamp < window.startStamp || stamp >= window.endStamp) continue;
    const name = row.dimensionValues?.[1]?.value;
    if (name in counts) counts[name] += Number(row.metricValues?.[0]?.value || 0);
  }
  return counts;
}

/* Median of the same clock slot on earlier days, which is what the slot should
   be compared against. Rows from the slot's own day are excluded so a day
   cannot be its own baseline. */
export function baselineForSlot(report, window, eventNames, medianFn) {
  const byDate = new Map();
  for (const row of report?.rows || []) {
    const stamp = row.dimensionValues?.[0]?.value || '';
    if (stamp.length !== 12) continue;
    const date = stamp.slice(0, 8);
    if (date >= window.startStamp.slice(0, 8)) continue;
    const minute = Number(stamp.slice(10, 12));
    const slotStart = Math.floor(minute / window.slotMinutes) * window.slotMinutes;
    if (`${stamp.slice(8, 10)}${String(slotStart).padStart(2, '0')}` !== window.clock) continue;
    if (!byDate.has(date)) byDate.set(date, Object.fromEntries(eventNames.map((name) => [name, 0])));
    const name = row.dimensionValues?.[1]?.value;
    if (name in byDate.get(date)) byDate.get(date)[name] += Number(row.metricValues?.[0]?.value || 0);
  }
  const days = [...byDate.values()];
  return Object.fromEntries(eventNames.map((name) => [name, medianFn(days.map((day) => day[name] || 0))]));
}

/* Median of equal-duration cohorts ending at the same local clock on prior
   days. Ratios are calculated per day before taking the median; a ratio of
   medians would overweight high-volume days and hide the exact shape this
   rule is meant to detect. */
export function baselineForRollingWindow(report, window, eventNames, medianFn, { timeZone, baselineDays = 28 } = {}) {
  const days = [];
  for (let offset = 1; offset <= baselineDays; offset += 1) {
    const date = propertyMinuteNow(window.endMs - offset * 86_400_000, timeZone).slice(0, 8);
    const endStamp = `${date}${window.endStamp.slice(8, 12)}`;
    const endMs = minuteToMs(endStamp, timeZone);
    const startMs = endMs - window.durationMinutes * 60_000;
    days.push(countsForWindow(report, {
      startStamp: propertyMinuteNow(startMs, timeZone),
      endStamp,
    }, eventNames));
  }
  const result = Object.fromEntries(eventNames.map((name) => [name, medianFn(days.map((day) => day[name] || 0))]));
  const rates = days
    .filter((day) => Number(day.begin_checkout) > 0)
    .map((day) => Number(day.purchase || 0) / Number(day.begin_checkout));
  result.checkout_to_purchase = medianFn(rates);
  result.sample_days = rates.length;
  return result;
}

export function evaluateCheckoutCompletion(current, baseline, settings = {}) {
  const checkout = Number(current?.begin_checkout || 0);
  const purchase = Number(current?.purchase || 0);
  const baselineCheckout = Number(baseline?.begin_checkout || 0);
  const baselineRate = Number(baseline?.checkout_to_purchase || 0);
  const currentRate = checkout > 0 ? purchase / checkout : 0;
  const absoluteDrop = baselineRate - currentRate;
  const ratioToBaseline = baselineRate > 0 ? currentRate / baselineRate : null;
  const abnormal = checkout >= Number(settings.checkout_min || 15)
    && baselineCheckout >= Number(settings.baseline_checkout_min || 8)
    && Number(baseline?.sample_days || 0) >= Number(settings.baseline_min_days || 14)
    && baselineRate > 0
    && currentRate < baselineRate * Number(settings.ratio_to_baseline || 0.5)
    && absoluteDrop >= Number(settings.absolute_drop || 0.15);
  return { abnormal, checkout, purchase, currentRate, baselineRate, baselineCheckout, absoluteDrop, ratioToBaseline };
}

/* "Two consecutive windows" only means something when the samples are
   adjacent. GitHub's scheduler used to deliver realtime runs hours apart,
   which made a 5-hour gap count as consecutive; the Dispatcher Cron and
   GitHub's own cron can now also land two runs a minute apart. A gap above
   max_gap_minutes restarts the count, a gap below min_gap_minutes is the
   same window sampled twice and does not advance it. */
export function nextRuleState(previous, abnormal, nowMs, settings, window = null) {
  const prior = { consecutive: 0, active: false, lastAlertedAt: 0, ...(previous || {}) };
  /* With a settled window the run clock no longer says anything useful: the
     job runs every 28 minutes but reads a slot that only moves every 30, so
     two runs often read the same slot. Identity of the data read is what
     decides whether a streak advanced, so key on the slot when there is one
     and fall back to the run clock when there is not. */
  const priorMs = window ? Number(prior.windowStartMs) : (prior.checkedAt ? Date.parse(prior.checkedAt) : Number.NaN);
  const currentMs = window ? window.startMs : nowMs;
  const gapMinutes = Number.isFinite(priorMs) ? (currentMs - priorMs) / 60_000 : null;
  const coverageGap = gapMinutes !== null && gapMinutes > settings.max_gap_minutes;
  const duplicate = window
    ? prior.windowKey === window.key
    : gapMinutes !== null && gapMinutes < settings.min_gap_minutes;
  let consecutive = 0;
  if (abnormal) {
    if (gapMinutes === null || coverageGap) consecutive = 1;
    else if (duplicate) consecutive = Math.max(Number(prior.consecutive) || 0, 1);
    else consecutive = (Number(prior.consecutive) || 0) + 1;
  }
  const restarted = abnormal && (consecutive === 1 || !prior.abnormalSince);
  const next = {
    ...prior,
    consecutive,
    active: abnormal ? Boolean(prior.active) : false,
    // When the abnormal streak began, for "已持续 X" in alerts and recovery.
    abnormalSince: abnormal ? (restarted ? new Date(nowMs).toISOString() : prior.abnormalSince) : null,
    checkedAt: new Date(nowMs).toISOString(),
    windowKey: window ? window.key : prior.windowKey,
    windowStartMs: window ? window.startMs : prior.windowStartMs,
    gapMinutes: gapMinutes === null ? null : Math.round(gapMinutes * 10) / 10,
    coverageGap,
    duplicate,
  };
  return { next, confirmed: consecutive >= settings.consecutive_zeros };
}

/* Re-alert cadence for a persisting condition. `schedule` is either a number
   of hours (fixed) or an array such as [1, 2, 3]: 1 h after the first page,
   2 h after the second, then every 3 h — dense while the owner can still
   stop the bleeding, sparse once it is old news. The 2026-09-15 checkout
   incident paged at 00:46 and then not until 07:16 under the old flat 6 h. */
export function realertDelayHours(schedule, alertCount) {
  if (Array.isArray(schedule) && schedule.length) return Number(schedule[Math.min(Math.max(alertCount, 1) - 1, schedule.length - 1)]);
  return Number(schedule) || 6;
}

export function shouldRecordAlert(previous, confirmed, nowMs, schedule) {
  if (!confirmed) return false;
  const prior = previous || {};
  if (!prior.active) return true;
  const delayHours = realertDelayHours(schedule, Number(prior.alertCount) || 1);
  return nowMs - Number(prior.lastAlertedAt || 0) >= delayHours * 3_600_000;
}

export function durationText(fromIso, nowMs) {
  const fromMs = Date.parse(fromIso || '');
  if (!Number.isFinite(fromMs)) return '';
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${rest} 分钟`;
}

/* Top screens for one event from a realtime report with dimensions
   [eventName, unifiedScreenName], so a checkout alert can say which product
   pages were producing the add-to-carts. */
export function topScreensForEvent(report, eventName, limit = 5) {
  const rows = (report?.rows || [])
    .filter((row) => row.dimensionValues?.[0]?.value === eventName)
    .map((row) => ({ screen: String(row.dimensionValues?.[1]?.value || '').slice(0, 60), count: Number(row.metricValues?.[0]?.value || 0) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
  return rows.slice(0, limit);
}

export function appendCoverage(list, nowIso, cap = 96) {
  return [...(Array.isArray(list) ? list : []).filter(Boolean), nowIso].slice(-cap);
}

function localParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return { date: `${get('year')}${get('month')}${get('day')}`, minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')) };
}

/* Share of the day's 30-minute windows that a realtime run actually
   observed. Two runs in the same window count once. */
export function coverageForDate(timestamps, dateYYYYMMDD, timeZone, windowMinutes = 30) {
  const expected = Math.round(1440 / windowMinutes);
  const buckets = new Set();
  for (const timestamp of Array.isArray(timestamps) ? timestamps : []) {
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) continue;
    const { date, minuteOfDay } = localParts(ms, timeZone);
    if (date !== dateYYYYMMDD) continue;
    buckets.add(Math.floor(minuteOfDay / windowMinutes));
  }
  return { windows: buckets.size, expected, ratio: expected ? buckets.size / expected : 0 };
}

/* Deviation-band rules for partial failures. Both require the current count
   to be above zero so they stay disjoint from the *_zero rules.
   RETIRED as an alerting path on 2026-09-21 -- kept because the diagnostic
   replays it, so the idea can be re-priced against fresh data instead of
   re-argued. Over 35 settled days add_to_cart_drop fired three times with
   purchases at or above the slot median every time, and begin_checkout_drop
   fired zero times, including on the 2026-09-15 incident.

   - add_to_cart_drop: traffic at or above traffic_floor_ratio of baseline,
     ATC at or below drop_ratio of its baseline median.
   - begin_checkout_drop: enough current ATC, and the checkout/ATC ratio at
     or below drop_ratio of the baseline ratio. */
export function evaluateDropRules(current, baseline, settings) {
  const cur = { page_view: 0, add_to_cart: 0, begin_checkout: 0, ...(current || {}) };
  const base = { page_view: 0, add_to_cart: 0, begin_checkout: 0, ...(baseline || {}) };
  const cfg = {
    traffic_floor_ratio: 0.6, drop_ratio: 0.35, add_to_cart_min_median: 8, begin_checkout_min_median: 2, current_atc_min: 8,
    ...(settings || {}),
  };
  const trafficOk = base.page_view > 0 && cur.page_view >= cfg.traffic_floor_ratio * base.page_view;
  const addToCartDrop = trafficOk
    && base.add_to_cart >= cfg.add_to_cart_min_median
    && cur.add_to_cart > 0
    && cur.add_to_cart <= cfg.drop_ratio * base.add_to_cart;
  const baselineRatio = base.add_to_cart > 0 ? base.begin_checkout / base.add_to_cart : 0;
  const currentRatio = cur.add_to_cart > 0 ? cur.begin_checkout / cur.add_to_cart : 0;
  const beginCheckoutDrop = cur.add_to_cart >= cfg.current_atc_min
    && base.begin_checkout >= cfg.begin_checkout_min_median
    && baselineRatio > 0
    && cur.begin_checkout > 0
    && currentRatio <= cfg.drop_ratio * baselineRatio;
  return {
    add_to_cart_drop: addToCartDrop,
    begin_checkout_drop: beginCheckoutDrop,
    trafficOk,
    baselineRatio: Math.round(baselineRatio * 1000) / 1000,
    currentRatio: Math.round(currentRatio * 1000) / 1000,
  };
}

/* A daily stage that already produced its result for the target date within
   rerunMs is a duplicate delivery (GitHub's late cron after the Dispatcher
   Cron already ran it), not a new day. */
export function isDailyStageFresh(prior, stage, targetDate, nowMs, rerunMs) {
  if (!prior || !prior.generatedAt || prior.targetDate !== targetDate) return false;
  if (stage === 'primary' && prior.stage !== 'primary') return false;
  const generatedMs = Date.parse(prior.generatedAt);
  return Number.isFinite(generatedMs) && nowMs - generatedMs < rerunMs;
}

/* A window where every event is zero, on a site Layer 1 says is up, is
   missing data rather than a dead storefront.

   2026-09-24: window 16:30-17:00 returned page_view 0 against a baseline of
   180, and every other event zero too, so add_to_cart_zero paged. Inside that
   same window the synthetic checkout watch passed three times with real
   shipping rates, the storefront was serving the GA4 tag and firing
   page_view, and an order was placed at 17:24. The data had simply not
   arrived — querying the same period 19 minutes later showed 30 page views
   where the alerting run saw none. GA4's backlog ran past three hours that
   day, against the 90 minutes measured on 09-20.

   Raising the lag to chase a backlog makes Layer 4 useless. Refusing to judge
   an empty window does not, because a real storefront failure still puts
   people on the site: page_view stays above zero and every funnel rule keeps
   working. Every-event-zero is the one shape that cannot be a storefront
   problem, since a storefront cannot stop its own page views.

   storefrontHealthy gates it deliberately. If Layer 1 is unhappy too the
   zeros may be real, and the rules should still be allowed to speak. */
export function isEmptyWindow(current, baseline, eventNames, { storefrontHealthy, pageViewMinMedian = 10 } = {}) {
  if (!storefrontHealthy) return false;
  const total = (eventNames || []).reduce((sum, name) => sum + (Number(current?.[name]) || 0), 0);
  if (total !== 0) return false;
  // Without a baseline worth the name this is just a quiet night, and quiet
  // nights are not worth suppressing anything over.
  return Number(baseline?.page_view) >= pageViewMinMedian;
}

/* Consecutive empty windows, keyed on slot identity like the rule streaks, so
   a re-read of the same slot cannot inflate the count. */
export function nextEmptyState(previous, window) {
  const prior = previous || {};
  const consecutive = prior.windowKey === window.key
    ? Number(prior.consecutive) || 1
    : (Number(prior.consecutive) || 0) + 1;
  return { consecutive, windowKey: window.key, checkedAt: new Date().toISOString() };
}

/* What the synthetic checkout probe saw during the window this alert is
   about.

   A Layer 4 alert names a slot that closed up to two hours ago, so "the probe
   is fine now" answers a question nobody asked. The probe runs every 20
   minutes and keeps a rolling log, so the honest answer is what it found
   inside that slot -- on 2026-09-24 it had passed three times inside the very
   window that paged, which was the whole case for the alert being false.

   This NEVER decides whether the alert fires. It is a sentence in the
   message, the same rule the order heartbeat follows for traffic: a probe
   that agrees tells the owner where to look first, and a probe that has
   nothing to say must not be able to keep a real alert quiet. */
export function watchVerdictLine(log, window, { nowMs = Date.now(), maxAgeMinutes = 45, padMinutes = 20 } = {}) {
  const entries = (Array.isArray(log?.entries) ? log.entries : [])
    .filter((row) => Number.isFinite(Number(row?.at)));
  if (!entries.length) return '🤖 结账探测：没有记录（探测可能还没开始跑）';

  /* Padded by one probe interval each side. The probe runs every 20 minutes
     against a 30-minute window, so strict containment usually finds a single
     run — on 2026-09-24 it caught one of the three that bracketed the window.
     A break lasting long enough for the funnel to notice also shows in the
     runs either side, so the padded range is better evidence and still
     honestly about that period. */
  const from = window.startMs - padMinutes * 60_000;
  const until = window.endMs + padMinutes * 60_000;
  const covering = entries.filter((row) => Number(row.at) >= from && Number(row.at) < until);
  if (covering.length) {
    const broken = covering.filter((row) => row.status === 'broken' || row.status === 'degraded').length;
    const measured = covering.filter((row) => row.status !== 'unmeasured').length;
    if (!measured) return `🤖 结账探测：覆盖该时段跑了 ${covering.length} 次，但都没测准（限流或超时），说明不了什么`;
    if (!broken) {
      const how = measured === 1 ? '一次，成功加购并拿到运费' : `${measured} 次，全部成功加购并拿到运费`;
      return `🤖 结账探测：覆盖该时段跑了 ${how} → 那时店铺能买，优先查 GA4 埋点而不是店铺`;
    }
    return `🤖 结账探测：覆盖该时段 ${broken}/${measured} 次走不完结账 → 这很可能是真的故障，先按下面的清单查`;
  }

  // No probe landed inside the slot. Say so, and offer the nearest one with
  // its age attached rather than letting it pose as evidence about the window.
  const latest = entries.reduce((best, row) => (Number(row.at) > Number(best.at) ? row : best), entries[0]);
  const ageMinutes = Math.round((nowMs - Number(latest.at)) / 60_000);
  if (ageMinutes > maxAgeMinutes) return `🤖 结账探测：最近一次是 ${ageMinutes} 分钟前，太旧，不作数`;
  const word = latest.status === 'ok' ? '成功加购并拿到运费' : latest.status === 'unmeasured' ? '没测准' : '走不完结账';
  return `🤖 结账探测：该时段前后没有记录；最近一次是 ${ageMinutes} 分钟前，${word}`;
}

/* ---------------------------------------------------------------------- *
   What each Layer 4 rule means, in the owner's words.

   On 2026-09-24 an alert read
     当前: {"add_to_cart":0} / 平时同时段中位数: {"add_to_cart":12.5}
   and on 10-06 the owner said he no longer understood the notifications.
   Each rule now says what happened, why it might matter, and what to do with
   his own hands, in that order. The numbers are still there, as sentences.
 * ---------------------------------------------------------------------- */

const EVENT_WORDS = {
  page_view: '浏览',
  view_item: '看商品',
  add_to_cart: '加入购物车',
  begin_checkout: '进入结账',
  purchase: '购买',
  checkout_to_purchase: '结账完成率',
  estimated_abandonment: '估计弃单率',
};
const RATIO_KEYS = new Set(['checkout_to_purchase', 'estimated_abandonment']);

export const RULE_COPY = {
  add_to_cart_zero: {
    level: 'act',
    store: '店铺可能有问题',
    title: '加入购物车突然没了',
    meaning: '这半小时没有任何人加入购物车，平时这个时段是有的。可能是加购按钮坏了，也可能只是 GA4 没记录到。',
    advice: '请用手机打开正在投广告的商品页，试一次加入购物车；也看看主题或 app 最近有没有更新。',
  },
  begin_checkout_zero: {
    level: 'act',
    store: '店铺可能有问题',
    title: '有人加购，但没人进结账',
    meaning: '顾客在加入购物车，可是这半小时没有任何人进入结账页。9/15 免运费被误关时就是这个样子。',
    advice: '请用手机走一遍「加入购物车 → 结账」，看卡在哪一步；先查运费（免运费）、折扣、库存和结账设置最近有没有改。',
  },
  checkout_completion_drop: {
    level: 'act',
    store: '店铺可能有问题',
    title: '进了结账，但付款成功的人明显变少',
    meaning: '进入结账的人数正常，但最后付款成功的比例比平时低很多，弃单可能在增加。',
    advice: '请看 Shopify 后台的弃单（abandoned checkouts），并检查付款方式、折扣、地址验证和库存。',
  },
  ga4_collection_zero: {
    level: 'watch',
    store: '店铺多半正常',
    title: 'GA4 收不到任何流量',
    meaning: '网站是好的，但 GA4 这半小时一次浏览都没记录到。生意不一定受影响，但广告会因为缺数据而越投越差。',
    advice: '请检查 GA4 / Web Pixel 设置，以及主题或 app 最近有没有更新。',
  },
  purchase_tracking_gap: {
    level: 'watch',
    store: '店铺正常',
    title: '有订单，但 GA4 没记到购买',
    meaning: 'Shopify 刚收到订单，可是 GA4 连续两个时段都没记到购买。生意没坏，是购买追踪断了，广告会因此少算成交。',
    advice: '请检查 Web Pixel / GA4 的结账事件设置。',
  },
};

function figure(key, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return RATIO_KEYS.has(key) ? `${Math.round(number * 100)}%` : `${Math.round(number * 10) / 10}`;
}

/* "加入购物车 0 次（平时这个时段约 12.5 次）" from the rule's own detail. */
export function describeCounts(current = {}, baseline = {}) {
  return Object.keys(current || {})
    .filter((key) => EVENT_WORDS[key])
    .map((key) => {
      const now = figure(key, current[key]);
      const usual = baseline && key in baseline ? figure(key, baseline[key]) : '';
      const unit = RATIO_KEYS.has(key) ? '' : ' 次';
      return `${EVENT_WORDS[key]} ${now}${unit}${usual ? `（平时这个时段约 ${usual}${unit}）` : ''}`;
    })
    .join('；');
}

function windowSentence(window, nowMs) {
  if (!window?.startStamp) return '';
  const clock = (stamp) => `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}`;
  const minutes = Math.round((nowMs - window.endMs) / 60_000);
  return `看的是 ${clock(window.startStamp)}–${clock(window.endStamp)} 这半小时（GA4 的数据要约 2 小时才完整，所以这是 ${minutes} 分钟前的情况）。`;
}

export function businessAlert({ rule, site = '', alertCount = 1, abnormalSince = null, nowMs = Date.now(), window = null, detail = {}, screensLine = '', probeLine = '', runUrl = '' }) {
  const copy = RULE_COPY[rule] || { level: 'watch', store: '店铺状况暂时看不到', title: rule, meaning: '', advice: '' };
  const ongoing = alertCount > 1;
  const sinceMs = Date.parse(abnormalSince || '');
  const lasted = Number.isFinite(sinceMs) ? duration(nowMs - sinceMs) : '';
  return buildAlert({
    level: copy.level,
    title: ongoing ? `仍在持续：${copy.title}（第 ${alertCount} 次提醒${lasted ? `，已 ${lasted}` : ''}）` : copy.title,
    site,
    store: copy.store,
    lines: [
      ongoing ? '' : copy.meaning,
      describeCounts(detail.current, detail.baseline),
      windowSentence(window, nowMs),
      screensLine,
      probeLine,
      copy.advice,
    ],
    atMs: nowMs,
    details: [`rule=${rule}`, `current=${JSON.stringify(detail.current || {})}`, `baseline=${JSON.stringify(detail.baseline || {})}`],
    link: runUrl,
  });
}

export function businessRecoveryAlert({ rule, site = '', lastedMs = null, nowMs = Date.now(), detail = {}, runUrl = '' }) {
  const copy = RULE_COPY[rule] || { title: rule };
  return buildAlert({
    level: 'ok',
    title: `恢复了：${copy.title}`,
    site,
    store: '店铺正常',
    lines: [
      Number.isFinite(lastedMs) && lastedMs > 0 ? `持续了 ${duration(lastedMs)}。` : '',
      describeCounts(detail.current, detail.baseline),
    ],
    atMs: nowMs,
    details: [`rule=${rule}`],
    link: runUrl,
  });
}

export function emptyWindowAlert({ site = '', consecutive, window = null, baselinePageView, nowMs = Date.now(), runUrl = '' }) {
  return buildAlert({
    level: 'ignore',
    title: `GA4 连续 ${consecutive} 个时段没有数据`,
    site,
    store: '店铺多半正常',
    lines: [
      `GA4 回来的数据全是 0（平时这个时段约 ${baselinePageView} 次浏览）。店铺本身由第 1 层和结账探测在看，它们没有报警。`,
      '通常是 Google 那边处理积压，等等就会补上；如果明天还这样，可能是主题或 app 更新把 GA4 埋点拿掉了。',
      windowSentence(window, nowMs),
    ],
    atMs: nowMs,
    details: [`window_empty consecutive=${consecutive}`],
    link: runUrl,
  });
}
