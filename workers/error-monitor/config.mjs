import { MONITOR_SITES } from '../site-catalog.generated.mjs';

export const SITES = MONITOR_SITES;

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

export const UPTIME_TARGETS = SITES.filter((site) => site.enabledLayers.includes('layer1')).flatMap((site) => [
  {
    siteId: site.id,
    id: `${site.id}:homepage`,
    url: `${site.baseUrl.replace(/\/$/, '')}/`,
    validate: async (response) => {
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (!/<html[\s>]/i.test(body) || !/(APGO|Shopify|shopify-section)/i.test(body)) {
        throw new Error('expected APGO/Shopify page marker missing');
      }
    },
  },
  {
    siteId: site.id,
    id: `${site.id}:cart-api`,
    url: `${site.baseUrl.replace(/\/$/, '')}/cart.js`,
    validate: async (response) => {
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const cart = await response.json();
      if (!cart || !Array.isArray(cart.items) || !Number.isFinite(Number(cart.item_count))) {
        throw new Error('invalid Shopify cart JSON');
      }
    },
  },
]);

export const LIMITS = {
  bodyBytes: 8_192,
  perIpPerMinute: 10,
  requestTimeoutMs: 10_000,
  slowMs: 5_000,
  failureThreshold: 2,
  // HTTP 429 is the platform limiting the probe; it needs a longer run than a
  // real failure before it is worth a message (3 probes = 15 minutes).
  throttleThreshold: 3,
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

// Push-based order heartbeat (orders.mjs). Mirrored in
// config/alerts-config.json `orders` for documentation, like the js_errors
// limits above.
export const ORDER_LIMITS = {
  checkMinutes: 10,
  baselineDays: 28,
  sampleMinutes: 30,
  percentile: 0.9,
  multiplier: 1.5,
  floorMinutes: 90,
  capMinutes: 720,
  // A bucket with fewer samples than this uses the bootstrap threshold, so a
  // site that only started pushing cannot page on its first quiet night.
  minSamples: 8,
  bootstrapMinutes: 360,
  criticalMultiplier: 2,
  realertMs: 6 * 60 * 60_000,
  failureNotifyMs: 6 * 60 * 60_000,
  pushStaleMs: 24 * 60 * 60_000,
  retentionDays: 35,
  logCap: 6000,
  bodyBytes: 8_192,
  timeZone: 'Asia/Kuala_Lumpur',
};
