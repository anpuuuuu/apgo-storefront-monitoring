import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMeaningfulScheduledRun, selectWorkflowFreshnessRun } from '../scripts/github-schedule-health-lib.mjs';

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

