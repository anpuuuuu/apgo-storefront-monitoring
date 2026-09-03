import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runSelfTest } from '../scripts/layer3-self-test.mjs';
import { receiveError } from '../workers/error-monitor/errors.mjs';

const env = { MONITOR_SITE_ID: 'apgo-my', MONITOR_MODE: 'shadow', MONITOR_WORKER_URL: 'https://monitor.example.test', CF_ACCOUNT_ID: 'test', CF_API_TOKEN: 'test', MONITOR_HEARTBEAT_TOKEN: 'must-not-send' };
const log = () => {};
function mockRequest({ live = false } = {}) {
  return async (url, options) => {
    if (url.endsWith('/?apgo_em_test=1')) return new Response('https://monitor.example.test/beacon');
    if (url.endsWith('/beacon')) {
      assert.equal(options.headers.authorization, live ? 'Bearer must-not-send' : undefined);
      assert.equal(JSON.parse(options.body).kind, 'selftest');
      return new Response(null, { status: 204 });
    }
    assert.ok(live, 'Shadow must verify its own beacon, not an unrelated production heartbeat');
    return Response.json({ sites: [{ siteId: 'apgo-my', layers: [{ layer: 'layer3', stale: false, source: 'authenticated-selftest' }] }] });
  };
}
test('Shadow verifies its unique D1 evidence without heartbeat authorization or any SQL mutation', async () => {
  const logs = [];
  await runSelfTest({ env, request: mockRequest(), log: (entry) => logs.push(JSON.parse(entry)), query: async (sql, params) => {
    assert.match(sql, /^SELECT .* FROM js_errors WHERE site_id = \?1 AND session_id = \?2/);
    assert.equal(params[0], 'apgo-my');
    assert.match(params[1], /^github-shadow-[0-9a-f-]{36}$/);
    return [{ site_id: params[0], session_id: params[1], kind: 'selftest', critical: 0 }];
  } });
  assert.equal(logs[0].evidenceVerified, true);
  assert.equal(logs[0].heartbeatSuppressed, true);
});
test('missing Shadow evidence fails even if a production heartbeat could be healthy', async () => {
  await assert.rejects(runSelfTest({ env, request: mockRequest(), query: async () => [], log }), /not confirmed in D1/);
});
test('Live retains authenticated selftest and heartbeat verification', async () => {
  await runSelfTest({ env: { ...env, MONITOR_MODE: 'live' }, request: mockRequest({ live: true }), query: () => assert.fail(), log });
});
test('unknown mode or missing site fails closed', async () => {
  await assert.rejects(runSelfTest({ env: { ...env, MONITOR_MODE: 'oops' } }), /Invalid MONITOR_MODE/);
  await assert.rejects(runSelfTest({ env: { ...env, MONITOR_SITE_ID: '' } }), /MONITOR_SITE_ID/);
});
test('existing Worker stores public selftest but never writes heartbeat or alert state', async () => {
  const mutations = [];
  const DB = { prepare(sql) { return { bind() { return this; }, first: async () => ({ c: 0 }), run: async () => { mutations.push(sql); return {}; } }; } };
  const request = new Request('https://monitor.example.test/beacon', {
    method: 'POST', headers: { origin: 'https://apgo.my', 'user-agent': 'APGO-Layer3-SelfTest/2.0' },
    body: JSON.stringify({ kind: 'selftest', m: 'APGO error monitor self-test', src: 'theme://apgo-error-monitor', url: 'https://apgo.my/', sid: 'github-shadow-test' }),
  });
  assert.equal((await receiveError(request, { DB, MONITOR_HEARTBEAT_TOKEN: 'production-secret' })).status, 204);
  assert.equal(mutations.length, 1);
  assert.match(mutations[0], /INSERT INTO js_errors/);
  assert.doesNotMatch(mutations[0], /monitor_heartbeats|alert_log/);
});
test('selftest runs independently after health failures, with explicit Shadow default', () => {
  const workflow = readFileSync(new URL('../.github/workflows/monitor-self-health.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: always\(\) && !cancelled\(\) && needs.plan.outputs.matrix/);
  assert.match(workflow, /name: Refresh Layer 3 self-test\s+if: always\(\) && !cancelled\(\)/);
  assert.match(workflow, /MONITOR_MODE: \$\{\{ vars.MONITOR_MODE \|\| 'shadow' \}\}/);
});
