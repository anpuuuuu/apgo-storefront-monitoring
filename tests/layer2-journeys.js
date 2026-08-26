const {
  expect,
  TestConfigStaleError,
  clearCart,
  cartJson,
  clickCartAdd,
  setMarket,
  navigateToCart,
  siteUrl,
  ensureAvailable,
} = require('./monitor-fixture');

function moneyMinor(text) {
  const matches = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d{1,2})?/g);
  if (!matches?.length) return NaN;
  return Math.round(Number(matches[matches.length - 1]) * 100);
}

async function prepareMarket(page, site, market) {
  await setMarket(page, site.baseUrl, market.countryCode);
  await clearCart(page);
  const currency = await page.evaluate(() => window.Shopify?.currency?.active || '');
  expect(currency, `${site.id} storefront currency`).toBe(market.currency);
  await expect(page.locator('body')).toContainText(market.priceMarker);
}

async function assertHomepage(page, site, { followCampaign = false } = {}) {
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  const challenge = page.getByText(/connection needs to be verified|verify you are human/i).first();
  if (await challenge.isVisible().catch(() => false)) {
    throw new Error('MONITOR_ACCESS_CHALLENGE: Cloudflare challenged the synthetic browser before storefront rendering');
  }
  await expect(page.locator('header, [data-header-section]').first()).toBeVisible();
  for (const link of site.criticalLinks || []) {
    await expect(page.locator(`a[href*="${link.homepageHrefContains}"]:visible`).first(), `${link.id} homepage link`).toBeVisible();
  }
  if (site.expectErrorMonitor) {
    await expect.poll(() => page.evaluate(() => window.__apgoEM), {
      message: 'Layer 3 monitor did not exclude the health-check session',
    }).toBe('excluded');
  }
  if (followCampaign) {
    const campaign = (site.criticalLinks || []).find((link) => link.id === 'golden-bull');
    if (!campaign) throw new TestConfigStaleError(`${site.id} has no golden-bull critical link`);
    await page.locator(`a[href*="${campaign.homepageHrefContains}"]:visible`).first().click();
    await page.waitForURL(new RegExp(campaign.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), { timeout: 45_000 });
    await expect(page.locator('[data-apgo-campaign-section]:visible').first()).toBeVisible({ timeout: 30_000 });
  }
}

async function assertHeaderCartCount(page, expectedCount) {
  const bubble = page.locator('[data-testid="cart-bubble"]:visible').first();
  await expect.poll(async () => {
    const text = await bubble.textContent().catch(() => '');
    return Number(String(text).trim() || 0);
  }, { message: 'Header cart count did not match Shopify cart item_count' }).toBe(expectedCount);
}

async function addNormalV3(page, site) {
  const fixture = site.fixtures.normalV3;
  const add = await ensureAvailable(
    page,
    site.baseUrl,
    fixture.handle,
    '[data-apgo-cc-add]:visible, [data-apgo-cc-buybar-add]:visible, form[action*="/cart/add"] button[name="add"]:visible'
  );
  await clickCartAdd(page, add, { expectedVariantId: fixture.expectedVariantId });
  const cart = await cartJson(page);
  const item = cart.items.find((entry) => Number(entry.variant_id) === Number(fixture.expectedVariantId));
  expect(item, `normal V3 should add variant ${fixture.expectedVariantId}`).toBeTruthy();
  await assertHeaderCartCount(page, cart.item_count);
  return cart;
}

