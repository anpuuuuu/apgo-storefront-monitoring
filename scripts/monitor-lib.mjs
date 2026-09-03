import { readFileSync } from 'node:fs';
import { getSite, siteLayer } from './site-config.mjs';

export const config = JSON.parse(readFileSync(new URL('../config/alerts-config.json', import.meta.url), 'utf8'));
export const site = getSite();
export const siteId = site.id;
export const propertyId = process.env.GA4_PROPERTY_ID || site.ga4PropertyId || '';
export const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
export const accountId = process.env.CF_ACCOUNT_ID || '';
export const cfToken = process.env.CF_API_TOKEN || '';
export const databaseId = config.cloudflare.database_id;
export const workerUrl = (process.env.MONITOR_WORKER_URL || config.cloudflare.worker_url || '').replace(/\/$/, '');
export const monitorMode = process.env.MONITOR_MODE || 'shadow';
if (!['shadow', 'live'].includes(monitorMode)) throw new Error('Invalid MONITOR_MODE');

export function stateKey(key) {
  // Shadow must never read or overwrite Live counters/candidates during migration.
  return `${siteId}:${monitorMode === 'live' ? '' : 'shadow:'}${key}`;
}

export function missingRequiredEnv({ needsD1 = true, needsHeartbeat = monitorMode === 'live' } = {}) {
  const missing = [];
  if (!propertyId) missing.push('GA4_PROPERTY_ID');
  if (!accessToken) missing.push('GOOGLE_OAUTH_ACCESS_TOKEN');
  if (!workerUrl) missing.push('MONITOR_WORKER_URL');
  if (needsD1 && !accountId) missing.push('CF_ACCOUNT_ID');
  if (needsD1 && !cfToken) missing.push('CF_API_TOKEN');
  if (needsHeartbeat && !process.env.MONITOR_HEARTBEAT_TOKEN) missing.push('MONITOR_HEARTBEAT_TOKEN');
  return missing;
}

export function requireEnv(options = {}) {
  const missing = missingRequiredEnv(options);
  if (missing.length) throw new Error(`Required monitoring configuration missing: ${missing.join(', ')}`);
}

export function assertUnrestrictedMetrics(payload) {
  const restricted = payload.metadata?.schemaRestrictionResponse?.activeMetricRestrictions || [];
  if (restricted.length) {
    const names = restricted.map((entry) => `${entry.metricName} (${(entry.restrictedMetricTypes || []).join(', ')})`).join('; ');
    throw new Error(`GA4_METRIC_ACCESS_RESTRICTED: ${names}. Restricted zero values are unavailable data, not zero sales.`);
  }
}

export async function ga(method, body, { allowRestrictedMetrics = false } = {}) {
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(`GA4 ${method} HTTP ${response.status}: ${payload.error?.message || JSON.stringify(payload)}`);
  if (!allowRestrictedMetrics) assertUnrestrictedMetrics(payload);
  return payload;
}

export async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new Error(`D1 HTTP ${response.status}: ${JSON.stringify(payload.errors || payload)}`);
  return payload.result?.[0]?.results || [];
}

export async function getState(key) {
  const rows = await d1('SELECT value FROM state WHERE key = ?1', [stateKey(key)]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

export async function setState(key, value) {
  await d1(
    `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [stateKey(key), JSON.stringify(value)]
  );
}

export async function logAlert(layer, kind, detail) {
  if (monitorMode !== 'live') {
    console.log(JSON.stringify({ shadow: true, siteId, layer, kind, detailSuppressed: true }));
    return;
  }
  await d1('INSERT INTO alert_log (layer, kind, detail) VALUES (?1, ?2, ?3)', [siteLayer(siteId, layer), kind, JSON.stringify({ siteId, ...detail })]);
}

export async function heartbeat(layer, detail = {}) {
  if (monitorMode !== 'live') {
    console.log(JSON.stringify({ shadow: true, heartbeatSuppressed: true, siteId, layer, detailSuppressed: true }));
    return;
  }
  const response = await fetch(`${workerUrl}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.MONITOR_HEARTBEAT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ siteId, layer, source: 'github-actions', status: 'ok', detail: { ...detail, runUrl: process.env.RUN_URL || '' } }),
  });
  if (!response.ok) throw new Error(`Heartbeat HTTP ${response.status}: ${await response.text()}`);
}

export async function workerHealthy() {
  const response = await fetch(`${workerUrl}/health`, { headers: { 'user-agent': 'APGO-HealthCheck/2.0 GA4' } });
  const payload = await response.json().catch(() => ({}));
  const siteHealth = payload.sites?.find((entry) => entry.siteId === siteId);
  const layer1 = siteHealth?.layers?.find((row) => row.layer === 'layer1')
    || payload.heartbeats?.find((row) => row.layer === siteLayer(siteId, 'layer1') || row.layer === 'layer1');
  return response.ok && payload.ok && layer1 && !layer1.stale;
}

export async function telegram(text) {
  if (monitorMode !== 'live') {
    console.log(JSON.stringify({ shadow: true, telegramSuppressed: true, siteId, textSuppressed: true }));
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) throw new Error('Telegram secrets are not configured');
  const label = site.alertLabel || site.name || site.id;
  const namespacedText = String(text).includes(`[${label}]`) ? String(text) : `[${label}] ${text}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: namespacedText.slice(0, 3900), disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mytDate(offsetDays = 0) {
  const value = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.ga4.timezone }).format(value);
}
