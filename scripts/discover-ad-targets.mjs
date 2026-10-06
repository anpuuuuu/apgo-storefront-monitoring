#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAlert } from '../workers/alert-format.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(here, '..', 'config', 'sites.json');

export class AdDiscoveryError extends Error {
  constructor(message) {
    super(`AD_DISCOVERY_FAILED: ${message}`);
    this.name = 'AdDiscoveryError';
  }
}

export function normalizeLandingPath(value, storeOrigin = '') {
  const raw = String(value || '').trim();
  if (!raw || raw === '(not set)') return '';
  // GA4 occasionally contains a comma-separated navigation trail or a full
  // external URL in this dimension. Neither is a storefront landing page.
  if (/[\r\n,]/.test(raw)) return '';
  try {
    const base = new URL('https://store.invalid');
    const parsed = new URL(raw, base);
    if (parsed.origin !== base.origin) {
      if (!storeOrigin || parsed.origin !== new URL(storeOrigin).origin) return '';
    }
    let pathname = decodeURIComponent(parsed.pathname || '/');
    pathname = pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/$/, '');
    // Checkout/cart/account routes are session- or customer-specific. Testing
    // them later creates guaranteed 404s and leaks checkout tokens into logs.
    const first = pathname.toLowerCase().split('/').filter(Boolean)[0] || '';
    if (new Set([
      'admin', 'account', 'authentication', 'cart', 'challenge', 'checkout',
      'checkouts', 'orders', 'password', 'wallets',
    ]).has(first)) return '';
    return pathname || '/';
  } catch {
    return '';
  }
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function rowsFromReport(report) {
  return (report?.rows || []).map((row) => {
    const dimensions = row.dimensionValues || [];
    const dated = dimensions.length >= 4;
    return {
      // Older fixtures have the original three dimensions. Production now
      // adds date so post-retirement traffic is separate from old history.
      date: dated ? dimensions[0]?.value || '' : '',
      landingPage: dimensions[dated ? 1 : 0]?.value || '',
      channel: dimensions[dated ? 2 : 1]?.value || '',
      country: dimensions[dated ? 3 : 2]?.value || '',
      sessions: number(row.metricValues?.[0]?.value),
      addToCarts: number(row.metricValues?.[1]?.value),
      checkouts: number(row.metricValues?.[2]?.value),
    };
  });
}

export function buildAdTargets(rows, config, siteId = '') {
  const discovery = config.monitoring?.layer2?.adDiscovery || {};
  const channels = new Set(discovery.paidChannels || []);
  const marketMap = discovery.countryMarketMap || {};
  const minimumSessions = number(discovery.minimumSessions || 1);
  const maxLandingPages = Math.max(1, number(discovery.maxLandingPages || 10));
  const sites = new Map((config.sites || []).filter((site) => site.enabled).map((site) => [site.id, site]));
  const primarySite = siteId ? sites.get(siteId) : [...sites.values()][0];
  if (!primarySite) throw new AdDiscoveryError('no enabled site is configured');
  const retired = new Set((discovery.retiredLandingPaths || []).map((entry) => normalizeLandingPath(entry.path, primarySite.baseUrl)).filter(Boolean));

  const merged = new Map();
  for (const row of rows || []) {
    if (!channels.has(row.channel)) continue;
    const landingPath = normalizeLandingPath(row.landingPage, primarySite.baseUrl);
    const market = marketMap[row.country];
    if (!landingPath || retired.has(landingPath) || !market || !primarySite.markets?.some((entry) => entry.id === market)) continue;
    const key = `${primarySite.id}|${market}|${landingPath}`;
    const current = merged.get(key) || {
      site: primarySite.id,
      market,
      landingPath,
      channel: row.channel,
      sessions: 0,
      addToCarts: 0,
      checkouts: 0,
    };
    // One customer path is tested once per market. If the same URL is used by
    // several paid channels, prefer the social WebView profile because it is
    // the stricter mobile environment and aggregate all traffic metrics.
    if (row.channel === 'Paid Social') current.channel = row.channel;
    current.sessions += number(row.sessions);
    current.addToCarts += number(row.addToCarts);
    current.checkouts += number(row.checkouts);
    merged.set(key, current);
  }

  const ranked = [...merged.values()]
    .filter((target) => target.sessions >= minimumSessions || target.addToCarts > 0 || target.checkouts > 0)
    .sort((a, b) => (
      Number(b.checkouts > 0) - Number(a.checkouts > 0)
      || Number(b.addToCarts > 0) - Number(a.addToCarts > 0)
      || b.sessions - a.sessions
      || a.landingPath.localeCompare(b.landingPath)
    ));

  // Keep the highest-ranked paid target from every active market before
  // filling the remaining global budget. Otherwise a busy MY campaign can
  // push every SG landing page out of a ten-target run.
  const selected = [];
  for (const market of primarySite.markets || []) {
    const top = ranked.find((target) => target.market === market.id);
    if (top && selected.length < maxLandingPages) selected.push(top);
  }
  for (const target of ranked) {
    if (selected.length >= maxLandingPages) break;
    if (!selected.includes(target)) selected.push(target);
  }

  return selected
    .sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b))
    .map((target, index) => ({ ...target, rank: index + 1 }));
}

