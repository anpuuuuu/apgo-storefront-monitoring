#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const matrixPath = path.resolve(process.env.MONITOR_MATRIX_FILE || 'layer2-matrix.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const journeys = Array.isArray(matrix) ? matrix : matrix.include;
if (!Array.isArray(journeys) || !journeys.length) throw new Error('Layer 2 batch contains no journeys');

function runJourney(journey) {
  const artifacts = path.resolve(process.env.MONITOR_ARTIFACTS_DIR || 'artifacts', journey.id);
  const env = {
    ...process.env,
    MONITOR_V2: '1',
    MONITOR_ARTIFACTS_DIR: artifacts,
    MONITOR_JOB_ID: journey.id,
    MONITOR_SITE: journey.site,
    MONITOR_SITE_ID: journey.site,
    MONITOR_MARKET: journey.market || '',
    MONITOR_DEVICE: journey.device,
    MONITOR_JOURNEY: journey.journey,
    MONITOR_SUITE: journey.suite,
    MONITOR_FLOW: journey.flow || '',
    MONITOR_RULE: journey.rule || '',
    MONITOR_SPEC: journey.spec,
    MONITOR_LANDING_PATH: journey.landingPath || '',
    MONITOR_CHANNEL: journey.channel || '',
    MONITOR_AD_SESSIONS: String(journey.sessions || 0),
    MONITOR_AD_ADD_TO_CARTS: String(journey.addToCarts || 0),
    MONITOR_AD_CHECKOUTS: String(journey.checkouts || 0),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/run-layer2-journey.mjs'], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ id: journey.id, exitCode: code ?? 1 }));
  });
}

const results = [];
for (const [index, journey] of journeys.entries()) {
  console.log(JSON.stringify({ event: 'layer2_journey_start', index: index + 1, total: journeys.length, id: journey.id }));
  results.push(await runJourney(journey));
}

const failed = results.filter((entry) => entry.exitCode !== 0);
console.log(JSON.stringify({ event: 'layer2_batch_complete', total: results.length, failed: failed.map((entry) => entry.id) }));
if (failed.length) process.exitCode = 1;
