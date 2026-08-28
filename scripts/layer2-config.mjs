#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(here, '..', 'config', 'sites.json');

function resolveThemeRoot() {
  const configured = process.env.MONITOR_THEME_ROOT;
  if (!configured) {
    throw new Layer2ConfigError('MONITOR_THEME_ROOT is required for Theme Contract validation');
  }
  return path.resolve(configured);
}

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
  const themeRoot = resolveThemeRoot();
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
  const tabs = Object.entries(cartSection.blocks || {})
    .filter(([, block]) => block.type === 'tab' && block.settings?.enabled && !block.disabled)
    .map(([blockId, block]) => ({ blockId, settings: block.settings || {} }));
  const offers = Object.entries(cartSection.blocks || {})
    .filter(([, block]) => block.type === 'offer_item' && !block.disabled)
    .map(([blockId, block]) => ({ blockId, settings: block.settings || {} }));
  unique(tabs, `${site.id} enabled cart tab`, (entry) => entry.blockId);
  unique(offers, `${site.id} enabled cart offer`, (entry) => entry.blockId);
  unique(tabs, `${site.id} enabled cart tab slot`, (entry) => entry.settings.slot);
  const slots = new Set(tabs.map((entry) => entry.settings.slot));
  for (const tab of tabs) {
    required(tab.settings.slot, `${site.id} cart tab ${tab.blockId}.slot`);
    required(tab.settings.label, `${site.id} cart tab ${tab.blockId}.label`);
    if (tab.settings.audience === 'trigger' && !(tab.settings.trigger_products || []).length) {
      throw new Layer2ConfigError(`${site.id} cart tab ${tab.blockId} is trigger-based without trigger products`);
    }
  }
  for (const offer of offers) {
    required(offer.settings.tab_slot, `${site.id} cart offer ${offer.blockId}.tab_slot`);
    if (!slots.has(offer.settings.tab_slot)) {
      throw new Layer2ConfigError(`${site.id} cart offer ${offer.blockId} references missing tab ${offer.settings.tab_slot}`);
    }
    required(offer.settings.product, `${site.id} cart offer ${offer.blockId}.product`);
    if (!['actual', 'promo'].includes(offer.settings.price_mode)) {
      throw new Layer2ConfigError(`${site.id} cart offer ${offer.blockId} has invalid price mode`);
    }
  }

  const eventTemplate = loadThemeJson(contract.goldenBullTemplate, `${site.id}.themeContract.goldenBullTemplate`);
  const eventSection = sectionByType(eventTemplate, 'apgo-event-collection-grid', `${site.id} Golden Bull template`);
  const blocks = Object.entries(eventSection.blocks || {})
    .filter(([, block]) => !block.disabled)
    .map(([blockId, block]) => ({ blockId, block }));
  unique(blocks, `${site.id} enabled Golden Bull block`, (entry) => entry.blockId);
  for (const { blockId, block } of blocks) {
    const settings = block.settings || {};
    if (!['promo_banner', 'product_carousel', 'featured_stage'].includes(block.type)) {
      throw new Layer2ConfigError(`${site.id} Golden Bull block ${blockId} has unsupported type ${block.type}`);
    }
    const markets = expectedGoldenBullMarkets(block);
    if (block.type === 'promo_banner' && markets.length) {
      required(settings.cta_mode, `${site.id} Golden Bull block ${blockId}.cta_mode`);
    }
    if (block.type === 'product_carousel' && markets.length && !(settings.products || []).length) {
      throw new Layer2ConfigError(`${site.id} Golden Bull carousel ${blockId} has no products`);
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

export function validateLayer2Config(config, { legacy = false, contract = Boolean(process.env.MONITOR_THEME_ROOT) } = {}) {
  const layer2 = config.monitoring?.layer2;
  required(layer2, 'monitoring.layer2');
  const discovery = layer2.adDiscovery;
  required(discovery, 'monitoring.layer2.adDiscovery');
  if (discovery.enabled) {
    if (!Number(discovery.lookbackDays) || !Number(discovery.maxLandingPages)) {
      throw new Layer2ConfigError('adDiscovery lookbackDays and maxLandingPages must be positive');
    }
    if (!Array.isArray(discovery.paidChannels) || !discovery.paidChannels.length) {
      throw new Layer2ConfigError('adDiscovery paidChannels must not be empty');
    }
    if (!Object.keys(discovery.countryMarketMap || {}).length) {
      throw new Layer2ConfigError('adDiscovery countryMarketMap must not be empty');
    }
  }
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
  const deviceIds = new Set(layer2.devices.map((device) => device.id));
  for (const id of [...(discovery.paidSocialDevices || []), ...(discovery.otherPaidDevices || [])]) {
    if (!deviceIds.has(id)) throw new Layer2ConfigError(`adDiscovery references unknown device ${id}`);
  }

  const enabledSites = (config.sites || []).filter((site) => site.enabled && site.type === 'shopify');
  if (!enabledSites.length) throw new Layer2ConfigError('no enabled Shopify sites');
  unique(enabledSites, 'site');

  for (const site of enabledSites) {
    required(site.repository, `${site.id}.repository`);
    required(site.repositoryId, `${site.id}.repositoryId`);
    required(site.defaultBranch, `${site.id}.defaultBranch`);
    required(site.ga4PropertyId, `${site.id}.ga4PropertyId`);
    if (!/^\d+$/.test(String(site.repositoryId))) {
      throw new Layer2ConfigError(`${site.id}.repositoryId must be an immutable numeric GitHub repository id`);
    }
    required(site.baseUrl, `${site.id}.baseUrl`);
    unique(site.markets || [], `${site.id} market`);
    unique(site.criticalLinks || [], `${site.id} critical link`);
    unique(site.promotions || [], `${site.id} promotion`);
    for (const market of site.markets || []) {
      required(market.countryCode, `${site.id}.${market.id}.countryCode`);
      required(market.currency, `${site.id}.${market.id}.currency`);
      required(market.priceMarker, `${site.id}.${market.id}.priceMarker`);
    }
    if (contract) validateThemeContract(site);
    if (!legacy) continue;

    required(site.fixtures?.apiCheckVariantId, `${site.id}.fixtures.apiCheckVariantId`);
    validateProductFixture(site, 'normalV3');
    validateProductFixture(site, 'giftPickerV3');
    validateProductFixture(site, 'atomicBundle');
    validateProductFixture(site, 'laundryPdp', { variants: true });
    validateProductFixture(site, 'detergentPromo', { variants: true });
    if (!Number(site.fixtures.normalV3.expectedVariantId)) {
      throw new Layer2ConfigError(`${site.id}.normalV3.expectedVariantId is invalid`);
    }
    if (!Number(site.fixtures.atomicBundle.expectedVariantId) || !Number(site.fixtures.atomicBundle.expectedPriceMinor)) {
      throw new Layer2ConfigError(`${site.id}.atomicBundle expected variant or price is invalid`);
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

function buildLegacyLayer2Matrix(config, cadence = 'hourly') {
  validateLayer2Config(config, { legacy: true });
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

    // One exact Atomic Bundle add per social in-app browser profile. These
    // projects emulate the UA + rendering engine combinations seen in Layer 3
    // without multiplying every checkout/discount journey by three.
    for (const deviceId of ['facebook-android', 'instagram-iphone', 'whatsapp-android']) {
      const socialDevice = devices.find((device) => device.id === deviceId);
      if (!socialDevice) throw new Layer2ConfigError(`full matrix needs ${deviceId}`);
      include.push(matrixItem({
        site,
        market: primaryMarket,
        device: socialDevice,
        journey: 'atomic-social-add',
        suite: 'full',
        spec: 'tests/social-webview.spec.js',
      }));
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

function targetId(target) {
  return createHash('sha256')
    .update(`${target.site}|${target.market}|${target.channel}|${target.landingPath}`)
    .digest('hex')
    .slice(0, 10);
}

function adMatrixItem(site, market, device, target, cadence) {
  return {
    ...matrixItem({
      site,
      market,
      device,
      journey: `ad-${targetId(target)}`,
      suite: cadence === 'daily' ? 'full' : 'light',
      spec: 'tests/ad-landing.spec.js',
      flow: 'ad-landing',
    }),
    landingPath: target.landingPath,
    channel: target.channel,
    sessions: Number(target.sessions || 0),
    addToCarts: Number(target.addToCarts || 0),
    checkouts: Number(target.checkouts || 0),
  };
}

export function buildLayer2Matrix(config, cadence = 'post-deploy', adTargets = []) {
  validateLayer2Config(config);
  if (cadence === 'hourly' || cadence === 'full') return buildLegacyLayer2Matrix(config, cadence);
  if (!['daily', 'post-deploy'].includes(cadence)) throw new Layer2ConfigError(`unknown cadence ${cadence}`);

  const devices = config.monitoring.layer2.devices;
  const discovery = config.monitoring.layer2.adDiscovery;
  const requestedSiteId = process.env.MONITOR_SITE_ID || '';
  const enabledSites = config.sites.filter((site) => site.enabled && site.type === 'shopify' && (!requestedSiteId || site.id === requestedSiteId));
  if (!enabledSites.length) throw new Layer2ConfigError(`matrix has no enabled site matching ${requestedSiteId || 'configuration'}`);
  const include = [];

  for (const site of enabledSites) {
    const targets = (adTargets || []).filter((target) => target.site === site.id);
    const primaryMarket = site.markets.find((market) => market.id === 'MY') || site.markets[0];

    if (cadence === 'daily') {
      const desktop = devices.find((device) => device.id === 'desktop-chromium' && device.daily);
      if (!desktop) throw new Layer2ConfigError('daily matrix needs desktop-chromium');
      for (const market of site.markets) {
        include.push(matrixItem({
          site, market, device: desktop, journey: 'desktop-smoke', suite: 'light', spec: 'tests/hourly-v2.spec.js',
        }));
      }
    }

    for (const target of targets) {
      const market = site.markets.find((entry) => entry.id === target.market);
      if (!market) throw new Layer2ConfigError(`ad target references unknown market ${target.market}`);
      const ids = target.channel === 'Paid Social' ? discovery.paidSocialDevices : discovery.otherPaidDevices;
      for (const id of ids) {
        const device = devices.find((entry) => entry.id === id && entry[cadence === 'daily' ? 'daily' : 'postDeploy']);
        if (!device) throw new Layer2ConfigError(`${cadence} ad target requires enabled device ${id}`);
        include.push(adMatrixItem(site, market, device, target, cadence));
      }
    }

    // GA4 may legitimately return no paid landing pages. Keep a real mobile
    // purchase check so a no-ad day never turns Layer 2 into a no-op.
    if (!targets.length) {
      for (const id of ['android-chromium', 'iphone-webkit']) {
        const flag = cadence === 'daily' ? 'daily' : 'postDeploy';
        const device = devices.find((entry) => entry.id === id && entry[flag]);
        if (!device) throw new Layer2ConfigError(`${cadence} fallback requires ${id}`);
        include.push(matrixItem({
          site, market: primaryMarket, device, journey: 'mobile-main', suite: 'light', spec: 'tests/hourly-v2.spec.js',
        }));
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
    validateLayer2Config(config, { contract: true });
    console.log('Layer 2 configuration is valid.');
    return;
  }
  if (command === 'matrix') {
    const cadence = process.argv[4] || process.env.MONITOR_CADENCE || 'post-deploy';
    const targetsPath = process.argv[5] || process.env.MONITOR_AD_TARGETS_FILE || '';
    let targets = [];
    if (targetsPath) {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(targetsPath), 'utf8'));
      targets = Array.isArray(parsed) ? parsed : (parsed.targets || []);
    }
    console.log(JSON.stringify(buildLayer2Matrix(config, cadence, targets)));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
