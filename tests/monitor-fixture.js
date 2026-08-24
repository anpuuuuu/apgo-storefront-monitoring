const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
const sites = config.sites.filter((site) => site.enabled && site.type === 'shopify');
const monitorSuite = process.env.MONITOR_SUITE || 'light';

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
    // Runs before every storefront document. The window marker is used by the
    // current snippet; the in-page UA suffix keeps older cached documents inert
    // without changing the browser-shaped HTTP User-Agent Shopify receives.
    await page.addInitScript(() => {
      window.__apgoHealthCheck = true;
      const browserUserAgent = navigator.userAgent;
      try {
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          get: () => `${browserUserAgent} APGO-HealthCheck/2.0`,
        });
      } catch (_) {}
    });
    page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => networkLog.push(`FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
    page.on('response', (response) => {
      if (response.status() >= 400) networkLog.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (config.monitoring.blockedAnalyticsHosts.some((host) => url.includes(host))) return route.abort('blockedbyclient');
      // Light checks validate the theme's own product/cart controls. Loading
      // AIOD here adds several background cart polls which can rate-limit the
      // synthetic session before its single UI add. Full commerce checks keep
      // AIOD enabled because those checks explicitly verify its discounts and
      // free gifts.
      if (monitorSuite === 'light' && /\/extensions\/.*aiod-automatic-discounts-/i.test(url)) {
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('console.log', { body: Buffer.from(consoleLog.join('\n')), contentType: 'text/plain' });
      await testInfo.attach('network.log', { body: Buffer.from(networkLog.join('\n')), contentType: 'text/plain' });
      try {
        const cart = await cartRequest(page, '/cart.js', { cache: 'no-store' });
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
    const waits = [0, 15_000, 45_000, 90_000];
    let lastStatus = 0;
    let retryAfterMs = 0;
    for (const wait of waits) {
      const delay = Math.max(wait, retryAfterMs);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const response = await fetch(requestUrl, requestInit);
      lastStatus = response.status;
      const text = await response.text();
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : 0;
        retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : Math.max(0, dateDelay || 0);
        continue;
      }
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
      if (!response.ok) throw new Error(`${requestUrl} HTTP ${response.status}: ${JSON.stringify(body)}`);
      return body;
    }
    throw new Error(`MONITOR_RATE_LIMIT: ${requestUrl} remained rate limited after customer-like retries (HTTP ${lastStatus})`);
  }, { requestUrl: url, requestInit: init });
}

function addResponseVariantIds(body) {
  const entries = Array.isArray(body?.items) ? body.items : [body];
  return entries
    .map((item) => Number(item?.variant_id || item?.id || 0))
    .filter(Boolean);
}

async function clickCartAdd(page, button, { expectedVariantId, timeoutMs = 20_000 } = {}) {
  const waits = [0, 15_000, 45_000, 90_000];
  let lastStatus = 0;
  let retryAfterMs = 0;

  for (const wait of waits) {
    const delay = Math.max(wait, retryAfterMs);
    if (delay) await page.waitForTimeout(delay);
    await expect(button).toBeEnabled({ timeout: timeoutMs });

    const responsePromise = page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return url.pathname === '/cart/add.js' && response.request().method() === 'POST';
      } catch (_) {
        return false;
      }
    }, { timeout: timeoutMs });

    await button.click();
    const response = await responsePromise;
    lastStatus = response.status();
    const text = await response.text();
    if (lastStatus === 429) {
      const headers = await response.headers();
      const retryAfter = headers['retry-after'];
      const seconds = Number(retryAfter);
      const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : 0;
      retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : Math.max(0, dateDelay || 0);
      continue;
    }

    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(`/cart/add.js returned non-JSON HTTP ${lastStatus}: ${text.slice(0, 300)}`);
    }
    if (!response.ok()) throw new Error(`/cart/add.js HTTP ${lastStatus}: ${JSON.stringify(body)}`);

    const addedVariantIds = addResponseVariantIds(body);
    expect(addedVariantIds.length, 'UI add response should contain at least one added variant').toBeGreaterThan(0);
    if (expectedVariantId) {
      expect(
        addedVariantIds,
        `UI add response should include selected variant ${expectedVariantId}`
      ).toContain(Number(expectedVariantId));
    }
    return body;
  }

  throw new Error(`MONITOR_RATE_LIMIT: /cart/add.js remained rate limited after customer-like retries (HTTP ${lastStatus})`);
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
  const target = siteUrl(baseUrl, `/products/${encodeURIComponent(handle)}`);
  const waits = [0, 5_000, 15_000, 45_000];
  let response;
  for (const wait of waits) {
    if (wait) await page.waitForTimeout(wait);
    response = await page.goto(target, { waitUntil: 'domcontentloaded' });
    if (response?.status() !== 429) break;
  }
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
  clickCartAdd,
  waitForCartStable,
  setMarket,
  navigateToCart,
  siteUrl,
  ensureAvailable,
};
