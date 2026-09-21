#!/usr/bin/env node
/* Synthetic checkout watch — the fast line under Layer 4's slow backstop.

   Layer 4 reads a settled GA4 window and confirms over two adjacent slots, so
   it answers in about two and a half hours. That is the right trade for a
   statistical rule. This is the other half of it: every 20 minutes, act like
   a shopper on a real product — add it to a real cart, ask for shipping rates
   to a real Malaysian postcode — and check the answer is one somebody could
   actually check out with.

   Public cart endpoints only. It never opens the checkout page, never touches
   payment, never creates an order, and it clears the cart when it is done.
   The requests carry a probe user agent and run no JavaScript, so they do not
   appear in GA4 and cannot contaminate the numbers the Layer 4 rules read.

   Usage: node scripts/storefront-watch.mjs   (from storefront-watch.yml) */
import fs from 'node:fs';
import { discoverAdTargets } from './discover-ad-targets.mjs';
import { createStorefrontClient, probeProduct, snapshotHandles } from './checkout-probe-lib.mjs';
import {
  BROKEN,
  OK,
  judgeProbe,
  judgeRun,
  nextWatchState,
  pickHandles,
  recoveryMessage,
  watchMessage,
} from './storefront-watch-lib.mjs';
import { config, getState, heartbeat, logAlert, requireEnv, setState, site, telegram } from './monitor-lib.mjs';

const dryRun = process.env.WATCH_DRY_RUN === 'true';
requireEnv({ needsD1: !dryRun, needsGa4: false, needsHeartbeat: !dryRun });

const settings = config.storefront_watch || {};
const address = config.investigator?.address || {};
const STATE_KEY = 'probe:watch';
const HANDLES_KEY = 'probe:watch:handles';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (settings.mode === 'off' || !address.zip) {
  console.log(JSON.stringify({ event: 'storefront_watch_skipped', reason: settings.mode === 'off' ? 'mode off' : 'no probe address' }));
  process.exit(0);
}

/* The handle list is the advertised products plus the Layer 2 fixtures — the
   same list the nightly snapshot walks. Ad discovery needs the Meta API and
   can fail, so the last good list is cached: a watch that stops watching
   because an unrelated API had a bad minute is worse than a slightly stale
   list. */
async function watchHandles() {
  let discovered = [];
  try {
    const sitesConfig = JSON.parse(fs.readFileSync(new URL('../config/sites.json', import.meta.url), 'utf8'));
    discovered = await discoverAdTargets(sitesConfig);
  } catch (error) {
    console.log(JSON.stringify({ event: 'watch_ad_targets_unavailable', reason: String(error?.message || error).slice(0, 200) }));
  }
  const fresh = snapshotHandles(site, discovered);
  if (fresh.length) {
    if (!dryRun) await setState(HANDLES_KEY, { handles: fresh, refreshedAt: new Date().toISOString() });
    return { handles: fresh, stale: false };
  }
  const cached = dryRun ? null : await getState(HANDLES_KEY);
  return { handles: cached?.handles || [], stale: true };
}

/* One request per product instead of paging the whole catalogue: at a 20
   minute cadence the catalogue fetch would be four requests every run for
   information about two products. */
async function fetchProduct(client, handle) {
  const response = await client.request(`/products/${encodeURIComponent(handle)}.js`);
  if (!response.ok || !response.json?.variants) return null;
  const product = response.json;
  return {
    handle,
    title: String(product.title || handle),
    variants: (product.variants || []).map((variant) => ({
      id: variant.id,
      title: String(variant.title || ''),
      available: Boolean(variant.available),
    })),
  };
}

const previous = dryRun ? null : await getState(STATE_KEY);
const runIndex = Number(previous?.runIndex) || 0;
const { handles: allHandles, stale } = await watchHandles();
const handles = pickHandles(allHandles, {
  canaries: Number(settings.canaries) || 1,
  rotating: Number(settings.rotating) || 1,
  runIndex,
});

if (!handles.length) {
  console.log(JSON.stringify({ event: 'storefront_watch_no_handles', stale }));
  if (!dryRun) await heartbeat('watch', { status: 'error', note: 'no handles to probe' });
  process.exit(0);
}

const results = [];
for (const handle of handles) {
  if (results.length) await sleep(Number(settings.pause_ms) || 4_000);
  // A fresh client per product means a fresh cart cookie, so the cart starts
  // empty and one product's failure cannot contaminate the next.
  const client = createStorefrontClient({ baseUrl: site.baseUrl });
  const product = await fetchProduct(client, handle);
  if (!product) {
    results.push({ handle, title: handle, probe: null, judgement: { status: 'unmeasured', reasons: ['读不到这个商品（可能已下架或改了 handle）'] } });
    continue;
  }
  const probe = await probeProduct(client, product, address);
  results.push({ handle, title: product.title, probe, judgement: judgeProbe(probe) });
}

const verdict = judgeRun(results.map((entry) => entry.judgement));
const nowMs = Date.now();
const mode = settings.mode || 'observe';
const summary = {
  event: 'storefront_watch',
  mode,
  status: verdict.status,
  measured: verdict.measured,
  broken: verdict.broken,
  handlesStale: stale,
  results: results.map((entry) => ({
    handle: entry.handle,
    status: entry.judgement.status,
    reasons: entry.judgement.reasons,
    rates: entry.probe?.rates?.map((rate) => `${rate.name}=${rate.price}`) ?? null,
  })),
};

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const { shouldAlert, recovered, next, confirmed } = nextWatchState(previous, verdict, nowMs, settings);
await setState(STATE_KEY, next);
console.log(JSON.stringify({ ...summary, consecutive: next.consecutive, confirmed, shouldAlert, recovered }));

if (shouldAlert) {
  await logAlert('layer4', mode === 'armed' ? 'business_alert' : 'would_alert', {
    rule: 'synthetic_checkout_broken',
    mode,
    alertCount: next.alertCount,
    brokenSince: next.brokenSince,
    results: summary.results,
  });
  if (mode === 'armed') {
    await telegram(watchMessage({
      results,
      verdict,
      alertCount: next.alertCount,
      brokenSince: next.brokenSince,
      nowMs,
      siteLabel: site.alertLabel || site.name || '',
      runUrl: process.env.RUN_URL || '',
    }));
  }
} else if (recovered) {
  await logAlert('layer4', 'recovery', { rule: 'synthetic_checkout_broken', results: summary.results });
  if (mode === 'armed') {
    await telegram(recoveryMessage({ results, brokenSince: previous?.brokenSince, nowMs, runUrl: process.env.RUN_URL || '' }), { silent: true });
  }
}

/* The heartbeat carries the verdict so /health and the Dispatcher can see the
   watch is both running and passing, not merely running. */
await heartbeat('watch', {
  status: verdict.status === BROKEN && mode === 'armed' ? 'error' : 'ok',
  mode,
  verdict: verdict.status,
  measured: verdict.measured,
  broken: verdict.broken,
  consecutive: next.consecutive,
  handles,
});

if (verdict.status === OK) process.exit(0);
process.exit(0);
