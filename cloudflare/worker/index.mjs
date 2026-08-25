import { HEARTBEAT_LIMITS } from './config.mjs';
import { listHeartbeats, writeHeartbeat } from './db.mjs';
import { corsHeaders, digestBrowserErrors, receiveError } from './errors.mjs';
import { bearerToken, secretMatches } from './security.mjs';
import { runScheduledUptime } from './uptime.mjs';

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export function normalizeHeartbeatStatus(status) {
  return ['ok', 'passed', 'transient'].includes(String(status || '').toLowerCase()) ? 'ok' : 'error';
}

async function health(env) {
  const heartbeats = await listHeartbeats(env.DB);
  const now = Date.now();
  const statuses = heartbeats.map((row) => ({
    layer: row.layer,
    source: row.source,
    status: row.status,
    observedAt: row.observed_at,
    ageSeconds: Math.max(0, Math.floor((now - Date.parse(row.observed_at)) / 1000)),
    stale: !HEARTBEAT_LIMITS[row.layer] || now - Date.parse(row.observed_at) > HEARTBEAT_LIMITS[row.layer],
  }));
  const layer1 = statuses.find((row) => row.layer === 'layer1');
  const ok = Boolean(layer1 && !layer1.stale && layer1.status === 'ok');
  return json({ ok, service: 'apgo-monitoring', now: new Date(now).toISOString(), heartbeats: statuses }, ok ? 200 : 503);
}

async function heartbeat(request, env) {
  if (!await secretMatches(bearerToken(request), env.MONITOR_HEARTBEAT_TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!['layer1', 'layer2', 'layer3', 'layer4'].includes(body.layer)) return json({ ok: false, error: 'invalid layer' }, 400);
  const normalizedStatus = normalizeHeartbeatStatus(body.status);
  await writeHeartbeat(env.DB, body.layer, String(body.source || 'github-actions').slice(0, 100), normalizedStatus,
    body.detail && typeof body.detail === 'object' ? body.detail : {});
  return json({ ok: true }, 202);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return health(env);
    if (url.pathname === '/heartbeat' && request.method === 'POST') return heartbeat(request, env);
    if (url.pathname === '/beacon' || url.pathname === '/') return receiveError(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin') || '') });
    return json({ ok: false, error: 'not found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    if (env.CRON_ENABLED !== 'true') {
      console.log(JSON.stringify({ event: 'scheduled_skipped', reason: 'CRON_ENABLED is not true' }));
      return;
    }
    ctx.waitUntil((async () => {
      const result = await runScheduledUptime(env, controller.scheduledTime);
      if (!result.duplicate) await digestBrowserErrors(env);
      console.log(JSON.stringify({ event: 'scheduled_complete', scheduledTime: controller.scheduledTime, ...result }));
    })());
  },
};
