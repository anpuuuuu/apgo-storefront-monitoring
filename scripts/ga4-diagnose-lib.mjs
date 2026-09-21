/* Pure helpers for the GA4 freshness diagnostic. Kept apart from
   ga4-diagnose.mjs so they can be unit tested without calling GA4: a wrong
   window calculation would not crash, it would quietly answer the freshness
   question with the wrong data and send the fix in the wrong direction. */

export const EVENT_NAMES = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];

/* Oldest first; each entry is [startMinutesAgo, endMinutesAgo), so a row
   belongs to the window when start > age >= end. */
export const WINDOWS = [[180, 150], [150, 120], [120, 90], [90, 60], [60, 30], [30, 0]];

/* GA4 reports dateHourMinute as a wall clock in the property's reporting
   timezone. Read that zone's offset from the zone itself rather than assuming
   +08:00, so the maths stays right if the property ever moves, and so a zone
   with DST would still line up on both sides of a transition. */
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

/* One implementation, shared with the rules. The diagnostic exists to tell
   the rules what to do, so the two must agree on what a window even is. */
export { propertyMinuteNow } from './ga4-anomaly-lib.mjs';

export function minutesAgo(stamp, nowMs, timeZone) {
  const ms = minuteToMs(stamp, timeZone);
  return Number.isFinite(ms) ? (nowMs - ms) / 60_000 : NaN;
}

export function windowIndexFor(ageMinutes, windows = WINDOWS) {
  if (!Number.isFinite(ageMinutes)) return -1;
  return windows.findIndex(([start, end]) => ageMinutes < start && ageMinutes >= end);
}

/* Sums a dateHourMinute report into the windows. `rows` is the GA4 rows array,
   dimension 0 the timestamp and dimension 1 the key being counted. Keys not in
   `keys` are dropped, so an unexpected event name cannot inflate a column. */
export function bucketByWindow(rows, nowMs, { timeZone, keys = EVENT_NAMES, windows = WINDOWS } = {}) {
  const totals = windows.map(() => Object.fromEntries(keys.map((key) => [key, 0])));
  for (const row of rows || []) {
    const index = windowIndexFor(minutesAgo(row?.dimensionValues?.[0]?.value, nowMs, timeZone), windows);
    if (index < 0) continue;
    const key = row?.dimensionValues?.[1]?.value;
    if (!keys.includes(key)) continue;
    totals[index][key] += Number(row?.metricValues?.[0]?.value || 0);
  }
  return totals;
}
