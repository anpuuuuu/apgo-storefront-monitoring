import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchWorkflowRuns,
  runHistory,
  shouldNotifyFailure,
  workflowFileFromRef,
} from '../scripts/workflow-failure-notify-lib.mjs';

const run = (id, conclusion, status = 'completed') => ({ id, status, conclusion });

test('workflowFileFromRef extracts the workflow file name', () => {
  assert.equal(workflowFileFromRef('anpuuuuu/apgo-storefront-monitoring/.github/workflows/monitor-alerts.yml@refs/heads/main'), 'monitor-alerts.yml');
  assert.equal(workflowFileFromRef('owner/repo/.github/workflows/deploy-worker.yml'), 'deploy-worker.yml');
  assert.equal(workflowFileFromRef(''), '');
  assert.equal(workflowFileFromRef(undefined), '');
});

test('runHistory skips the current run and neutral conclusions, stops at the last success', () => {
  const runs = [run(9, 'failure'), run(8, 'cancelled'), run(7, 'failure'), run(6, 'skipped'), run(5, 'success'), run(4, 'failure')];
  assert.deepEqual(runHistory(runs, 9), { previous: 'failure', failures: 1 });
  assert.deepEqual(runHistory(runs, 999), { previous: 'failure', failures: 2 });
  assert.deepEqual(runHistory([run(9, 'failure'), run(5, 'success')], 9), { previous: 'success', failures: 0 });
  assert.deepEqual(runHistory([run(9, 'failure')], 9), { previous: null, failures: 0 });
  assert.deepEqual(runHistory([run(9, 'failure'), run(8, null, 'in_progress'), run(7, 'success')], 9), { previous: 'success', failures: 0 });
  assert.equal(runHistory(null, 9), null);
});

test('a single failure after a success stays quiet; the second consecutive failure pages', () => {
  // 2026-09-14 01:45 UTC: one ECONNRESET, the scheduler re-ran within the hour and it passed.
  const afterSuccess = [run(9, 'failure'), run(8, 'success'), run(7, 'success')];
  assert.deepEqual(shouldNotifyFailure({ runs: afterSuccess, currentRunId: 9 }), { notify: false, reason: 'first_failure_after_success' });
  const secondFailure = [run(10, 'failure'), run(9, 'failure'), run(8, 'success')];
  assert.deepEqual(shouldNotifyFailure({ runs: secondFailure, currentRunId: 10 }), { notify: true, reason: 'consecutive_failures:2' });
  // The current run is normally still in progress and absent from the completed list.
  assert.deepEqual(shouldNotifyFailure({ runs: [run(9, 'failure'), run(8, 'success')], currentRunId: 10 }), { notify: true, reason: 'consecutive_failures:2' });
  assert.deepEqual(shouldNotifyFailure({ runs: [run(9, 'failure'), run(8, 'failure'), run(7, 'success')], currentRunId: 10, minConsecutive: 3 }), { notify: true, reason: 'consecutive_failures:3' });
  assert.deepEqual(shouldNotifyFailure({ runs: [run(9, 'failure'), run(8, 'success')], currentRunId: 10, minConsecutive: 3 }), { notify: false, reason: 'first_failure_after_success' });
});

test('unreadable history, a brand-new workflow, or min=1 always notify', () => {
  assert.deepEqual(shouldNotifyFailure({ runs: null, currentRunId: 9 }), { notify: true, reason: 'run_history_unavailable' });
  assert.deepEqual(shouldNotifyFailure({ runs: [], currentRunId: 9 }), { notify: true, reason: 'no_previous_run' });
  assert.deepEqual(shouldNotifyFailure({ runs: [run(9, 'failure')], currentRunId: 9 }), { notify: true, reason: 'no_previous_run' });
  assert.deepEqual(shouldNotifyFailure({ runs: [run(8, 'success')], currentRunId: 9, minConsecutive: 1 }), { notify: true, reason: 'every_failure' });
  assert.deepEqual(shouldNotifyFailure({ runs: [run(8, 'success')], currentRunId: 9, minConsecutive: '0' }), { notify: true, reason: 'every_failure' });
});

test('fetchWorkflowRuns asks GitHub for the workflow file and returns null on any problem', async () => {
  const calls = [];
  const ok = async (url, options) => {
    calls.push({ url, auth: options.headers.authorization });
    return { ok: true, json: async () => ({ workflow_runs: [run(1, 'success')] }) };
  };
  const runs = await fetchWorkflowRuns({ repo: 'anpuuuuu/apgo-storefront-monitoring', workflowFile: 'monitor-alerts.yml', token: 'ghs_x', fetchImpl: ok });
  assert.deepEqual(runs, [run(1, 'success')]);
  assert.equal(calls[0].url, 'https://api.github.com/repos/anpuuuuu/apgo-storefront-monitoring/actions/workflows/monitor-alerts.yml/runs?status=completed&per_page=10');
  assert.equal(calls[0].auth, 'Bearer ghs_x');

  assert.equal(await fetchWorkflowRuns({ repo: 'a/b', workflowFile: 'x.yml', token: 't', fetchImpl: async () => ({ ok: false, status: 403 }) }), null);
  assert.equal(await fetchWorkflowRuns({ repo: 'a/b', workflowFile: 'x.yml', token: 't', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), null);
  assert.equal(await fetchWorkflowRuns({ repo: 'a/b', workflowFile: 'x.yml', token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null);
  assert.equal(await fetchWorkflowRuns({ repo: 'a/b', workflowFile: '', token: 't', fetchImpl: ok }), null, 'no workflow file means no request');
  assert.equal(calls.length, 1);
});
