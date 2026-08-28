#!/usr/bin/env node
import fs from 'node:fs';
import { assertSource, getSite } from './site-config.mjs';

const token = process.env.GITHUB_TOKEN || '';
const site = getSite();
const cadence = process.env.MONITOR_CADENCE || 'daily';
if (!token) throw new Error('GITHUB_TOKEN is required');

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'APGO-Storefront-Monitoring/1.0',
};

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body.message || 'request failed'}`);
  return body;
}

const repository = process.env.MONITOR_SOURCE_REPO || site.repository;
const repositoryId = process.env.MONITOR_SOURCE_REPOSITORY_ID || site.repositoryId;
const metadata = await github(`/repos/${repository}`);
assertSource(site, { repository: metadata.full_name, repositoryId: metadata.id });
if (String(repositoryId) !== String(metadata.id)) {
  throw new Error(`TEST_CONFIG_STALE: workflow repository id ${repositoryId} does not match GitHub ${metadata.id}`);
}

let sha = process.env.MONITOR_SOURCE_SHA || '';
if (cadence === 'post-deploy') {
  assertSource(site, { repository, repositoryId, sha });
} else {
  const commit = await github(`/repos/${repository}/commits/${encodeURIComponent(site.defaultBranch)}`);
  sha = commit.sha;
  assertSource(site, { repository, repositoryId, sha });
}

const output = {
  siteId: site.id,
  repository,
  repositoryId: String(metadata.id),
  sha,
  branch: site.defaultBranch,
  cadence,
};
console.log(JSON.stringify(output));
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
}
