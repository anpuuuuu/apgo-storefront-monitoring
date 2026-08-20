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

      await test.step('detergent market tiers and protected gifts', async () => {
        const fixture = site.fixtures.detergentPromo;
        const variants = Object.values(fixture.variants).slice(0, 3);
        const tiers = market.detergentPromotionTiers || [];

        for (const [tierIndex, tier] of tiers.entries()) {
          const quantityPerVariant = tier.cartQuantity / variants.length;
          expect(Number.isInteger(quantityPerVariant), 'Detergent fixture quantity must divide evenly across three scents').toBe(true);
          await addItems(monitorPage, variants.map((id) => ({ id, quantity: quantityPerVariant })));
          // AIOD's gift manager runs on the storefront/cart page. Loading the
          // cart before asserting allows its normal customer-facing automation
          // to finish instead of inspecting the pre-app Cart API response.
          await monitorPage.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
          await monitorPage.waitForTimeout(8_000);
          const cart = await cartJson(monitorPage);
          console.log(JSON.stringify({
            checkpoint: `detergent-tier-${tier.cartQuantity}`,
            market: market.id,
            currency: cart.currency,
            items: cart.items.map((item) => ({
              productId: item.product_id,
              variantId: item.variant_id,
              quantity: item.quantity,
              finalLinePrice: item.final_line_price,
              propertyKeys: Object.keys(item.properties || {}),
            })),
          }));
          const paidQuantity = cart.items.filter((item) => Number(item.product_id) === Number(fixture.productId) && item.final_line_price > 0)
            .reduce((sum, item) => sum + item.quantity, 0);
          expect(paidQuantity, `${market.id} ${tier.cartQuantity}-pack paid quantity`).toBe(tier.expectedPaidQuantity);
          const giftQuantity = cart.items.filter((item) => Number(item.product_id) === Number(fixture.productId)
              && (item.final_line_price === 0 || Object.keys(item.properties || {}).some((key) => site.expected.freeGiftPropertyNames.includes(key))))
            .reduce((sum, item) => sum + item.quantity, 0);
          expect(giftQuantity, `${market.id} ${tier.cartQuantity}-pack gift quantity`).toBe(tier.expectedGiftQuantity);
          await expect(monitorPage.getByRole('tab', { name: site.fixtures.cartOffers.detergentTabText })).toBeVisible();

          if (market.expectsProtectedDetergentGift) {
            const lockedGift = monitorPage.locator('.cart-items__table-row[data-apgo-gift-line], .apgo-cart-item--gift').first();
            await expect(lockedGift).toBeVisible();
            await expect(lockedGift.locator('[data-cart-item-select]')).toBeDisabled();
          }

          if (tierIndex < tiers.length - 1) {
            await clearCart(monitorPage);
          }
        }

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
