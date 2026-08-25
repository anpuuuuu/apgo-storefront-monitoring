const {
  test,
  expect,
  sites,
  TestConfigStaleError,
  clearCart,
  cartJson,
  clickCartAdd,
  setMarket,
  siteUrl,
} = require('./monitor-fixture');
const { assertHeaderCartCount, clearAfterCheckout } = require('./layer2-journeys');

const marketId = (process.env.MONITOR_MARKET || '').toUpperCase();

async function loadedImages(root) {
  return root.locator('img').evaluateAll((images) => images.map((image) => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    width: image.naturalWidth,
  })));
}

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  const promotion = site.promotions.find((entry) => entry.id === 'golden-bull');
  if (!market || !promotion) throw new TestConfigStaleError(`${site.id} Golden Bull ${marketId} configuration is missing`);

  test(`[v2][${site.id}][${market.id}] Golden Bull promotions`, async ({ monitorPage }) => {
    await setMarket(monitorPage, site.baseUrl, market.countryCode);
    await clearCart(monitorPage);
    await monitorPage.goto(siteUrl(site.baseUrl, promotion.path), { waitUntil: 'domcontentloaded' });

    const sections = monitorPage.locator('[data-apgo-campaign-section]:visible');
    const sectionCount = await sections.count();
    expect(sectionCount, 'visible campaign section count').toBeGreaterThanOrEqual(promotion.minimumVisibleSections || 1);
    const metadata = await sections.evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-section-id'),
      promotionId: node.getAttribute('data-promotion-id'),
      position: Number(node.getAttribute('data-section-position')),
    })));
    expect(new Set(metadata.map((entry) => entry.id)).size, 'section ids must be unique').toBe(metadata.length);
    expect(new Set(metadata.map((entry) => entry.promotionId)).size, 'promotion ids must be unique').toBe(metadata.length);
    expect(metadata.map((entry) => entry.position), 'visible section positions must be continuous')
      .toEqual(Array.from({ length: metadata.length }, (_, index) => index + 1));

    for (let index = 0; index < sectionCount; index += 1) {
      const section = sections.nth(index);
      await section.scrollIntoViewIfNeeded();
      const images = await loadedImages(section);
      for (const image of images) {
        expect(image.src, `section ${metadata[index].id} image src`).toBeTruthy();
        expect(image.complete && image.width > 0, `section ${metadata[index].id} image should load`).toBe(true);
      }
      const links = section.locator('a[href]:visible');
      for (let linkIndex = 0; linkIndex < await links.count(); linkIndex += 1) {
        const href = await links.nth(linkIndex).getAttribute('href');
        const parsed = new URL(href, site.baseUrl);
        expect(parsed.hostname, 'campaign links must remain on the APGO storefront').toBe(new URL(site.baseUrl).hostname);
        expect(parsed.pathname, 'campaign link needs a destination').not.toBe(promotion.path);
      }
    }

    const carousel = monitorPage.locator('[data-apgo-campaign-section]:visible [data-apgo-scroll-track]').first();
    if (await carousel.isVisible().catch(() => false)) {
      const overflow = await carousel.evaluate((node) => node.scrollWidth > node.clientWidth + 2);
      expect(overflow, 'campaign product carousel should overflow horizontally').toBe(true);
      const zone = carousel.locator('xpath=ancestor::*[@data-apgo-campaign-section][1]');
      const next = zone.locator('[data-apgo-scroll-next]:visible').first();
      if (await next.isVisible().catch(() => false)) {
        const before = await carousel.evaluate((node) => node.scrollLeft);
        await next.click();
        await expect.poll(() => carousel.evaluate((node) => node.scrollLeft)).toBeGreaterThan(before);
        const previous = zone.locator('[data-apgo-scroll-previous]:visible').first();
        await expect(previous).toBeEnabled();
      }

      const carouselAdd = carousel.locator('.apgo-event-listing-card__btn--add:not([disabled])').first();
      await expect(carouselAdd, 'a visible product carousel needs at least one addable item').toBeVisible();
      const carouselVariant = Number(await carouselAdd.getAttribute('data-variant-id'));
      await clickCartAdd(monitorPage, carouselAdd, { expectedVariantId: carouselVariant });
      let carouselCart = await cartJson(monitorPage);
      expect(carouselCart.items.some((item) => Number(item.variant_id) === carouselVariant), 'carousel ADD must update Shopify cart').toBe(true);
      await assertHeaderCartCount(monitorPage, carouselCart.item_count);
      await clearCart(monitorPage);
    }

    // Exercise one ordinary banner Add and Buy Now journey.
    const ordinaryZone = monitorPage.locator('[data-apgo-campaign-section]:visible:not([data-apgo-event-gift-modal-id])')
      .filter({ has: monitorPage.locator('.apgo-event-linked-banner-zone__button--add:not([disabled])') })
      .first();
    await expect(ordinaryZone, 'Golden Bull needs one ordinary addable promo banner').toBeVisible();
    const add = ordinaryZone.locator('.apgo-event-linked-banner-zone__button--add').first();
    const expectedVariant = Number(await add.getAttribute('data-variant-id'));
    await clickCartAdd(monitorPage, add, { expectedVariantId: expectedVariant });
    const cart = await cartJson(monitorPage);
    expect(cart.items.some((item) => Number(item.variant_id) === expectedVariant)).toBe(true);
    await assertHeaderCartCount(monitorPage, cart.item_count);
    await clearCart(monitorPage);

    await monitorPage.reload({ waitUntil: 'domcontentloaded' });
    const buy = monitorPage.locator(`[data-apgo-campaign-section]:visible:not([data-apgo-event-gift-modal-id]) .apgo-event-linked-banner-zone__button--buy[data-variant-id="${expectedVariant}"]:not([disabled])`).first();
    await expect(buy).toBeVisible();
    let addRequestCount = 0;
    monitorPage.on('request', (request) => {
      if (new URL(request.url()).pathname === '/cart/add.js' && request.method() === 'POST') addRequestCount += 1;
    });
    await Promise.all([
      monitorPage.waitForURL(/checkout|checkouts/i, { timeout: 60_000 }),
      buy.click(),
    ]);
    expect(addRequestCount, 'Buy now must add exactly once before checkout').toBe(1);
    expect(new RegExp(site.expected.checkoutHostPattern, 'i').test(new URL(monitorPage.url()).hostname)).toBe(true);
    await clearAfterCheckout(monitorPage, site);

    // A configured gift promo must open only its own picker, enforce the
    // required count and submit the main variant + protected gift lines.
    await monitorPage.goto(siteUrl(site.baseUrl, promotion.path), { waitUntil: 'domcontentloaded' });
    const giftZone = monitorPage.locator('[data-apgo-campaign-section][data-apgo-event-gift-modal-id]:visible')
      .filter({ has: monitorPage.locator('.apgo-event-linked-banner-zone__button--add:not([disabled])') })
      .first();
    if (await giftZone.isVisible().catch(() => false)) {
      const giftAdd = giftZone.locator('.apgo-event-linked-banner-zone__button--add').first();
      const mainVariant = Number(await giftAdd.getAttribute('data-variant-id'));
      const modalId = await giftZone.getAttribute('data-apgo-event-gift-modal-id');
      await giftAdd.click();
      const modal = monitorPage.locator(`#${modalId}.is-open[data-apgo-event-gift-modal]`);
      await expect(modal).toBeVisible();
      const picker = modal.locator('[data-apgo-cc-gift-picker]');
      const required = Number(await picker.getAttribute('data-gift-count'));
      expect(required, 'gift promo requires a positive gift count').toBeGreaterThan(0);
      const giftOptions = picker.locator('[data-apgo-cc-gift-option]:not(.is-soldout)');
      expect(await giftOptions.count(), 'gift promo needs an available gift').toBeGreaterThan(0);
      const giftVariant = Number(await giftOptions.first().getAttribute('data-gift-variant'));
      const plus = giftOptions.first().locator('[data-apgo-cc-gift-step="up"]');
      for (let index = 0; index < required; index += 1) await plus.click();
      const commit = modal.locator('[data-apgo-event-gift-add]');
      await expect(commit).toBeEnabled();
      await Promise.all([
        monitorPage.waitForResponse((response) => new URL(response.url()).pathname === '/cart/add.js' && response.request().method() === 'POST'),
        commit.click(),
      ]);
      const giftCart = await cartJson(monitorPage);
      expect(giftCart.items.some((item) => Number(item.variant_id) === mainVariant), 'gift promo main product').toBe(true);
      const protectedGifts = giftCart.items
        .filter((item) => Number(item.variant_id) === giftVariant && item.properties?._gift_pick === 'true')
        .reduce((sum, item) => sum + item.quantity, 0);
      expect(protectedGifts, 'gift promo selected quantity').toBe(required);
      await clearCart(monitorPage);
    }
  });
}
