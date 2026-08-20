const {
  test,
  expect,
  sites,
  clearCart,
  cartJson,
  addItems,
  setMarket,
  siteUrl,
} = require('./monitor-fixture');

for (const site of sites) {
  for (const market of site.markets) {
    test(`[full][${site.id}][${market.id}] isolated commerce journey`, async ({ monitorPage }) => {
      await monitorPage.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
      await setMarket(monitorPage, site.baseUrl, market.countryCode);

      await test.step('market currency and copy', async () => {
        const currency = await monitorPage.evaluate(() => window.Shopify?.currency?.active || '');
        expect(currency).toBe(market.currency);
        await expect(monitorPage.locator('body')).toContainText(market.priceMarker);
      });

      await test.step('detergent mixed scent 6+3 and protected gift', async () => {
        const fixture = site.fixtures.detergentPromo;
        const variants = Object.values(fixture.variants).slice(0, 3);
        await addItems(monitorPage, variants.map((id) => ({ id, quantity: 2 })));
        await monitorPage.waitForTimeout(6_000);
        const cart = await cartJson(monitorPage);
        const paidQuantity = cart.items.filter((item) => Number(item.product_id) === Number(fixture.productId) && item.final_line_price > 0)
          .reduce((sum, item) => sum + item.quantity, 0);
        expect(paidQuantity).toBe(fixture.minimumPaidQuantity);
        const giftQuantity = cart.items.filter((item) => item.final_line_price === 0 || Object.keys(item.properties || {}).some((key) => site.expected.freeGiftPropertyNames.includes(key)))
          .reduce((sum, item) => sum + item.quantity, 0);
        expect(giftQuantity, 'AIOD 6+3 gift lines were not created').toBeGreaterThanOrEqual(fixture.expectedGiftQuantity);
        await monitorPage.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
        await expect(monitorPage.getByRole('tab', { name: site.fixtures.cartOffers.detergentTabText })).toBeVisible();
        const lockedGift = monitorPage.locator('.cart-items__table-row[data-apgo-gift-line], .apgo-cart-item--gift').first();
        await expect(lockedGift).toBeVisible();
        await expect(lockedGift.locator('[data-cart-item-select]')).toBeDisabled();

        const checkout = monitorPage.locator('button[name="checkout"], a[href*="/checkout"]').first();
        await expect(checkout).toBeVisible();
        await Promise.all([
          monitorPage.waitForURL(/checkout|checkouts/i, { timeout: 45_000 }),
          checkout.click(),
        ]);
        expect(new RegExp(site.expected.checkoutHostPattern, 'i').test(new URL(monitorPage.url()).hostname)).toBe(true);
        await expect(monitorPage.locator('body')).toContainText(/Laundry Detergent|Detergent Promo/i);
        await expect(monitorPage.locator('body')).toContainText(market.priceMarker);
        // Deliberately stop at the checkout summary: no address, payment or
        // order submission is performed by this monitor.
        await monitorPage.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
        await clearCart(monitorPage);
      });

      await test.step('Glaze trigger controls add-on eligibility and maximum', async () => {
        const fixture = site.fixtures.glaze;
        const triggerVariant = market.id === 'SG' ? fixture.triggerVariantIds[1] : fixture.triggerVariantIds[0];
        await addItems(monitorPage, [{ id: triggerVariant, quantity: 1 }]);
        await monitorPage.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
        const tab = monitorPage.getByRole('tab', { name: fixture.tabText });
        await expect(tab).toBeVisible();
        await tab.click();
        const add = monitorPage.locator('[data-offer-group]:not([hidden]) [data-offer-add]:not([disabled])').first();
        if (await add.isVisible().catch(() => false)) {
          await add.click();
          await expect(add).toBeDisabled();
          await expect(add).toContainText(/ADDED|ADD AGAIN/i);
        }
        const triggerItem = (await cartJson(monitorPage)).items.find((item) => Number(item.variant_id) === Number(triggerVariant));
        await monitorPage.evaluate(async (key) => {
          const response = await fetch('/cart/change.js', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: key, quantity: 0 }) });
          if (!response.ok) throw new Error(`remove trigger HTTP ${response.status}`);
        }, triggerItem.key);
        await monitorPage.waitForTimeout(1_500);
        await monitorPage.reload({ waitUntil: 'domcontentloaded' });
        await expect(tab).toBeHidden();
        await clearCart(monitorPage);
      });

      await test.step('recommended tab and checkout summary without order', async () => {
        await addItems(monitorPage, [{ id: site.fixtures.apiCheckVariantId, quantity: 1 }]);
        await monitorPage.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
        await expect(monitorPage.getByRole('tab', { name: site.fixtures.cartOffers.recommendedTabText })).toBeVisible();
        const cartBefore = await cartJson(monitorPage);
        const checkout = monitorPage.locator('button[name="checkout"], a[href*="/checkout"]').first();
        await expect(checkout).toBeVisible();
        await Promise.all([
          monitorPage.waitForURL(/checkout|checkouts/i, { timeout: 45_000 }),
          checkout.click(),
        ]);
        expect(new RegExp(site.expected.checkoutHostPattern, 'i').test(new URL(monitorPage.url()).hostname)).toBe(true);
        expect(cartBefore.item_count).toBe(1);
        expect(cartBefore.currency).toBe(market.currency);
      });
    });
  }
}
