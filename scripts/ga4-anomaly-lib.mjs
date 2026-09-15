/* Pure helpers for the Layer 4 realtime/daily scripts. No env or network
   access here so `node --test` can import them directly. */

/* "Two consecutive windows" only means something when the samples are
   adjacent. GitHub's scheduler used to deliver realtime runs hours apart,
   which made a 5-hour gap count as consecutive; the Dispatcher Cron and
   GitHub's own cron can now also land two runs a minute apart. A gap above
   max_gap_minutes restarts the count, a gap below min_gap_minutes is the
   same window sampled twice and does not advance it. */
export function nextRuleState(previous, abnormal, nowMs, settings) {
  const prior = { consecutive: 0, active: false, lastAlertedAt: 0, ...(previous || {}) };
  const priorMs = prior.checkedAt ? Date.parse(prior.checkedAt) : Number.NaN;
  const gapMinutes = Number.isFinite(priorMs) ? (nowMs - priorMs) / 60_000 : null;
  const coverageGap = gapMinutes !== null && gapMinutes > settings.max_gap_minutes;
  const duplicate = gapMinutes !== null && gapMinutes < settings.min_gap_minutes;
  let consecutive = 0;
  if (abnormal) {
    if (gapMinutes === null || coverageGap) consecutive = 1;
    else if (duplicate) consecutive = Math.max(Number(prior.consecutive) || 0, 1);
    else consecutive = (Number(prior.consecutive) || 0) + 1;
  }
  const next = {
    ...prior,
    consecutive,
    active: abnormal ? Boolean(prior.active) : false,
    checkedAt: new Date(nowMs).toISOString(),
    gapMinutes: gapMinutes === null ? null : Math.round(gapMinutes * 10) / 10,
    coverageGap,
    duplicate,
  };
  return { next, confirmed: consecutive >= settings.consecutive_zeros };
}

export function shouldRecordAlert(previous, confirmed, nowMs, realertHours) {
  if (!confirmed) return false;
  const prior = previous || {};
  return !prior.active || nowMs - Number(prior.lastAlertedAt || 0) >= realertHours * 3_600_000;
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