async function addGiftPickerV3(page, site, market = null) {
  const fixture = site.fixtures.giftPickerV3;
  const marketId = market?.id || 'MY';
  const handle = fixture.marketHandles?.[marketId] || fixture.handle;
  const expectedVariantId = fixture.marketVariantIds?.[marketId] || fixture.expectedVariantId;
  const add = await ensureAvailable(
    page,
    site.baseUrl,
    handle,
    '[data-apgo-cc-add]:visible, [data-apgo-cc-buybar-add]:visible, form[action*="/cart/add"] button[name="add"]:visible'
  );
  const picker = page.locator('[data-apgo-cc-gift-picker]:visible').first();
  await expect(picker).toBeVisible();
  expect(Number(await picker.getAttribute('data-gift-count'))).toBe(fixture.requiredGiftQuantity);
  const options = picker.locator('[data-apgo-cc-gift-option]:not(.is-soldout)');
  if (await options.count() < fixture.requiredGiftQuantity) {
    throw new TestConfigStaleError(`${handle} has fewer available gifts than required`);
  }
  const selected = [];
  for (let index = 0; index < fixture.requiredGiftQuantity; index += 1) {
    const option = options.nth(index);
    const variantId = Number(await option.getAttribute('data-gift-variant'));
    if (!fixture.giftVariantIds.includes(variantId)) {
      throw new TestConfigStaleError(`${fixture.handle} exposed unconfigured gift variant ${variantId}`);
    }
    await option.locator('[data-apgo-cc-gift-step="up"]').click();
    selected.push(variantId);
  }
  await clickCartAdd(page, add, { expectedVariantId });
  const cart = await cartJson(page);
  expect(cart.items.some((item) => Number(item.variant_id) === Number(expectedVariantId))).toBe(true);
  const giftQuantity = cart.items
    .filter((item) => selected.includes(Number(item.variant_id)) && item.properties?._gift_pick === 'true')
    .reduce((sum, item) => sum + item.quantity, 0);
  expect(giftQuantity, 'selected PDP gifts should be added atomically').toBe(fixture.requiredGiftQuantity);
  return cart;
}

async function verifyLaundryPdp(page, site, { addToCart = true } = {}) {
  const fixture = site.fixtures.laundryPdp;
  const optionValue = (scent) => fixture.optionValues?.[scent] || scent;
  await ensureAvailable(page, site.baseUrl, fixture.handle, 'main h1:visible');

  const currentMediaState = async () => {
    const desktopImage = page.locator('[data-apgo-main-img]:visible').first();
    if (await desktopImage.isVisible().catch(() => false)) {
      return `desktop:${await desktopImage.getAttribute('src')}`;
    }

    const track = page.locator('[data-apgo-carousel-track]:visible').first();
    await expect(track, 'mobile product media carousel').toBeVisible();
    return track.evaluate((element) => {
      const slides = Array.from(element.querySelectorAll('.apgo-mpdp-slide'));
      const current = slides.reduce((best, slide, index) => {
        const distance = Math.abs(slide.offsetLeft - element.scrollLeft);
        return distance < best.distance ? { index, distance, slide } : best;
      }, { index: -1, distance: Number.POSITIVE_INFINITY, slide: null });
      const image = current.slide?.querySelector('img');
      return `mobile:${current.index}:${image?.currentSrc || image?.src || ''}`;
    });
  };

  let previousMedia = await currentMediaState();
  const initialVariantId = await page.evaluate(() => Number(
    window.currentVariantId
    || document.querySelector('form[action*="/cart/add"] input[name="id"]')?.value
  ));
  const allScents = Object.keys(fixture.variants);
  const initialScent = allScents.find((scent) => Number(fixture.variants[scent]) === initialVariantId);
  // Start with a different option so the first assertion proves state changes,
  // then walk every configured scent one-by-one. This catches controlled-form
  // regressions where a partial selection is immediately reset on re-render.
  const scentOrder = allScents.filter((scent) => scent !== initialScent);
  if (initialScent) scentOrder.push(initialScent);

  for (const scent of scentOrder) {
    const input = page.locator(`input[data-apgo-option-input][value="${optionValue(scent)}"]`).first();
    const label = page.locator(`label:visible:has(input[data-apgo-option-input][value="${optionValue(scent)}"])`).first();
    expect(await input.count(), `${scent} radio input must exist`).toBe(1);
    await expect(label, `${scent} visible option label`).toBeVisible();
    await label.click();
    await expect(input).toBeChecked();
    await expect(label).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => Number(window.currentVariantId || document.querySelector('form[action*="/cart/add"] input[name="id"]')?.value)))
      .toBe(Number(fixture.variants[scent]));
    await expect.poll(currentMediaState, { message: `${scent} should update the active product image` }).not.toBe(previousMedia);
    previousMedia = await currentMediaState();
  }

  // Return to the primary scent so the final cart assertion is deterministic.
  const primary = page.locator(`input[data-apgo-option-input][value="${optionValue(fixture.primaryScent)}"]`).first();
  const primaryLabel = page.locator(`label:visible:has(input[data-apgo-option-input][value="${optionValue(fixture.primaryScent)}"])`).first();
  await primaryLabel.click();
  await expect(primary).toBeChecked();
  const qtyInput = page.locator('[data-apgo-qty-input]:visible').first();
  const price = page.locator('[data-apgo-price]:visible').first();
  expect(moneyMinor(await price.textContent()), 'quantity 1 displayed total').toBe(fixture.unitPriceMinor);
  await page.locator('[data-apgo-qty="up"]:visible').first().click();
  await page.locator('[data-apgo-qty="up"]:visible').first().click();
  await expect(qtyInput).toHaveValue('3');
  await expect.poll(async () => moneyMinor(await price.textContent()), { message: 'quantity 3 total should equal unit price × 3' })
    .toBe(fixture.unitPriceMinor * 3);
  await page.locator('[data-apgo-qty="down"]:visible').first().click();
  await page.locator('[data-apgo-qty="down"]:visible').first().click();
  await expect(qtyInput).toHaveValue('1');
  await expect.poll(async () => moneyMinor(await price.textContent())).toBe(fixture.unitPriceMinor);

  if (!addToCart) return;
  await clickCartAdd(page, page.locator('[data-apgo-add]:visible').first(), { expectedVariantId: fixture.variants[fixture.primaryScent] });
  const cart = await cartJson(page);
  const item = cart.items.find((entry) => Number(entry.variant_id) === Number(fixture.variants[fixture.primaryScent]));
  expect(item?.quantity, `${fixture.primaryScent} cart quantity`).toBe(1);
  expect(item?.final_line_price, `${fixture.primaryScent} cart amount`).toBe(fixture.unitPriceMinor);
}

