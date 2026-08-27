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

test('hourly matrix contains Android main and desktop smoke only', () => {
  const matrix = buildLayer2Matrix(cloneConfig(), 'hourly');
  assert.deepEqual(matrix.include.map((entry) => entry.journey).sort(), ['desktop-smoke', 'mobile-main']);
});

test('full matrix includes MY/SG, core devices and social WebView profiles', () => {
  const matrix = buildLayer2Matrix(cloneConfig(), 'full');
  assert.deepEqual([...new Set(matrix.include.map((entry) => entry.market))].sort(), ['MY', 'SG']);
  assert.deepEqual([...new Set(matrix.include.map((entry) => entry.device))].sort(), [
    'android-chromium',
    'desktop-chromium',
    'facebook-android',
    'instagram-iphone',
    'iphone-webkit',
    'whatsapp-android',
  ]);
  assert.equal(matrix.include.filter((entry) => entry.journey === 'atomic-social-add').length, 3);
  assert(matrix.include.some((entry) => entry.journey === 'golden-bull'));
  assert(matrix.include.some((entry) => entry.journey === 'cart-offers-tab_5'));
  assert(matrix.include.some((entry) => entry.journey === 'cart-offers-safeguards'));
  assert(matrix.include.filter((entry) => entry.flow === 'cart-offers').every((entry) => entry.rule));
});

test('duplicate promotion ids fail as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  config.sites[0].promotions.push(structuredClone(config.sites[0].promotions[0]));
  assert.throws(() => validateLayer2Config(config), Layer2ConfigError);
});

test('missing configured variant fails as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.laundryPdp.variants.Lavender;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*Lavender/);
});

test('missing storefront scent option value fails as TEST_CONFIG_STALE', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.laundryPdp.optionValues.Lavender;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*optionValues\.Lavender/);
});

test('complex detergent promotion requires expected market tiers', () => {
  const config = cloneConfig();
  config.sites[0].markets[0].detergentPromotionTiers = [];
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*expected tiers/);
});

test('complex detergent promotion requires an expected market amount', () => {
  const config = cloneConfig();
  delete config.sites[0].markets[1].detergentPaidUnitPriceMinor;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*paid unit price/);
});

test('normal PDP fixture requires a stable variant id', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.normalV3.expectedVariantId;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*normalV3.*VariantId/);
});

test('Glaze fixture requires market-specific expected offer prices', () => {
  const config = cloneConfig();
  delete config.sites[0].fixtures.glaze.firstOfferPriceMinor.SG;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*firstOfferPriceMinor.SG/);
});

test('an enabled theme tab missing from the coverage contract is stale', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.cartOffers.tabs.shift();
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*enabled cart-offer tabs/);
});

test('an enabled theme offer missing from the coverage contract is stale', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.cartOffers.offers.shift();
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*enabled cart-offer items/);
});

test('cart offer business-rule drift is stale even when the block still exists', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.cartOffers.offers[0].maxQuantity = 0;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*cart offer glaze_paint/);
});

test('an enabled Golden Bull block missing from the coverage contract is stale', () => {
  const config = cloneConfig();
  config.sites[0].themeContract.goldenBullBlocks.pop();
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*enabled Golden Bull blocks/);
});

test('Golden Bull banner and counter drift is stale even when the block remains enabled', () => {
  const config = cloneConfig();
  const block = config.sites[0].themeContract.goldenBullBlocks.find((entry) => entry.blockId === 'promo_banner_aurora');
  block.banner = 'shopify://shop_images/wrong-banner.png';
  block.counterEnabled = true;
  assert.throws(() => validateLayer2Config(config), /TEST_CONFIG_STALE.*promo_banner_aurora behaviour/);
});
