#!/usr/bin/env node
const workerUrl = (process.env.MONITOR_WORKER_URL || '').replace(/\/$/, '');
const siteId = process.env.MONITOR_SITE_ID || 'apgo-my';
if (!workerUrl) throw new Error('MONITOR_WORKER_URL is required');
const response = await fetch(`${workerUrl}/health`, { headers: { 'user-agent': 'APGO-HealthCheck/2.0 GitHub' } });
const body = await response.json().catch(() => ({}));
console.log(JSON.stringify(body, null, 2));
if (!response.ok || !body.ok) throw new Error(`Worker health failed: HTTP ${response.status}`);
const site = body.sites?.find((entry) => entry.siteId === siteId);
const layer1 = site?.layers?.find((row) => row.layer === 'layer1')
  || body.heartbeats?.find((row) => row.layer === `${siteId}:layer1` || row.layer === 'layer1');
if (!layer1 || layer1.stale) throw new Error('Layer 1 heartbeat is missing or stale');
