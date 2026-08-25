#!/usr/bin/env node
const workerUrl = (process.env.MONITOR_WORKER_URL || '').replace(/\/$/, '');
const token = process.env.MONITOR_HEARTBEAT_TOKEN || '';
const layer = process.env.MONITOR_LAYER || '';
const requestedStatus = String(process.env.MONITOR_STATUS || 'ok').toLowerCase();
const status = ['ok', 'passed', 'transient'].includes(requestedStatus) ? 'ok' : 'error';
const source = process.env.MONITOR_SOURCE || 'github-actions';
let extraDetail = {};
if (process.env.MONITOR_DETAIL_JSON_FILE) {
  extraDetail = JSON.parse(await import('node:fs').then(({ readFileSync }) => readFileSync(process.env.MONITOR_DETAIL_JSON_FILE, 'utf8')));
}

if (!workerUrl || !token || !layer) {
  throw new Error('MONITOR_WORKER_URL, MONITOR_HEARTBEAT_TOKEN and MONITOR_LAYER are required');
}

const response = await fetch(`${workerUrl}/heartbeat`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    layer,
    source,
    status,
    detail: {
      runUrl: process.env.RUN_URL || '',
      suite: process.env.MONITOR_SUITE || '',
      commit: process.env.GITHUB_SHA || '',
      ...extraDetail,
    },
  }),
});
if (!response.ok) throw new Error(`heartbeat HTTP ${response.status}: ${await response.text()}`);
console.log(`Heartbeat written for ${layer} (${status})`);
