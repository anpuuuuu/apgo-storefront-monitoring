const {
  test, expect, sites, TestConfigStaleError, clearCart, cartJson,
  clickCartAdd, setMarket, siteUrl,
} = require('./monitor-fixture');
const { assertHeaderCartCount, clearAfterCheckout } = require('./layer2-journeys');

const marketId = (process.env.MONITOR_MARKET || '').toUpperCase();

function handleize(value) {
  // Shopify's handleize keeps underscores in saved block ids while lowering
  // their letters; spaces and other punctuation become hyphens.
  return String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '');
}

function expectedSectionId(block) {
  if (block.type === 'promo_banner') return handleize(`promo-${block.blockId}`);
  if (block.type === 'product_carousel') return handleize(`carousel-${block.blockId}`);
  return `featured-${block.blockId}`;
}

async function loadedImages(root) {
  return root.locator('img').evaluateAll((images) => images.map((image) => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    width: image.naturalWidth,
  })));
}

async function chooseGiftAndCommit(page, zone, expectedCount) {
  const add = zone.locator('.apgo-event-linked-banner-zone__button--add').first();
  const mainVariant = Number(await add.getAttribute('data-variant-id'));
  const modalId = await zone.getAttribute('data-apgo-event-gift-modal-id');
  await add.click();
  const modal = page.locator(`#${modalId}.is-open[data-apgo-event-gift-modal]`);
  await expect(modal).toBeVisible();
  const picker = modal.locator('[data-apgo-cc-gift-picker]');
  const required = Number(await picker.getAttribute('data-gift-count'));
  expect(required).toBe(expectedCount);
  const options = picker.locator('[data-apgo-cc-gift-option]:not(.is-soldout)');
  if (await options.count() < required) throw new TestConfigStaleError(`Golden Bull ${modalId} has too few available gifts`);
  const selected = [];
  for (let index = 0; index < required; index += 1) {
    const option = options.nth(index);
    selected.push(Number(await option.getAttribute('data-gift-variant')));
    await option.locator('[data-apgo-cc-gift-step="up"]').click();
  }
  const commit = modal.locator('[data-apgo-event-gift-add]');
  await expect(commit).toBeEnabled();
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/cart/add.js' && response.request().method() === 'POST'),
    commit.click(),
  ]);
  const cart = await cartJson(page);
  expect(cart.items.some((item) => Number(item.variant_id) === mainVariant), 'gift promo main product').toBe(true);
  const gifts = cart.items
    .filter((item) => selected.includes(Number(item.variant_id)) && item.properties?._gift_pick === 'true')
    .reduce((sum, item) => sum + item.quantity, 0);
  expect(gifts, 'gift promo selected quantity').toBe(required);
}

