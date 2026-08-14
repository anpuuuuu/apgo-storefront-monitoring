/* Synthetic health checks for APGO Shopify storefronts.
   Sites come from ../sites.json — every enabled site of type "shopify" gets
   the same three checks: homepage, cart API, and a real-browser add-to-cart
   (the flow that silently died for 4 days in Aug 2026, fix 106eaf5). */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { sites } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
const shopifySites = sites.filter((s) => s.enabled && s.type === 'shopify');

/* Analytics/pixel hosts are aborted so monitoring traffic never pollutes
   GA4 / Meta / TikTok data. The UA also carries an "APGO-HealthCheck" marker
   (see playwright.config.js). */
const BLOCKED_HOSTS = [
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'doubleclick.net',
  'connect.facebook.net',
  'facebook.com/tr',
  'analytics.tiktok.com',
  'clarity.ms',
  'hotjar.com',
  /* Layer-3 error beacons: the snippet already ignores APGO-HealthCheck UAs,
     this is defense-in-depth so synthetic runs can never write error rows. */
  'workers.dev',
];

/* The page may navigate right after add-to-cart (cart drawer, follow-up
   modal, redirect) — treat a destroyed execution context as "poll again". */
async function cartItemCount(page) {
  try {
    return await page.evaluate(() =>
      fetch('/cart.js', { cache: 'no-store' })
        .then((r) => r.json())
        .then((c) => c.item_count)
    );
  } catch (_) {
    return -1;
  }
}

for (const site of shopifySites) {
  test.describe(`[${site.id}] ${site.name}`, () => {
    test.beforeEach(async ({ context }) => {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (BLOCKED_HOSTS.some((h) => url.includes(h))) return route.abort();
        return route.continue();
      });
    });

    test('homepage responds', async ({ page }) => {
      const resp = await page.goto(`${site.baseUrl}/`, { waitUntil: 'domcontentloaded' });
      expect(resp, 'no response from homepage').toBeTruthy();
      expect(resp.status(), 'homepage HTTP status').toBeLessThan(400);

      /* Flip expectErrorMonitor in sites.json once the Layer-3 snippet is
         live — then a missing/broken snippet (e.g. Shogun rewriting a
         layout) fails the hourly run instead of going unnoticed. */
      if (site.expectErrorMonitor) {
        const em = await page.evaluate(() => window.__apgoEM === 1);
        expect(em, 'Layer-3 error-monitor snippet missing or failed to init').toBe(true);
      }
    });

    test('cart API accepts a known variant', async ({ request }) => {
      test.skip(!site.apiCheckVariantId, 'no apiCheckVariantId configured for this site');
      const add = await request.post(`${site.baseUrl}/cart/add.js`, {
        data: { items: [{ id: site.apiCheckVariantId, quantity: 1 }] },
      });
      expect(add.status(), '/cart/add.js HTTP status').toBeLessThan(400);
      const cart = await request.get(`${site.baseUrl}/cart.js`);
      expect(cart.ok(), '/cart.js readable').toBeTruthy();
      const json = await cart.json();
      expect(json.item_count, 'cart item_count after API add').toBeGreaterThan(0);
    });

    for (const product of site.products || []) {
      test(`add to cart on /products/${product.handle}`, async ({ page }) => {
        await page.goto(`${site.baseUrl}/products/${product.handle}`, {
          waitUntil: 'domcontentloaded',
        });

        /* Monitoring products are chosen for deep stock — a visible sold-out
           CTA means the product needs replacing in sites.json, not that the
           site is down, hence the explicit message. */
        const soldOut = page.locator('[data-apgo-cc-sold-out]:visible');
        expect(
          await soldOut.count(),
          'product shows Sold out — replace this monitoring product in sites.json'
        ).toBe(0);

        /* v3 PDP button first, standard theme button as fallback. */
        const addBtn = page
          .locator('[data-apgo-cc-add]:visible, form[action*="/cart/add"] button[name="add"]:visible')
          .first();
        await expect(addBtn, 'Add to cart button visible').toBeVisible({ timeout: 20_000 });

        /* A visible gift picker legitimately blocks add-to-cart until
           giftRequired (2) gifts are picked — do it like a real customer.
           Hidden pickers must NOT block; that was the Aug 2026 bug. */
        const picker = page.locator('[data-apgo-cc-gift-picker]:visible').first();
        if (await picker.isVisible().catch(() => false)) {
          const up = picker
            .locator('[data-apgo-cc-gift-option]:not(.is-soldout) [data-apgo-cc-gift-step="up"]')
            .first();
          if (await up.isVisible().catch(() => false)) {
            await up.click();
            await up.click();
          }
        }

        await addBtn.click();

        await expect
          .poll(() => cartItemCount(page), {
            timeout: 20_000,
            message: 'cart item_count did not increase after clicking Add to cart',
          })
          .toBeGreaterThan(0);
      });
    }
  });
}
