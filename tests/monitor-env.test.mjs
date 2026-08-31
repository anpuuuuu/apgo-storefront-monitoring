import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONITOR_SITE_ID = 'apgo-my';
process.env.GA4_PROPERTY_ID = 'test-property';
process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'test-access-token';
process.env.MONITOR_WORKER_URL = 'https://monitor.example.test';
process.env.MONITOR_MODE = 'shadow';
delete process.env.CF_ACCOUNT_ID;
delete process.env.CF_API_TOKEN;
delete process.env.MONITOR_HEARTBEAT_TOKEN;

const { missingRequiredEnv } = await import('../scripts/monitor-lib.mjs');

test('GA4 validation in shadow mode does not require D1 or heartbeat credentials', () => {
  assert.deepEqual(missingRequiredEnv({ needsD1: false }), []);
});

test('stateful GA4 checks still require D1 credentials', () => {
  assert.deepEqual(missingRequiredEnv({ needsD1: true }), ['CF_ACCOUNT_ID', 'CF_API_TOKEN']);
});

test('live heartbeat validation requires its shared secret', () => {
  assert.deepEqual(
    missingRequiredEnv({ needsD1: false, needsHeartbeat: true }),
    ['MONITOR_HEARTBEAT_TOKEN'],
  );
});
