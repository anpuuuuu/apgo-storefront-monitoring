import { LIMITS, SHOPIFY_ORIGIN, STORE_ORIGINS } from './config.mjs';
import { getState, logAlert, setState, writeHeartbeat } from './db.mjs';
import { bearerToken, cleanPath, cleanSource, secretMatches, sha256Hex } from './security.mjs';
import { sendTelegram } from './telegram.mjs';

export function originAllowed(origin) {
  return STORE_ORIGINS.includes(origin) || SHOPIFY_ORIGIN.test(origin);
}

export function corsHeaders(origin) {
  const headers = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (originAllowed(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

export function isCriticalCartError({ kind, status, stage }) {
  const httpStatus = Number(status) || 0;
  return kind === 'cart'
    && stage === 'response'
    && httpStatus >= 500
    && httpStatus <= 599;
}

export function isIgnoredBrowserNoise({ kind, message }) {
  if (kind !== 'error') return false;
  return /_AutofillCallbackHandler|window\.webkit\.messageHandlers/.test(String(message || ''));
}

export function isIgnoredUserAgent(userAgent) {
  // These are link-preview/ad crawlers, not shoppers. Keep FB_IAB/FB4A and
  // ordinary Android WebViews because they represent real customer sessions.
  return /(?:meta-externalads\/|facebookexternalhit\/|\bFacebot\b)/i.test(String(userAgent || ''));
}

export function classifyClientType(userAgent) {
  const ua = String(userAgent || '');
  if (/FB_IAB\/|FBAN\/|FBAV\/|FBIOS/i.test(ua)) return 'facebook';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/WA4A\/|WhatsApp/i.test(ua)) return 'whatsapp';
  if (/;\s*wv\)|Version\/4\.0.*Mobile Safari/i.test(ua)) return 'android-webview';
  if (/(?:iPhone|iPad|iPod).*AppleWebKit.*Mobile/i.test(ua) && !/Version\/[^ ]+.*Safari/i.test(ua)) return 'ios-webview';
  if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile-browser';
  return 'desktop-browser';
}

export function classifyBrowserSignal({ kind, message, source, stage }) {
  if (kind === 'cart' && stage === 'verified-success') return 'cart-recovered';
  if (kind === 'cart') return 'cart-network';
  const evidence = `${message || ''} ${source || ''} ${stage || ''}`;
  if (/\/shopifycloud\/shop-js\/modules\/|\/cdn\/wpm\/|#moveItemsToDefaultSlot|shop-(?:login|user-recognition|cart-sync)/i.test(evidence)) {
    return 'shopify-platform';
  }
  if ((kind === 'resource' || stage === 'style') && /\/cdn\/fonts\//i.test(evidence)) return 'font-resource';
  return 'theme';
}

function platformFamily(evidence) {
  if (/shop-login|login-button/i.test(evidence)) return 'shop-login';
  if (/user-recognition/i.test(evidence)) return 'user-recognition';
  if (/cart-sync|moveItemsToDefaultSlot/i.test(evidence)) return 'cart-sync';
  if (/\/cdn\/wpm\//i.test(evidence)) return 'web-pixels';
  const moduleName = String(evidence).match(/\/shopifycloud\/shop-js\/modules\/([^/?#\s]+)/i)?.[1];
  return moduleName || 'shop-js';
}

/* Embedded URLs, long ids and hashes make every occurrence of one error
   family hash to a fresh signature (observed: one "Unable to fetch <asset>"
   family split into 45 signatures in a day), which defeats first-seen
   detection, mute flags and re-alert cooldowns. Collapse them before
   hashing; classification still sees the original text. */
export function normalizeSignatureText(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s"'()<>]+/gi, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d{4,}/g, '<n>');
}

export function normalizedBrowserSignatureInput({ kind, message, source, line, action, stage }) {
  const normalizedMessage = String(message || '').replace(/^Uncaught\s+/i, '').trim();
  const category = classifyBrowserSignal({ kind, message: normalizedMessage, source, stage });
  if (category === 'shopify-platform') {
    return `${category}|${platformFamily(`${normalizedMessage} ${source || ''}`)}`;
  }
  return `${kind}|${normalizeSignatureText(normalizedMessage)}|${source || ''}|${Number(line) || 0}|${action || ''}|${stage || ''}`;
}

export function shouldAlertDigestRow(row) {
  const category = row.category || classifyBrowserSignal(row);
  const occurrences = Number(row.occurrences || 0);
  const sessions = Number(row.sessions || 0);
  const networks = Number(row.networks || 0);
  if (category === 'cart-recovered') return false;
  if (category === 'shopify-platform') return occurrences >= 15 && sessions >= 15 && networks >= 5;
  if (category === 'font-resource') return sessions >= 20 && networks >= 5;
  if (category === 'cart-network') return occurrences >= 3 && sessions >= 3 && networks >= 2;
  return networks >= 2;
}

export function browserRealertMs(row) {
  const category = row.category || classifyBrowserSignal(row);
  if (category === 'shopify-platform') return 6 * 60 * 60_000;
  if (category === 'font-resource') return 12 * 60 * 60_000;
  return LIMITS.errorRealertMs;
}

function cleanText(value, max) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

async function readLimitedText(request, maxBytes) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error('payload too large');
    error.status = 413;
    throw error;
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('payload too large');
        const error = new Error('payload too large');
        error.status = 413;
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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
  if (!refOrigin || !originAllowed(refOrigin)) return new Response(null, { status: 403, headers });

  let raw;
  try { raw = await readLimitedText(request, LIMITS.bodyBytes); }
  catch (error) { return new Response(null, { status: error?.status === 413 ? 413 : 400, headers }); }
  let data;
  try { data = JSON.parse(raw); } catch { return new Response(null, { status: 400, headers }); }
  if (!data || typeof data.m !== 'string' || !data.m || typeof data.sid !== 'string') return new Response(null, { status: 400, headers });

  const ua = cleanText(request.headers.get('user-agent'), 300);
  if (isIgnoredUserAgent(ua)) return new Response(null, { status: 204, headers });
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = (await sha256Hex(`${request.headers.get('cf-connecting-ip') || ''}|${day}`)).slice(0, 32);
  const message = cleanText(data.m, 300);
  const source = cleanSource(data.src);
  const line = Number.isFinite(Number(data.line)) ? Math.trunc(Number(data.line)) : 0;
  const col = Number.isFinite(Number(data.col)) ? Math.trunc(Number(data.col)) : 0;
  const kind = ['error', 'rejection', 'resource', 'cart', 'selftest'].includes(data.kind) ? data.kind : 'error';
  const action = cleanText(data.action, 80);
  const stage = cleanText(data.stage, 80);
  const status = Number.isFinite(Number(data.status)) ? Math.trunc(Number(data.status)) : 0;
  const durationMs = Math.min(120_000, Math.max(0, Math.trunc(Number(data.duration_ms) || 0)));
  const visibilityState = ['visible', 'hidden', 'prerender', 'unloaded'].includes(String(data.visibility))
    ? String(data.visibility)
    : 'unknown';
  const onlineState = [-1, 0, 1].includes(Number(data.online)) ? Number(data.online) : -1;
  const pageLeaving = Number(data.page_leaving) === 1 ? 1 : 0;
  const clientType = classifyClientType(ua);
  // Never trust a browser-supplied `critical` flag. A status of 0 is normally
  // a shopper connection drop, navigation abort or device/network issue. Only
  // a real Shopify Cart API 5xx response is eligible for immediate escalation.
  const critical = isCriticalCartError({ kind, status, stage });
  const authorizedSelftest = kind === 'selftest'
    && await secretMatches(bearerToken(request), env.MONITOR_HEARTBEAT_TOKEN);
  if (isIgnoredBrowserNoise({ kind, message })) return new Response(null, { status: 204, headers });
  const signature = (await sha256Hex(normalizedBrowserSignatureInput({
    kind,
    message,
    source,
    line,
    action,
    stage,
  }))).slice(0, 32);

  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM js_errors WHERE ip_hash = ?1 AND created_at > datetime('now', '-60 seconds')"
  ).bind(ipHash).first();
  if (Number(rate?.c || 0) >= LIMITS.perIpPerMinute) return new Response(null, { status: 429, headers });

  await env.DB.prepare(
    `INSERT INTO js_errors
     (signature, kind, message, source, line, col, stack, page_url, user_agent,
      session_id, ip_hash, action, http_status, stage, critical, duration_ms,
      visibility_state, online_state, page_leaving, client_type)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`
  ).bind(signature, kind, message, source, line, col, cleanText(data.stack, 1000), cleanPath(data.url), ua,
    cleanText(data.sid, 64), ipHash, action, status, stage, critical ? 1 : 0, durationMs,
    visibilityState, onlineState, pageLeaving, clientType).run();

  if (authorizedSelftest) await writeHeartbeat(env.DB, 'layer3', 'authenticated-selftest', 'ok', { signature, page: cleanPath(data.url) });
  if (critical) await alertCriticalCartError(env, {
    signature,
    message,
    action,
    stage,
    status,
    page_url: cleanPath(data.url),
  });
  return new Response(null, { status: 204, headers });
}

async function alertCriticalCartError(env, detail) {
  const key = `critical-cart:${detail.signature}`;
  const state = (await getState(env.DB, key)) || { lastAlertMs: 0 };
  if (Date.now() - state.lastAlertMs < LIMITS.errorRealertMs) return;
  await sendTelegram(env, `🔴 [Layer 3 Critical Cart Error]\n${detail.action || detail.stage}: ${detail.message}\nHTTP ${detail.status}\nPage: ${detail.page_url}\nSignature: ${detail.signature}`);
  await logAlert(env.DB, 'layer3', 'critical-cart', detail);
  await setState(env.DB, key, { lastAlertMs: Date.now() });
}

export async function digestBrowserErrors(env) {
  const rows = await env.DB.prepare(
    `SELECT signature, kind, COUNT(*) AS occurrences,
            COUNT(DISTINCT session_id) AS sessions,
            COUNT(DISTINCT ip_hash) AS networks,
            MIN(message) AS message, MIN(page_url) AS page_url,
            GROUP_CONCAT(DISTINCT page_url) AS pages,
            MIN(source) AS source, MAX(action) AS action,
            MAX(stage) AS stage, MAX(http_status) AS http_status,
            ROUND(AVG(duration_ms)) AS avg_duration_ms,
            SUM(CASE WHEN online_state = 0 THEN 1 ELSE 0 END) AS offline_events,
            SUM(CASE WHEN page_leaving = 1 THEN 1 ELSE 0 END) AS leaving_events,
            GROUP_CONCAT(DISTINCT visibility_state) AS visibility_states,
            COUNT(DISTINCT CASE
              WHEN client_type = 'facebook'
                OR (client_type IS NULL AND (instr(user_agent, 'FB_IAB/') > 0 OR instr(user_agent, 'FBAN/') > 0 OR instr(user_agent, 'FBAV/') > 0))
              THEN session_id
            END) AS facebook_in_app_sessions,
            COUNT(DISTINCT CASE
              WHEN client_type = 'instagram' THEN session_id
            END) AS instagram_in_app_sessions,
            COUNT(DISTINCT CASE
              WHEN client_type = 'whatsapp' THEN session_id
            END) AS whatsapp_in_app_sessions,
            COUNT(DISTINCT CASE
              WHEN client_type = 'android-webview'
                OR (client_type IS NULL
                  AND instr(user_agent, 'FB_IAB/') = 0
                  AND (
                    instr(user_agent, '; wv)') > 0
                    OR (instr(user_agent, 'Version/4.0') > 0 AND instr(user_agent, 'Mobile Safari') > 0)
                  ))
              THEN session_id
            END) AS android_webview_sessions,
            COUNT(DISTINCT CASE
              WHEN client_type = 'ios-webview' THEN session_id
            END) AS ios_webview_sessions,
            COUNT(DISTINCT CASE
              WHEN client_type = 'mobile-browser'
                OR (client_type IS NULL
                  AND instr(user_agent, 'Mobile') > 0
                  AND instr(user_agent, 'FB_IAB/') = 0
                  AND instr(user_agent, '; wv)') = 0
                  AND NOT (instr(user_agent, 'Version/4.0') > 0 AND instr(user_agent, 'Mobile Safari') > 0))
              THEN session_id
            END) AS mobile_browser_sessions,
            COUNT(DISTINCT CASE
              WHEN client_type = 'desktop-browser'
                OR (client_type IS NULL AND instr(user_agent, 'Mobile') = 0)
              THEN session_id
            END) AS desktop_browser_sessions
     FROM js_errors
     WHERE critical = 0 AND kind <> 'selftest' AND created_at > datetime('now', '-10 minutes')
     GROUP BY signature
     HAVING (kind = 'resource' AND COUNT(*) >= ?3 AND COUNT(DISTINCT session_id) >= ?4)
         OR (kind <> 'resource' AND COUNT(*) >= ?1 AND COUNT(DISTINCT session_id) >= ?2)
     ORDER BY occurrences DESC
     LIMIT 50`
  ).bind(
    LIMITS.errorMinOccurrences,
    LIMITS.errorMinSessions,
    LIMITS.resourceMinOccurrences,
    LIMITS.resourceMinSessions,
  ).all();

  const pending = [];
  for (const row of rows.results || []) {
    row.category = classifyBrowserSignal(row);
    if (!shouldAlertDigestRow(row)) continue;
    const known = await env.DB.prepare('SELECT muted FROM known_signatures WHERE signature = ?1').bind(row.signature).first();
    if (known?.muted) continue;
    const key = `js-alert:${row.signature}`;
    const state = (await getState(env.DB, key)) || { lastAlertMs: 0 };
    if (Date.now() - state.lastAlertMs < browserRealertMs(row)) continue;
    pending.push(row);
  }

  if (!pending.length) return { alerted: 0, eligible: 0 };

  const selected = pending.slice(0, LIMITS.errorDigestMaxItems);
  await sendTelegram(env, buildBrowserDigest(selected, pending.length));
  await logAlert(env.DB, 'layer3', 'browser-digest', {
    signatures: selected.map((row) => row.signature),
    omitted: Math.max(0, pending.length - selected.length),
    rows: selected,
  });

  const alertedAt = Date.now();
  await env.DB.batch(selected.flatMap((row) => [
    env.DB.prepare(
      `INSERT INTO state (key, value, updated_at)
       VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(`js-alert:${row.signature}`, JSON.stringify({ lastAlertMs: alertedAt })),
    env.DB.prepare(
      `INSERT INTO known_signatures (signature, sample_message, last_alerted_at)
       VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(signature) DO UPDATE SET last_alerted_at = datetime('now')`
    ).bind(row.signature, row.message),
  ]));

  return { alerted: selected.length, eligible: pending.length };
}

export function buildBrowserDigest(rows, eligibleCount = rows.length) {
  const sections = [[
    '🟠 [Layer 3 Browser Error Digest]',
    `${eligibleCount} eligible signatures / 10 min`,
  ].join('\n')];

  rows.forEach((row, index) => {
    const stage = row.stage ? `/${String(row.stage).toUpperCase()}` : '';
    const networkEvidence = Number(row.networks || 0) > 0 ? ` · ${row.networks} networks` : '';
    const pages = [...new Set(
      String(row.pages || row.page_url || '/')
        .split(',')
        .map((page) => page.trim())
        .filter(Boolean),
    )];
    const visiblePages = pages.slice(0, 3);
    const pageEvidence = visiblePages.join(' | ') + (pages.length > visiblePages.length
      ? ` | +${pages.length - visiblePages.length} more`
      : '');
    const clients = [
      ['Facebook in-app', Number(row.facebook_in_app_sessions || 0)],
      ['Instagram in-app', Number(row.instagram_in_app_sessions || 0)],
      ['WhatsApp in-app', Number(row.whatsapp_in_app_sessions || 0)],
      ['Android WebView', Number(row.android_webview_sessions || 0)],
      ['iOS WebView', Number(row.ios_webview_sessions || 0)],
      ['Mobile browser', Number(row.mobile_browser_sessions || 0)],
      ['Desktop browser', Number(row.desktop_browser_sessions || 0)],
    ].filter(([, count]) => count > 0);
    const lines = [
      `${index + 1}. ${String(row.kind).toUpperCase()}${stage} · ${String(row.category || classifyBrowserSignal(row)).toUpperCase()} · ${row.sessions} sessions${networkEvidence} · ${row.occurrences} events`,
      String(row.message || 'Unknown browser error').slice(0, 220),
      `Pages (${pages.length}): ${pageEvidence}`,
    ];
    if (clients.length) lines.push(`Clients: ${clients.map(([label, count]) => `${label} (${count})`).join(' · ')}`);
    if (row.kind === 'cart') {
      lines.push(`Diagnostics: avg ${Number(row.avg_duration_ms || 0)} ms · offline ${Number(row.offline_events || 0)} · leaving ${Number(row.leaving_events || 0)} · visibility ${String(row.visibility_states || 'unknown')}`);
    }
    if (row.source) lines.push(`Source: ${String(row.source).slice(0, 220)}`);
    lines.push(`Signature: ${row.signature}`);
    sections.push(lines.join('\n'));
  });

  if (eligibleCount > rows.length) {
    sections.push(`+ ${eligibleCount - rows.length} more signatures retained in D1`);
  }
  return sections.join('\n\n');
}
