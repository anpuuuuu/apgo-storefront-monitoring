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

test('full matrix includes MY/SG and all three device projects', () => {
  const matrix = buildLayer2Matrix(cloneConfig(), 'full');
  assert.deepEqual([...new Set(matrix.include.map((entry) => entry.market))].sort(), ['MY', 'SG']);
  assert.deepEqual([...new Set(matrix.include.map((entry) => entry.device))].sort(), [
    'android-chromium',
    'desktop-chromium',
    'iphone-webkit',
  ]);
  assert(matrix.include.some((entry) => entry.journey === 'golden-bull'));
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
