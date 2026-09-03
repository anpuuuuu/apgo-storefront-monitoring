import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONITOR_SITE_ID = 'apgo-my';
process.env.MONITOR_MODE = 'shadow';
const shadow = await import('../scripts/monitor-lib.mjs?shadow-test');
process.env.MONITOR_MODE = 'live';
const live = await import('../scripts/monitor-lib.mjs?live-test');

test('Live state keys are unchanged and Shadow keys are isolated', () => {
  for (const key of ['ga4:realtime:atc', 'ga4:daily:candidate:20260902']) {
    assert.equal(live.stateKey(key), `apgo-my:${key}`);
    assert.equal(shadow.stateKey(key), `apgo-my:shadow:${key}`);
  }
});

test('Shadow read/write round-trip never queries a Live key', async (t) => {
  const calls = [];
  const values = new Map();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    calls.push({ sql, params });
    if (sql.startsWith('INSERT')) values.set(params[0], params[1]);
    const results = sql.startsWith('SELECT') && values.has(params[0]) ? [{ value: values.get(params[0]) }] : [];
    return Response.json({ success: true, result: [{ results }] });
  });
  const key = 'ga4:daily:candidate:20260902';
  await shadow.setState(key, { stage: 'primary' });
  assert.deepEqual(await shadow.getState(key), { stage: 'primary' });
  assert.equal(await live.getState(key), null);
  assert.deepEqual(calls.map((call) => call.params[0]), [shadow.stateKey(key), shadow.stateKey(key), live.stateKey(key)]);
});

test('Shadow heartbeat, Telegram and alert logging make no network calls', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Shadow attempted a production side effect'); });
  t.mock.method(console, 'log', () => {});
  await shadow.heartbeat('layer4', {});
  await shadow.telegram('test');
  await shadow.logAlert('layer4', 'test', {});
});
