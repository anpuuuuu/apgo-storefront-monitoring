import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isWorkflowPaused, selectMeaningfulScheduledRun, selectWorkflowFreshnessRun } from '../scripts/github-schedule-health-lib.mjs';

test('an explicit Layer 4 pause never pauses Layer 2 or defaults to paused', () => {
  assert.equal(isWorkflowPaused('monitor-alerts.yml', 'true'), true);
  assert.equal(isWorkflowPaused('site-health-v2.yml', 'true'), false);
  assert.equal(isWorkflowPaused('monitor-alerts.yml'), false);
  assert.equal(isWorkflowPaused('monitor-alerts.yml', ''), false);
  assert.equal(isWorkflowPaused('monitor-alerts.yml', 'false'), false);
  assert.throws(() => isWorkflowPaused('monitor-alerts.yml', 'invalid'), /Invalid MONITOR_LAYER4_PAUSED/);
});

test('paused Layer 4 makes no GitHub call or recovery dispatch and is not accepted as healthy', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /site-health-v2\.yml\/runs/);
    return Response.json({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', event: 'schedule', updated_at: new Date().toISOString() }] });
  });
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(JSON.parse(line)));
  const prior = Object.fromEntries(['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'MONITOR_LAYER4_PAUSED'].map((key) => [key, process.env[key]]));
  try {
    process.env.GITHUB_TOKEN = 'test';
    process.env.GITHUB_REPOSITORY = 'example/monitoring';
    process.env.MONITOR_LAYER4_PAUSED = 'true';
    await import('../scripts/github-schedule-health.mjs?pause-test');
    assert.equal(globalThis.fetch.mock.callCount(), 1);
    assert.ok(logged.some((entry) => entry.workflow === 'monitor-alerts.yml' && entry.status === 'paused_by_owner' && entry.accepted === false));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('schedule gate and watchdog both use the Layer 4 pause while keeping manual diagnostics', () => {
  const ga4Workflow = readFileSync(new URL('../.github/workflows/monitor-alerts.yml', import.meta.url), 'utf8');
  const healthWorkflow = readFileSync(new URL('../.github/workflows/monitor-self-health.yml', import.meta.url), 'utf8');
  assert.match(ga4Workflow, /github\.event_name != 'schedule' \|\| \(vars\.MONITOR_SCHEDULE_ENABLED == 'true' && vars\.MONITOR_LAYER4_PAUSED != 'true'\)/);
  assert.match(healthWorkflow, /MONITOR_LAYER4_PAUSED: \$\{\{ vars\.MONITOR_LAYER4_PAUSED \|\| 'false' \}\}/);
});

test('ignores a cancelled pending schedule and uses the latest meaningful result', () => {
  const cancelled = { id: 3, status: 'completed', conclusion: 'cancelled' };
  const success = { id: 2, status: 'completed', conclusion: 'success' };
  const olderFailure = { id: 1, status: 'completed', conclusion: 'failure' };
  const result = selectMeaningfulScheduledRun([cancelled, success, olderFailure]);
  assert.equal(result.run, success);
  assert.deepEqual(result.ignored, [cancelled]);
});

test('does not hide a real workflow failure', () => {
  const failed = { id: 4, status: 'completed', conclusion: 'failure' };
  const success = { id: 3, status: 'completed', conclusion: 'success' };
  assert.equal(selectMeaningfulScheduledRun([failed, success]).run, failed);
});

test('does not treat an in-progress run as a completed health result', () => {
  const running = { id: 5, status: 'in_progress', conclusion: null };
  const success = { id: 4, status: 'completed', conclusion: 'success' };
  assert.equal(selectMeaningfulScheduledRun([running, success]).run, success);
});

test('workflow freshness accepts dispatch recovery and exposes an active run', () => {
  const active = { id: 7, event: 'workflow_dispatch', status: 'in_progress', conclusion: null };
  const recovery = { id: 6, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const push = { id: 5, event: 'push', status: 'completed', conclusion: 'success' };
  const result = selectWorkflowFreshnessRun([active, recovery, push]);
  assert.equal(result.active, active);
  assert.equal(result.run, recovery);
});

test('Layer 2 daily freshness ignores successful post-deploy pushes', () => {
  const push = { id: 8, event: 'push', status: 'completed', conclusion: 'success' };
  const schedule = { id: 7, event: 'schedule', status: 'completed', conclusion: 'success' };
  assert.equal(selectWorkflowFreshnessRun([push, schedule]).run, schedule);
});

