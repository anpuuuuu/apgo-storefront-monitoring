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

/* The handle list is the advertised products first, then the Layer 2 fixtures.
   The order matters: the canary is whatever comes first, and the product
   currently taking ad spend is the one worth watching every 20 minutes.

   Discovery reads GA4, so it is cached rather than run every time. Ad targets
   change on the scale of days, not minutes, and 72 GA4 queries a day to learn
   the same answer would be waste. A cache older than refresh_hours is
   refreshed; if that refresh fails the previous list is used anyway, because a
   watch that stops watching over an unrelated API's bad minute is worse than
   a slightly stale list. Fixtures alone are the last resort — on 2026-09-21
   two of the five pointed at products that had been deleted, so a fixture-only
   list is a watch with most of its slots aimed at 404s. */
async function watchHandles() {
  const cached = dryRun ? null : await getState(HANDLES_KEY);
  const refreshMs = (Number(settings.handles_refresh_hours) || 6) * 3_600_000;
  const cachedAge = cached?.refreshedAt ? Date.now() - Date.parse(cached.refreshedAt) : Number.POSITIVE_INFINITY;
  /* Only a list that discovery actually produced counts as a cache. An entry
     with no adTargets count came from the version that cached the
     fixtures-only fallback, and trusting it would keep the watch on that
     fallback for refresh_hours while looking perfectly healthy in the log. */
  const cachedHandles = Array.isArray(cached?.handles) && Number(cached?.adTargets) > 0 ? cached.handles : [];
  if (cachedHandles.length && cachedAge < refreshMs) {
    return { handles: cachedHandles, source: 'cache', ageMinutes: Math.round(cachedAge / 60_000) };
  }

  let discovered = [];
  try {
    const sitesConfig = JSON.parse(fs.readFileSync(new URL('../config/sites.json', import.meta.url), 'utf8'));
    discovered = await discoverAdTargets(sitesConfig);
  } catch (error) {
    console.log(JSON.stringify({ event: 'watch_ad_targets_unavailable', reason: String(error?.message || error).slice(0, 200) }));
  }

  const fresh = snapshotHandles(site, discovered);
  // Only a list that actually learned something new is worth caching. Caching
  // a fixtures-only fallback would pin the watch to the fallback for hours.
  if (discovered.length && fresh.length) {
    if (!dryRun) await setState(HANDLES_KEY, { handles: fresh, refreshedAt: new Date().toISOString(), adTargets: discovered.length });
    return { handles: fresh, source: 'discovery', adTargets: discovered.length };
  }
  if (cachedHandles.length) return { handles: cachedHandles, source: 'stale-cache', ageMinutes: Math.round(cachedAge / 60_000) };
  return { handles: fresh, source: 'fixtures-only' };
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
const { handles: allHandles, ...handleSource } = await watchHandles();
const handles = pickHandles(allHandles, {
  canaries: Number(settings.canaries) || 1,
  rotating: Number(settings.rotating) || 1,
  runIndex,
});

if (!handles.length) {
  console.log(JSON.stringify({ event: 'storefront_watch_no_handles', ...handleSource }));
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
  handles: handleSource,
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
