import test from 'node:test';
import assert from 'node:assert/strict';

import { heartbeatSeverity } from '../cloudflare/worker/uptime.mjs';
import { normalizeHeartbeatStatus } from '../cloudflare/worker/index.mjs';

test('heartbeat delay escalates only after two complete stale windows', () => {
  const limit = 90 * 60_000;
  assert.equal(heartbeatSeverity(limit, limit), null);
  assert.equal(heartbeatSeverity(limit + 1, limit), 'warning');
  assert.equal(heartbeatSeverity(limit * 2, limit), 'warning');
  assert.equal(heartbeatSeverity(limit * 2 + 1, limit), 'critical');
  assert.equal(heartbeatSeverity(Number.POSITIVE_INFINITY, limit), 'critical');
});

test('Layer 2 failures can never be stored as a healthy heartbeat', () => {
  assert.equal(normalizeHeartbeatStatus('passed'), 'ok');
  assert.equal(normalizeHeartbeatStatus('transient'), 'ok');
  assert.equal(normalizeHeartbeatStatus('failed'), 'error');
  assert.equal(normalizeHeartbeatStatus('TEST_CONFIG_STALE'), 'error');
  assert.equal(normalizeHeartbeatStatus(''), 'error');
});
