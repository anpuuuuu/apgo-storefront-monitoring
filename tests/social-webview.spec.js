const {
  test,
  expect,
  sites,
  cartJson,
  clearCart,
  clickCartAdd,
  ensureAvailable,
} = require('./monitor-fixture');
const { prepareMarket } = require('./layer2-journeys');

const marketId = (process.env.MONITOR_MARKET || 'MY').toUpperCase();
const deviceId = process.env.MONITOR_DEVICE || '';
const uaMarkers = {
  'facebook-android': /FB_IAB\/FB4A.*FBAV\//,
  'instagram-iphone': /Instagram\s/i,
  'whatsapp-android': /WA4A\//,
};

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  if (!market) throw new Error(`TEST_CONFIG_STALE: ${site.id} has no market ${marketId}`);

  test(`[v2][${site.id}][${market.id}] Atomic Bundle add in ${deviceId}`, async ({ monitorPage }) => {
    const uaMarker = uaMarkers[deviceId];
    if (!uaMarker) throw new Error(`TEST_CONFIG_STALE: unsupported social WebView device ${deviceId}`);
    expect(await monitorPage.evaluate(() => navigator.userAgent)).toMatch(uaMarker);

    await prepareMarket(monitorPage, site, market);
    const fixture = site.fixtures.atomicBundle;
    const add = await ensureAvailable(
      monitorPage,
      site.baseUrl,
      fixture.handle,
      '[data-apgo-cc-add]:visible, [data-apgo-cc-buybar-add]:visible'
    );
    await clickCartAdd(monitorPage, add, { expectedVariantId: fixture.expectedVariantId });

    const cart = await cartJson(monitorPage);
    const item = cart.items.find((entry) => Number(entry.variant_id) === Number(fixture.expectedVariantId));
    expect(item, `Atomic Bundle should add variant ${fixture.expectedVariantId}`).toBeTruthy();
    expect(item.quantity, 'Atomic Bundle should be added exactly once').toBe(1);
    expect(item.final_line_price, 'Atomic Bundle cart amount').toBe(fixture.expectedPriceMinor);
    await clearCart(monitorPage);
  });
}