async function verifyCartBasics(page, site) {
  await navigateToCart(page, site.baseUrl);
  let cart = await cartJson(page);
  expect(cart.item_count).toBeGreaterThan(0);
  const firstNormal = cart.items.find((item) => !item.properties?._free_gift && !item.properties?._gift_pick);
  expect(firstNormal, 'cart needs one removable paid item').toBeTruthy();
  const row = page.locator(`.cart-items__table-row[data-variant-id="${firstNormal.variant_id}"]`).first();
  await expect(row).toBeVisible();
  await expect(row.locator('img').first()).toBeVisible();
  await expect(row).toContainText(firstNormal.product_title);

  const plus = row.locator('.quantity-plus, button[name="plus"]').first();
  if (await plus.isVisible().catch(() => false) && await plus.isEnabled().catch(() => false)) {
    const before = firstNormal.quantity;
    await plus.click();
    await expect.poll(async () => (await cartJson(page)).items.find((item) => item.key === firstNormal.key)?.quantity).toBe(before + 1);
    const minus = row.locator('.quantity-minus, button[name="minus"]').first();
    await minus.click();
    await expect.poll(async () => (await cartJson(page)).items.find((item) => item.key === firstNormal.key)?.quantity).toBe(before);
  }

  cart = await cartJson(page);
  expect(cart.total_price, 'cart total must equal final line prices').toBe(cart.items.reduce((sum, item) => sum + item.final_line_price, 0));
  await assertHeaderCartCount(page, cart.item_count);
  const paidItems = cart.items.filter((item) => !item.properties?._free_gift && !item.properties?._gift_pick);
  if (paidItems.length > 1) {
    const remove = row.locator('.cart-items__remove, [data-cart-remove], button[aria-label*="Remove" i]').first();
    await remove.click();
    await expect.poll(async () => (await cartJson(page)).items.some((item) => item.key === firstNormal.key)).toBe(false);
    cart = await cartJson(page);
    await assertHeaderCartCount(page, cart.item_count);
  }
  return cart;
}

