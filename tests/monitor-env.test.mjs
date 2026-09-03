import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('production Worker deployment is main-only and migration remains opt-in', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  const deployJob = workflow.split(/\n  deploy:\s*\r?\n/)[1];
  assert.ok(deployJob, 'deployment job must exist');
  assert.match(deployJob, /\n    if: github\.ref == 'refs\/heads\/main'\s*\r?\n/);
  assert.match(deployJob, /\n    environment: production\s*\r?\n/);
  assert.match(workflow, /apply_d1_migration:\s*\r?\n\s+type: boolean\s*\r?\n\s+default: false/);
  assert.match(workflow, /if: inputs\.worker == 'error-monitor' && inputs\.apply_d1_migration/);
});

process.env.MONITOR_SITE_ID = 'apgo-my';
process.env.GA4_PROPERTY_ID = 'test-property';
process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'test-access-token';
process.env.MONITOR_WORKER_URL = 'https://monitor.example.test';
process.env.MONITOR_MODE = 'shadow';
delete process.env.CF_ACCOUNT_ID;
delete process.env.CF_API_TOKEN;
delete process.env.MONITOR_HEARTBEAT_TOKEN;

const { missingRequiredEnv, assertUnrestrictedMetrics, ga } = await import('../scripts/monitor-lib.mjs');

const restrictedReport = {
  rows: [{ metricValues: [{ value: '0' }] }],
  metadata: { schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'purchaseRevenue', restrictedMetricTypes: ['REVENUE_DATA'] }] } },
};

test('restricted zeros fail as an access problem instead of becoming zero revenue', () => {
  assert.throws(() => assertUnrestrictedMetrics(restrictedReport), /GA4_METRIC_ACCESS_RESTRICTED: purchaseRevenue \(REVENUE_DATA\)/);
  assert.doesNotThrow(() => assertUnrestrictedMetrics({ rows: restrictedReport.rows }));
});

test('only explicit diagnostic queries can inspect restricted results', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(restrictedReport));
  await assert.rejects(ga('runReport', {}), /GA4_METRIC_ACCESS_RESTRICTED/);
  assert.deepEqual(await ga('runReport', {}, { allowRestrictedMetrics: true }), restrictedReport);
});

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
