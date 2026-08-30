const {
  test,
  expect,
  sites,
  TestConfigStaleError,
  assertNoAccessChallenge,
  resourceFailuresFor,
  cartJson,
  clickCartAdd,
  waitForCartStable,
  navigateToCart,
  siteUrl,
} = require('./monitor-fixture');
const { prepareMarket, assertHeaderCartCount, enterCheckout, clearAfterCheckout, moneyMinor } = require('./layer2-journeys');
const { classifyVisibleImages } = require('../scripts/image-health.cjs');

const marketId = String(process.env.MONITOR_MARKET || '').toUpperCase();
const landingPath = process.env.MONITOR_LANDING_PATH || '';
const channel = process.env.MONITOR_CHANNEL || '';
const adMode = process.env.MONITOR_AD_MODE || 'full';

async function assertVisibleImages(page) {
  const deadline = Date.now() + 15_000;
  let lastResult = { state: 'waiting', detail: 'no-visible-image' };
  while (Date.now() < deadline) {
    const images = await page.locator('main img, [role="main"] img').evaluateAll((nodes) => nodes
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight;
      })
      .slice(0, 12)
      .map((node) => ({ src: node.currentSrc || node.src, complete: node.complete, width: node.naturalWidth })));
    lastResult = classifyVisibleImages(images, resourceFailuresFor(page));
    if (lastResult.state === 'failed') {
      throw new Error(`Visible advertising image failed: ${lastResult.detail}`);
    }
    if (lastResult.state === 'loaded') return;
    await page.waitForTimeout(500);
  }

  if (lastResult.state === 'waiting') {
    throw new Error('Advertising landing did not expose a visible image within 15 seconds');
  }

  // A lazy image that is still incomplete is not proof of a broken response.
  // Keep it in CI diagnostics without turning a timing race into a storefront incident.
  console.warn(`MONITOR_IMAGE_PENDING: ${lastResult.detail}`);
}

async function assertRuntimePromotions(page) {
  const sections = page.locator('[data-apgo-campaign-section]:visible');
  const metadata = await sections.evaluateAll((nodes) => nodes.map((node) => ({
    sectionId: node.getAttribute('data-section-id') || '',
    promotionId: node.getAttribute('data-promotion-id') || '',
  })));
  const ids = metadata.map((entry) => entry.promotionId).filter(Boolean);
  expect(new Set(ids).size, 'visible promotion ids must be unique').toBe(ids.length);
  for (const entry of metadata) {
    expect(entry.sectionId, 'visible campaign section id').toBeTruthy();
    expect(entry.promotionId, 'visible campaign promotion id').toBeTruthy();
  }
  const links = sections.locator('a[href]:visible');
  for (let index = 0; index < Math.min(await links.count(), 20); index += 1) {
    const href = await links.nth(index).getAttribute('href');
    expect(href && !href.startsWith('javascript:'), 'campaign CTA must have a safe destination').toBeTruthy();
  }
}

async function navigateAdvertisingLanding(page, site) {
  const target = siteUrl(site.baseUrl, landingPath);
  let response;
  for (const wait of [0, 15_000, 45_000]) {
    if (wait) await page.waitForTimeout(wait);
    response = await page.goto(target, { waitUntil: 'domcontentloaded' });
    if (response?.status() !== 429) break;
  }
  if (response?.status() === 429) {
    throw new Error(`MONITOR_RATE_LIMIT: advertising landing ${landingPath} remained rate limited`);
  }
  if (!response || response.status() >= 400) {
    throw new Error(`Advertising landing ${landingPath} returned HTTP ${response?.status() || 'network'}`);
  }
  return response;
}

