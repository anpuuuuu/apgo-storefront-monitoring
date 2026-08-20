#!/usr/bin/env node
const token = process.env.GITHUB_TOKEN || '';
const repository = process.env.GITHUB_REPOSITORY || '';
if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');

const checks = [
  { workflow: 'site-health.yml', maxAgeMinutes: 130 },
  { workflow: 'monitor-alerts.yml', maxAgeMinutes: 100 },
];
const now = Date.now();

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
  const latest = (body.workflow_runs || []).find((run) => run.status === 'completed');
  if (!latest) throw new Error(`${check.workflow} has no completed scheduled run`);
  const ageMinutes = (now - Date.parse(latest.updated_at)) / 60_000;
  console.log(JSON.stringify({ workflow: check.workflow, ageMinutes, conclusion: latest.conclusion, url: latest.html_url }));
  if (ageMinutes > check.maxAgeMinutes) throw new Error(`${check.workflow} schedule is stale (${ageMinutes.toFixed(1)} minutes)`);
  if (latest.conclusion !== 'success') throw new Error(`${check.workflow} latest scheduled run concluded ${latest.conclusion}`);
}
