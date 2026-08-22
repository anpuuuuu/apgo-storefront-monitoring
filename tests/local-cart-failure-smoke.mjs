import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const pickerScript = `${repoRoot}assets/apgo-cc-pdp-picker.js`;
const cartItemsScript = `${repoRoot}assets/component-cart-items.js`;
const cartItemsSource = readFileSync(cartItemsScript, 'utf8');
const baseUrl = 'https://apgo.my';
const normalV3Handle = 'apgo-pro-car-wash-towel-l-160cm-x-60cm';
const blockedHosts = [
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'clarity.ms',
  'monorail-edge.shopifysvc.com',
];

const browser = await chromium.launch({ headless: true });

async function newPage() {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (blockedHosts.some((host) => url.includes(host))) return route.abort('blockedbyclient');
    return route.continue();
  });
  return { context, page };
}

async function injectLocalPicker(page) {
  await page.route('**/assets/apgo-cc-pdp-picker.js*', (route) => route.abort('blockedbyclient'));
  await page.goto(`${baseUrl}/products/${normalV3Handle}`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: pickerScript });
  await page.waitForFunction(() => document.querySelector('[data-apgo-cc-add]'));
}

async function testPdpRequestLock() {
  const { context, page } = await newPage();
  let addRequests = 0;
  await page.route('**/cart/add.js*', async (route) => {
    addRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1 }) });
  });
  await page.route('**/cart.js*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ item_count: 1, items: [], total_price: 0 }),
  }));

  await injectLocalPicker(page);
  const addButton = page.locator('[data-apgo-cc-add]:visible').first();
  const buyButton = page.locator('[data-apgo-cc-buy-now]:visible').first();
  await addButton.click();
  await page.waitForFunction(() => document.querySelector('[data-apgo-cc-add]')?.disabled === true);
  assert.equal(await buyButton.isDisabled(), true, 'Buy now must share the Add-to-cart request lock');
  await page.evaluate(() => document.querySelector('[data-apgo-cc-buy-now]')?.click());
  await page.waitForTimeout(800);
  assert.equal(addRequests, 1, 'Rapid cross-button clicks must produce one cart write');
  await context.close();
}

async function testPdpNetworkFailureCopy() {
  const { context, page } = await newPage();
  await page.route('**/cart/add.js*', (route) => route.abort('failed'));
  await injectLocalPicker(page);

  const addButton = page.locator('[data-apgo-cc-add]:visible').first();
  await addButton.click();
  const toast = page.locator('.apgo-cart-success-toast--error').first();
  await toast.waitFor({ state: 'visible' });
  const copy = await toast.innerText();
  assert.match(copy, /Unable to add to cart/i);
  assert.match(copy, /check your connection and try again/i);
  assert.doesNotMatch(copy, /Failed to fetch/i);
  assert.equal(await addButton.isEnabled(), true, 'Purchase actions must recover after a failed request');
  await context.close();
}

async function testCartQuantityFailureRecovery() {
  const { context, page } = await newPage();
  let changeRequests = 0;
  let sectionRequests = 0;
  await page.route('**/assets/component-cart-items.js*', (route) => route.abort('blockedbyclient'));
  await page.goto(`${baseUrl}/cart`, { waitUntil: 'domcontentloaded' });
  const imports = JSON.parse(await page.locator('script[type="importmap"]').textContent()).imports;
  let resolvedCartItemsSource = cartItemsSource;
  for (const [specifier, assetUrl] of Object.entries(imports)) {
    const absoluteUrl = assetUrl.startsWith('//') ? `https:${assetUrl}` : assetUrl;
    resolvedCartItemsSource = resolvedCartItemsSource
      .replaceAll(`'${specifier}'`, `'${absoluteUrl}'`)
      .replaceAll(`"${specifier}"`, `"${absoluteUrl}"`);
  }
  const localModuleUrl = `${baseUrl}/cdn/shop/files/apgo-local-component-cart-items.js`;
  await page.route(localModuleUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: resolvedCartItemsSource,
  }));
  const moduleResult = await page.evaluate(async (url) => {
    try {
      await import(url);
      return { defined: !!customElements.get('cart-items-component') };
    } catch (error) {
      return { defined: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, localModuleUrl);
  assert.equal(moduleResult.defined, true, `Local cart module did not load: ${moduleResult.error || 'unknown error'}`);
  await page.route('**/cart/change*', (route) => {
    changeRequests += 1;
    return route.abort('failed');
  });
  await page.route(/[?&]section_id=apgo-test-cart(?:&|$)/, (route) => {
    sectionRequests += 1;
    return route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<div id="shopify-section-apgo-test-cart"><div data-refreshed-quantity="1">Server quantity: 1</div></div>',
    });
  });
  await page.evaluate(() => {
    window.Theme = window.Theme || {};
    window.Theme.routes = window.Theme.routes || {};
    window.Theme.routes.cart_change_url = '/cart/change.js';
    window.apgoCartToastEnsure = function () {
      var toast = document.querySelector('[data-apgo-cart-toast]');
      if (!toast) {
        toast = document.createElement('div');
        toast.setAttribute('data-apgo-cart-toast', '');
        document.body.appendChild(toast);
      }
      return toast;
    };
    document.querySelectorAll('cart-items-component').forEach((component) => component.remove());
    const section = document.createElement('div');
    section.id = 'shopify-section-apgo-test-cart';
    section.innerHTML = `
      <cart-items-component data-section-id="apgo-test-cart">
        <span ref="cartItemCount">1</span>
        <table><tbody>
          <tr class="cart-items__table-row" ref="cartItemRows[]">
            <td>
              <div ref="quantitySelectors[]"><input name="updates[]" value="2" data-cart-line="1"></div>
            </td>
            <td class="hidden" ref="cartItemErrorContainer-1"><span ref="cartItemError-1"></span></td>
          </tr>
        </tbody></table>
      </cart-items-component>`;
    document.body.appendChild(section);
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const component = document.querySelector('cart-items-component[data-section-id="apgo-test-cart"]');
    if (!component || typeof component.updateQuantity !== 'function') {
      throw new Error('Synthetic cart component was not upgraded');
    }
    component.updateQuantity({ line: 1, quantity: 2, action: 'change' });
  });
  try {
    await page.waitForFunction(() => document.querySelector('[data-apgo-cart-toast]')?.textContent?.includes('refreshed'));
  } catch (error) {
    console.error('Cart failure diagnostics:', {
      changeRequests,
      sectionRequests,
      toast: await page.locator('[data-apgo-cart-toast]').allTextContents(),
    });
    throw error;
  }
  assert.equal(changeRequests, 1);
  assert.equal(sectionRequests, 1);
  assert.equal(await page.locator('[data-refreshed-quantity]').getAttribute('data-refreshed-quantity'), '1');
  assert.match(await page.locator('[data-apgo-cart-toast]').innerText(), /cart has been refreshed/i);
  await context.close();
}

try {
  await testPdpRequestLock();
  console.log('PASS PDP global request lock');
  await testPdpNetworkFailureCopy();
  console.log('PASS PDP friendly network failure');
  await testCartQuantityFailureRecovery();
  console.log('PASS cart quantity failure recovery');
} finally {
  await browser.close();
}
