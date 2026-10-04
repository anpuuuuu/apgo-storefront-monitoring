/* Read-only Shopify abandoned-checkout evidence.

   The Admin API can expose customer and recovery details, but this monitor
   intentionally asks only for abandonedCheckoutsCount. D1 receives a time
   window, a count, precision, and timestamps—never checkout records or PII.

   This starts as observation. It does not send Telegram or decide that a
   checkout is broken on its own; the data can later corroborate the existing
   GA4 completion-rate rule after a real baseline has accumulated. */
import { rollingWindowEndingAt, settledWindow } from '../../scripts/ga4-anomaly-lib.mjs';
import { SHOPIFY_ABANDONED_LIMITS, siteKey } from './config.mjs';
import { getState, setState } from './db.mjs';

export const ABANDONED_COUNT_QUERY = `query AbandonedCount($query: String!) {
  abandonedCheckoutsCount(query: $query) {
    count
    precision
  }
}`;

export function normalizeShopDomain(value) {
  const host = String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new Error('SHOPIFY_ADMIN_SHOP must be a *.myshopify.com domain');
  }
  return host;
}

export function abandonedWindow(nowMs, options = {}) {
  const settings = { ...SHOPIFY_ABANDONED_LIMITS, ...options };
  const slot = settledWindow(nowMs, {
    timeZone: settings.timeZone,
    lagMinutes: settings.settledLagMinutes,
    slotMinutes: settings.checkMinutes,
  });
  return rollingWindowEndingAt(slot, {
    durationMinutes: settings.windowMinutes,
    timeZone: settings.timeZone,
  });
}

export function abandonedSearchQuery(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid abandoned-checkout window');
  }
  return `created_at:>='${new Date(startMs).toISOString()}' created_at:<'${new Date(endMs).toISOString()}' recovery_state:not_recovered`;
}

export function appendAbandonedSnapshot(log, snapshot, nowMs, options = {}) {
  const { retentionDays, logCap } = { ...SHOPIFY_ABANDONED_LIMITS, ...options };
  const cutoff = nowMs - retentionDays * 86_400_000;
  const entries = (Array.isArray(log?.entries) ? log.entries : [])
    .filter((entry) => Date.parse(entry.windowEnd || '') >= cutoff)
    .filter((entry) => !(entry.windowStart === snapshot.windowStart && entry.windowEnd === snapshot.windowEnd));
  entries.push(snapshot);
  entries.sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));
  return {
    entries: entries.length > logCap ? entries.slice(entries.length - logCap) : entries,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export async function fetchAbandonedCount({
  shopDomain,
  accessToken,
  startMs,
  endMs,
  apiVersion = SHOPIFY_ABANDONED_LIMITS.apiVersion,
  fetchImpl = fetch,
}) {
  const shop = normalizeShopDomain(shopDomain);
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('SHOPIFY_ADMIN_ACCESS_TOKEN is required');
  if (!/^\d{4}-\d{2}$/.test(String(apiVersion))) throw new Error('Invalid Shopify Admin API version');

  const response = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'APGO-Storefront-Monitor/1.0',
      'x-shopify-access-token': token,
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      query: ABANDONED_COUNT_QUERY,
      variables: { query: abandonedSearchQuery(startMs, endMs) },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Shopify Admin HTTP ${response.status}`);
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(`Shopify Admin GraphQL error: ${String(payload.errors[0]?.message || 'unknown error').slice(0, 160)}`);
  }
  const result = payload.data?.abandonedCheckoutsCount;
  const count = Number(result?.count);
  if (!Number.isInteger(count) || count < 0 || !result?.precision) {
    throw new Error('Shopify Admin returned an invalid abandoned checkout count');
  }
  return { count, precision: String(result.precision) };
}

function failureReason(error) {
  const text = String(error?.message || error || '');
  if (/myshopify\.com domain/.test(text)) return 'invalid_shop_domain';
  if (/HTTP 401|HTTP 403|access denied|permission/i.test(text)) return 'authentication_or_permission';
  if (/HTTP 429/.test(text)) return 'throttled';
  if (/GraphQL/.test(text)) return 'graphql_error';
  return 'request_failed';
}

export async function runAbandonedObservation(env, site, nowMs = Date.now()) {
  const settings = site?.shopifyAdmin;
  if (!settings?.shopEnv || !settings?.tokenEnv) return { ok: true, status: 'disabled' };
  const latestKey = siteKey(site.id, 'shopify:abandoned:latest');
  const logKey = siteKey(site.id, 'shopify:abandoned:log');
  const checkedAt = new Date(nowMs).toISOString();
  const shopDomain = env[settings.shopEnv];
  const accessToken = env[settings.tokenEnv];
  if (!shopDomain || !accessToken) {
    await setState(env.DB, latestKey, { status: 'not_configured', checkedAt });
    return { ok: true, status: 'not_configured' };
  }

  const window = abandonedWindow(nowMs, {
    timeZone: settings.timeZone || SHOPIFY_ABANDONED_LIMITS.timeZone || 'Asia/Kuala_Lumpur',
  });
  try {
    const result = await fetchAbandonedCount({
      shopDomain,
      accessToken,
      startMs: window.startMs,
      endMs: window.endMs,
      apiVersion: settings.apiVersion || SHOPIFY_ABANDONED_LIMITS.apiVersion,
    });
    const snapshot = {
      windowStart: new Date(window.startMs).toISOString(),
      windowEnd: new Date(window.endMs).toISOString(),
      count: result.count,
      precision: result.precision,
      checkedAt,
    };
    const log = appendAbandonedSnapshot(await getState(env.DB, logKey), snapshot, nowMs);
    await Promise.all([
      setState(env.DB, logKey, log),
      setState(env.DB, latestKey, { status: 'ok', ...snapshot }),
    ]);
    return { ok: true, status: 'observed', ...snapshot };
  } catch (error) {
    const previous = (await getState(env.DB, latestKey)) || {};
    await setState(env.DB, latestKey, {
      ...previous,
      status: 'error',
      checkedAt,
      errorAt: checkedAt,
      reason: failureReason(error),
    });
    throw error;
  }
}
