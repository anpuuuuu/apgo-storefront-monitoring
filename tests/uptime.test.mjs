import test from 'node:test';
import assert from 'node:assert/strict';

import { heartbeatSeverity, shouldAlertHeartbeat } from '../workers/error-monitor/uptime.mjs';
import { classifyHealth, normalizeHeartbeatStatus } from '../workers/error-monitor/index.mjs';

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

test('health distinguishes a fresh failed check from a broken monitor', () => {
  const freshFailure = classifyHealth([{ layers: [
    { layer: 'layer1', status: 'ok', stale: false },
    { layer: 'layer2', status: 'error', stale: false },
  ] }]);
  assert.deepEqual(freshFailure, { monitoringOperational: true, checksPassing: false });
  const delayed = classifyHealth([{ layers: [
    { layer: 'layer1', status: 'ok', stale: false },
    { layer: 'layer2', status: 'ok', stale: true },
  ] }]);
  assert.deepEqual(delayed, { monitoringOperational: false, checksPassing: false });
});

test('a 429 run backs off and rolls up separately from real outages', async () => {
  const { evaluateUptimeSample, isThrottledSample, shouldSkipUptimeProbe } = await import('../workers/error-monitor/uptime.mjs');
  const limits = {
    failureThreshold: 2, throttleThreshold: 3, slowThreshold: 3, slowMs: 5000,
    uptimeRealertMs: 3_600_000, throttleBackoffBaseMs: 15 * 60_000,
    throttleBackoffMaxMs: 60 * 60_000, throttleDigestMs: 6 * 60 * 60_000,
  };
  const now = Date.now();
  const throttled = { id: 'apgo-my:homepage', ok: false, status: 429, latencyMs: 90, error: 'HTTP 429' };
  const down = { id: 'apgo-my:homepage', ok: false, status: 503, latencyMs: 90, error: 'HTTP 503' };
  const ok = { id: 'apgo-my:homepage', ok: true, status: 200, latencyMs: 130, error: '' };
  assert.equal(isThrottledSample(throttled), true);
  assert.equal(isThrottledSample(down), false);

  let step = evaluateUptimeSample(null, throttled, now, limits);
  assert.equal(step.state.nextProbeAtMs, now + 15 * 60_000);
  assert.equal(shouldSkipUptimeProbe(step.state, now + 5 * 60_000), true);
  step = evaluateUptimeSample(step.state, throttled, now, limits);
  assert.deepEqual(step.events, [], 'two 429s in a row (the 2026-09-09 pattern) stay silent');
  assert.equal(step.state.failures, 0, '429 never counts as a failure');
  step = evaluateUptimeSample(step.state, throttled, now, limits);
  assert.deepEqual(step.events, ['throttled']);
  assert.equal(step.state.incidentOpen, false, 'monitor throttling is not a storefront outage');
  assert.equal(step.state.nextProbeAtMs, now + 60 * 60_000);
  assert.equal(step.state.throttleSamplesSinceDigest, 3);
  step = evaluateUptimeSample(step.state, ok, now, limits);
  assert.deepEqual(step.events, [], 'a throttle digest does not create a noisy recovery message');
  assert.equal(step.state.throttled, 0);

  const legacyThrottleState = {
    incidentOpen: true,
    lastAlertMs: now - 60_000,
    lastSample: throttled,
  };
  const migrated = evaluateUptimeSample(legacyThrottleState, ok, now, limits);
  assert.deepEqual(migrated.events, [], 'a pre-backoff 429 incident is closed silently after deployment');
  assert.equal(migrated.state.incidentOpen, false);

  let real = evaluateUptimeSample(null, down, now, limits);
  real = evaluateUptimeSample(real.state, down, now, limits);
  assert.deepEqual(real.events, ['down'], 'real failures still alert after two probes');
  const mixed = evaluateUptimeSample(evaluateUptimeSample(null, throttled, now, limits).state, down, now, limits);
  assert.equal(mixed.state.failures, 1, 'a 429 followed by a 503 starts the failure count fresh');
  assert.deepEqual(mixed.events, []);
});
