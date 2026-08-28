export const SITES = [
  {
    id: 'apgo-my',
    label: 'APGO MY',
    origins: ['https://apgo.my', 'https://www.apgo.my'],
    baseUrl: 'https://apgo.my',
    enabledLayers: ['layer1', 'layer2', 'layer3', 'layer4'],
  },
];

export const STORE_ORIGINS = SITES.flatMap((site) => site.origins);

export function siteForOrigin(origin) {
  return SITES.find((site) => site.origins.includes(origin)) || null;
}

export function siteById(siteId) {
  return SITES.find((site) => site.id === siteId) || null;
}

export function siteKey(siteId, value) {
  return `${siteId}:${value}`;
}

export const UPTIME_TARGETS = [
  {
    siteId: 'apgo-my',
    id: 'apgo-my:homepage',
    url: 'https://apgo.my/',
    validate: async (response) => {
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (!/<html[\s>]/i.test(body) || !/(APGO|Shopify|shopify-section)/i.test(body)) {
        throw new Error('expected APGO/Shopify page marker missing');
      }
    },
  },
  {
    siteId: 'apgo-my',
    id: 'apgo-my:cart-api',
    url: 'https://apgo.my/cart.js',
    validate: async (response) => {
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const cart = await response.json();
      if (!cart || !Array.isArray(cart.items) || !Number.isFinite(Number(cart.item_count))) {
        throw new Error('invalid Shopify cart JSON');
      }
    },
  },
];

export const LIMITS = {
  bodyBytes: 8_192,
  perIpPerMinute: 10,
  requestTimeoutMs: 10_000,
  slowMs: 5_000,
  failureThreshold: 2,
  slowThreshold: 3,
  uptimeRealertMs: 60 * 60_000,
  // Heartbeat incidents already alert again when warning escalates to
  // critical. Keep long incidents visible without paging every hour.
  heartbeatRealertMs: 6 * 60 * 60_000,
  errorWindowMinutes: 10,
  errorMinOccurrences: 3,
  errorMinSessions: 2,
  resourceMinOccurrences: 8,
  resourceMinSessions: 5,
  errorDigestMaxItems: 6,
  errorRealertMs: 2 * 60 * 60_000,
};

export const HEARTBEAT_LIMITS = {
  layer1: 15 * 60_000,
  // Layer 2 now runs once daily. Post-deploy checks deliberately do not
  // refresh this heartbeat, so a successful theme push cannot hide a missed
  // daily commerce run.
  layer2: 30 * 60 * 60_000,
  layer3: 26 * 60 * 60_000,
  layer4: 90 * 60_000,
};

export const HEARTBEAT_CRITICAL_LIMITS = {
  layer2: 36 * 60 * 60_000,
};
