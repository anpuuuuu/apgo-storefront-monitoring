import {
  config,
  ga,
  getState,
  requireEnv,
  setState,
  site,
  telegram,
  workerUrl,
} from './monitor-lib.mjs';
import { settledWindow } from './ga4-anomaly-lib.mjs';
import {
  eventCountsThrough,
  formatEveningSummary,
  orderStatsForDate,
  reportDateForEvening,
  summarizeHealth,
} from './evening-summary-lib.mjs';

requireEnv({ needsHeartbeat: false });

if (config.reporting?.evening?.enabled === false) {
  console.log(JSON.stringify({ ok: true, kind: 'evening-summary', status: 'disabled' }));
  process.exit(0);
}

const timeZone = config.reporting?.evening?.timezone || config.ga4.timezone;
const nowMs = Date.now();
const reportDate = reportDateForEvening(nowMs, timeZone);
const dedupeKey = `report:evening:${reportDate}`;
if (await getState(dedupeKey) && process.env.SUMMARY_FORCE !== 'true') {
  console.log(JSON.stringify({ ok: true, kind: 'evening-summary', reportDate, status: 'already_sent' }));
  process.exit(0);
}

const settled = settledWindow(nowMs, {
  timeZone,
  lagMinutes: Number(config.ga4.realtime.settled_lag_minutes) || 120,
  slotMinutes: Number(config.ga4.realtime.window_minutes) || 30,
});
const settledDate = settled.endStamp.slice(0, 8);
const cutoffStamp = settledDate === reportDate ? settled.endStamp : `${reportDate}2400`;
const cutoffLabel = cutoffStamp.endsWith('2400')
  ? '24:00'
  : `${cutoffStamp.slice(8, 10)}:${cutoffStamp.slice(10, 12)}`;
const events = ['begin_checkout', 'purchase'];

const [report, healthResponse, orderLog, completionState] = await Promise.all([
  ga('runReport', {
    dateRanges: [{ startDate: reportDate, endDate: reportDate }],
    dimensions: [{ name: 'dateHourMinute' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: events } } },
    limit: '10000',
  }),
  fetch(`${workerUrl}/health`, { headers: { 'user-agent': 'APGO-HealthCheck/2.0 EveningSummary' } }),
  getState('orders:log'),
  getState('ga4:realtime:checkout_completion_drop'),
]);
const healthPayload = await healthResponse.json().catch(() => null);
if (!healthPayload?.sites) throw new Error(`Worker health unreadable: HTTP ${healthResponse.status}`);

const counts = eventCountsThrough(report, reportDate, cutoffStamp, events);
const orders = orderStatsForDate(orderLog, reportDate, timeZone);
const health = summarizeHealth(healthPayload);
const text = formatEveningSummary({
  label: site.alertLabel || site.name || site.id,
  reportDate,
  cutoffLabel,
  counts,
  orders,
  health,
  completionState,
  timeZone,
});

await telegram(text);
await setState(dedupeKey, {
  sentAt: new Date(nowMs).toISOString(), reportDate, cutoffStamp,
  monitoringOperational: health.monitoringOperational, checksPassing: health.checksPassing,
});
console.log(JSON.stringify({ ok: true, kind: 'evening-summary', reportDate, sent: true }));
