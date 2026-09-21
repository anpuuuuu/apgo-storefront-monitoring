/* Pure helpers for the Layer 4 realtime/daily scripts. No env or network
   access here so `node --test` can import them directly. */

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
