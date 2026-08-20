import { readFileSync } from 'node:fs';

export const config = JSON.parse(readFileSync(new URL('../alerts-config.json', import.meta.url), 'utf8'));
export const propertyId = process.env.GA4_PROPERTY_ID || '';
export const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
export const accountId = process.env.CF_ACCOUNT_ID || '';
export const cfToken = process.env.CF_API_TOKEN || '';
export const databaseId = config.cloudflare.database_id;
export const workerUrl = (process.env.MONITOR_WORKER_URL || config.cloudflare.worker_url || '').replace(/\/$/, '');

export function requireEnv() {
  const missing = [];
  if (!propertyId) missing.push('GA4_PROPERTY_ID');
  if (!accessToken) missing.push('GOOGLE_OAUTH_ACCESS_TOKEN');
  if (!accountId) missing.push('CF_ACCOUNT_ID');
  if (!cfToken) missing.push('CF_API_TOKEN');
  if (!workerUrl) missing.push('MONITOR_WORKER_URL');
  if (!process.env.MONITOR_HEARTBEAT_TOKEN) missing.push('MONITOR_HEARTBEAT_TOKEN');
  if (missing.length) throw new Error(`Required monitoring configuration missing: ${missing.join(', ')}`);
}

export async function ga(method, body) {
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(`GA4 ${method} HTTP ${response.status}: ${payload.error?.message || JSON.stringify(payload)}`);
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
  const rows = await d1('SELECT value FROM state WHERE key = ?1', [key]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

export async function setState(key, value) {
  await d1(
    `INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, JSON.stringify(value)]
  );
}

export async function logAlert(layer, kind, detail) {
  await d1('INSERT INTO alert_log (layer, kind, detail) VALUES (?1, ?2, ?3)', [layer, kind, JSON.stringify(detail)]);
}

export async function heartbeat(layer, detail = {}) {
  const response = await fetch(`${workerUrl}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.MONITOR_HEARTBEAT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ layer, source: 'github-actions', status: 'ok', detail: { ...detail, runUrl: process.env.RUN_URL || '' } }),
  });
  if (!response.ok) throw new Error(`Heartbeat HTTP ${response.status}: ${await response.text()}`);
}

export async function workerHealthy() {
  const response = await fetch(`${workerUrl}/health`, { headers: { 'user-agent': 'APGO-HealthCheck/2.0 GA4' } });
  const payload = await response.json().catch(() => ({}));
  const layer1 = payload.heartbeats?.find((row) => row.layer === 'layer1');
  return response.ok && payload.ok && layer1 && !layer1.stale;
}

export async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) throw new Error('Telegram secrets are not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true }),
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
