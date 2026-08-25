#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(here, '..', 'sites.json');

export class Layer2ConfigError extends Error {
  constructor(message) {
    super(`TEST_CONFIG_STALE: ${message}`);
    this.name = 'Layer2ConfigError';
  }
}

export function loadLayer2Config(configPath = defaultConfigPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function required(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Layer2ConfigError(`${label} is required`);
  }
}

function unique(items, label, key = (item) => item.id) {
  const seen = new Set();
  for (const item of items) {
    const id = key(item);
    required(id, `${label} id`);
    if (seen.has(id)) throw new Layer2ConfigError(`duplicate ${label} id: ${id}`);
    seen.add(id);
  }
}

function validateProductFixture(site, name, { variants = false } = {}) {
  const fixture = site.fixtures?.[name];
  required(fixture, `${site.id}.fixtures.${name}`);
  required(fixture.handle, `${site.id}.fixtures.${name}.handle`);
  if (variants) {
    required(fixture.variants, `${site.id}.fixtures.${name}.variants`);
    for (const [variantName, variantId] of Object.entries(fixture.variants)) {
      if (!Number(variantId)) throw new Layer2ConfigError(`${site.id}.${name}.${variantName} variant id is invalid`);
    }
  }
}

export function validateLayer2Config(config) {
  const layer2 = config.monitoring?.layer2;
  required(layer2, 'monitoring.layer2');
  if (!Array.isArray(layer2.devices) || layer2.devices.length < 2) {
    throw new Layer2ConfigError('monitoring.layer2.devices must contain at least desktop and mobile');
  }
  unique(layer2.devices, 'device');
  for (const device of layer2.devices) {
    required(device.browser, `device ${device.id}.browser`);
    required(device.profile, `device ${device.id}.profile`);
    if (!['chromium', 'webkit'].includes(device.browser)) {
      throw new Layer2ConfigError(`device ${device.id} uses unsupported browser ${device.browser}`);
    }
  }

  const enabledSites = (config.sites || []).filter((site) => site.enabled && site.type === 'shopify');
  if (!enabledSites.length) throw new Layer2ConfigError('no enabled Shopify sites');
  unique(enabledSites, 'site');

  for (const site of enabledSites) {
    required(site.baseUrl, `${site.id}.baseUrl`);
    unique(site.markets || [], `${site.id} market`);
    unique(site.criticalLinks || [], `${site.id} critical link`);
    unique(site.promotions || [], `${site.id} promotion`);
    required(site.fixtures?.apiCheckVariantId, `${site.id}.fixtures.apiCheckVariantId`);
    validateProductFixture(site, 'normalV3');
    validateProductFixture(site, 'giftPickerV3');
    validateProductFixture(site, 'laundryPdp', { variants: true });
    validateProductFixture(site, 'detergentPromo', { variants: true });
    if (!Number(site.fixtures.normalV3.expectedVariantId)) {
      throw new Layer2ConfigError(`${site.id}.normalV3.expectedVariantId is invalid`);
    }

    const laundry = site.fixtures.laundryPdp;
    if (!Number(laundry.unitPriceMinor)) throw new Layer2ConfigError(`${site.id}.laundryPdp.unitPriceMinor is invalid`);
    for (const scent of [laundry.primaryScent, laundry.secondaryScent]) {
      required(scent, `${site.id}.laundryPdp scent`);
      if (!Number(laundry.variants[scent])) throw new Layer2ConfigError(`${site.id}.laundryPdp is missing ${scent}`);
      required(laundry.optionValues?.[scent], `${site.id}.laundryPdp.optionValues.${scent}`);
    }
    const gift = site.fixtures.giftPickerV3;
    if (!Number(gift.expectedVariantId) || !Number(gift.requiredGiftQuantity)) {
      throw new Layer2ConfigError(`${site.id}.giftPickerV3 needs expectedVariantId and requiredGiftQuantity`);
    }
    if (!Array.isArray(gift.giftVariantIds) || gift.giftVariantIds.length < gift.requiredGiftQuantity) {
      throw new Layer2ConfigError(`${site.id}.giftPickerV3 does not contain enough gift variants`);
    }

    for (const promotion of site.promotions || []) {
      if (!Array.isArray(promotion.markets) || !promotion.markets.length) {
        throw new Layer2ConfigError(`${site.id}.promotion ${promotion.id} has no markets`);
      }
      for (const marketId of promotion.markets) {
        const market = site.markets.find((entry) => entry.id === marketId);
        if (!market) throw new Layer2ConfigError(`${site.id}.promotion ${promotion.id} references unknown market ${marketId}`);
        required(market.currency, `${site.id}.${marketId}.currency`);
        required(market.priceMarker, `${site.id}.${marketId}.priceMarker`);
        if (promotion.type === 'detergent' && !(market.detergentPromotionTiers || []).length) {
          throw new Layer2ConfigError(`${site.id}.${marketId} detergent promotion has no expected tiers`);
        }
        if (promotion.type === 'detergent' && !Number(market.detergentPaidUnitPriceMinor)) {
          throw new Layer2ConfigError(`${site.id}.${marketId} detergent promotion has no expected paid unit price`);
        }
      }
      if (promotion.fixture) required(site.fixtures[promotion.fixture], `${site.id}.fixtures.${promotion.fixture}`);
      if (promotion.type === 'event-page') required(promotion.path, `${site.id}.promotion ${promotion.id}.path`);
    }

    const glaze = site.fixtures.glaze;
    for (const field of ['firstOfferProductId', 'firstOfferVariantId']) {
      if (!Number(glaze?.[field])) throw new Layer2ConfigError(`${site.id}.fixtures.glaze.${field} is invalid`);
    }
    for (const market of site.markets) {
      if (!Number(glaze.firstOfferPriceMinor?.[market.id])) {
        throw new Layer2ConfigError(`${site.id}.fixtures.glaze.firstOfferPriceMinor.${market.id} is invalid`);
      }
    }
    const offers = site.fixtures.cartOffers;
    for (const field of ['quickAddProductId', 'quickAddVariantId']) {
      if (!Number(offers?.[field])) throw new Layer2ConfigError(`${site.id}.fixtures.cartOffers.${field} is invalid`);
    }
    required(offers.selectOptionsHandle, `${site.id}.fixtures.cartOffers.selectOptionsHandle`);
  }

  return config;
}

