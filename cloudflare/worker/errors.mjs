import { LIMITS, SHOPIFY_ORIGIN, STORE_ORIGINS } from './config.mjs';
import { getState, logAlert, setState, writeHeartbeat } from './db.mjs';
import { cleanPath, sha256Hex } from './security.mjs';
import { sendTelegram } from './telegram.mjs';

export function originAllowed(origin) {
  return STORE_ORIGINS.includes(origin) || SHOPIFY_ORIGIN.test(origin);
}

export function corsHeaders(origin) {
  return {
    'access-control-allow-origin': originAllowed(origin) ? origin : STORE_ORIGINS[0],
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function cleanText(value, max) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

export async function receiveError(request, env) {
  const origin = request.headers.get('origin') || '';
  const headers = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers });
  if ((request.headers.get('user-agent') || '').includes('APGO-HealthCheck')) return new Response(null, { status: 204, headers });

  let refOrigin = origin;
  if (!refOrigin) {
    try { refOrigin = new URL(request.headers.get('referer') || '').origin; } catch { refOrigin = ''; }
  }
  if (refOrigin && !originAllowed(refOrigin)) return new Response(null, { status: 403, headers });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > LIMITS.bodyBytes) return new Response(null, { status: 413, headers });
  let data;
  try { data = JSON.parse(raw); } catch { return new Response(null, { status: 400, headers }); }
  if (!data || typeof data.m !== 'string' || !data.m || typeof data.sid !== 'string') return new Response(null, { status: 400, headers });

  const ua = cleanText(request.headers.get('user-agent'), 300);
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = (await sha256Hex(`${request.headers.get('cf-connecting-ip') || ''}|${day}`)).slice(0, 32);
  const message = cleanText(data.m, 300);
  const source = cleanText(data.src, 300);
  const line = Number.isFinite(Number(data.line)) ? Math.trunc(Number(data.line)) : 0;
  const col = Number.isFinite(Number(data.col)) ? Math.trunc(Number(data.col)) : 0;
  const kind = ['error', 'rejection', 'resource', 'cart', 'selftest'].includes(data.kind) ? data.kind : 'error';
  const action = cleanText(data.action, 80);
  const stage = cleanText(data.stage, 80);
  const status = Number.isFinite(Number(data.status)) ? Math.trunc(Number(data.status)) : 0;
  const critical = kind === 'cart' && Boolean(data.critical);
  const signature = (await sha256Hex(`${kind}|${message}|${source}|${line}|${action}|${stage}`)).slice(0, 32);

  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM js_errors WHERE ip_hash = ?1 AND created_at > datetime('now', '-60 seconds')"
  ).bind(ipHash).first();
  if (Number(rate?.c || 0) >= LIMITS.perIpPerMinute) return new Response(null, { status: 429, headers });

  await env.DB.prepare(
    `INSERT INTO js_errors
     (signature, kind, message, source, line, col, stack, page_url, user_agent,
      session_id, ip_hash, action, http_status, stage, critical)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
  ).bind(signature, kind, message, source, line, col, cleanText(data.stack, 1000), cleanPath(data.url), ua,
    cleanText(data.sid, 64), ipHash, action, status, stage, critical ? 1 : 0).run();

  if (kind === 'selftest') await writeHeartbeat(env.DB, 'layer3', 'browser-selftest', 'ok', { signature, page: cleanPath(data.url) });
  if (critical) await alertCriticalCartError(env, { signature, message, action, stage, status });
  return new Response(null, { status: 204, headers });
}

async function alertCriticalCartError(env, detail) {
  const key = `critical-cart:${detail.signature}`;
  const state = (await getState(env.DB, key)) || { lastAlertMs: 0 };
  if (Date.now() - state.lastAlertMs < LIMITS.errorRealertMs) return;
  await sendTelegram(env, `🔴 [Layer 3 Critical Cart Error]\n${detail.action || detail.stage}: ${detail.message}\nHTTP ${detail.status || 'network'}\nSignature: ${detail.signature}`);
  await logAlert(env.DB, 'layer3', 'critical-cart', detail);
  await setState(env.DB, key, { lastAlertMs: Date.now() });
}

export async function digestBrowserErrors(env) {
  const rows = await env.DB.prepare(
    `SELECT signature, kind, COUNT(*) AS occurrences,
            COUNT(DISTINCT session_id) AS sessions,
            MIN(message) AS message, MIN(page_url) AS page_url,
            MAX(action) AS action, MAX(stage) AS stage, MAX(http_status) AS http_status
     FROM js_errors
     WHERE critical = 0 AND created_at > datetime('now', '-10 minutes')
     GROUP BY signature
     HAVING COUNT(*) >= ?1 AND COUNT(DISTINCT session_id) >= ?2
     ORDER BY occurrences DESC`
  ).bind(LIMITS.errorMinOccurrences, LIMITS.errorMinSessions).all();

  for (const row of rows.results || []) {
    const known = await env.DB.prepare('SELECT muted FROM known_signatures WHERE signature = ?1').bind(row.signature).first();
    if (known?.muted) continue;
    const key = `js-alert:${row.signature}`;
    const state = (await getState(env.DB, key)) || { lastAlertMs: 0 };
    if (Date.now() - state.lastAlertMs < LIMITS.errorRealertMs) continue;
    await sendTelegram(env, `🟠 [Layer 3 Browser Error]\n${row.sessions} sessions · ${row.occurrences} occurrences / 10 min\n${row.kind}: ${row.message}\nPage: ${row.page_url}\nSignature: ${row.signature}`);
    await logAlert(env.DB, 'layer3', 'browser-error', row);
    await setState(env.DB, key, { lastAlertMs: Date.now() });
    await env.DB.prepare(
      `INSERT INTO known_signatures (signature, sample_message, last_alerted_at)
       VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(signature) DO UPDATE SET last_alerted_at = datetime('now')`
    ).bind(row.signature, row.message).run();
  }
}
