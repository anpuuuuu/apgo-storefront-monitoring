const {
  test,
  expect,
  sites,
  clearCart,
  cartJson,
  addItems,
  clickCartAdd,
  siteUrl,
  ensureAvailable,
} = require('./monitor-fixture');

for (const site of sites) {
  test(`[light][${site.id}] homepage, navigation and Layer 3 bootstrap`, async ({ monitorPage }) => {
    await monitorPage.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
    await expect(monitorPage.locator('header, [data-header-section]').first()).toBeVisible();
    await expect(monitorPage.locator('a[href*="/collections"]:visible, a[href*="/pages"]:visible').first()).toBeVisible();
    if (site.expectErrorMonitor) {
      await expect.poll(
        () => monitorPage.evaluate(() => window.__apgoEM),
        { message: 'Layer 3 monitor snippet is missing' }
      ).toBe('excluded');
    }
  });

  test(`[light][${site.id}] Cart API and cart quantity/removal`, async ({ monitorPage }) => {
    await monitorPage.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
    await addItems(monitorPage, [{ id: site.fixtures.apiCheckVariantId, quantity: 2 }]);
    let cart = await cartJson(monitorPage);
    expect(cart.items.some((item) => Number(item.variant_id) === Number(site.fixtures.apiCheckVariantId))).toBe(true);
    await monitorPage.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
    const row = monitorPage.locator(`.cart-items__table-row[data-variant-id="${site.fixtures.apiCheckVariantId}"]`).first();
    await expect(row).toBeVisible();
    await row.locator('.quantity-minus, button[name="minus"]').first().click();
    await expect.poll(async () => (await cartJson(monitorPage)).items.find((item) => Number(item.variant_id) === Number(site.fixtures.apiCheckVariantId))?.quantity).toBe(1);
    cart = await cartJson(monitorPage);
    expect(cart.total_price).toBe(cart.items.reduce((sum, item) => sum + item.final_line_price, 0));
    await row.locator('.cart-items__remove, [data-cart-remove], button[aria-label*="Remove" i]').first().click();
    await expect.poll(async () => (await cartJson(monitorPage)).items.some((item) => Number(item.variant_id) === Number(site.fixtures.apiCheckVariantId))).toBe(false);
    await clearCart(monitorPage);
  });

  for (const fixtureName of ['normalV3', 'giftPickerV3']) {
    test(`[light][${site.id}] ${fixtureName} PDP adds the selected product`, async ({ monitorPage }) => {
      const fixture = site.fixtures[fixtureName];
      const add = await ensureAvailable(
        monitorPage,
        site.baseUrl,
        fixture.handle,
        '[data-apgo-cc-add]:visible, form[action*="/cart/add"] button[name="add"]:visible'
      );
      const picker = monitorPage.locator('[data-apgo-cc-gift-picker]:visible').first();
      if (await picker.isVisible().catch(() => false)) {
        const plus = picker.locator('[data-apgo-cc-gift-option]:not(.is-soldout) [data-apgo-cc-gift-step="up"]').first();
        if (await plus.isVisible().catch(() => false)) {
          await plus.click();
          await plus.click();
        }
      }
      await clickCartAdd(monitorPage, add);
      await clearCart(monitorPage);
    });
  }

  test(`[light][${site.id}] apgo-v1s-plus variant, image, total price and cart variant`, async ({ monitorPage }) => {
    const fixture = site.fixtures.laundryPdp;
    const lavenderValue = fixture.optionValues?.Lavender || 'Lavender';
    await ensureAvailable(monitorPage, site.baseUrl, fixture.handle, 'main h1:visible');
    const lavender = monitorPage.locator(`input[data-apgo-option-input][value="${lavenderValue}"]`).first();
    const lavenderLabel = monitorPage.locator(`label:visible:has(input[data-apgo-option-input][value="${lavenderValue}"])`).first();
    expect(await lavender.count(), 'Lavender radio input must exist').toBe(1);
    await expect(lavenderLabel, 'Lavender visible option label').toBeVisible();
    await lavenderLabel.click();
    await expect(lavender).toBeChecked();
    await expect(lavenderLabel).toHaveClass(/active/);
    await expect.poll(() => monitorPage.evaluate(() => Number(window.currentVariantId || document.querySelector('form[action*="/cart/add"] input[name="id"]')?.value))).toBe(Number(fixture.variants.Lavender));
    const price = monitorPage.locator('[data-apgo-price]').first();
    const beforePrice = await price.textContent();
    await monitorPage.locator('[data-apgo-qty="up"]').first().click();
    await monitorPage.locator('[data-apgo-qty="up"]').first().click();
    await expect.poll(() => price.textContent()).not.toBe(beforePrice);
    await clickCartAdd(monitorPage, monitorPage.locator('[data-apgo-add]:visible').first(), {
      expectedVariantId: fixture.variants.Lavender,
    });
    await clearCart(monitorPage);
  });
}