export function retiredLandingTraffic(rows, config, siteId = '') {
  const discovery = config.monitoring?.layer2?.adDiscovery || {};
  const channels = new Set(discovery.paidChannels || []);
  const marketMap = discovery.countryMarketMap || {};
  const sites = new Map((config.sites || []).filter((site) => site.enabled).map((site) => [site.id, site]));
  const site = siteId ? sites.get(siteId) : [...sites.values()][0];
  if (!site) throw new AdDiscoveryError('no enabled site is configured');
  const definitions = new Map((discovery.retiredLandingPaths || []).map((entry) => [
    normalizeLandingPath(entry.path, site.baseUrl),
    { ...entry, retiredDate: String(entry.retiredOn || '').replaceAll('-', '') },
  ]));
  const found = new Map();
  for (const row of rows || []) {
    if (!channels.has(row.channel)) continue;
    const landingPath = normalizeLandingPath(row.landingPage, site.baseUrl);
    const definition = definitions.get(landingPath);
    const market = marketMap[row.country];
    if (!definition || !market || !/^\d{8}$/.test(row.date || '') || row.date <= definition.retiredDate) continue;
    const activity = number(row.sessions) + number(row.addToCarts) + number(row.checkouts);
    if (!activity) continue;
    const key = `${site.id}|${market}|${landingPath}`;
    const current = found.get(key) || {
      site: site.id, market, landingPath, retiredOn: definition.retiredOn,
      reason: definition.reason || '', latestDate: '', sessions: 0, addToCarts: 0, checkouts: 0,
    };
    current.latestDate = current.latestDate > row.date ? current.latestDate : row.date;
    current.sessions += number(row.sessions);
    current.addToCarts += number(row.addToCarts);
    current.checkouts += number(row.checkouts);
    found.set(key, current);
  }
  return [...found.values()].sort((a, b) => b.latestDate.localeCompare(a.latestDate) || b.sessions - a.sessions);
}

/* A page registered as retired is still receiving paid traffic: somewhere an
   ad, or a link in a post, is spending money on it. The 2026-10 Merdeka set
   was this exact case before the registry existed. */
export function retiredLandingAlert(items, label = 'APGO', nowMs = Date.now()) {
  const shown = (items || []).slice(0, 5);
  const day = (value) => {
    const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    return match ? `${match[2]}/${match[3]}` : String(value || '');
  };
  return buildAlert({
    level: 'watch',
    title: '已下架的网址还在吃广告流量',
    site: label,
    store: '广告钱可能在白花',
    lines: [
      '这些网址已经登记为下架，但最近还有付费流量进来，顾客点进去可能看到错误页或已结束的活动：',
      ...shown.map((item) => `· ${item.landingPath}：${day(item.latestDate)} 有 ${item.sessions} 次访问、${item.addToCarts} 次加购、${item.checkouts} 次进结账`),
      '请把指向它的广告改到还在的页面，或在 Shopify 后台「在线商店 → 导航 → URL 重定向」把旧网址转到新商品。如果它其实又上架了，告诉我把它从下架名单拿掉。',
    ],
    atMs: nowMs,
    details: ['该网址不会加入浏览器故障批次（下架登记）', ...shown.map((item) => `${item.landingPath} sessions=${item.sessions} atc=${item.addToCarts} checkouts=${item.checkouts}`)],
  });
}

export function formatRetiredLandingAlert(items, label = 'APGO', nowMs = Date.now()) {
  return retiredLandingAlert(items, label, nowMs).text;
}

export async function fetchAdReport({ accessToken, propertyId, lookbackDays = 3, fetchImpl = fetch }) {
  if (!accessToken) throw new AdDiscoveryError('GOOGLE_OAUTH_ACCESS_TOKEN is required');
  if (!propertyId) throw new AdDiscoveryError('GA4_PROPERTY_ID is required');
  const response = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${Math.max(1, number(lookbackDays))}daysAgo`, endDate: 'today' }],
      dimensions: [
        { name: 'date' },
        { name: 'landingPagePlusQueryString' },
        { name: 'sessionDefaultChannelGroup' },
        { name: 'country' },
      ],
      metrics: [{ name: 'sessions' }, { name: 'addToCarts' }, { name: 'checkouts' }],
      limit: '10000',
      keepEmptyRows: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new AdDiscoveryError(`GA4 runReport HTTP ${response.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AdDiscoveryError(`GA4 returned invalid JSON: ${error.message}`);
  }
}

export async function discoverAdTargets(config, env = process.env) {
  return (await discoverAdTargetReport(config, env)).targets;
}

export async function discoverAdTargetReport(config, env = process.env) {
  const discovery = config.monitoring?.layer2?.adDiscovery;
  if (!discovery?.enabled) return { targets: [], retiredTraffic: [] };
  const enabledSites = (config.sites || []).filter((site) => site.enabled && site.type === 'shopify');
  const site = env.MONITOR_SITE_ID
    ? enabledSites.find((entry) => entry.id === env.MONITOR_SITE_ID)
    : enabledSites[0];
  if (!site) throw new AdDiscoveryError(`unknown or disabled site: ${env.MONITOR_SITE_ID || '(first enabled site)'}`);
  const report = await fetchAdReport({
    accessToken: env.GOOGLE_OAUTH_ACCESS_TOKEN,
    propertyId: env.GA4_PROPERTY_ID || site.ga4PropertyId,
    lookbackDays: discovery.lookbackDays,
  });
  const rows = rowsFromReport(report);
  return {
    targets: buildAdTargets(rows, config, site.id),
    retiredTraffic: retiredLandingTraffic(rows, config, site.id),
  };
}

async function main() {
  const configPath = path.resolve(process.argv[2] || defaultConfigPath);
  const outputPath = path.resolve(process.argv[3] || path.join(path.dirname(configPath), 'ad-targets.json'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { targets, retiredTraffic } = await discoverAdTargetReport(config);
  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays: config.monitoring?.layer2?.adDiscovery?.lookbackDays || 3,
    targets,
    retiredTraffic,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ adTargets: targets.length, retiredTraffic: retiredTraffic.length, output: outputPath, targets }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof AdDiscoveryError ? error.message : `AD_DISCOVERY_FAILED: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
