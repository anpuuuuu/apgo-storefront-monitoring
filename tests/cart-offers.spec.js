const {
  test,
  expect,
  sites,
  TestConfigStaleError,
  clearCart,
  cartJson,
  addItems,
  waitForCartStable,
  navigateToCart,
} = require('./monitor-fixture');
const { moneyMinor, prepareMarket, assertHeaderCartCount, addGiftPickerV3 } = require('./layer2-journeys');

const marketId = (process.env.MONITOR_MARKET || '').toUpperCase();
const requestedRules = new Set((process.env.MONITOR_RULE || '').toLowerCase().split(',').map((rule) => rule.trim()).filter(Boolean));
const shouldRunRule = (rule) => requestedRules.size === 0 || requestedRules.has(rule.toLowerCase());

async function storefrontProduct(page, handle) {
  return page.evaluate(async (productHandle) => {
    const response = await fetch(`/products/${encodeURIComponent(productHandle)}.js`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`product ${productHandle} HTTP ${response.status}`);
    return response.json();
  }, handle);
}

async function cardForHandle(group, handle) {
  const cards = group.locator('[data-offer-card]');
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    const href = await card.locator('.cart-offers-tabs__card-link').getAttribute('href');
    let decoded = href || '';
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    if (decoded.includes(`/products/${handle}`)) return card;
  }
  return null;
}

async function waitForVariantLine(page, variantId, { minimumQuantity = 1, unitPriceMinor = 0 } = {}) {
  let latest;
  for (const delay of [2_500, 5_000, 8_000]) {
    await page.waitForTimeout(delay);
    const cart = await cartJson(page);
    const lines = cart.items.filter((item) => Number(item.variant_id) === Number(variantId));
    latest = {
      cart,
      quantity: lines.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      finalLinePrice: lines.reduce((sum, item) => sum + Number(item.final_line_price || 0), 0),
    };
    const unitPrice = latest.quantity ? Math.round(latest.finalLinePrice / latest.quantity) : 0;
    if (latest.quantity >= minimumQuantity && (!unitPriceMinor || unitPrice === unitPriceMinor)) return latest;
  }
  throw new Error(`variant ${variantId} did not reach quantity ${minimumQuantity} and unit price ${unitPriceMinor}: ${JSON.stringify(latest)}`);
}

