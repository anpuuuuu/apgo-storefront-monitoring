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
  // A signature that already made the digest says nothing new two hours
  // later: on 2026-09-13/15 the same two signatures each sent four digests
  // in 48 hours. One digest per signature per day; D1 keeps every event and
  // `D1 maintenance → list-signatures` shows the message text.
  errorRealertMs: 24 * 60 * 60_000,
  // A Shopify 5xx on cart/checkout pages as it happens and keeps its own
  // shorter window so a second wave the same day is not swallowed.
  criticalCartRealertMs: 2 * 60 * 60_000,
};

export const HEARTBEAT_LIMITS = {
  layer1: 15 * 60_000,
  // Layer 2 now runs once daily. Post-deploy checks deliberately do not
  // refresh this heartbeat, so a successful theme push cannot hide a missed
  // daily commerce run.
  layer2: 30 * 60 * 60_000,
  layer3: 26 * 60 * 60_000,
  layer4: 90 * 60_000,
  // Synthetic checkout probe, dispatched every 20 minutes. Two missed runs is
  // a schedule problem worth seeing; one is GitHub being GitHub.
  watch: 45 * 60_000,
};

export const HEARTBEAT_CRITICAL_LIMITS = {
  layer2: 36 * 60 * 60_000,
};

// Push-based order heartbeat (orders.mjs). Mirrored in
// config/alerts-config.json `orders` for documentation, like the js_errors
// limits above.
export const ORDER_LIMITS = {
  checkMinutes: 10,
  /* One flat gap, measured rather than modelled. 455 orders over 2026-09-09 to
     09-20 gave a median gap of 19 minutes, a 90th percentile of 1h19m, and a
     longest normal gap of 5h51m; the only longer one, 8h01m, was the 09-15
     free-shipping incident. Replayed over those days a 7-hour threshold fires
     exactly once, on the incident, while 4 hours fires nine times and every
     one of those days was confirmed healthy.

     The per-hour percentile baseline this replaces could not work: a 4-hour
     window holds zero orders in 3.6% of all normal windows, and within one
     hour-of-week bucket the count ranges 4 to 17. The spread swamps the
     signal, which is why the old rule rang 11 times in three healthy days.

     This is deliberately the slow backstop for "sales have actually stopped".
     Catching a broken checkout quickly is the funnel's job: on 09-15 the GA4
     rule paged at 00:46, five hours before a 7-hour gap rule would have. */
  gapMinutes: 420,
  criticalMultiplier: 2,
  /* Reported in the heartbeat so the margin above real traffic stays visible
     and gapMinutes can be retuned from evidence instead of taste. */
  observedGapDays: 28,
  realertMs: 6 * 60 * 60_000,
  failureNotifyMs: 6 * 60 * 60_000,
  pushStaleMs: 24 * 60 * 60_000,
  retentionDays: 35,
  logCap: 6000,
  bodyBytes: 8_192,
  timeZone: 'Asia/Kuala_Lumpur',
};
