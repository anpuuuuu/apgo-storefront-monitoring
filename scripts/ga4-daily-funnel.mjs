import {
  config,
  ga,
  getState,
  setState,
  logAlert,
  heartbeat,
  median,
  mytDate,
  requireEnv,
  telegram,
} from './monitor-lib.mjs';

requireEnv();

const stage = process.env.DAILY_STAGE === 'confirm' ? 'confirm' : 'primary';
const mode = config.ga4.mode;
const targetDate = mytDate(-1).replaceAll('-', '');
const targetWeekday = new Date(`${mytDate(-1)}T12:00:00+08:00`).getUTCDay();
const FUNNEL_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'];

function dimensionFilter() {
  return { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_EVENTS } } };
}

function pathGroup(path = '') {
  const clean = path.toLowerCase();
  if (clean.includes('golden-bull-award')) return 'campaign_page';
  if (clean.includes('/products/')) return 'product_page';
  return 'other_page';
}

function productGroup(itemName = '') {
  const clean = itemName.toLowerCase();
  if (clean.includes('laundry detergent') || clean.includes('detergent promo')) return 'laundry_products';
  if (clean.includes('aurora')) return 'aurora_products';
  return 'other_products';
}

function emptyStats() {
  return { view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0, purchasers: 0, transactions: 0, revenue: 0 };
}

function key(date, country, device, group) {
  return `${date}|${country || 'Unknown'}|${device || 'unknown'}|${group || 'other_page'}`;
}

function buildStats(eventReport, itemReport, globalReport) {
  const detailed = new Map();
  const products = new Map();
  const dates = new Set();
  for (const row of eventReport.rows || []) {
    const [date, eventName, country, device, path] = (row.dimensionValues || []).map((value) => value.value || '');
    dates.add(date);
    const entryKey = key(date, country, device, pathGroup(path));
    if (!detailed.has(entryKey)) detailed.set(entryKey, emptyStats());
    detailed.get(entryKey)[eventName] += Number(row.metricValues?.[0]?.value || 0);
  }
  for (const row of itemReport.rows || []) {
    const [date, country, device, itemName] = (row.dimensionValues || []).map((value) => value.value || '');
    dates.add(date);
    const entryKey = key(date, country, device, productGroup(itemName));
    if (!products.has(entryKey)) products.set(entryKey, emptyStats());
    const stats = products.get(entryKey);
    stats.view_item += Number(row.metricValues?.[0]?.value || 0);
    stats.add_to_cart += Number(row.metricValues?.[1]?.value || 0);
    stats.begin_checkout += Number(row.metricValues?.[2]?.value || 0);
    stats.purchase += Number(row.metricValues?.[3]?.value || 0);
    stats.revenue += Number(row.metricValues?.[4]?.value || 0);
  }

  const global = new Map([...dates].map((date) => [date, emptyStats()]));
  for (const [entryKey, stats] of detailed) {
    const date = entryKey.split('|')[0];
    const total = global.get(date) || emptyStats();
    for (const eventName of FUNNEL_EVENTS) total[eventName] += stats[eventName];
    total.transactions += stats.transactions;
    total.revenue += stats.revenue;
    global.set(date, total);
  }
  for (const row of globalReport.rows || []) {
    const date = row.dimensionValues?.[0]?.value || '';
    const total = global.get(date) || emptyStats();
    total.purchasers = Number(row.metricValues?.[0]?.value || 0);
    total.transactions = Number(row.metricValues?.[1]?.value || total.transactions);
    total.revenue = Number(row.metricValues?.[2]?.value || total.revenue);
    global.set(date, total);
  }
  return { detailed, products, global };
}

function rates(stats) {
  return {
    view_to_atc: stats.view_item ? stats.add_to_cart / stats.view_item : 0,
    atc_to_checkout: stats.add_to_cart ? stats.begin_checkout / stats.add_to_cart : 0,
    checkout_to_purchase: stats.begin_checkout ? stats.purchase / stats.begin_checkout : 0,
    aov: stats.transactions ? stats.revenue / stats.transactions : 0,
  };
}

function compact(stats) {
  return { ...stats, ...rates(stats) };
}

function aggregateDetail(detailed, date, dimension, value) {
  const total = emptyStats();
  for (const [entryKey, stats] of detailed) {
    const [rowDate, country, device, group] = entryKey.split('|');
    const field = { country, device, group }[dimension];
    if (rowDate !== date || field !== value) continue;
    for (const fieldName of Object.keys(total)) total[fieldName] += stats[fieldName] || 0;
  }
  return total;
}

function sameWeekdayDates(allDates) {
  return allDates.filter((date) => {
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    return date !== targetDate && new Date(`${iso}T12:00:00+08:00`).getUTCDay() === targetWeekday;
  }).slice(-4);
}

function baselineFor(samples) {
  const fields = [...Object.keys(emptyStats()), 'view_to_atc', 'atc_to_checkout', 'checkout_to_purchase', 'aov'];
  return Object.fromEntries(fields.map((field) => [field, median(samples.map((sample) => compact(sample)[field] || 0))]));
}

