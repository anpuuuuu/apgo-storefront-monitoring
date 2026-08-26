const { test, sites } = require('./monitor-fixture');
const {
  prepareMarket,
  assertHomepage,
  addNormalV3,
  verifyCartBasics,
  enterCheckout,
  buyNormalV3,
  clearAfterCheckout,
} = require('./layer2-journeys');

const marketId = (process.env.MONITOR_MARKET || '').toUpperCase();

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  if (!market) throw new Error(`TEST_CONFIG_STALE: ${site.id} has no market ${marketId}`);

  test(`[v2][${site.id}][${market.id}] cross-device checkout`, async ({ monitorPage }) => {
    await prepareMarket(monitorPage, site, market);
    await assertHomepage(monitorPage, site);
    await addNormalV3(monitorPage, site);
    const cart = await verifyCartBasics(monitorPage, site);
    await enterCheckout(monitorPage, site, market, cart);
    await clearAfterCheckout(monitorPage, site);

    // Exercise the second purchase entry point independently. APGO's Buy now
    // intentionally stages the exact item in Cart first so discounts/gifts can
    // settle, then this journey continues to the Shopify Checkout summary.
    const buyCart = await buyNormalV3(monitorPage, site);
    await enterCheckout(monitorPage, site, market, buyCart);
    await clearAfterCheckout(monitorPage, site);
  });
}
