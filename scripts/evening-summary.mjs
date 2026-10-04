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
import { minuteToMs, propertyMinuteNow, settledWindow } from './ga4-anomaly-lib.mjs';
import { fetchAbandonedCount } from '../workers/error-monitor/shopify-abandoned.mjs';
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

async function dailyAbandonedCount() {
  const settings = site.shopifyAdmin;
  if (config.shopify_abandoned?.mode === 'off' || !settings?.shopEnv || !settings?.tokenEnv) return { status: 'disabled' };
  const shopDomain = process.env[settings.shopEnv];
  const accessToken = process.env[settings.tokenEnv];
  if (!shopDomain || !accessToken) return { status: 'not_configured' };
  const startMs = minuteToMs(`${reportDate}0000`, timeZone);
  const endMs = cutoffStamp.endsWith('2400')
    ? minuteToMs(`${propertyMinuteNow(startMs + 30 * 60 * 60_000, timeZone).slice(0, 8)}0000`, timeZone)
    : minuteToMs(cutoffStamp, timeZone);
  try {
    return {
      status: 'ok',
      ...(await fetchAbandonedCount({
        shopDomain, accessToken, startMs, endMs,
        apiVersion: settings.apiVersion || config.shopify_abandoned?.api_version || '2026-10',
      })),
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'evening_shopify_abandoned_failed', reason: String(error?.message || error).slice(0, 200) }));
    return { status: 'error' };
  }
}

const [report, healthResponse, orderLog, completionState, abandoned] = await Promise.all([
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
  dailyAbandonedCount(),
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
  abandoned,
  timeZone,
});

await telegram(text);
await setState(dedupeKey, {
  sentAt: new Date(nowMs).toISOString(), reportDate, cutoffStamp,
  monitoringOperational: health.monitoringOperational, checksPassing: health.checksPassing,
});
console.log(JSON.stringify({ ok: true, kind: 'evening-summary', reportDate, sent: true }));
