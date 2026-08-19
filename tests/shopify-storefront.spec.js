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
      /* Shopify's cart-write backend can 503 for ~a minute (seen 2026-08-19,
         self-healed). Retry 5xx/network errors with real 20s gaps so only a
         sustained outage alerts; a 4xx means a config problem (dead variant)
         and fails immediately. */
      let add = null;
      let attempt;
      for (attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 20_000));
        try {
          add = await request.post(`${site.baseUrl}/cart/add.js`, {
            data: { items: [{ id: site.apiCheckVariantId, quantity: 1 }] },
          });
        } catch (_) {
          add = null;
          continue;
        }
        if (add.status() < 500) break;
      }
      expect(add, '/cart/add.js unreachable (network error on 3 attempts over ~40s)').toBeTruthy();
      expect(
        add.status(),
        `/cart/add.js HTTP status (final of ${Math.min(attempt, 3)} attempt(s))`
      ).toBeLessThan(400);
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

        /* One in-test write retry: a ~1-min Shopify cart-write blip
           (2026-08-19: POST /cart/add.js 503ed, self-healed) must not page
           anyone. Still empty after 20s → pause 10s, click again, poll 20s
           more; with Playwright's own retry this tolerates ~2 min of blip.
           A second click can at worst add a duplicate line to a throwaway
           session cart. */
        let count = 0;
        const pollCart = async (ms) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            count = await cartItemCount(page);
            if (count > 0) return true;
            await page.waitForTimeout(1_000);
          }
          return false;
        };
        if (!(await pollCart(20_000))) {
          await page.waitForTimeout(10_000);
          if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
          await pollCart(20_000);
        }
        expect(
          count,
          'cart item_count did not increase after clicking Add to cart (2 clicks ~30s apart)'
        ).toBeGreaterThan(0);
      });
    }
  });
}
