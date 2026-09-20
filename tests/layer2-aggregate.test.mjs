import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const monitoringRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aggregateScript = path.join(monitoringRoot, 'scripts', 'aggregate-layer2-results.mjs');
const expectedJob = {
  id: 'apgo-my-MY-android-chromium-mobile-main',
  site: 'apgo-my',
  market: 'MY',
  device: 'android-chromium',
  journey: 'mobile-main',
};

function runAggregate(result, { planResult = 'success', batchResult = 'success', planError = '', expected = [expectedJob], cadence = 'post-deploy' } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apgo-layer2-aggregate-'));
  const root = path.join(temp, 'results');
  fs.mkdirSync(root, { recursive: true });
  if (result) {
    const journeyDir = path.join(root, result.id);
    fs.mkdirSync(journeyDir, { recursive: true });
    fs.writeFileSync(path.join(journeyDir, 'layer2-result.json'), JSON.stringify(result));
  }
  const githubOutput = path.join(temp, 'github-output.txt');
  const run = spawnSync(process.execPath, [aggregateScript], {
    cwd: monitoringRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MONITOR_RESULTS_ROOT: root,
      MONITOR_PLAN_RESULT: planResult,
      MONITOR_BATCH_RESULT: batchResult,
      MONITOR_PLAN_ERROR: planError,
      MONITOR_CADENCE: cadence,
      MONITOR_EXPECTED_MATRIX: JSON.stringify({ include: expected }),
      MONITOR_AGGREGATE_FILE: path.join(temp, 'aggregate.json'),
      MONITOR_HEARTBEAT_DETAIL_FILE: path.join(temp, 'heartbeat.json'),
      GITHUB_OUTPUT: githubOutput,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  return {
    aggregate: JSON.parse(fs.readFileSync(path.join(temp, 'aggregate.json'), 'utf8')),
    heartbeat: JSON.parse(fs.readFileSync(path.join(temp, 'heartbeat.json'), 'utf8')),
    output: fs.readFileSync(githubOutput, 'utf8'),
  };
}

test('transient second-attempt success keeps aggregate healthy', () => {
  const result = {
    ...expectedJob,
    finalStatus: 'transient',
    classification: 'flaky',
    attempts: [{ attempt: 1, status: 'failed' }, { attempt: 2, status: 'passed' }],
  };
  const { aggregate, heartbeat } = runAggregate(result);
  assert.equal(aggregate.status, 'ok');
  assert.equal(aggregate.transient.length, 1);
  assert.equal(heartbeat.journeys[0].attempts, 2);
});

test('soft journey notes reach the heartbeat detail without failing the aggregate', () => {
  const note = { type: 'header_cart_bubble_lag', description: 'header showed 9 for 10 items until reload on /products/apgo-laundry-detergent-special-promotion-1' };
  const result = {
    ...expectedJob,
    finalStatus: 'passed',
    classification: 'ok',
    attempts: [{ attempt: 1, status: 'passed', notes: [note] }],
    notes: [note],
  };
  const { aggregate, heartbeat, output } = runAggregate(result, { cadence: 'daily' });
  assert.equal(aggregate.status, 'ok');
  assert.deepEqual(aggregate.noteCounts, { header_cart_bubble_lag: 1 });
  assert.deepEqual(heartbeat.noteCounts, { header_cart_bubble_lag: 1 });
  assert.deepEqual(heartbeat.journeys[0].notes, [note]);
  assert.match(output, /notify=false/);
  assert.match(output, /detail=1 journeys passed; transient=0; notes=header_cart_bubble_lag×1/);
});

test('two access challenges use a distinct synthetic-browser alert', () => {
  const result = {
    ...expectedJob,
    finalStatus: 'failed',
    classification: 'MONITOR_ACCESS_CHALLENGE',
    attempts: [
      { attempt: 1, status: 'failed', error: 'MONITOR_ACCESS_CHALLENGE' },
      { attempt: 2, status: 'failed', error: 'MONITOR_ACCESS_CHALLENGE' },
    ],
  };
  const { aggregate, output } = runAggregate(result);
  assert.equal(aggregate.status, 'failed');
  assert.equal(aggregate.challengeOnly, true);
  assert.equal(aggregate.notify, false);
  assert.match(output, /alert_title=APGO Layer 2 synthetic browser was blocked/);
  assert.match(output, /notify=false/);

  const daily = runAggregate(result, { cadence: 'daily' });
  assert.equal(daily.aggregate.notify, true);
  assert.match(daily.output, /notify=true/);
});

test('repeated synthetic rate limits are not reported as storefront failures', () => {
  const result = {
    ...expectedJob,
    finalStatus: 'failed',
    classification: 'MONITOR_RATE_LIMIT',
    attempts: [
      { attempt: 1, status: 'failed', error: 'MONITOR_RATE_LIMIT: /cart.js HTTP 429' },
      { attempt: 2, status: 'failed', error: 'MONITOR_RATE_LIMIT: localization HTTP 429' },
    ],
  };
  const { aggregate, output } = runAggregate(result);
  assert.equal(aggregate.status, 'failed');
  assert.match(output, /alert_title=APGO Layer 2 synthetic traffic was rate limited/);
});

test('missing journey result fails the aggregate heartbeat', () => {
  const { aggregate, output } = runAggregate(null);
  assert.equal(aggregate.status, 'failed');
  assert.deepEqual(aggregate.missing, [expectedJob.id]);
  assert.match(output, /alert_title=APGO Layer 2 monitoring result missing/);
});

test('a run our own concurrency group cancelled must never page', () => {
  /* 2026-09-20: six theme pushes in two hours. cancel-in-progress killed four
     post-deploy runs, and each reported the journeys it never reached as
     missing evidence and rang the phone. Superseded work is not a storefront
     fault. */
  const supersededMidBatch = runAggregate(null, { batchResult: 'cancelled' });
  assert.equal(supersededMidBatch.aggregate.status, 'cancelled');
  assert.equal(supersededMidBatch.aggregate.cancelled, true);
  assert.equal(supersededMidBatch.aggregate.notify, false);
  assert.equal(supersededMidBatch.aggregate.planningFailed, false, 'planning did not fail, the run was stopped');
  assert.match(supersededMidBatch.output, /status=cancelled/);
  assert.match(supersededMidBatch.output, /notify=false/);
  assert.match(supersededMidBatch.output, /detail=Layer 2 run superseded by a newer theme push/);
  assert.match(supersededMidBatch.output, /alert_title=APGO Layer 2 run was superseded/);

  // Cancelled before the matrix even existed: still silent, not "planning failed".
  const supersededInPlan = runAggregate(null, { planResult: 'cancelled', batchResult: 'cancelled', expected: [] });
  assert.equal(supersededInPlan.aggregate.status, 'cancelled');
  assert.equal(supersededInPlan.aggregate.notify, false);
  assert.equal(supersededInPlan.aggregate.planningFailed, false);

  // Journeys that did finish before the cancellation are still recorded.
  const partial = runAggregate({ ...expectedJob, finalStatus: 'passed', classification: 'ok', attempts: [{ attempt: 1, status: 'passed' }] },
    { batchResult: 'cancelled', expected: [expectedJob, { ...expectedJob, id: 'apgo-my-MY-iphone-webkit-second' }] });
  assert.equal(partial.aggregate.status, 'cancelled');
  assert.equal(partial.aggregate.receivedCount, 1);
  assert.match(partial.output, /1\/2 journeys had finished/);

  // A genuine failure inside the batch still pages.
  const real = runAggregate({ ...expectedJob, finalStatus: 'failed', classification: 'storefront_failure', attempts: [{ attempt: 1, status: 'failed', error: 'boom' }, { attempt: 2, status: 'failed', error: 'boom' }] },
    { batchResult: 'failure' });
  assert.equal(real.aggregate.status, 'failed');
  assert.equal(real.aggregate.cancelled, false);
  assert.match(real.output, /notify=true/);
});

test('failed or empty planning can never create a healthy heartbeat', () => {
  const failedPlan = runAggregate(null, { planResult: 'failure', expected: [] });
  assert.equal(failedPlan.aggregate.status, 'failed');
  assert.equal(failedPlan.aggregate.planningFailed, true);
  assert.match(failedPlan.output, /alert_title=APGO Layer 2 test planning failed/);

  const emptyPlan = runAggregate(null, { expected: [] });
  assert.equal(emptyPlan.aggregate.status, 'failed');
  assert.equal(emptyPlan.aggregate.planningFailed, true);
});

test('GA4 discovery failures keep their own alert classification', () => {
  const failed = runAggregate(null, {
    planResult: 'failure',
    planError: 'AD_DISCOVERY_FAILED: GA4 runReport HTTP 403',
    expected: [],
  });
  assert.match(failed.output, /alert_title=APGO Layer 2 GA4 advertising discovery failed/);
});

test('mixed journey failures report final classifications and both attempts', () => {
  const result = {
    ...expectedJob,
    finalStatus: 'failed',
    classification: 'storefront_failure',
    attempts: [
      { attempt: 1, status: 'failed', classification: 'MONITOR_ACCESS_CHALLENGE', error: 'challenge' },
      { attempt: 2, status: 'failed', classification: 'storefront_failure', error: 'campaign missing' },
    ],
  };
  const { output } = runAggregate(result);
  assert.match(output, /alert_title=APGO Layer 2 journeys failed after recheck/);
  assert.match(output, /#1 MONITOR_ACCESS_CHALLENGE: challenge/);
  assert.match(output, /#2 storefront_failure: campaign missing/);
});
