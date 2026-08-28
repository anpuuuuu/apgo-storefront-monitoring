#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(here, '..', 'sites.json');

export class AdDiscoveryError extends Error {
  constructor(message) {
    super(`AD_DISCOVERY_FAILED: ${message}`);
    this.name = 'AdDiscoveryError';
  }
}

export function normalizeLandingPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '(not set)') return '';
  try {
    const parsed = new URL(raw, 'https://store.invalid');
    let pathname = decodeURIComponent(parsed.pathname || '/');
    pathname = pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/$/, '');
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
  return (report?.rows || []).map((row) => ({
    landingPage: row.dimensionValues?.[0]?.value || '',
    channel: row.dimensionValues?.[1]?.value || '',
    country: row.dimensionValues?.[2]?.value || '',
    sessions: number(row.metricValues?.[0]?.value),
    addToCarts: number(row.metricValues?.[1]?.value),
    checkouts: number(row.metricValues?.[2]?.value),
  }));
}

export function buildAdTargets(rows, config) {
  const discovery = config.monitoring?.layer2?.adDiscovery || {};
  const channels = new Set(discovery.paidChannels || []);
  const marketMap = discovery.countryMarketMap || {};
  const minimumSessions = number(discovery.minimumSessions || 1);
  const maxLandingPages = Math.max(1, number(discovery.maxLandingPages || 10));
  const sites = new Map((config.sites || []).filter((site) => site.enabled).map((site) => [site.id, site]));
  const primarySite = [...sites.values()][0];
  if (!primarySite) throw new AdDiscoveryError('no enabled site is configured');

  const merged = new Map();
  for (const row of rows || []) {
    if (!channels.has(row.channel)) continue;
    const landingPath = normalizeLandingPath(row.landingPage);
    const market = marketMap[row.country];
    if (!landingPath || !market || !primarySite.markets?.some((entry) => entry.id === market)) continue;
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

  return [...merged.values()]
    .filter((target) => target.sessions >= minimumSessions || target.addToCarts > 0 || target.checkouts > 0)
    .sort((a, b) => (
      Number(b.checkouts > 0) - Number(a.checkouts > 0)
      || Number(b.addToCarts > 0) - Number(a.addToCarts > 0)
      || b.sessions - a.sessions
      || a.landingPath.localeCompare(b.landingPath)
    ))
    .slice(0, maxLandingPages)
    .map((target, index) => ({ ...target, rank: index + 1 }));
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
  const discovery = config.monitoring?.layer2?.adDiscovery;
  if (!discovery?.enabled) return [];
  const report = await fetchAdReport({
    accessToken: env.GOOGLE_OAUTH_ACCESS_TOKEN,
    propertyId: env.GA4_PROPERTY_ID,
    lookbackDays: discovery.lookbackDays,
  });
  return buildAdTargets(rowsFromReport(report), config);
}

async function main() {
  const configPath = path.resolve(process.argv[2] || defaultConfigPath);
  const outputPath = path.resolve(process.argv[3] || path.join(path.dirname(configPath), 'ad-targets.json'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const targets = await discoverAdTargets(config);
  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays: config.monitoring?.layer2?.adDiscovery?.lookbackDays || 3,
    targets,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ adTargets: targets.length, output: outputPath, targets }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof AdDiscoveryError ? error.message : `AD_DISCOVERY_FAILED: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