function anomaliesFor(label, current, baseline) {
  const threshold = config.ga4.daily.ratio_to_baseline;
  const issues = [];
  if (current.add_to_cart >= config.ga4.daily.atc_min
      && baseline.view_to_atc > 0
      && rates(current).view_to_atc < baseline.view_to_atc * threshold) issues.push('view_to_atc');
  if (current.add_to_cart >= config.ga4.daily.atc_min
      && baseline.atc_to_checkout > 0
      && rates(current).atc_to_checkout < baseline.atc_to_checkout * threshold) issues.push('atc_to_checkout');
  if (current.begin_checkout >= config.ga4.daily.checkout_min
      && baseline.checkout_to_purchase > 0
      && rates(current).checkout_to_purchase < baseline.checkout_to_purchase * threshold) issues.push('checkout_to_purchase');
  if (current.begin_checkout >= config.ga4.daily.checkout_min
      && baseline.revenue > 0
      && current.revenue < baseline.revenue * threshold) issues.push('revenue');
  return issues.length ? { label, issues, current: compact(current), baseline } : null;
}

const [eventReport, itemReport, globalReport] = await Promise.all([
  ga('runReport', {
    dateRanges: [{ startDate: '35daysAgo', endDate: 'yesterday' }],
    dimensions: [
      { name: 'date' }, { name: 'eventName' }, { name: 'country' },
      { name: 'deviceCategory' }, { name: 'pagePath' },
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: dimensionFilter(),
    limit: '250000',
  }),
  ga('runReport', {
    dateRanges: [{ startDate: '35daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }, { name: 'country' }, { name: 'deviceCategory' }, { name: 'itemName' }],
    metrics: [
      { name: 'itemsViewed' },
      { name: 'itemsAddedToCart' },
      { name: 'itemsCheckedOut' },
      { name: 'itemsPurchased' },
      { name: 'itemRevenue' },
    ],
    limit: '250000',
  }),
  ga('runReport', {
    dateRanges: [{ startDate: '35daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'totalPurchasers' }, { name: 'transactions' }, { name: 'purchaseRevenue' }],
    limit: '1000',
  }),
]);

const { detailed, products, global } = buildStats(eventReport, itemReport, globalReport);
const baselineDates = sameWeekdayDates([...global.keys()].sort());
if (!global.has(targetDate) || baselineDates.length < 3) {
  throw new Error(`GA4 daily dataset incomplete: target=${targetDate}, weekday baseline samples=${baselineDates.length}`);
}

const targets = [{ label: 'all', current: global.get(targetDate), baseline: baselineFor(baselineDates.map((date) => global.get(date) || emptyStats())) }];
for (const [dimension, values] of Object.entries({
  country: ['Malaysia', 'Singapore'],
  device: ['mobile', 'desktop', 'tablet'],
  group: ['campaign_page', 'product_page'],
})) {
  for (const value of values) {
    targets.push({
      label: `${dimension}:${value}`,
      current: aggregateDetail(detailed, targetDate, dimension, value),
      baseline: baselineFor(baselineDates.map((date) => aggregateDetail(detailed, date, dimension, value))),
    });
  }
}

for (const value of ['laundry_products', 'aurora_products', 'other_products']) {
  targets.push({
    label: `product:${value}`,
    current: aggregateDetail(products, targetDate, 'group', value),
    baseline: baselineFor(baselineDates.map((date) => aggregateDetail(products, date, 'group', value))),
  });
}

const anomalies = targets.map((target) => anomaliesFor(target.label, target.current, target.baseline)).filter(Boolean);
const summary = {
  targetDate,
  stage,
  mode,
  baselineDates,
  generatedAt: new Date().toISOString(),
  overall: compact(global.get(targetDate)),
  sevenDay: [...global.keys()].sort().slice(-7).map((date) => ({ date, ...compact(global.get(date)) })),
  segments: targets.slice(1).map((target) => ({ label: target.label, current: compact(target.current), baseline: target.baseline })),
  anomalies,
};

const stateKey = `ga4:daily:candidate:${targetDate}`;
if (stage === 'primary') {
  await setState(stateKey, summary);
  if (anomalies.length) await logAlert('layer4', 'daily_candidate', summary);
} else {
  const primary = await getState(stateKey);
  const confirmedLabels = new Set(anomalies.map((item) => item.label));
  const persistent = (primary?.anomalies || []).filter((item) => confirmedLabels.has(item.label));
  summary.persistent = persistent;
  if (persistent.length) {
    const kind = mode === 'armed' ? 'business_alert' : 'would_alert';
    await logAlert('layer4', kind, summary);
    if (mode === 'armed') {
      const lines = persistent.slice(0, 8).map((item) => `${item.label}: ${item.issues.join(', ')}`);
      await telegram(`APGO GA4 daily funnel alert (${targetDate})\n${lines.join('\n')}\n${process.env.RUN_URL || ''}`);
    }
  }
}

await heartbeat('layer4', { kind: 'daily', stage, mode, targetDate, anomalyCount: anomalies.length });
console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
