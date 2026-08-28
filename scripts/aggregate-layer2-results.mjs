#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.MONITOR_RESULTS_ROOT || 'layer2-results');
const outputPath = path.resolve(process.env.MONITOR_AGGREGATE_FILE || 'layer2-aggregate.json');
const heartbeatPath = path.resolve(process.env.MONITOR_HEARTBEAT_DETAIL_FILE || 'layer2-heartbeat-detail.json');
const planResult = process.env.MONITOR_PLAN_RESULT || 'success';
const planError = process.env.MONITOR_PLAN_ERROR || '';
let expected = [];
let matrixError = '';
try {
  expected = JSON.parse(process.env.MONITOR_EXPECTED_MATRIX || '{"include":[]}').include || [];
} catch (error) {
  matrixError = String(error?.message || error);
}
const planningFailed = planResult !== 'success' || Boolean(matrixError) || expected.length === 0;

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
const status = planningFailed || failed.length || missing.length ? 'failed' : 'ok';
const attemptSummary = (result) => (result.attempts || [])
  .filter((attempt) => attempt.status === 'failed')
  .map((attempt) => `#${attempt.attempt} ${attempt.classification || 'failed'}: ${attempt.error || 'failed'}`)
  .join(' | ');
const failedSummary = failed.slice(0, 2)
  .map((result) => `${result.id}${result.landingPath ? ` ${result.channel || 'Paid'} ${result.landingPath}` : ''} [${result.classification}]: ${attemptSummary(result)}`)
  .join(' || ');
const detail = planningFailed
  ? `Layer 2 planning failed (plan=${planResult}, expected=${expected.length}${planError ? `, error=${planError}` : ''}${matrixError ? `, matrix=${matrixError}` : ''})`
  : failed.length || missing.length
    ? `journeys failed=${failed.length}, missing=${missing.length}; ${failedSummary || `missing: ${missing.slice(0, 3).join(', ')}`}`
    : `${results.length} journeys passed; transient=${transient.length}`;
const failureClassifications = new Set(failed.map((result) => result.classification));
const cadence = process.env.MONITOR_CADENCE || '';
const challengeOnly = !planningFailed
  && missing.length === 0
  && failed.length > 0
  && failureClassifications.size === 1
  && failureClassifications.has('MONITOR_ACCESS_CHALLENGE');
// A blocked synthetic runner is monitoring degradation, not evidence that
// shoppers are down. Keep the workflow/heartbeat red, but page at most on the
// daily full run. Mixed or real storefront failures still notify immediately.
const notify = status === 'failed' && (!challengeOnly || cadence === 'daily');
const alertTitle = planningFailed
  ? planError.includes('AD_DISCOVERY_FAILED')
    ? 'APGO Layer 2 GA4 advertising discovery failed'
    : 'APGO Layer 2 test planning failed'
  : missing.length
  ? 'APGO Layer 2 monitoring result missing'
    : failureClassifications.has('TEST_CONFIG_STALE')
      ? 'APGO Layer 2 test configuration is stale'
    : failureClassifications.size === 1 && failureClassifications.has('MONITOR_RATE_LIMIT')
      ? 'APGO Layer 2 synthetic traffic was rate limited'
    : failureClassifications.size === 1 && failureClassifications.has('MONITOR_ACCESS_CHALLENGE')
      ? 'APGO Layer 2 synthetic browser was blocked'
      : 'APGO Layer 2 journeys failed after recheck';
const aggregate = {
  generatedAt: new Date().toISOString(),
  status,
  cadence,
  challengeOnly,
  notify,
  planResult,
  planningFailed,
  expectedCount: expected.length,
  receivedCount: results.length,
  missing,
  failed,
  transient,
  results,
};
fs.writeFileSync(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
fs.writeFileSync(heartbeatPath, `${JSON.stringify({
  cadence,
  planResult,
  planningFailed,
  expectedCount: expected.length,
  receivedCount: results.length,
  missing,
  journeys: results.map((result) => ({
    id: result.id,
    status: result.finalStatus,
    attempts: result.attempts.length,
    classification: result.classification,
    landingPath: result.landingPath || '',
    channel: result.channel || '',
    commit: result.commit || '',
  })),
}, null, 2)}\n`);
console.log(JSON.stringify({ status, detail, expected: expected.length, received: results.length, failed: failed.length, transient: transient.length, missing }));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `detail=${detail.replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert_title=${alertTitle}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `notify=${notify}\n`);
}
