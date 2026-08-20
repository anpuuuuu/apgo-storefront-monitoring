#!/usr/bin/env node
const workerUrl = (process.env.MONITOR_WORKER_URL || '').replace(/\/$/, '');
if (!workerUrl) throw new Error('MONITOR_WORKER_URL is required');

const session = `github-selftest-${Date.now()}`;
const response = await fetch(`${workerUrl}/beacon`, {
  method: 'POST',
  headers: {
    origin: 'https://apgo.my',
    referer: 'https://apgo.my/?apgo_em_test=1',
    'content-type': 'text/plain;charset=UTF-8',
    'user-agent': 'APGO-Layer3-SelfTest/2.0',
  },
  body: JSON.stringify({
    kind: 'selftest',
    m: 'APGO error monitor self-test',
    src: 'theme://apgo-error-monitor',
    url: 'https://apgo.my/',
    sid: session,
  }),
});
if (response.status !== 204) throw new Error(`Layer 3 self-test beacon HTTP ${response.status}: ${await response.text()}`);

const health = await fetch(`${workerUrl}/health`, { headers: { 'user-agent': 'APGO-Layer3-SelfTest/2.0' } });
const body = await health.json().catch(() => ({}));
const layer3 = body.heartbeats?.find((row) => row.layer === 'layer3');
if (!layer3 || layer3.stale || !String(layer3.source).includes('selftest')) {
  throw new Error(`Layer 3 heartbeat was not updated: ${JSON.stringify(body)}`);
}
console.log(JSON.stringify({ ok: true, session, layer3 }, null, 2));
