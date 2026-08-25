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

function runAggregate(result) {
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
      MONITOR_EXPECTED_MATRIX: JSON.stringify({ include: [expectedJob] }),
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
  assert.match(output, /alert_title=APGO Layer 2 synthetic browser was blocked/);
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