async function exerciseBanner(page, site, market, promotion, block) {
  const pageUrl = siteUrl(site.baseUrl, promotion.path);
  const zoneId = expectedSectionId(block);
  let zone = page.locator(`[data-apgo-campaign-section][data-section-id="${zoneId}"]`);
  await expect(zone).toBeVisible();
  const expectedHandle = market.id === 'SG' ? (block.productSg || block.product) : block.product;

  const counter = zone.locator('[data-aurora-stock-counter]');
  if (block.counterEnabled) {
    await expect(counter, `${block.blockId} inventory counter`).toBeVisible();
    expect(Number(await counter.getAttribute('data-total'))).toBe(Number(block.counterReleaseTotal));
    const maximum = Number(block.counterReleaseTotal);
    const remaining = Number((await counter.locator('[data-aurora-stock-number]').first().textContent() || '').trim());
    expect(remaining, `${block.blockId} counter cannot be negative or exceed its release`).toBeGreaterThanOrEqual(0);
    expect(remaining, `${block.blockId} counter cannot be negative or exceed its release`).toBeLessThanOrEqual(maximum);
  } else {
    await expect(counter, `${block.blockId} disabled counter must not render`).toHaveCount(0);
  }

  if (block.ctaMode === 'product_link') {
    const link = zone.locator('.apgo-event-linked-banner-zone__button--single, [data-apgo-campaign-promotion-link]').first();
    await expect(link).toBeVisible();
    expect(decodeURIComponent(await link.getAttribute('href') || '')).toContain(`/products/${expectedHandle}`);
    return;
  }

  if (block.giftEnabled) {
    await chooseGiftAndCommit(page, zone, Number(block.giftCount || 2));
    await clearCart(page);
    return;
  }

  const add = zone.locator('.apgo-event-linked-banner-zone__button--add:not([disabled])').first();
  const buy = zone.locator('.apgo-event-linked-banner-zone__button--buy:not([disabled])').first();
  await expect(add, `${block.blockId} ADD`).toBeVisible();
  await expect(buy, `${block.blockId} BUY NOW`).toBeVisible();
  const expectedVariant = Number(await add.getAttribute('data-variant-id'));
  expect(expectedVariant).toBeGreaterThan(0);
  await clickCartAdd(page, add, { expectedVariantId: expectedVariant });
  let cart = await cartJson(page);
  expect(cart.items.some((item) => Number(item.variant_id) === expectedVariant)).toBe(true);
  await assertHeaderCartCount(page, cart.item_count);
  await clearCart(page);

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  zone = page.locator(`[data-apgo-campaign-section][data-section-id="${zoneId}"]`);
  let addRequestCount = 0;
  const countRequest = (request) => {
    if (new URL(request.url()).pathname === '/cart/add.js' && request.method() === 'POST') addRequestCount += 1;
  };
  page.on('request', countRequest);
  const addResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/cart/add.js' && response.request().method() === 'POST'
  ), { timeout: 30_000 });
  await Promise.all([
    page.waitForURL(/checkout|checkouts/i, { timeout: 60_000 }),
    zone.locator('.apgo-event-linked-banner-zone__button--buy:not([disabled])').first().click(),
  ]);
  const addResponse = await addResponsePromise;
  const addBody = await addResponse.json();
  const addedVariants = (Array.isArray(addBody.items) ? addBody.items : [addBody])
    .map((item) => Number(item.variant_id || item.id || 0));
  page.off('request', countRequest);
  expect(addRequestCount, `${block.blockId} Buy now must add exactly once`).toBe(1);
  expect(addedVariants, `${block.blockId} Buy now exact variant`).toContain(expectedVariant);
  expect(new RegExp(site.expected.checkoutHostPattern, 'i').test(new URL(page.url()).hostname)).toBe(true);
  await clearAfterCheckout(page, site);
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
}

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  const promotion = site.promotions.find((entry) => entry.id === 'golden-bull');
  if (!market || !promotion) throw new TestConfigStaleError(`${site.id} Golden Bull ${marketId} configuration is missing`);

  test(`[v2][${site.id}][${market.id}] complete Golden Bull contract`, async ({ monitorPage }) => {
    await setMarket(monitorPage, site.baseUrl, market.countryCode);
    await clearCart(monitorPage);
    await monitorPage.goto(siteUrl(site.baseUrl, promotion.path), { waitUntil: 'domcontentloaded' });

    const expectedBlocks = site.themeContract.goldenBullBlocks.filter((block) => block.renderMarkets.includes(market.id));
    const expectedIds = expectedBlocks.map(expectedSectionId);
    const sections = monitorPage.locator('[data-apgo-campaign-section]:visible');
    const metadata = await sections.evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-section-id'), promotionId: node.getAttribute('data-promotion-id'),
      position: Number(node.getAttribute('data-section-position')),
    })));
    expect(metadata.map((entry) => entry.id), `${market.id} visible campaign contract`).toEqual(expectedIds);
    expect(new Set(metadata.map((entry) => entry.promotionId)).size, 'promotion ids must be unique').toBe(metadata.length);
    expect(metadata.map((entry) => entry.position), 'visible section positions must be continuous')
      .toEqual(Array.from({ length: metadata.length }, (_, index) => index + 1));

    for (let index = 0; index < metadata.length; index += 1) {
      const section = sections.nth(index);
      await section.scrollIntoViewIfNeeded();
      for (const image of await loadedImages(section)) {
        expect(image.src, `section ${metadata[index].id} image src`).toBeTruthy();
        expect(image.complete && image.width > 0, `section ${metadata[index].id} image should load`).toBe(true);
      }
      const links = section.locator('a[href]:visible');
      for (let linkIndex = 0; linkIndex < await links.count(); linkIndex += 1) {
        const parsed = new URL(await links.nth(linkIndex).getAttribute('href'), site.baseUrl);
        expect(parsed.hostname).toBe(new URL(site.baseUrl).hostname);
        expect(parsed.pathname).not.toBe(promotion.path);
      }
    }

    for (const block of expectedBlocks.filter((entry) => entry.type === 'promo_banner')) {
      await exerciseBanner(monitorPage, site, market, promotion, block);
    }

    for (const block of expectedBlocks.filter((entry) => entry.type === 'product_carousel')) {
      const zone = monitorPage.locator(`[data-apgo-campaign-section][data-section-id="${expectedSectionId(block)}"]`);
      const track = zone.locator('[data-apgo-scroll-track]');
      await expect(track).toBeVisible();
      expect(await track.evaluate((node) => node.scrollWidth > node.clientWidth + 2), 'carousel must overflow').toBe(true);
      const renderedHandles = await track.locator('[data-product-handle]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-product-handle')));
      for (const handle of renderedHandles) expect(block.products).toContain(handle);
      expect(new Set(renderedHandles).size).toBe(renderedHandles.length);
      const next = zone.locator('[data-apgo-scroll-next]:visible').first();
      if (await next.isVisible().catch(() => false)) {
        const before = await track.evaluate((node) => node.scrollLeft);
        await next.click();
        await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBeGreaterThan(before);
        await expect(zone.locator('[data-apgo-scroll-previous]:visible').first()).toBeEnabled();
      }
      const carouselAdd = track.locator('.apgo-event-listing-card__btn--add:not([disabled])').first();
      await expect(carouselAdd).toBeVisible();
      const variant = Number(await carouselAdd.getAttribute('data-variant-id'));
      await clickCartAdd(monitorPage, carouselAdd, { expectedVariantId: variant });
      const cart = await cartJson(monitorPage);
      expect(cart.items.some((item) => Number(item.variant_id) === variant)).toBe(true);
      await assertHeaderCartCount(monitorPage, cart.item_count);
      await clearCart(monitorPage);
    }
  });
}
