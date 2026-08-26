#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(here, '..', 'sites.json');
const themeRoot = path.resolve(here, '..', '..');

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

function loadThemeJson(relativePath, label) {
  required(relativePath, label);
  const absolutePath = path.resolve(themeRoot, relativePath);
  const relativeToTheme = path.relative(themeRoot, absolutePath);
  if (relativeToTheme.startsWith('..') || path.isAbsolute(relativeToTheme)) {
    throw new Layer2ConfigError(`${label} must stay inside the theme repository`);
  }
  if (!fs.existsSync(absolutePath)) throw new Layer2ConfigError(`${label} does not exist: ${relativePath}`);
  const source = fs.readFileSync(absolutePath, 'utf8').replace(/^\/\*[\s\S]*?\*\//, '');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Layer2ConfigError(`${label} is not valid Shopify JSON: ${error.message}`);
  }
}

function equalJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Layer2ConfigError(`${label} drifted (theme=${JSON.stringify(actual)}, monitor=${JSON.stringify(expected)})`);
  }
}

function sectionByType(template, type, label) {
  const matches = Object.entries(template.sections || {}).filter(([, section]) => section.type === type);
  if (matches.length !== 1) throw new Layer2ConfigError(`${label} needs exactly one ${type} section`);
  return matches[0][1];
}

function expectedGoldenBullMarkets(block) {
  const settings = block.settings || {};
  const allowed = (market) => settings.market_visibility === 'both' || settings.market_visibility === market.toLowerCase();
  const renders = (market) => {
    if (!allowed(market)) return false;
    if (block.type === 'promo_banner') {
      const product = market === 'SG' ? (settings.product_sg || settings.product) : settings.product;
      const banner = market === 'SG' ? (settings.banner_sg || settings.banner) : settings.banner;
      return Boolean(product && banner);
    }
    if (block.type === 'product_carousel') {
      const banner = market === 'SG' ? (settings.banner_sg || settings.banner) : settings.banner;
      return Boolean(banner && Array.isArray(settings.products) && settings.products.length);
    }
    if (block.type === 'featured_stage') return Boolean(settings.product_1 && settings.product_2);
    return false;
  };
  return ['MY', 'SG'].filter(renders);
}