function matrixItem({ site, market, device, journey, suite, spec, flow = '' }) {
  return {
    id: [site.id, market?.id || 'default', device.id, journey].join('-'),
    site: site.id,
    market: market?.id || '',
    device: device.id,
    browser: device.browser,
    journey,
    suite,
    spec,
    flow,
  };
}

export function buildLayer2Matrix(config, cadence = 'hourly') {
  validateLayer2Config(config);
  const devices = config.monitoring.layer2.devices;
  const enabledSites = config.sites.filter((site) => site.enabled && site.type === 'shopify');
  const include = [];

  for (const site of enabledSites) {
    const primaryMarket = site.markets.find((market) => market.id === 'MY') || site.markets[0];
    if (cadence === 'hourly' || cadence === 'push') {
      const android = devices.find((device) => device.id === 'android-chromium' && device.hourly);
      const desktop = devices.find((device) => device.id === 'desktop-chromium' && device.hourly);
      if (!android || !desktop) throw new Layer2ConfigError('hourly matrix needs android-chromium and desktop-chromium');
      include.push(matrixItem({ site, market: primaryMarket, device: android, journey: 'mobile-main', suite: 'light', spec: 'tests/hourly-v2.spec.js' }));
      include.push(matrixItem({ site, market: primaryMarket, device: desktop, journey: 'desktop-smoke', suite: 'light', spec: 'tests/hourly-v2.spec.js' }));
      continue;
    }

    if (cadence !== 'full') throw new Layer2ConfigError(`unknown cadence ${cadence}`);
    const android = devices.find((device) => device.id === 'android-chromium' && device.daily);
    if (!android) throw new Layer2ConfigError('full matrix needs android-chromium');

    // Complex discount/cart behaviour is checked once on Android per market.
    for (const promotion of site.promotions || []) {
      for (const marketId of promotion.markets) {
        const market = site.markets.find((entry) => entry.id === marketId);
        const isExistingCommerceFlow = ['detergent', 'glaze', 'recommendations'].includes(promotion.type);
        include.push(matrixItem({
          site,
          market,
          device: android,
          journey: promotion.id,
          suite: 'full',
          spec: isExistingCommerceFlow ? 'tests/full-commerce.spec.js' : 'tests/golden-bull.spec.js',
          flow: isExistingCommerceFlow ? promotion.type : promotion.id,
        }));
      }
    }

    // Cross-device checks focus on interaction, cart summary and checkout.
    for (const device of devices.filter((entry) => entry.daily)) {
      for (const market of site.markets) {
        include.push(matrixItem({ site, market, device, journey: 'core-checkout', suite: 'full', spec: 'tests/core-checkout.spec.js' }));
      }
    }
  }

  unique(include, 'matrix job');
  return { include };
}

function main() {
  const command = process.argv[2] || 'validate';
  const configPath = process.argv[3] ? path.resolve(process.argv[3]) : defaultConfigPath;
  const config = loadLayer2Config(configPath);
  if (command === 'validate') {
    validateLayer2Config(config);
    console.log('Layer 2 configuration is valid.');
    return;
  }
  if (command === 'matrix') {
    const cadence = process.argv[4] || process.env.MONITOR_CADENCE || 'hourly';
    console.log(JSON.stringify(buildLayer2Matrix(config, cadence)));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
