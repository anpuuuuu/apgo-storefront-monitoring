const {
  test,
  expect,
  sites,
  clearCart,
  cartJson,
  addItems,
  waitForCartStable,
  setMarket,
  navigateToCart,
} = require('./monitor-fixture');

async function logOfferTabs(page, checkpoint) {
  const tabs = await page.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => ({
    text: node.textContent?.trim() || '',
    hidden: node.hidden || node.getAttribute('aria-hidden') === 'true',
    selected: node.getAttribute('aria-selected'),
  })));
  console.log(JSON.stringify({ checkpoint, offerTabs: tabs }));
}

async function prepareMarket(page, site, market) {
  await setMarket(page, site.baseUrl, market.countryCode);
  await clearCart(page);
  const currency = await page.evaluate(() => window.Shopify?.currency?.active || '');
  expect(currency).toBe(market.currency);
  await expect(page.locator('body')).toContainText(market.priceMarker);
}

async function dismissGiftModal(page) {
  const modal = page.locator('[data-apgo-cart-gift-modal]');
  if (!await modal.isVisible().catch(() => false)) return;
  await modal.locator('button[data-apgo-cart-gift-close]').first().click({ timeout: 10_000 });
  await expect(modal).toBeHidden({ timeout: 10_000 });
}

async function returnToCartAndClear(page, site) {
  await navigateToCart(page, site.baseUrl);
  await clearCart(page);
}

const requestedMarket = (process.env.MONITOR_MARKET || '').toUpperCase();
const requestedFlow = (process.env.MONITOR_FLOW || '').toLowerCase();

function shouldRun(market, flow) {
  return (!requestedMarket || market.id === requestedMarket)
    && (!requestedFlow || flow === requestedFlow);
}