function validateThemeContract(site) {
  const contract = site.themeContract;
  required(contract, `${site.id}.themeContract`);

  const cartTemplate = loadThemeJson(contract.cartTemplate, `${site.id}.themeContract.cartTemplate`);
  const cartSection = sectionByType(cartTemplate, 'cart-offers-tabs', `${site.id} cart template`);
  const actualTabs = Object.entries(cartSection.blocks || {})
    .filter(([, block]) => block.type === 'tab' && block.settings?.enabled && !block.disabled)
    .map(([blockId, block]) => ({ blockId, block }));
  const actualOffers = Object.entries(cartSection.blocks || {})
    .filter(([, block]) => block.type === 'offer_item' && !block.disabled)
    .map(([blockId, block]) => ({ blockId, block }));
  const expectedTabs = contract.cartOffers?.tabs || [];
  const expectedOffers = contract.cartOffers?.offers || [];
  unique(expectedTabs, `${site.id} cart-offer tab`, (entry) => entry.blockId);
  unique(expectedOffers, `${site.id} cart-offer item`, (entry) => entry.blockId);
  equalJson(actualTabs.map((entry) => entry.blockId), expectedTabs.map((entry) => entry.blockId), `${site.id} enabled cart-offer tabs and order`);
  equalJson(actualOffers.map((entry) => entry.blockId), expectedOffers.map((entry) => entry.blockId), `${site.id} enabled cart-offer items and order`);

  for (const expected of expectedTabs) {
    const actual = actualTabs.find((entry) => entry.blockId === expected.blockId)?.block?.settings;
    if (!actual) throw new Layer2ConfigError(`${site.id} cart tab ${expected.blockId} is not enabled`);
    equalJson({
      slot: actual.slot,
      label: actual.label,
      audience: actual.audience,
      triggerProducts: actual.trigger_products || [],
      triggerMinQuantity: Number(actual.trigger_min_quantity || 1),
    }, {
      slot: expected.slot,
      label: expected.label,
      audience: expected.audience,
      triggerProducts: expected.triggerProducts || [],
      triggerMinQuantity: Number(expected.triggerMinQuantity || 1),
    }, `${site.id} cart tab ${expected.blockId}`);
  }

  const knownSlots = new Set(expectedTabs.map((entry) => entry.slot));
  for (const expected of expectedOffers) {
    if (!knownSlots.has(expected.tabSlot)) throw new Layer2ConfigError(`${site.id} offer ${expected.blockId} references unknown tab slot ${expected.tabSlot}`);
    const actual = actualOffers.find((entry) => entry.blockId === expected.blockId)?.block?.settings;
    if (!actual) throw new Layer2ConfigError(`${site.id} cart offer ${expected.blockId} is not enabled`);
    equalJson({
      tabSlot: actual.tab_slot,
      product: actual.product || '',
      variantId: String(actual.variant_id || ''),
      priceMode: actual.price_mode,
      promoPriceMy: actual.promo_price_my || '',
      promoPriceSg: actual.promo_price_sg || '',
      maxQuantity: Number(actual.max_quantity || 0),
    }, {
      tabSlot: expected.tabSlot,
      product: expected.product || '',
      variantId: String(expected.variantId || ''),
      priceMode: expected.priceMode,
      promoPriceMy: expected.promoPriceMy || '',
      promoPriceSg: expected.promoPriceSg || '',
      maxQuantity: Number(expected.maxQuantity || 0),
    }, `${site.id} cart offer ${expected.blockId}`);
  }

  const eventTemplate = loadThemeJson(contract.goldenBullTemplate, `${site.id}.themeContract.goldenBullTemplate`);
  const eventSection = sectionByType(eventTemplate, 'apgo-event-collection-grid', `${site.id} Golden Bull template`);
  const enabledBlocks = Object.entries(eventSection.blocks || {})
    .filter(([, block]) => !block.disabled)
    .map(([blockId, block]) => ({ blockId, block }));
  const expectedBlocks = contract.goldenBullBlocks || [];
  unique(expectedBlocks, `${site.id} Golden Bull block`, (entry) => entry.blockId);
  equalJson(enabledBlocks.map((entry) => entry.blockId), expectedBlocks.map((entry) => entry.blockId), `${site.id} enabled Golden Bull blocks and order`);
  for (const expected of expectedBlocks) {
    const actual = enabledBlocks.find((entry) => entry.blockId === expected.blockId)?.block;
    if (!actual) throw new Layer2ConfigError(`${site.id} Golden Bull block ${expected.blockId} is not enabled`);
    const settings = actual.settings || {};
    equalJson(actual.type, expected.type, `${site.id} Golden Bull block ${expected.blockId} type`);
    equalJson(settings.market_visibility || 'both', expected.marketVisibility || 'both', `${site.id} Golden Bull block ${expected.blockId} market`);
    equalJson(expectedGoldenBullMarkets(actual), expected.renderMarkets || [], `${site.id} Golden Bull block ${expected.blockId} rendered markets`);
    if (actual.type === 'promo_banner') {
      equalJson({
        ctaMode: settings.cta_mode,
        singleCtaLabel: settings.single_cta_label || '',
        banner: settings.banner || '',
        bannerSg: settings.banner_sg || '',
        product: settings.product || '',
        variantId: String(settings.variant_id || ''),
        productSg: settings.product_sg || '',
        variantIdSg: String(settings.variant_id_sg || ''),
        giftEnabled: Boolean(settings.gift_enabled),
        giftPool: settings.gift_pool || [],
        giftCount: Number(settings.gift_count || 0),
        counterEnabled: Boolean(settings.show_counter),
        counterMilestoneTotal: String(settings.counter_milestone_total || ''),
        counterReleaseTotal: String(settings.counter_release_total || ''),
        counterManualDeduction: String(settings.counter_manual_deduction || ''),
        counterFlowBaseline: String(settings.counter_flow_baseline || ''),
      }, {
        ctaMode: expected.ctaMode,
        singleCtaLabel: expected.singleCtaLabel || '',
        banner: expected.banner || '',
        bannerSg: expected.bannerSg || '',
        product: expected.product || '',
        variantId: String(expected.variantId || ''),
        productSg: expected.productSg || '',
        variantIdSg: String(expected.variantIdSg || ''),
        giftEnabled: Boolean(expected.giftEnabled),
        giftPool: expected.giftPool || [],
        giftCount: Number(expected.giftCount || 0),
        counterEnabled: Boolean(expected.counterEnabled),
        counterMilestoneTotal: String(expected.counterMilestoneTotal || ''),
        counterReleaseTotal: String(expected.counterReleaseTotal || ''),
        counterManualDeduction: String(expected.counterManualDeduction || ''),
        counterFlowBaseline: String(expected.counterFlowBaseline || ''),
      }, `${site.id} Golden Bull block ${expected.blockId} behaviour`);
    }
    if (actual.type === 'product_carousel') {
      equalJson({
        banner: settings.banner || '',
        bannerSg: settings.banner_sg || '',
        products: settings.products || [],
        variantIds: settings.variant_ids || '',
        hideCompareAt: Boolean(settings.hide_compare_at),
        showPromoLimit: Boolean(settings.show_promo_limit),
        showScrollCue: Boolean(settings.show_scroll_cue),
      }, {
        banner: expected.banner || '',
        bannerSg: expected.bannerSg || '',
        products: expected.products || [],
        variantIds: expected.variantIds || '',
        hideCompareAt: Boolean(expected.hideCompareAt),
        showPromoLimit: Boolean(expected.showPromoLimit),
        showScrollCue: Boolean(expected.showScrollCue),
      }, `${site.id} Golden Bull block ${expected.blockId} behaviour`);
    }
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
    validateThemeContract(site);
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
    for (const market of site.markets) {
      required(gift.marketHandles?.[market.id], `${site.id}.giftPickerV3.marketHandles.${market.id}`);
      if (!Number(gift.marketVariantIds?.[market.id])) {
        throw new Layer2ConfigError(`${site.id}.giftPickerV3.marketVariantIds.${market.id} is invalid`);
      }
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
    if (site.expected?.checkoutExactCartLines !== true) {
      throw new Layer2ConfigError(`${site.id}.expected.checkoutExactCartLines must be true`);
    }
  }

  return config;
}

function matrixItem({ site, market, device, journey, suite, spec, flow = '', rule = '' }) {
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
    rule,
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
        if (promotion.type === 'cart-offers') {
          const contract = site.themeContract.cartOffers;
          for (const tab of contract.tabs) {
            const offerCount = contract.offers.filter((offer) => offer.tabSlot === tab.slot).length;
            const rules = [];
            for (let part = 1; part <= Math.ceil(offerCount / 3); part += 1) {
              rules.push(`${tab.slot}-part-${part}`);
            }
            include.push(matrixItem({
              site, market, device: android, journey: `cart-offers-${tab.slot}`,
              suite: 'full', spec: 'tests/cart-offers.spec.js', flow: 'cart-offers', rule: rules.join(','),
            }));
          }
          include.push(matrixItem({
            site, market, device: android, journey: 'cart-offers-safeguards',
            suite: 'full', spec: 'tests/cart-offers.spec.js', flow: 'cart-offers', rule: 'gift-picker,bulk-actions,multi-tab',
          }));
          continue;
        }
        const isExistingCommerceFlow = ['detergent', 'glaze', 'recommendations'].includes(promotion.type);
        const commerceSpec = isExistingCommerceFlow ? 'tests/full-commerce.spec.js' : 'tests/golden-bull.spec.js';
        include.push(matrixItem({
          site,
          market,
          device: android,
          journey: promotion.id,
          suite: 'full',
          spec: commerceSpec,
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