async function enterCheckout(page, site, market, expectedCart) {
  const checkout = page.locator('button[name="checkout"], a[href*="/checkout"]').first();
  await expect(checkout).toBeVisible();
  await Promise.all([
    page.waitForURL(/checkout|checkouts/i, { timeout: 60_000 }),
    checkout.click(),
  ]);
  expect(new RegExp(site.expected.checkoutHostPattern, 'i').test(new URL(page.url()).hostname)).toBe(true);
  await expect(page.locator('body')).toContainText(market.priceMarker);
  const body = page.locator('body');
  await expect(body).toContainText(new RegExp(site.expected.checkoutSummaryPattern, 'i'));
  const expectedItems = expectedCart.items.filter((entry) => entry.quantity > 0);
  for (const item of expectedItems) {
    await expect(page.locator('body')).toContainText(item.product_title);
    if (item.variant_title && item.variant_title !== 'Default Title') {
      await expect(body).toContainText(item.variant_title);
    }
    if (item.quantity > 1) {
      const quantity = String(item.quantity);
      await expect.poll(async () => {
        const exactText = await page.getByText(quantity, { exact: true }).count();
        const labelled = await page.locator(`[aria-label*="Quantity ${quantity}" i], [aria-label*="Qty ${quantity}" i]`).count();
        return exactText + labelled;
      }, { message: `checkout must expose quantity ${quantity} for ${item.product_title}` }).toBeGreaterThan(0);
    }
  }
  const checkoutText = (await body.innerText()).replace(/[\s,]/g, '');
  const amount = (Number(expectedCart.total_price) / 100).toFixed(2);
  const compactMarker = String(market.priceMarker || '').replace(/\s/g, '');
  expect(checkoutText, `checkout must show exact cart total ${compactMarker}${amount}`).toContain(`${compactMarker}${amount}`);
  const expectedGiftQuantity = expectedItems
    .filter((item) => item.final_line_price === 0 || Object.keys(item.properties || {}).some((key) => site.expected.freeGiftPropertyNames.includes(key)))
    .reduce((sum, item) => sum + item.quantity, 0);
  if (expectedGiftQuantity > 0) expect(checkoutText).toMatch(/FREE|0\.00|赠品|贈品/i);
  // Stop at the summary. Never fill contact, shipping or payment fields.
}

async function buyNormalV3(page, site) {
  const fixture = site.fixtures.normalV3;
  const buy = await ensureAvailable(
    page,
    site.baseUrl,
    fixture.handle,
    '[data-apgo-cc-buy-now]:visible, [data-apgo-cc-buybar-checkout]:visible, [data-apgo-buy-now]:visible'
  );
  const before = await cartJson(page);
  await clickCartAdd(page, buy, { expectedVariantId: fixture.expectedVariantId });
  await page.waitForURL(/\/cart(?:$|\?)/, { timeout: 45_000 });
  const cart = await cartJson(page);
  const added = cart.items.find((item) => Number(item.variant_id) === Number(fixture.expectedVariantId));
  expect(added, 'Buy now must add the selected V3 variant').toBeTruthy();
  expect(cart.item_count - before.item_count, 'Buy now must add exactly once').toBe(1);
  await assertHeaderCartCount(page, cart.item_count);
  return cart;
}

async function clearAfterCheckout(page, site) {
  await page.goto(siteUrl(site.baseUrl, '/cart'), { waitUntil: 'domcontentloaded' });
  await clearCart(page);
}

module.exports = {
  moneyMinor,
  prepareMarket,
  assertHomepage,
  assertHeaderCartCount,
  addNormalV3,
  addGiftPickerV3,
  verifyLaundryPdp,
  verifyCartBasics,
  enterCheckout,
  buyNormalV3,
  clearAfterCheckout,
};
