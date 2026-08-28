import { MONITOR_SITES } from '../site-catalog.generated.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
const GITHUB_API = 'https://api.github.com';

export const SOURCE_SITES = new Map(MONITOR_SITES.map((site) => [site.repositoryId, { ...site, siteId: site.id }]));

function responseJson(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function base64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function utf8Base64Url(value) {
  return base64Url(new TextEncoder().encode(value));
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag, value) {
  return Uint8Array.of(tag, ...derLength(value.length), ...value);
}

function pkcs1ToPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  return der(0x30, Uint8Array.of(...version, ...rsaAlgorithm, ...der(0x04, pkcs1)));
}

function decodePem(pem) {
  const value = String(pem || '').replace(/\\n/g, '\n');
  const isPkcs1 = value.includes('BEGIN RSA PRIVATE KEY');
  const body = value.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s+/g, '');
  if (!body) throw new Error('GitHub App private key is missing or invalid');
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return isPkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
}

export async function verifyWebhookSignature(rawBody, header, secret) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!match || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const actual = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  const expected = Uint8Array.from(match[1].match(/.{2}/g), (hex) => Number.parseInt(hex, 16));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

export function validatePush(payload, eventName) {
  if (eventName !== 'push') return { accepted: false, status: 202, reason: 'ignored event' };
  const repositoryId = String(payload?.repository?.id || '');
  const site = SOURCE_SITES.get(repositoryId);
  if (!site) return { accepted: false, status: 403, reason: 'unknown repository' };
  if (payload?.repository?.full_name !== site.repository) return { accepted: false, status: 403, reason: 'repository identity mismatch' };
  if (payload?.ref !== site.branchRef) return { accepted: false, status: 202, reason: 'ignored ref' };
  if (!/^[0-9a-f]{40}$/i.test(String(payload?.after || ''))) return { accepted: false, status: 400, reason: 'invalid source commit' };
  if (payload.deleted) return { accepted: false, status: 202, reason: 'ignored branch deletion' };
  return { accepted: true, site, repositoryId, sourceSha: payload.after };
}

async function githubAppJwt(env) {
  const appId = String(env.GITHUB_APP_ID || '');
  if (!appId) throw new Error('GITHUB_APP_ID is missing');
  const key = await crypto.subtle.importKey(
    'pkcs8', decodePem(env.GITHUB_APP_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = utf8Base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = utf8Base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'APGO-Storefront-Monitor-Dispatcher/1.0',
  };
}

async function githubJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body?.message || 'request failed'}`);
  return body;
}

async function installationToken(env, sourceRepository) {
  const jwt = await githubAppJwt(env);
  const installation = await githubJson(`${GITHUB_API}/repos/${sourceRepository}/installation`, {
    headers: githubHeaders(jwt),
  });
  const centralRepository = String(env.CENTRAL_REPOSITORY || 'anpuuuuu/apgo-storefront-monitoring');
  const centralName = centralRepository.split('/')[1];
  if (!centralName) throw new Error('CENTRAL_REPOSITORY is invalid');
  const token = await githubJson(`${GITHUB_API}/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(jwt),
    body: JSON.stringify({
      repositories: [centralName],
      permissions: { actions: 'write', contents: 'read', metadata: 'read' },
    }),
  });
  if (!token.token) throw new Error('GitHub installation token response did not contain a token');
  return token.token;
}

async function dispatchLayer2(env, push, deliveryId) {
  const centralRepository = String(env.CENTRAL_REPOSITORY || 'anpuuuuu/apgo-storefront-monitoring');
  const token = await installationToken(env, push.site.repository);
  const response = await fetch(`${GITHUB_API}/repos/${centralRepository}/actions/workflows/site-health-v2.yml/dispatches`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        site_id: push.site.siteId,
        cadence: 'post-deploy',
        source_repo: push.site.repository,
        source_repository_id: push.repositoryId,
        source_sha: push.sourceSha,
        delivery_id: deliveryId,
      },
    }),
  });
  if (response.status !== 204) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`GitHub workflow dispatch HTTP ${response.status}: ${body?.message || 'request failed'}`);
  }
}

async function notifyFailure(env, site, deliveryId, error) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const message = `🔴 [${site?.label || 'MONITOR'}][Dispatcher] Post-deploy dispatch failed\nDelivery: ${deliveryId}\n${String(error?.message || error).slice(0, 900)}`;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }),
  });
}

async function webhook(request, env, ctx) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return responseJson({ ok: false, error: 'payload too large' }, 413);
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return responseJson({ ok: false, error: 'payload too large' }, 413);
  const valid = await verifyWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET);
  if (!valid) return responseJson({ ok: false, error: 'invalid signature' }, 401);

  const deliveryId = String(request.headers.get('x-github-delivery') || '');
  if (!/^[0-9a-f-]{16,80}$/i.test(deliveryId)) return responseJson({ ok: false, error: 'invalid delivery id' }, 400);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
  catch { return responseJson({ ok: false, error: 'invalid JSON' }, 400); }
  const push = validatePush(payload, request.headers.get('x-github-event'));
  if (!push.accepted) return responseJson({ ok: true, ignored: push.reason }, push.status);

  const dedupeKey = `github-delivery:${deliveryId}`;
  if (await env.DELIVERIES.get(dedupeKey)) return responseJson({ ok: true, duplicate: true }, 202);
  await env.DELIVERIES.put(dedupeKey, 'pending', { expirationTtl: DELIVERY_TTL_SECONDS });
  try {
    await dispatchLayer2(env, push, deliveryId);
    await env.DELIVERIES.put(dedupeKey, 'dispatched', { expirationTtl: DELIVERY_TTL_SECONDS });
    return responseJson({ ok: true, dispatched: true, siteId: push.site.siteId, sourceSha: push.sourceSha }, 202);
  } catch (error) {
    await env.DELIVERIES.delete(dedupeKey);
    ctx.waitUntil(notifyFailure(env, push.site, deliveryId, error));
    return responseJson({ ok: false, error: 'dispatch failed' }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return responseJson({ ok: true, service: 'apgo-monitor-dispatcher' });
    if (url.pathname === '/github/webhook' && request.method === 'POST') return webhook(request, env, ctx);
    return responseJson({ ok: false, error: 'not found' }, 404);
  },
};
