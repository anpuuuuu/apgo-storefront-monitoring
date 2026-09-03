#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getSite } from './site-config.mjs';
import { d1 } from './monitor-lib.mjs';

export async function runSelfTest({ env = process.env, request = fetch, query = d1, log = console.log } = {}) {
  const mode = env.MONITOR_MODE || 'shadow';
  if (!['shadow', 'live'].includes(mode)) throw new Error('Invalid MONITOR_MODE');
  if (!env.MONITOR_SITE_ID) throw new Error('MONITOR_SITE_ID is required');
  const site = getSite(env.MONITOR_SITE_ID);
  const workerUrl = (env.MONITOR_WORKER_URL || '').replace(/\/$/, '');
  if (!workerUrl) throw new Error('MONITOR_WORKER_URL is required');
  if (mode === 'live' && !env.MONITOR_HEARTBEAT_TOKEN) throw new Error('Live self-test requires MONITOR_HEARTBEAT_TOKEN');
  if (mode === 'shadow' && (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN)) throw new Error('Shadow self-test requires D1 read credentials');
  const origin = new URL(site.baseUrl).origin;
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 APGO-HealthCheck/2.0 Layer3-SelfTest';
  const storefront = await request(origin + '/?apgo_em_test=1', {
    headers: { 'user-agent': userAgent }, redirect: 'follow', signal: AbortSignal.timeout(20000),
  });
  const html = await storefront.text();
  if (!storefront.ok || !html.includes(workerUrl + '/beacon')) throw new Error('Layer 3 storefront snippet is missing (HTTP ' + storefront.status + ')');

  const session = 'github-' + mode + '-' + randomUUID();
  const headers = { origin, referer: origin + '/?apgo_em_test=1', 'content-type': 'text/plain;charset=UTF-8', 'user-agent': 'APGO-Layer3-SelfTest/2.0' };
  // Public selftest evidence is excluded from digests. ONLY authenticated selftests
  // can refresh the production heartbeat. Shadow must never send this header.
  if (mode === 'live') headers.authorization = 'Bearer ' + env.MONITOR_HEARTBEAT_TOKEN;
  const response = await request(workerUrl + '/beacon', {
    method: 'POST', headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ kind: 'selftest', m: 'APGO error monitor self-test', src: 'theme://apgo-error-monitor', url: origin + '/', sid: session }),
  });
  if (response.status !== 204) throw new Error('Layer 3 self-test beacon HTTP ' + response.status);

  if (mode === 'shadow') {
    // Verify this exact fresh beacon, not a heartbeat an official task wrote.
    const rows = await query('SELECT site_id, session_id, kind, critical FROM js_errors WHERE site_id = ?1 AND session_id = ?2 LIMIT 2', [site.id, session]);
    if (rows.length !== 1 || rows[0].site_id !== site.id || rows[0].session_id !== session || rows[0].kind !== 'selftest' || Number(rows[0].critical) !== 0) {
      throw new Error('Shadow Layer 3 beacon was not confirmed in D1');
    }
    log(JSON.stringify({ ok: true, mode, siteId: site.id, session, evidenceVerified: true, heartbeatSuppressed: true }));
    return;
  }
  const health = await request(workerUrl + '/health', { signal: AbortSignal.timeout(15000) });
  const body = await health.json().catch(() => ({}));
  const layer3 = body.sites?.find((entry) => entry.siteId === site.id)?.layers?.find((row) => row.layer === 'layer3')
    || body.heartbeats?.find((row) => row.layer === site.id + ':layer3' || row.layer === 'layer3');
  if (!health.ok || !layer3 || layer3.stale || !String(layer3.source).includes('selftest')) throw new Error('Layer 3 heartbeat was not updated');
  log(JSON.stringify({ ok: true, mode, siteId: site.id, session, layer3 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelfTest().catch((error) => { console.error('Layer 3 self-test failed: ' + error.message); process.exitCode = 1; });
}
