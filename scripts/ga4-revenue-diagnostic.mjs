import { ga, requireEnv, propertyId } from './monitor-lib.mjs';

requireEnv({ needsD1: false, needsHeartbeat: false });
const ranges = [{ startDate: '2026-08-01', endDate: '2026-09-02' }];
const requests = [
  { name: 'dailyRevenue', dimensions: [{ name: 'date' }], metrics: ['transactions', 'totalPurchasers', 'purchaseRevenue', 'grossPurchaseRevenue', 'totalRevenue'] },
  { name: 'purchaseEvent', dimensions: [{ name: 'eventName' }], metrics: ['eventCount', 'eventValue'], dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'purchase' } } } },
  { name: 'itemPurchase', dimensions: [{ name: 'date' }], metrics: ['itemsPurchased', 'itemRevenue'] },
];
for (const { name, metrics, ...rest } of requests) {
  const report = await ga('runReport', { ...rest, dateRanges: ranges, metrics: metrics.map((metric) => ({ name: metric })), limit: '1000' }, { allowRestrictedMetrics: true });
  const headers = [...(report.dimensionHeaders || []), ...(report.metricHeaders || [])].map((header) => header.name);
  const rows = (report.rows || []).map((row) => Object.fromEntries(headers.map((header, i) => [header, [...(row.dimensionValues || []), ...(row.metricValues || [])][i]?.value])));
  // Aggregate reporting data only: no transaction IDs, customer data or credentials.
  console.log(JSON.stringify({ diagnostic: name, propertyId, ranges, rowCount: report.rowCount || 0, metadata: report.metadata || {}, rows }));
}
