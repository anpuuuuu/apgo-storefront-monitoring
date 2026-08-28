import test from 'node:test';
import assert from 'node:assert/strict';

import { heartbeatSeverity, shouldAlertHeartbeat } from '../workers/error-monitor/uptime.mjs';
import { normalizeHeartbeatStatus } from '../workers/error-monitor/index.mjs';

test('heartbeat delay escalates only after two complete stale windows', () => {
  const limit = 90 * 60_000;
  assert.equal(heartbeatSeverity(limit, limit), null);
  assert.equal(heartbeatSeverity(limit + 1, limit), 'warning');
  assert.equal(heartbeatSeverity(limit * 2, limit), 'warning');
  assert.equal(heartbeatSeverity(limit * 2 + 1, limit), 'critical');
  assert.equal(heartbeatSeverity(Number.POSITIVE_INFINITY, limit), 'critical');
});

test('daily Layer 2 heartbeat warns at 30 hours and becomes critical at 36 hours', () => {
  const warning = 30 * 60 * 60_000;
  const critical = 36 * 60 * 60_000;
  assert.equal(heartbeatSeverity(warning, warning, critical), null);
  assert.equal(heartbeatSeverity(warning + 1, warning, critical), 'warning');
  assert.equal(heartbeatSeverity(critical, warning, critical), 'warning');
  assert.equal(heartbeatSeverity(critical + 1, warning, critical), 'critical');
});

test('heartbeat incident re-alerts on severity change, not every hour', () => {
  const now = Date.now();
  const realertMs = 6 * 60 * 60_000;
  const state = { open: true, severity: 'critical', lastAlertMs: now - 60 * 60_000 };
  assert.equal(shouldAlertHeartbeat('critical', state, now, realertMs), false);
  assert.equal(shouldAlertHeartbeat('warning', state, now, realertMs), true);
  assert.equal(shouldAlertHeartbeat('critical', { ...state, lastAlertMs: now - realertMs }, now, realertMs), true);
  assert.equal(shouldAlertHeartbeat(null, state, now, realertMs), false);
});

test('Layer 2 failures can never be stored as a healthy heartbeat', () => {
  assert.equal(normalizeHeartbeatStatus('passed'), 'ok');
  assert.equal(normalizeHeartbeatStatus('transient'), 'ok');
  assert.equal(normalizeHeartbeatStatus('failed'), 'error');
  assert.equal(normalizeHeartbeatStatus('TEST_CONFIG_STALE'), 'error');
  assert.equal(normalizeHeartbeatStatus(''), 'error');
});
