#!/usr/bin/env node
import { isWorkflowPaused, selectWorkflowFreshnessRun } from './github-schedule-health-lib.mjs';

const token = process.env.GITHUB_TOKEN || '';
const repository = process.env.GITHUB_REPOSITORY || '';
if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');

const checks = [
  // Post-deploy successes must not hide a missed daily commerce run.
  { workflow: 'site-health-v2.yml', maxAgeMinutes: 30 * 60, events: ['schedule', 'workflow_dispatch'], inputs: { cadence: 'daily', retry_delay_seconds: '60' } },
  { workflow: 'monitor-alerts.yml', maxAgeMinutes: 100, events: ['schedule', 'workflow_dispatch'], inputs: { mode: 'realtime', simulate_zero: 'false' } },
];
const now = Date.now();
const ref = process.env.GITHUB_REF_NAME || 'main';

function githubHeaders() {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'APGO-HealthCheck/2.0',
  };
}

async function dispatchRecovery(check, reason) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${check.workflow}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({ ref, inputs: check.inputs }),
  });
  if (response.status !== 204) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`${check.workflow} recovery dispatch failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  console.log(JSON.stringify({ workflow: check.workflow, status: 'recovery_dispatched', reason, ref }));
}

for (const check of checks) {
  if (isWorkflowPaused(check.workflow, process.env.MONITOR_LAYER4_PAUSED || 'false')) {
    console.log(JSON.stringify({ workflow: check.workflow, status: 'paused_by_owner', accepted: false,
      message: 'Excluded from partial Shadow acceptance; do not query freshness or dispatch recovery' }));
    continue;
  }
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${check.workflow}/runs?per_page=20`;
  const response = await fetch(url, {
    headers: githubHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub runs API ${response.status}: ${JSON.stringify(body)}`);
  const { run: latest, ignored, active } = selectWorkflowFreshnessRun(body.workflow_runs || [], check.events);
  if (ignored.length) {
    console.log(JSON.stringify({
      workflow: check.workflow,
      status: 'ignored_neutral_runs',
      runs: ignored.map((run) => ({ id: run.id, conclusion: run.conclusion, url: run.html_url })),
      message: 'Cancelled/skipped scheduled runs do not prove that the storefront monitor failed',
    }));
  }
  if (active) {
    const activeAgeMinutes = (now - Date.parse(active.created_at)) / 60_000;
    console.log(JSON.stringify({
      workflow: check.workflow,
      status: 'recovery_in_progress',
      event: active.event,
      activeAgeMinutes,
      url: active.html_url,
    }));
    if (activeAgeMinutes <= check.maxAgeMinutes) continue;
  }
  if (!latest) {
    await dispatchRecovery(check, 'no completed scheduled or recovery run');
    continue;
  }
  const ageMinutes = (now - Date.parse(latest.updated_at)) / 60_000;
  if (ageMinutes > check.maxAgeMinutes) {
    await dispatchRecovery(check, `latest completed run is ${ageMinutes.toFixed(1)} minutes old`);
    continue;
  }
  console.log(JSON.stringify({ workflow: check.workflow, ageMinutes, conclusion: latest.conclusion, url: latest.html_url }));
  if (latest.conclusion !== 'success') {
    // This watchdog owns schedule freshness only. The target workflow already
    // classifies and reports its own execution failure; failing self-health as
    // well would send a second Telegram alert for the same run.
    console.log(JSON.stringify({
      workflow: check.workflow,
      status: 'fresh_non_success_run',
      conclusion: latest.conclusion,
      message: 'Target workflow owns its own failure notification',
    }));
  }
}
