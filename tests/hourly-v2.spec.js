const { test, sites, clearCart } = require('./monitor-fixture');
const {
  prepareMarket,
  assertHomepage,
  addNormalV3,
  verifyCartBasics,
  enterCheckout,
  clearAfterCheckout,
} = require('./layer2-journeys');

const journey = process.env.MONITOR_JOURNEY || '';
const marketId = (process.env.MONITOR_MARKET || 'MY').toUpperCase();

for (const site of sites) {
  const market = site.markets.find((entry) => entry.id === marketId);
  if (!market) throw new Error(`TEST_CONFIG_STALE: ${site.id} has no market ${marketId}`);

  if (journey === 'desktop-smoke') {
    test(`[v2][${site.id}][${market.id}] desktop smoke`, async ({ monitorPage }) => {
      await prepareMarket(monitorPage, site, market);
      await assertHomepage(monitorPage, site);
      const cart = await addNormalV3(monitorPage, site);
      const renderedCart = await verifyCartBasics(monitorPage, site);
      if (!renderedCart.items.length || cart.currency !== market.currency) {
        throw new Error('Desktop smoke cart lost its test product or market');
      }
      await clearCart(monitorPage);
    });
  } else if (journey === 'mobile-main') {
    test(`[v2][${site.id}][${market.id}] Mobile primary purchase path`, async ({ monitorPage }) => {
      await prepareMarket(monitorPage, site, market);
      await assertHomepage(monitorPage, site);
      await addNormalV3(monitorPage, site);
      const cart = await verifyCartBasics(monitorPage, site);
      await enterCheckout(monitorPage, site, market, cart);
      await clearAfterCheckout(monitorPage, site);
    });
  } else {
    test('invalid hourly journey configuration', async () => {
      throw new Error(`TEST_CONFIG_STALE: unsupported hourly journey ${journey || '(empty)'}`);
    });
  }
}
