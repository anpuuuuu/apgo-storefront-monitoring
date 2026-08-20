export const STORE_ORIGINS = ['https://apgo.my', 'https://www.apgo.my'];
export const SHOPIFY_ORIGIN = /^https:\/\/[a-z0-9-]+\.myshopify\.com$/;

export const UPTIME_TARGETS = [
  {
    id: 'homepage',
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
    id: 'cart-api',
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
  errorWindowMinutes: 10,
  errorMinOccurrences: 3,
  errorMinSessions: 2,
  errorRealertMs: 2 * 60 * 60_000,
};

export const HEARTBEAT_LIMITS = {
  layer1: 15 * 60_000,
  layer2: 2 * 60 * 60_000,
  layer3: 26 * 60 * 60_000,
  layer4: 90 * 60_000,
};
