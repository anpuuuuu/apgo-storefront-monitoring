#!/usr/bin/env node
/* Alert investigator, phase 1a: when an armed GA4 rule pages for the first
   time, walk the advertised products through the storefront cart and ask for
   shipping rates, compare with the nightly snapshot, and post the evidence as
   a silent 🔎 message right after the alert. Fixing stays with a human.

   Usage:
     node scripts/investigator.mjs snapshot     # nightly, from monitor-alerts.yml daily-primary
   or import { investigate } and call it from ga4-anomaly.mjs. */
import fs from 'node:fs';
import { discoverAdTargets } from './discover-ad-targets.mjs';
import {
  buildSnapshot,
  createStorefrontClient,
  diffProbe,
  fetchCatalog,
  matchScreensToProducts,
  probeProduct,
  renderInvestigation,
  snapshotEntry,
  snapshotHandles,
} from './checkout-probe-lib.mjs';
import { config, getState, logAlert, setState, site, telegram } from './monitor-lib.mjs';

const settings = config.investigator || {};
const SNAPSHOT_KEY = 'probe:snapshot:latest';
const PREVIOUS_KEY = 'probe:snapshot:previous';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enabled() {
  return settings.mode !== 'off' && Boolean(settings.address?.zip);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probeHandles(client, catalog, handles) {
  const byHandle = new Map(catalog.map((product) => [product.handle, product]));
  const probes = [];
  const missing = [];
  for (const handle of handles) {
    const product = byHandle.get(handle);
    if (!product) { missing.push(handle); continue; }
    if (probes.length) await sleep(Number(settings.pause_ms) || 1_500);
    probes.push(await probeProduct(client, product, settings.address));
  }
  return { probes, missing, byHandle };
}

/* Nightly: probe the advertised + fixture products and keep two generations. */
export async function snapshot() {
  if (!enabled()) { console.log(JSON.stringify({ event: 'investigator_snapshot_skipped', reason: 'disabled or no address' })); return null; }
  const client = createStorefrontClient({ baseUrl: site.baseUrl });
  const catalog = await fetchCatalog(client);
  let adTargets = [];
  try {
    const sitesConfig = JSON.parse(fs.readFileSync(new URL('../config/sites.json', import.meta.url), 'utf8'));
    adTargets = await discoverAdTargets(sitesConfig);
  } catch (error) {
    console.log(JSON.stringify({ event: 'investigator_ad_targets_unavailable', reason: String(error?.message || error).slice(0, 200) }));
  }
  const handles = snapshotHandles(site, adTargets).slice(0, Number(settings.max_snapshot_products) || 8);
  const { probes, missing } = await probeHandles(client, catalog, handles);
  const current = buildSnapshot({ takenAt: new Date().toISOString(), address: settings.address, products: catalog, probes });
  const latest = await getState(SNAPSHOT_KEY);
  if (latest) await setState(PREVIOUS_KEY, latest);
  await setState(SNAPSHOT_KEY, current);
  const summary = {
    event: 'investigator_snapshot',
    takenAt: current.takenAt,
    handles,
    missingFromCatalog: missing,
    results: probes.map((probe) => ({ handle: probe.handle, cart: probe.cart?.itemCount ?? null, rates: probe.rates?.map((rate) => `${rate.name}=${rate.price}`) ?? null, error: probe.ratesError || probe.add?.error || probe.error || null })),
  };
  console.log(JSON.stringify(summary));
  return summary;
}

/* On the first page of an armed rule: probe the products GA4 says shoppers
   are adding right now and post the evidence. Never throws. */
export async function investigate({ rule, ruleLabel, screens }) {
  if (!enabled()) return { skipped: 'disabled' };
  const startedAt = Date.now();
  try {
    return await withTimeout(runInvestigation({ rule, ruleLabel, screens }), Number(settings.timeout_ms) || 90_000, 'investigation');
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 300);
    console.log(JSON.stringify({ event: 'investigation_failed', rule, reason, ms: Date.now() - startedAt }));
    try { await logAlert('layer4', 'investigation_failed', { rule, reason }); } catch { /* logging only */ }
    return { failed: reason };
  }
}

async function runInvestigation({ rule, ruleLabel, screens }) {
  const client = createStorefrontClient({ baseUrl: site.baseUrl });
  const catalog = await fetchCatalog(client);
  const { matched, unmatched } = matchScreensToProducts(screens || [], catalog, Number(settings.max_products) || 3);
  const latest = await getState(SNAPSHOT_KEY);
  const { probes, byHandle } = await probeHandles(client, catalog, matched.map((entry) => entry.handle));
  const results = probes.map((probe) => {
    const target = matched.find((entry) => entry.handle === probe.handle) || {};
    const previous = latest?.products?.[probe.handle] || null;
    const current = snapshotEntry(byHandle.get(probe.handle), probe);
    return { handle: probe.handle, title: probe.title, count: target.count || 0, probe, hadSnapshot: Boolean(previous), changes: diffProbe(previous, current) };
  });
  const text = renderInvestigation({
    ruleLabel,
    address: settings.address,
    results,
    unmatched,
    snapshotTakenAt: latest?.takenAt || null,
    siteLabel: site.alertLabel || site.name,
  });
  await telegram(text, { silent: true });
  const summary = {
    rule,
    matched: matched.map((entry) => entry.handle),
    unmatched,
    snapshotTakenAt: latest?.takenAt || null,
    results: results.map((entry) => ({ handle: entry.handle, cart: entry.probe.cart?.itemCount ?? null, rates: entry.probe.rates?.length ?? null, ratesError: entry.probe.ratesError, addError: entry.probe.add?.error || null, changes: entry.changes })),
  };
  await logAlert('layer4', 'investigation', summary);
  console.log(JSON.stringify({ event: 'investigation', ...summary }));
  return summary;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly && process.argv[2] === 'snapshot') {
  snapshot().catch((error) => {
    console.error(`Investigator snapshot failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