async function qualifyTab(page, site, tab) {
  await clearCart(page);
  await navigateToCart(page, site.baseUrl);
  const group = page.locator(`[data-offer-group][data-group-id="${tab.blockId}"]`);
  if (tab.audience === 'all') {
    await expect(group).toBeVisible({ timeout: 20_000 });
    return group;
  }

  await expect(group).toBeHidden();
  const availableTriggers = [];
  for (const handle of tab.triggerProducts) {
    const product = await storefrontProduct(page, handle);
    if (product?.variants?.length) availableTriggers.push({ handle, product });
  }
  if (!availableTriggers.length) {
    throw new TestConfigStaleError(`${site.id} ${marketId} tab ${tab.label} has no available trigger product`);
  }

  const minimum = Number(tab.triggerMinQuantity || 1);
  const triggerVariant = availableTriggers[0].product.variants.find((variant) => variant.available);
  if (!triggerVariant) throw new TestConfigStaleError(`${tab.label} trigger ${availableTriggers[0].handle} is sold out`);
  if (minimum > 1) {
    await addItems(page, [{ id: triggerVariant.id, quantity: minimum - 1 }]);
    await navigateToCart(page, site.baseUrl, { settleMs: 2_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(group, `${tab.label} must stay hidden below ${minimum}`).toBeHidden();
    await addItems(page, [{ id: triggerVariant.id, quantity: 1 }]);
  } else {
    await addItems(page, [{ id: triggerVariant.id, quantity: 1 }]);
  }

  await navigateToCart(page, site.baseUrl, { settleMs: minimum >= 6 ? 8_000 : 3_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const tabButton = page.getByRole('tab', { name: tab.label });
  await expect(tabButton, `${tab.label} must appear at its threshold`).toBeVisible({ timeout: 20_000 });
  await expect(tabButton, `${tab.label} must be the default eligible special offer`).toHaveAttribute('aria-selected', 'true');
  await tabButton.click();
  await expect(group).toBeVisible();
  await expect(tabButton).toHaveAttribute('aria-selected', 'true');
  return group;
}

async function assertOffer(page, site, market, group, offer) {
  const product = await storefrontProduct(page, offer.product);
  const card = await cardForHandle(group, offer.product);
  if (!product) {
    expect(card, `${offer.product} is unavailable in ${market.id} and must not render`).toBeNull();
    return;
  }
  if (!card) throw new Error(`Cart offer ${offer.blockId} (${offer.product}) did not render in ${market.id}`);
  await expect(card).toBeVisible();
  await expect(card.locator('img').first()).toBeVisible();
  expect(Number(await card.getAttribute('data-max-quantity'))).toBe(Number(offer.maxQuantity || 0));

  const configuredPrice = market.id === 'SG' ? offer.promoPriceSg : offer.promoPriceMy;
  const shownPrice = moneyMinor(await card.locator('.cart-offers-tabs__price-current').textContent());
  if (offer.priceMode === 'promo' && configuredPrice) {
    expect(shownPrice, `${offer.product} ${market.id} displayed promo price`).toBe(moneyMinor(configuredPrice));
  } else {
    expect(shownPrice, `${offer.product} ${market.id} displayed actual price`).toBeGreaterThan(0);
  }

  const add = card.locator('[data-offer-add]');
  const selectOptions = card.locator('.cart-offers-tabs__select-options');
  const configuredVariant = Number(offer.variantId || 0);
  if (!configuredVariant && product.variants.length > 1) {
    await expect(selectOptions, `${offer.product} must require variant selection`).toBeVisible();
    await expect(add).toHaveCount(0);
    const before = (await cartJson(page)).item_count;
    const href = await selectOptions.getAttribute('href');
    expect(decodeURIComponent(href || '')).toContain(`/products/${offer.product}`);
    expect((await cartJson(page)).item_count, 'SELECT OPTIONS must not mutate the cart').toBe(before);
    return;
  }

  const expectedVariant = configuredVariant || Number(product.variants[0].id);
  await expect(add, `${offer.product} must expose direct ADD`).toBeVisible();
  expect(Number(await add.getAttribute('data-variant-id'))).toBe(expectedVariant);
  await expect(add).toBeEnabled();
  await add.click();
  const expectedUnitPrice = offer.priceMode === 'promo' && configuredPrice ? moneyMinor(configuredPrice) : shownPrice;
  let observed = await waitForVariantLine(page, expectedVariant, { unitPriceMinor: expectedUnitPrice });
  await assertHeaderCartCount(page, observed.cart.item_count);

  if (Number(offer.maxQuantity) > 0) {
    await expect(add).toBeDisabled();
    await expect(add).toContainText(/ADDED/i);
    expect(observed.quantity, `${offer.product} per-order limit`).toBe(Number(offer.maxQuantity));
    return;
  }

  await expect(add).toBeEnabled();
  await expect(add).toContainText(/ADD ANOTHER/i);
  await add.click();
  observed = await waitForVariantLine(page, expectedVariant, { minimumQuantity: 2, unitPriceMinor: expectedUnitPrice });
  expect(observed.quantity, `${offer.product} max_quantity=0 must remain unlimited`).toBeGreaterThanOrEqual(2);
}

async function assertBulkGiftProtection(page, site, market) {
  await clearCart(page);
  await addItems(page, [{ id: site.fixtures.apiCheckVariantId, quantity: 1 }]);
  if (market.expectsProtectedDetergentGift) {
    const variants = Object.values(site.fixtures.detergentPromo.variants).slice(0, 3);
    await addItems(page, variants.map((id) => ({ id, quantity: 2 })));
  }
  await navigateToCart(page, site.baseUrl, { settleMs: market.expectsProtectedDetergentGift ? 8_000 : 2_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (market.expectsProtectedDetergentGift) await page.waitForTimeout(5_000);
  await waitForCartStable(page);

  const removable = page.locator('.cart-items__table-row[data-line-key]:not([data-apgo-gift-line]) [data-cart-item-select]:not([disabled])');
  expect(await removable.count(), 'bulk action needs removable rows').toBeGreaterThan(0);
  const locked = page.locator('.cart-items__table-row[data-apgo-gift-line] [data-cart-item-select]');
  for (let index = 0; index < await locked.count(); index += 1) await expect(locked.nth(index)).toBeDisabled();

  const all = page.locator('[data-cart-bulk-action="select-all"]');
  const remove = page.locator('[data-cart-bulk-action="remove-selected"]');
  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  for (let index = 0; index < await removable.count(); index += 1) await expect(removable.nth(index)).toBeChecked();
  for (let index = 0; index < await locked.count(); index += 1) await expect(locked.nth(index)).not.toBeChecked();
  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  for (let index = 0; index < await removable.count(); index += 1) await expect(removable.nth(index)).not.toBeChecked();

  await all.click();
  page.once('dialog', (dialog) => dialog.accept());
  await remove.click();
  await expect.poll(async () => (await cartJson(page)).items.filter((item) => item.final_line_price > 0).length, {
    message: 'REMOVE must remove every selected paid line',
  }).toBe(0);
  await clearCart(page);
}

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  if (!market) throw new TestConfigStaleError(`${site.id} has no market ${marketId}`);

  const contract = site.themeContract.cartOffers;
  for (const tab of contract.tabs) {
    const tabOffers = contract.offers.filter((offer) => offer.tabSlot === tab.slot);
    for (let start = 0; start < tabOffers.length; start += 3) {
      const offers = tabOffers.slice(start, start + 3);
      const part = Math.floor(start / 3) + 1;
      const rule = `${tab.slot}-part-${part}`;
      if (!shouldRunRule(rule)) continue;
      test(`[v2][${site.id}][${market.id}] Cart Offer ${tab.label} part ${part}`, async ({ monitorPage }) => {
        await prepareMarket(monitorPage, site, market);
        const group = await qualifyTab(monitorPage, site, tab);
        expect(offers.length, `${tab.label} configured offers`).toBeGreaterThan(0);
        for (const offer of offers) await assertOffer(monitorPage, site, market, group, offer);

        if (tab.audience === 'trigger') {
          const triggerIds = String(await group.getAttribute('data-trigger-product-ids')).split(',').filter(Boolean);
          const current = await cartJson(monitorPage);
          const triggerLines = current.items.filter((item) => triggerIds.includes(String(item.product_id)));
          for (const line of triggerLines) {
            await monitorPage.evaluate(async (key) => {
              const response = await fetch('/cart/change.js', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: key, quantity: 0 }),
              });
              if (!response.ok) throw new Error(`remove trigger HTTP ${response.status}`);
            }, line.key);
          }
          await monitorPage.reload({ waitUntil: 'domcontentloaded' });
          await expect(group, `${tab.label} must disappear after trigger removal`).toBeHidden();
        }
        await clearCart(monitorPage);
      });
    }
  }

  if (shouldRunRule('gift-picker')) test(`[v2][${site.id}][${market.id}] market Gift Picker`, async ({ monitorPage }) => {
    await prepareMarket(monitorPage, site, market);
    await addGiftPickerV3(monitorPage, site, market);
    await clearCart(monitorPage);
  });

  if (shouldRunRule('bulk-actions')) test(`[v2][${site.id}][${market.id}] Cart ALL REMOVE and gift protection`, async ({ monitorPage }) => {
    await prepareMarket(monitorPage, site, market);
    await assertBulkGiftProtection(monitorPage, site, market);
  });

  if (shouldRunRule('multi-tab')) test(`[v2][${site.id}][${market.id}] multiple eligible Tab priority and fallback`, async ({ monitorPage }) => {
    await prepareMarket(monitorPage, site, market);
    const triggerTabs = contract.tabs.filter((tab) => tab.audience === 'trigger' && Number(tab.triggerMinQuantity) === 1).slice(0, 2);
    const triggers = [];
    for (const tab of triggerTabs) {
      let selected;
      for (const handle of tab.triggerProducts) {
        const product = await storefrontProduct(monitorPage, handle);
        const variant = product?.variants?.find((entry) => entry.available);
        if (product && variant) { selected = { tab, product, variant }; break; }
      }
      if (!selected) throw new TestConfigStaleError(`${tab.label} has no available ${market.id} trigger`);
      triggers.push(selected);
    }
    await addItems(monitorPage, triggers.map((entry) => ({ id: entry.variant.id, quantity: 1 })));
    await navigateToCart(monitorPage, site.baseUrl, { settleMs: 3_000 });
    await monitorPage.reload({ waitUntil: 'domcontentloaded' });
    const firstTab = monitorPage.getByRole('tab', { name: triggers[0].tab.label });
    const secondTab = monitorPage.getByRole('tab', { name: triggers[1].tab.label });
    await expect(firstTab).toBeVisible();
    await expect(secondTab).toBeVisible();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    const cart = await cartJson(monitorPage);
    for (const line of cart.items.filter((item) => Number(item.product_id) === Number(triggers[0].product.id))) {
      await monitorPage.evaluate(async (key) => {
        const response = await fetch('/cart/change.js', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: key, quantity: 0 }),
        });
        if (!response.ok) throw new Error(`remove trigger HTTP ${response.status}`);
      }, line.key);
    }
    await monitorPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(firstTab).toBeHidden();
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await clearCart(monitorPage);
  });
}