for (const site of sites) {
  for (const market of site.markets) {
    if (shouldRun(market, 'detergent')) test(`[full][${site.id}][${market.id}] detergent tiers and checkout`, async ({ monitorPage }) => {
      await prepareMarket(monitorPage, site, market);
      const fixture = site.fixtures.detergentPromo;
      const variants = Object.values(fixture.variants).slice(0, 3);
      const tiers = market.detergentPromotionTiers || [];

      for (const [tierIndex, tier] of tiers.entries()) {
        const quantityPerVariant = tier.cartQuantity / variants.length;
        expect(Number.isInteger(quantityPerVariant), 'Detergent fixture quantity must divide evenly across three scents').toBe(true);
        await addItems(monitorPage, variants.map((id) => ({ id, quantity: quantityPerVariant })));
        // AIOD's gift manager runs on the storefront/cart page. Loading the
        // cart before asserting allows its customer-facing automation to
        // finish instead of inspecting the pre-app Cart API response.
        await navigateToCart(monitorPage, site.baseUrl, { settleMs: 8_000 });
        const cart = await waitForCartStable(monitorPage);
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
        const detergentLines = cart.items.filter((item) => Number(item.product_id) === Number(fixture.productId));
        const paidAmount = detergentLines.reduce((sum, item) => sum + item.final_line_price, 0);
        const expectedPaidAmount = tier.expectedPaidQuantity * market.detergentPaidUnitPriceMinor;
        expect(paidAmount, `${market.id} ${tier.cartQuantity}-pack exact paid amount`).toBe(expectedPaidAmount);
        expect(cart.total_price, `${market.id} ${tier.cartQuantity}-pack cart subtotal`).toBe(expectedPaidAmount);
        for (const giftLine of detergentLines.filter((item) => item.final_line_price === 0)) {
          expect(Object.keys(giftLine.properties || {}).length, 'free detergent lines must retain promotion properties').toBeGreaterThan(0);
        }
        await logOfferTabs(monitorPage, `${market.id}-detergent-${tier.cartQuantity}`);
        await expect(monitorPage.getByRole('tab', { name: site.fixtures.cartOffers.detergentTabText })).toBeVisible({ timeout: 20_000 });

        if (market.expectsProtectedDetergentGift) {
          const lockedGift = monitorPage.locator('.cart-items__table-row[data-apgo-gift-line], .apgo-cart-item--gift').first();
          await expect(lockedGift).toBeVisible();
          await expect(lockedGift.locator('[data-cart-item-select]')).toBeDisabled();
        }

        if (tierIndex < tiers.length - 1) await clearCart(monitorPage);
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
      await returnToCartAndClear(monitorPage, site);
    });

    if (shouldRun(market, 'glaze')) test(`[full][${site.id}][${market.id}] Glaze add-on eligibility`, async ({ monitorPage }) => {
      await prepareMarket(monitorPage, site, market);
      const fixture = site.fixtures.glaze;
      const triggerVariant = market.id === 'SG' ? fixture.triggerVariantIds[1] : fixture.triggerVariantIds[0];
      await addItems(monitorPage, [{ id: triggerVariant, quantity: 1 }]);
      await navigateToCart(monitorPage, site.baseUrl, { settleMs: 3_000 });
      await dismissGiftModal(monitorPage);

      const tab = monitorPage.getByRole('tab', { name: fixture.tabText });
      await logOfferTabs(monitorPage, `${market.id}-glaze-trigger`);
      await expect(tab).toBeVisible({ timeout: 20_000 });
      await tab.click();
      // Keep the locator anchored to the first offer card. Filtering by
      // :not([disabled]) made Playwright jump to the next card after the
      // clicked button became disabled, producing a false failure.
      const offerCard = monitorPage.locator(`[data-offer-group]:not([hidden]) [data-offer-card][data-product-id="${fixture.firstOfferProductId}"]`).first();
      await expect(offerCard, 'configured Glaze add-on card').toBeVisible();
      const add = offerCard.locator('[data-offer-add]').first();
      await expect(add, 'eligible Glaze add-on must expose an enabled ADD button').toBeVisible();
      await expect(add).toBeEnabled();
      await add.click();
      await dismissGiftModal(monitorPage);
      await expect(add).toBeDisabled();
      await expect(add).toContainText(/ADDED/i);
      const cartAfterOffer = await waitForCartStable(monitorPage);
      const addOn = cartAfterOffer.items.find((item) => Number(item.variant_id) === Number(fixture.firstOfferVariantId));
      expect(addOn, `Glaze add-on variant ${fixture.firstOfferVariantId}`).toBeTruthy();
      expect(addOn.quantity, 'Glaze add-on quantity limit').toBe(fixture.maxAddonQuantity);
      expect(addOn.final_line_price, `Glaze ${market.id} add-on exact promo amount`).toBe(fixture.firstOfferPriceMinor[market.id]);

      const triggerItem = (await cartJson(monitorPage)).items.find((item) => Number(item.variant_id) === Number(triggerVariant));
      expect(triggerItem, `Glaze trigger variant ${triggerVariant} should exist in cart`).toBeTruthy();
      await monitorPage.evaluate(async (key) => {
        const response = await fetch('/cart/change.js', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: key, quantity: 0 }),
        });
        if (!response.ok) throw new Error(`remove trigger HTTP ${response.status}`);
      }, triggerItem.key);
      await monitorPage.waitForTimeout(1_500);
      await monitorPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(tab).toBeHidden();
      await clearCart(monitorPage);
    });

    if (shouldRun(market, 'recommendations')) test(`[full][${site.id}][${market.id}] recommendations and checkout`, async ({ monitorPage }) => {
      await prepareMarket(monitorPage, site, market);
      await addItems(monitorPage, [{ id: site.fixtures.apiCheckVariantId, quantity: 1 }]);
      await navigateToCart(monitorPage, site.baseUrl, { settleMs: 2_000 });
      await dismissGiftModal(monitorPage);
      // With only one eligible offer group the storefront intentionally hides
      // the tab bar and renders that group as a labelled region. Verify the
      // audience contract instead of requiring editable tab copy to exist.
      const recommendedGroup = monitorPage.locator('[data-offer-group][data-audience="all"]:not([hidden])').first();
      await expect(recommendedGroup).toBeVisible({ timeout: 20_000 });
      await expect(recommendedGroup).toContainText(site.fixtures.cartOffers.recommendedTabText);

      const quickAddCard = recommendedGroup.locator(`[data-offer-card][data-product-id="${site.fixtures.cartOffers.quickAddProductId}"]`).first();
      const quickAdd = quickAddCard.locator('[data-offer-add]').first();
      await expect(quickAdd, 'single default-variant recommendation should expose ADD').toBeVisible();
      await quickAdd.click();
      await expect.poll(async () => (await cartJson(monitorPage)).items.some((item) => Number(item.variant_id) === Number(site.fixtures.cartOffers.quickAddVariantId)))
        .toBe(true);

      const selectOptions = recommendedGroup.locator(`a.cart-offers-tabs__select-options[href*="/products/${site.fixtures.cartOffers.selectOptionsHandle}"]`).first();
      await expect(selectOptions, 'named/multi-variant recommendation should expose SELECT OPTIONS').toBeVisible();
      await Promise.all([
        monitorPage.waitForURL(new RegExp(`/products/${site.fixtures.cartOffers.selectOptionsHandle}`), { timeout: 30_000 }),
        selectOptions.click(),
      ]);
      await navigateToCart(monitorPage, site.baseUrl);
      const cartBefore = await cartJson(monitorPage);
      const checkout = monitorPage.locator('button[name="checkout"], a[href*="/checkout"]').first();
      await expect(checkout).toBeVisible();
      await Promise.all([
        monitorPage.waitForURL(/checkout|checkouts/i, { timeout: 45_000 }),
        checkout.click(),
      ]);
      expect(new RegExp(site.expected.checkoutHostPattern, 'i').test(new URL(monitorPage.url()).hostname)).toBe(true);
      expect(cartBefore.item_count).toBeGreaterThanOrEqual(2);
      expect(cartBefore.currency).toBe(market.currency);
      await returnToCartAndClear(monitorPage, site);
    });
  }
}
