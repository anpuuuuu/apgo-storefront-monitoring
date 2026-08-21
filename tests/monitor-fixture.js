const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
const sites = config.sites.filter((site) => site.enabled && site.type === 'shopify');

class TestConfigStaleError extends Error {
  constructor(message) {
    super(`TEST_CONFIG_STALE: ${message}`);
    this.name = 'TestConfigStaleError';
  }
}

const test = base.extend({
  monitorPage: async ({ page, context }, use, testInfo) => {
    const consoleLog = [];
    const networkLog = [];
    page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => networkLog.push(`FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
    page.on('response', (response) => {
      if (response.status() >= 400) networkLog.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (config.monitoring.blockedAnalyticsHosts.some((host) => url.includes(host))) return route.abort('blockedbyclient');
      return route.continue();
    });
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('console.log', { body: Buffer.from(consoleLog.join('\n')), contentType: 'text/plain' });
      await testInfo.attach('network.log', { body: Buffer.from(networkLog.join('\n')), contentType: 'text/plain' });
      try {
        const cart = await page.evaluate(() => fetch('/cart.js', { cache: 'no-store' }).then((response) => response.json()));
        await testInfo.attach('final-cart.json', { body: Buffer.from(JSON.stringify(cart, null, 2)), contentType: 'application/json' });
      } catch (error) {
        await testInfo.attach('final-cart-error.txt', { body: Buffer.from(error.message), contentType: 'text/plain' });
      }
    }
  },
});

async function clearCart(page) {
  await cartRequest(page, '/cart/clear.js', { method: 'POST', headers: { accept: 'application/json' } });
  await page.waitForTimeout(1_500);
}

async function cartJson(page) {
  return cartRequest(page, '/cart.js', { cache: 'no-store' });
}

function cartSignature(cart) {
  return JSON.stringify((cart.items || []).map((item) => ({
    key: item.key,
    quantity: item.quantity,
    finalLinePrice: item.final_line_price,
    properties: item.properties || {},
  })));
}

async function waitForCartStable(page, { timeoutMs = 20_000, intervalMs = 1_500, stableSamples = 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  let latest;
  while (Date.now() < deadline) {
    latest = await cartJson(page);
    const signature = cartSignature(latest);
    stable = signature === previous ? stable + 1 : 1;
    if (stable >= stableSamples) return latest;
    previous = signature;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`Cart did not stabilize within ${timeoutMs} ms: ${cartSignature(latest || { items: [] })}`);
}

async function addItems(page, items) {
  const body = await cartRequest(page, '/cart/add.js', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ items }),
  });
  await page.waitForTimeout(1_500);
  return body;
}

async function cartRequest(page, url, init = {}) {
  return page.evaluate(async ({ requestUrl, requestInit }) => {
    const waits = [0, 5_000, 15_000, 45_000];
    let lastStatus = 0;
    for (const wait of waits) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await fetch(requestUrl, requestInit);
      lastStatus = response.status;
      const text = await response.text();
      if (response.status === 429) continue;
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
      if (!response.ok) throw new Error(`${requestUrl} HTTP ${response.status}: ${JSON.stringify(body)}`);
      return body;
    }
    throw new Error(`${requestUrl} remained rate limited after retries (HTTP ${lastStatus})`);
  }, { requestUrl: url, requestInit: init });
}

function siteUrl(baseUrl, pathname = '/') {
  return new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`).href;
}

async function setMarket(page, baseUrl, countryCode) {
  await page.goto(siteUrl(baseUrl), { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async (country) => {
    const form = new URLSearchParams({
      form_type: 'localization',
      utf8: '\u2713',
      _method: 'PUT',
      country_code: country,
      return_to: '/',
    });
    const waits = [0, 5_000, 15_000, 45_000];
    let status = 0;
    for (const wait of waits) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await fetch('/localization', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'follow',
      });
      status = response.status;
      if (status !== 429) return { ok: response.ok, status };
    }
    return { ok: false, status };
  }, countryCode);
  if (result.status === 429) throw new Error(`Shopify localization remained rate limited for ${countryCode}`);
  if (!result.ok) throw new TestConfigStaleError(`Shopify localization rejected ${countryCode} (HTTP ${result.status})`);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function navigateToCart(page, baseUrl, { settleMs = 1_500 } = {}) {
  const target = siteUrl(baseUrl, '/cart');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (new URL(page.url()).pathname !== '/cart') {
        await page.goto(target, { waitUntil: 'domcontentloaded' });
      } else {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    } catch (error) {
      lastError = error;
      const interrupted = /interrupted by another navigation|ERR_ABORTED|Navigation failed because page was closed/i.test(error.message);
      if (!interrupted) throw error;
    }
    if (new URL(page.url()).pathname === '/cart') {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (settleMs) await page.waitForTimeout(settleMs);
      return;
    }
    await page.waitForTimeout(attempt * 1_000);
  }
  throw new Error(`Could not reach cart after AIOD navigation settled: ${lastError?.message || page.url()}`);
}

async function ensureAvailable(page, baseUrl, handle, selector) {
  const response = await page.goto(siteUrl(baseUrl, `/products/${encodeURIComponent(handle)}`), { waitUntil: 'domcontentloaded' });
  if (!response || response.status() >= 400) throw new TestConfigStaleError(`product ${handle} returned HTTP ${response?.status() || 'network'}`);
  if (await page.locator('[data-apgo-cc-sold-out]:visible, button:has-text("Sold out"):visible').count()) {
    throw new TestConfigStaleError(`product ${handle} is sold out`);
  }
  const locator = page.locator(selector).first();
  if (!await locator.isVisible().catch(() => false)) throw new TestConfigStaleError(`${handle} no longer exposes selector ${selector}`);
  return locator;
}

module.exports = {
  test,
  expect,
  sites,
  TestConfigStaleError,
  clearCart,
  cartJson,
  addItems,
  waitForCartStable,
  setMarket,
  navigateToCart,
  siteUrl,
  ensureAvailable,
};
