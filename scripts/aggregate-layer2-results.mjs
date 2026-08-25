#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.MONITOR_RESULTS_ROOT || 'layer2-results');
const outputPath = path.resolve(process.env.MONITOR_AGGREGATE_FILE || 'layer2-aggregate.json');
const heartbeatPath = path.resolve(process.env.MONITOR_HEARTBEAT_DETAIL_FILE || 'layer2-heartbeat-detail.json');
const expected = JSON.parse(process.env.MONITOR_EXPECTED_MATRIX || '{"include":[]}').include || [];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const results = walk(root)
  .filter((file) => path.basename(file) === 'layer2-result.json')
  .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
const byId = new Map(results.map((result) => [result.id, result]));
const missing = expected.map((entry) => entry.id).filter((id) => !byId.has(id));
const failed = results.filter((result) => result.finalStatus === 'failed');
const transient = results.filter((result) => result.finalStatus === 'transient');
const status = failed.length || missing.length ? 'failed' : 'ok';
const firstProblem = failed[0] || (missing[0] ? { id: missing[0], attempts: [{ error: 'journey result/heartbeat is missing' }] } : null);
const problemError = firstProblem?.attempts?.find((attempt) => attempt.status === 'failed')?.error || '';
const detail = firstProblem
  ? `${firstProblem.id}: ${problemError || 'failed'} (missing=${missing.length}, failed=${failed.length})`
  : `${results.length} journeys passed; transient=${transient.length}`;
const failureClassifications = new Set(failed.map((result) => result.classification));
const alertTitle = missing.length
  ? 'APGO Layer 2 monitoring result missing'
    : failureClassifications.has('TEST_CONFIG_STALE')
      ? 'APGO Layer 2 test configuration is stale'
    : failureClassifications.size === 1 && failureClassifications.has('MONITOR_RATE_LIMIT')
      ? 'APGO Layer 2 synthetic traffic was rate limited'
    : failureClassifications.size === 1 && failureClassifications.has('MONITOR_ACCESS_CHALLENGE')
      ? 'APGO Layer 2 synthetic browser was blocked'
      : 'APGO Layer 2 storefront journey failed twice';
const aggregate = {
  generatedAt: new Date().toISOString(),
  status,
  expectedCount: expected.length,
  receivedCount: results.length,
  missing,
  failed,
  transient,
  results,
};
fs.writeFileSync(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
fs.writeFileSync(heartbeatPath, `${JSON.stringify({
  cadence: process.env.MONITOR_CADENCE || '',
  expectedCount: expected.length,
  receivedCount: results.length,
  missing,
  journeys: results.map((result) => ({
    id: result.id,
    status: result.finalStatus,
    attempts: result.attempts.length,
    classification: result.classification,
  })),
}, null, 2)}\n`);
console.log(JSON.stringify({ status, detail, expected: expected.length, received: results.length, failed: failed.length, transient: transient.length, missing }));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `detail=${detail.replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert_title=${alertTitle}\n`);
}
