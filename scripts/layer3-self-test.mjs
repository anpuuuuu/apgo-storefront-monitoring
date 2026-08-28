#!/usr/bin/env node
import { getSite } from './site-config.mjs';

const workerUrl = (process.env.MONITOR_WORKER_URL || '').replace(/\/$/, '');
const token = process.env.MONITOR_HEARTBEAT_TOKEN || '';
const site = getSite();
const storefrontOrigin = new URL(site.baseUrl).origin;
if (!workerUrl || !token) throw new Error('MONITOR_WORKER_URL and MONITOR_HEARTBEAT_TOKEN are required');

// Shopify serves a separate cached document to bare script-style user agents.
// Use a browser-shaped UA so this check verifies the same storefront document
// customers and Playwright receive. APGO-HealthCheck keeps the injected client
// monitor inert if a browser ever executes this response.
const storefrontUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ' +
  'APGO-HealthCheck/2.0 Layer3-SelfTest';

const storefront = await fetch(`${storefrontOrigin}/?apgo_em_test=1`, {
  headers: { 'user-agent': storefrontUserAgent },
  redirect: 'follow',
});
const storefrontHtml = await storefront.text();
if (!storefront.ok || !storefrontHtml.includes(`${workerUrl}/beacon`)) {
  throw new Error(`Layer 3 storefront snippet is missing (HTTP ${storefront.status})`);
}

const session = `github-selftest-${Date.now()}`;
const response = await fetch(`${workerUrl}/beacon`, {
  method: 'POST',
  headers: {
    origin: storefrontOrigin,
    referer: `${storefrontOrigin}/?apgo_em_test=1`,
    'content-type': 'text/plain;charset=UTF-8',
    'user-agent': 'APGO-Layer3-SelfTest/2.0',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    kind: 'selftest',
    m: 'APGO error monitor self-test',
    src: 'theme://apgo-error-monitor',
    url: `${storefrontOrigin}/`,
    sid: session,
  }),
});
if (response.status !== 204) throw new Error(`Layer 3 self-test beacon HTTP ${response.status}: ${await response.text()}`);

const health = await fetch(`${workerUrl}/health`, { headers: { 'user-agent': 'APGO-Layer3-SelfTest/2.0' } });
const body = await health.json().catch(() => ({}));
const siteHealth = body.sites?.find((entry) => entry.siteId === site.id);
const layer3 = siteHealth?.layers?.find((row) => row.layer === 'layer3')
  || body.heartbeats?.find((row) => row.layer === `${site.id}:layer3` || row.layer === 'layer3');
if (!layer3 || layer3.stale || !String(layer3.source).includes('selftest')) {
  throw new Error(`Layer 3 heartbeat was not updated: ${JSON.stringify(body)}`);
}
console.log(JSON.stringify({ ok: true, session, layer3 }, null, 2));
