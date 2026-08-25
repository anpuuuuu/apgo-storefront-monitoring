const { test, sites } = require('./monitor-fixture');
const {
  prepareMarket,
  assertHomepage,
  addNormalV3,
  verifyCartBasics,
  enterCheckout,
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
  });
}
