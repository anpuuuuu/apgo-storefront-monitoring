import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Layer2ConfigError,
  buildLayer2Matrix,
  loadLayer2Config,
  validateLayer2Config,
} from '../scripts/layer2-config.mjs';

function cloneConfig() {
  return structuredClone(loadLayer2Config());
}

test('current Layer 2 configuration is valid', () => {
  assert.doesNotThrow(() => validateLayer2Config(cloneConfig()));
});

test('dynamic Layer 2 is not blocked by an obsolete legacy product fixture', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.laundryPdp;
  assert.doesNotThrow(() => validateLayer2Config(config));
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*laundryPdp/);
});

test('post-deploy matrix falls back to Android and iPhone when GA4 has no paid pages', () => {
  const matrix = buildLayer2Matrix(cloneConfig(), 'post-deploy', []);
  assert.deepEqual(matrix.include.map((entry) => entry.device).sort(), ['android-chromium', 'iphone-webkit']);
  assert(matrix.include.every((entry) => entry.journey === 'mobile-main'));
});

test('daily matrix sends paid social pages to both social mobile profiles and keeps desktop smoke', () => {
  const matrix = buildLayer2Matrix(cloneConfig(), 'daily', [{
    site: 'apgo-my', market: 'MY', landingPath: '/products/demo', channel: 'Paid Social',
    sessions: 8, addToCarts: 2, checkouts: 1,
  }]);
  const adJobs = matrix.include.filter((entry) => entry.flow === 'ad-landing');
  assert.deepEqual(adJobs.map((entry) => entry.device).sort(), ['facebook-android', 'instagram-iphone']);
  assert.equal(matrix.include.filter((entry) => entry.journey === 'desktop-smoke').length, 2);
  assert(adJobs.every((entry) => entry.landingPath === '/products/demo'));
});

test('duplicate promotion ids fail as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  config.sites[0].promotions.push(structuredClone(config.sites[0].promotions[0]));
  assert.throws(() => validateLayer2Config(config), Layer2ConfigError);
});

test('duplicate immutable repository ids fail as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  const duplicate = structuredClone(config.sites[0]);
  duplicate.id = 'apgo-tw';
  duplicate.siteId = 'apgo-tw';
  duplicate.repository = 'anpuuuuu/apgo-tw-theme';
  duplicate.storefrontOrigins = ['https://apgo.com.tw'];
  config.sites.push(duplicate);
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*repository id/);
});

test('missing configured variant fails as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.laundryPdp.variants.Lavender;
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*Lavender/);
});

test('missing storefront scent option value fails as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.laundryPdp.optionValues.Lavender;
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*optionValues\.Lavender/);
});

test('complex detergent promotion requires expected market tiers', () => {
  const config = cloneConfig();
  config.sites[0].markets[0].detergentPromotionTiers = [];
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*expected tiers/);
});

test('complex detergent promotion requires an expected market amount', () => {
  const config = cloneConfig();
  delete config.sites[0].markets[1].detergentPaidUnitPriceMinor;
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*paid unit price/);
});

test('normal PDP fixture requires a stable variant id', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.normalV3.expectedVariantId;
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*normalV3.*VariantId/);
});

test('Glaze fixture requires market-specific expected offer prices', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.glaze.firstOfferPriceMinor.SG;
  assert.throws(() => validateLayer2Config(config, { legacy: true }), /TEST_CONFIG_STALE.*firstOfferPriceMinor.SG/);
});

test('runtime validation no longer requires a mirrored cart tab list', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.cartOffers.tabs.shift();
  assert.doesNotThrow(() => validateLayer2Config(config));
});

test('runtime validation no longer requires a mirrored cart offer list', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.cartOffers.offers.shift();
  assert.doesNotThrow(() => validateLayer2Config(config));
});

test('runtime validation does not hard-code an offer quantity rule', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.cartOffers.offers[0].maxQuantity = 0;
  assert.doesNotThrow(() => validateLayer2Config(config));
});

test('runtime validation no longer requires a mirrored promotion block list', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.goldenBullBlocks.pop();
  assert.doesNotThrow(() => validateLayer2Config(config));
});

test('runtime validation does not hard-code Golden Bull banner state', () => {
  const config = cloneConfig();
  const block = config.sites[0].themeContract.goldenBullBlocks.find((entry) => entry.blockId === 'promo_banner_aurora');
  block.banner = 'shopify://shop_images/wrong-banner.png';
  block.counterEnabled = true;
  assert.doesNotThrow(() => validateLayer2Config(config));
});