async function reachPurchasableArea(page, site) {
  const addSelector = [
    '[data-apgo-cc-add]:visible', '[data-apgo-cc-buybar-add]:visible', '[data-apgo-add]:visible',
    'form[action*="/cart/add"] button[name="add"]:visible',
    '.apgo-event-linked-banner-zone__button--add:visible',
    '.apgo-event-featured-banner__btn--add:visible',
    '.apgo-event-listing-card__btn--add:visible',
  ].join(', ');
  let add = page.locator(addSelector).first();
  if (await add.isVisible().catch(() => false)) return add;

  const productLink = page.locator([
    '[data-apgo-campaign-promotion-link][href*="/products/"]:visible',
    'main a[href*="/products/"]:visible',
    '[role="main"] a[href*="/products/"]:visible',
  ].join(', ')).first();
  if (!await productLink.isVisible().catch(() => false)) {
    throw new Error(`Advertising landing ${landingPath} has no usable purchase CTA or product link`);
  }
  const href = await productLink.getAttribute('href');
  await page.goto(new URL(href, site.baseUrl).href, { waitUntil: 'domcontentloaded' });
  await assertNoAccessChallenge(page, 'advertising PDP rendering');
  add = page.locator(addSelector).first();
  await expect(add, 'advertising product add button').toBeVisible({ timeout: 30_000 });
  return add;
}

