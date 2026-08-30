#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cwd = process.cwd();
const artifactsRoot = path.resolve(process.env.MONITOR_ARTIFACTS_DIR || 'artifacts');
const resultPath = path.join(artifactsRoot, 'layer2-result.json');
const retryDelayMs = Number(
  process.env.MONITOR_RETRY_DELAY_MS
  || (Number(process.env.MONITOR_RETRY_DELAY_SECONDS || 60) * 1_000)
);
const spec = process.env.MONITOR_SPEC || '';
const device = process.env.MONITOR_DEVICE || '';
const id = process.env.MONITOR_JOB_ID || [
  process.env.MONITOR_SITE,
  process.env.MONITOR_MARKET,
  device,
  process.env.MONITOR_JOURNEY,
].filter(Boolean).join('-');

if (!spec || !device || !id) throw new Error('MONITOR_SPEC, MONITOR_DEVICE and MONITOR_JOB_ID are required');
fs.mkdirSync(artifactsRoot, { recursive: true });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFirstError(node) {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node.errors) && node.errors[0]?.message) return node.errors[0].message;
  if (Array.isArray(node.results)) {
    for (const result of node.results) {
      const error = result?.error?.message || result?.errors?.[0]?.message;
      if (error) return error;
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      const error = Array.isArray(value)
        ? value.map(findFirstError).find(Boolean)
        : findFirstError(value);
      if (error) return error;
    }
  }
  return '';
}

function classifyError(error, exitCode) {
  if (exitCode === 0) return 'ok';
  if (/TEST_CONFIG_STALE/.test(error)) return 'TEST_CONFIG_STALE';
  if (/MONITOR_ACCESS_CHALLENGE/.test(error)) return 'MONITOR_ACCESS_CHALLENGE';
  if (/MONITOR_RATE_LIMIT|remained rate limited/i.test(error)) return 'MONITOR_RATE_LIMIT';
  return 'storefront_failure';
}

async function runAttempt(number) {
  const attemptDir = path.join(artifactsRoot, `attempt-${number}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  const resultsFile = path.join(attemptDir, 'results.json');
  const playwrightArgs = ['playwright', 'test', spec, `--project=${device}`];
  const isWindows = process.platform === 'win32';
  const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
  const args = isWindows ? ['/d', '/s', '/c', 'npx.cmd', ...playwrightArgs] : playwrightArgs;
  const startedAt = new Date().toISOString();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        MONITOR_V2: '1',
        MONITOR_OUTPUT_DIR: path.join(attemptDir, 'test-results'),
        MONITOR_REPORT_DIR: path.join(attemptDir, 'playwright-report'),
        MONITOR_RESULTS_FILE: resultsFile,
        MONITOR_ATTEMPT: String(number),
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  let error = '';
  if (fs.existsSync(resultsFile)) {
    try { error = findFirstError(JSON.parse(fs.readFileSync(resultsFile, 'utf8'))); } catch (_) {}
  }
  return {
    attempt: number,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    classification: classifyError(error, exitCode),
    error: String(error || (exitCode === 0 ? '' : `Playwright exited ${exitCode}`)).replace(/\s+/g, ' ').slice(0, 800),
  };
}

const attempts = [await runAttempt(1)];
let finalStatus = 'passed';
let classification = 'ok';
if (attempts[0].status === 'failed') {
  if (retryDelayMs > 0) {
    console.log(`First Layer 2 attempt failed. Waiting ${retryDelayMs} ms before a fresh-session recheck.`);
    await delay(retryDelayMs);
  }
  attempts.push(await runAttempt(2));
  if (attempts[1].status === 'passed') {
    finalStatus = 'transient';
    classification = attempts[0].classification === 'TEST_CONFIG_STALE' ? 'TEST_CONFIG_STALE_TRANSIENT' : 'flaky';
  } else {
    finalStatus = 'failed';
    if (attempts.some((attempt) => attempt.classification === 'TEST_CONFIG_STALE')) classification = 'TEST_CONFIG_STALE';
    else if (attempts.every((attempt) => attempt.classification === 'MONITOR_ACCESS_CHALLENGE')) classification = 'MONITOR_ACCESS_CHALLENGE';
    else if (attempts.every((attempt) => ['MONITOR_ACCESS_CHALLENGE', 'MONITOR_RATE_LIMIT'].includes(attempt.classification))) classification = 'MONITOR_RATE_LIMIT';
    else classification = 'storefront_failure';
  }
}

const result = {
  id,
  site: process.env.MONITOR_SITE || '',
  market: process.env.MONITOR_MARKET || '',
  device,
  journey: process.env.MONITOR_JOURNEY || '',
  suite: process.env.MONITOR_SUITE || '',
  landingPath: process.env.MONITOR_LANDING_PATH || '',
  channel: process.env.MONITOR_CHANNEL || '',
  mode: process.env.MONITOR_AD_MODE || '',
  commit: process.env.MONITOR_COMMIT || '',
  advertising: {
    sessions: Number(process.env.MONITOR_AD_SESSIONS || 0),
    addToCarts: Number(process.env.MONITOR_AD_ADD_TO_CARTS || 0),
    checkouts: Number(process.env.MONITOR_AD_CHECKOUTS || 0),
  },
  runUrl: process.env.RUN_URL || '',
  finalStatus,
  classification,
  attempts,
};
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ layer2Result: result }));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${finalStatus}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `classification=${classification}\n`);
}
if (finalStatus === 'failed') process.exitCode = 1;
