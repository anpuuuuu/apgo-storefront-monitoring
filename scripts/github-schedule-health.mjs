#!/usr/bin/env node
import { selectMeaningfulScheduledRun } from './github-schedule-health-lib.mjs';

const token = process.env.GITHUB_TOKEN || '';
const repository = process.env.GITHUB_REPOSITORY || '';
if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');

const checks = [
  { workflow: 'site-health.yml', maxAgeMinutes: 130 },
  { workflow: 'monitor-alerts.yml', maxAgeMinutes: 100 },
];
const now = Date.now();

async function currentCommitAgeMinutes() {
  const sha = process.env.GITHUB_SHA || '';
  if (!sha) return Number.POSITIVE_INFINITY;
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'APGO-HealthCheck/2.0',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub commit API ${response.status}: ${JSON.stringify(body)}`);
  const committedAt = body.commit?.committer?.date || body.commit?.author?.date;
  return committedAt ? (now - Date.parse(committedAt)) / 60_000 : Number.POSITIVE_INFINITY;
}

const rolloutAgeMinutes = await currentCommitAgeMinutes();

for (const check of checks) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${check.workflow}/runs?event=schedule&per_page=20`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'APGO-HealthCheck/2.0',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub runs API ${response.status}: ${JSON.stringify(body)}`);
  const { run: latest, ignored } = selectMeaningfulScheduledRun(body.workflow_runs || []);
  if (ignored.length) {
    console.log(JSON.stringify({
      workflow: check.workflow,
      status: 'ignored_neutral_runs',
      runs: ignored.map((run) => ({ id: run.id, conclusion: run.conclusion, url: run.html_url })),
      message: 'Cancelled/skipped scheduled runs do not prove that the storefront monitor failed',
    }));
  }
  if (!latest && rolloutAgeMinutes <= 180) {
    console.log(JSON.stringify({
      workflow: check.workflow,
      status: 'startup_grace',
      rolloutAgeMinutes,
      message: 'Waiting for the first scheduled run after monitoring rollout',
    }));
    continue;
  }
  if (!latest) throw new Error(`${check.workflow} has no completed scheduled run after startup grace`);
  const ageMinutes = (now - Date.parse(latest.updated_at)) / 60_000;
  if (ageMinutes > check.maxAgeMinutes && rolloutAgeMinutes <= 180) {
    console.log(JSON.stringify({
      workflow: check.workflow,
      status: 'startup_grace',
      rolloutAgeMinutes,
      previousScheduledRunAgeMinutes: ageMinutes,
      message: 'Schedule was just enabled; waiting for its first post-rollout run',
    }));
    continue;
  }
  console.log(JSON.stringify({ workflow: check.workflow, ageMinutes, conclusion: latest.conclusion, url: latest.html_url }));
  if (ageMinutes > check.maxAgeMinutes) throw new Error(`${check.workflow} schedule is stale (${ageMinutes.toFixed(1)} minutes)`);
  if (latest.conclusion !== 'success') throw new Error(`${check.workflow} latest scheduled run concluded ${latest.conclusion}`);
}
