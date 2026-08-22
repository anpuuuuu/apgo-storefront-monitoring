import test from 'node:test';
import assert from 'node:assert/strict';

import { heartbeatSeverity } from '../cloudflare/worker/uptime.mjs';

test('heartbeat delay escalates only after two complete stale windows', () => {
  const limit = 90 * 60_000;
  assert.equal(heartbeatSeverity(limit, limit), null);
  assert.equal(heartbeatSeverity(limit + 1, limit), 'warning');
  assert.equal(heartbeatSeverity(limit * 2, limit), 'warning');
  assert.equal(heartbeatSeverity(limit * 2 + 1, limit), 'critical');
  assert.equal(heartbeatSeverity(Number.POSITIVE_INFINITY, limit), 'critical');
});