async function exercisePersistedOptions(page) {
  const selects = page.locator('main select[name*="option" i]:visible, main variant-selects select:visible');
  for (let index = 0; index < Math.min(await selects.count(), 3); index += 1) {
    const select = selects.nth(index);
    const options = await select.locator('option:not([disabled])').evaluateAll((nodes) => nodes.map((node) => node.value).filter(Boolean));
    if (options.length < 2) continue;
    const chosen = options[1];
    await select.selectOption(chosen);
    await page.waitForTimeout(300);
    await expect(select, 'selected product option must survive the component update').toHaveValue(chosen);
  }

  const inlineGroups = page.locator('main [data-apgo-cc-option-group]');
  const confirmModal = page.locator('[data-apgo-cc-confirm-modal]');
  const useMobileConfirm = await page.evaluate(() => window.matchMedia?.('(max-width: 1023px)').matches)
    && await inlineGroups.count() > 0
    && await confirmModal.count() > 0;
  if (useMobileConfirm) {
    const opener = inlineGroups.first().locator('label:visible, [role="button"]:visible, button:visible').first();
    await expect(opener, 'mobile option chip must be available to open the confirmation modal').toBeVisible();
    await opener.click();
    await expect(confirmModal, 'mobile option interaction must open the real confirmation modal').toHaveClass(/is-open/);
    const confirmGroups = confirmModal.locator('[data-apgo-cc-confirm-option-group]');
    for (let index = 0; index < Math.min(await confirmGroups.count(), 3); index += 1) {
      const chips = confirmGroups.nth(index).locator('[data-apgo-cc-confirm-chip]:not([disabled])');
      if (await chips.count() < 2) continue;
      const chip = chips.nth(1);
      const chosen = await chip.getAttribute('data-option-value');
      await chip.click();
      await expect(chip, 'modal option selection must remain active').toHaveClass(/is-active/);
      await expect(confirmGroups.nth(index).locator('[data-apgo-cc-confirm-option-current]'), 'modal option label must retain the selected value').toHaveText(chosen);
      await expect(inlineGroups.nth(index).locator('input[type="radio"]:checked'), 'modal selection must persist into the product form').toHaveValue(chosen);
    }
    await confirmModal.locator('button[data-apgo-cc-confirm-close]:visible').click();
    await expect(confirmModal).not.toHaveClass(/is-open/);
    return;
  }

  // Some PDPs render desktop and mobile radio groups at the same time and hide
  // one set with CSS. Build the groups from visible labels, because the radio
  // itself may intentionally be visually hidden inside a customer-facing chip.
  const visibleOptions = await page.locator('main label:visible').evaluateAll((labels) => labels.flatMap((label) => {
    const forId = label.getAttribute('for');
    const radio = label.querySelector('input[type="radio"][name]:not([data-gift-variant]):not([disabled])')
      || (forId ? document.getElementById(forId) : null);
    if (!(radio instanceof HTMLInputElement) || radio.type !== 'radio' || radio.disabled || radio.hasAttribute('data-gift-variant')) return [];
    return [{ name: radio.name, id: radio.id, value: radio.value }];
  }));
  const groups = [...new Set(visibleOptions.map((option) => option.name).filter(Boolean))].slice(0, 3);
  for (const name of groups) {
    const options = visibleOptions.filter((option) => option.name === name);
    if (options.length < 2) continue;
    const chosen = options[1];
    const escapedId = String(chosen.id || '').replace(/([\\"'\[\]#.:])/g, '\\$1');
    const escapedName = String(name).replace(/([\\"'\[\]#.:])/g, '\\$1');
    const escapedValue = String(chosen.value).replace(/([\\"'\[\]#.:])/g, '\\$1');
    const radio = chosen.id
      ? page.locator(`main input#${escapedId}`)
      : page.locator(`main label:visible input[type="radio"][name="${escapedName}"][value="${escapedValue}"]`).first();
    const label = chosen.id
      ? page.locator(`main label[for="${escapedId}"]:visible`).first()
      : radio.locator('xpath=ancestor::label[1]');
    await expect(label, 'only a customer-visible product option may be exercised').toBeVisible();
    await label.click();
    await page.waitForTimeout(300);
    await expect(radio, 'selected product option must not reset before the remaining choices are complete').toBeChecked();
  }
}

async function chooseVisibleGifts(page, picker) {
  const required = Number(await picker.getAttribute('data-gift-count') || 0);
  if (!required) return [];
  const options = picker.locator('[data-apgo-cc-gift-option]:not(.is-soldout):not(.is-disabled)');
  if (await options.count() < required) throw new TestConfigStaleError(`runtime gift picker needs ${required} available gifts`);
  const chosen = [];
  for (let index = 0; index < required; index += 1) {
    const option = options.nth(index);
    chosen.push(Number(await option.getAttribute('data-gift-variant')));
    await option.locator('[data-apgo-cc-gift-step="up"]').click();
  }
  return chosen;
}

async function selectedVariantId(page, add) {
  return Number(
    await add.getAttribute('data-variant-id')
    || await page.locator('form[action*="/cart/add"] input[name="id"]').first().inputValue().catch(() => 0)
    || await page.evaluate(() => window.currentVariantId || 0)
  );
}

async function addRuntimeProduct(page, add) {
  const variantId = await selectedVariantId(page, add);
  expect(variantId, 'advertising purchase action must resolve an active variant').toBeGreaterThan(0);
  const inlinePicker = page.locator('main [data-apgo-cc-gift-picker]:visible').first();
  if (await inlinePicker.isVisible().catch(() => false)) await chooseVisibleGifts(page, inlinePicker);

  const zone = add.locator('xpath=ancestor::*[@data-apgo-event-gift-modal-id][1]');
  const modalId = await zone.getAttribute('data-apgo-event-gift-modal-id').catch(() => '');
  if (modalId) {
    await add.click();
    const modal = page.locator(`#${modalId}.is-open[data-apgo-event-gift-modal]`);
    await expect(modal).toBeVisible();
    await chooseVisibleGifts(page, modal.locator('[data-apgo-cc-gift-picker]'));
    await clickCartAdd(page, modal.locator('[data-apgo-event-gift-add]'), { expectedVariantId: variantId });
  } else {
    await clickCartAdd(page, add, { expectedVariantId: variantId });
  }
  return variantId;
}

async function reconcileRuntimeCartGift(page) {
  const modal = page.locator('[data-apgo-cart-gift-modal].is-open:visible').first();
  if (!await modal.isVisible().catch(() => false)) return;
  await chooseVisibleGifts(page, modal.locator('[data-apgo-cc-gift-picker]'));
  await clickCartAdd(page, modal.locator('[data-apgo-cart-gift-add]'));
}

async function validateRuntimeOffers(page) {
  const groups = page.locator('[data-offer-group]:visible:not([hidden])');
  const cards = groups.locator('[data-offer-card]:visible');
  for (let index = 0; index < Math.min(await cards.count(), 20); index += 1) {
    const card = cards.nth(index);
    expect(Number(await card.getAttribute('data-product-id')), 'runtime offer product id').toBeGreaterThan(0);
    expect(moneyMinor(await card.locator('.cart-offers-tabs__price-current').textContent()), 'runtime offer displayed price').toBeGreaterThanOrEqual(0);
    const hasAction = await card.locator('[data-offer-add]:visible, .cart-offers-tabs__select-options:visible').count();
    expect(hasAction, 'runtime offer must expose ADD or SELECT OPTIONS').toBeGreaterThan(0);
  }

  const add = cards.locator('[data-offer-add]:visible:not([disabled])').first();
  if (!await add.isVisible().catch(() => false)) return;
  const card = add.locator('xpath=ancestor::*[@data-offer-card][1]');
  const productId = await card.getAttribute('data-product-id');
  const variantId = Number(await add.getAttribute('data-variant-id'));
  const maxQuantity = Number(await card.getAttribute('data-max-quantity') || 0);
  const before = await cartJson(page);
  await clickCartAdd(page, add, { expectedVariantId: variantId });
  const after = await waitForCartStable(page);
  expect(after.item_count, 'runtime offer add must not reduce cart quantity').toBeGreaterThan(before.item_count);
  if (maxQuantity === 1) {
    const refreshed = page.locator(`[data-offer-card][data-product-id="${productId}"]`).first();
    await expect.poll(async () => {
      const button = refreshed.locator('[data-offer-add]').first();
      return await button.isDisabled().catch(() => false)
        || /ADDED/i.test(await button.textContent().catch(() => ''));
    }, { message: 'max-quantity one offer should become ADDED/disabled' }).toBe(true);
  }
}

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  if (!market) throw new TestConfigStaleError(`${site.id} has no market ${marketId}`);
  if (!landingPath) throw new TestConfigStaleError('MONITOR_LANDING_PATH is missing');

  test(`[v2][${site.id}][${market.id}] ${channel} advertising ${adMode} ${landingPath}`, async ({ monitorPage }) => {
    // These modes use a new browser context. Clearing an already-empty cart
    // would turn a read-only check into a /cart/clear.js write and can create
    // the very 429 that this monitor is trying to diagnose.
    await prepareMarket(monitorPage, site, market, { clear: adMode === 'full' });
    await navigateAdvertisingLanding(monitorPage, site);
    await assertNoAccessChallenge(monitorPage, `advertising landing ${landingPath}`);
    await expect(monitorPage.locator('main, [role="main"]').first()).toBeVisible();

    if (adMode === 'cart-smoke') {
      const cart = await cartJson(monitorPage);
      expect(cart.total_price, 'cart total must equal final line prices').toBe(cart.items.reduce((sum, item) => sum + item.final_line_price, 0));
      if (cart.item_count > 0) {
        await expect(monitorPage.locator('a[href*="/checkout"], button[name="checkout"], [data-checkout-button]').first(), 'a non-empty cart landing must expose checkout').toBeVisible();
      }
      await assertHeaderCartCount(monitorPage, cart.item_count);
      return;
    }

    await assertVisibleImages(monitorPage);
    await assertRuntimePromotions(monitorPage);

    const add = await reachPurchasableArea(monitorPage, site);
    await exercisePersistedOptions(monitorPage);
    if (adMode === 'read-only') {
      expect(await selectedVariantId(monitorPage, add), 'read-only advertising check must resolve an active variant').toBeGreaterThan(0);
      await expect(add, 'read-only advertising check must leave the purchase action usable').toBeVisible();
      return;
    }
    const variantId = await addRuntimeProduct(monitorPage, add);
    let cart = await waitForCartStable(monitorPage);
    expect(cart.items.some((item) => Number(item.variant_id) === variantId), 'selected advertising variant must exist in cart').toBe(true);
    expect(cart.total_price, 'cart total must equal final line prices').toBe(cart.items.reduce((sum, item) => sum + item.final_line_price, 0));
    await assertHeaderCartCount(monitorPage, cart.item_count);

    await navigateToCart(monitorPage, site.baseUrl, { settleMs: 2_000 });
    await reconcileRuntimeCartGift(monitorPage);
    await validateRuntimeOffers(monitorPage);
    cart = await waitForCartStable(monitorPage);
    expect(cart.total_price, 'settled cart total must equal final line prices').toBe(cart.items.reduce((sum, item) => sum + item.final_line_price, 0));
    await assertHeaderCartCount(monitorPage, cart.item_count);
    await enterCheckout(monitorPage, site, market, cart);
    await clearAfterCheckout(monitorPage, site);
  });
}
