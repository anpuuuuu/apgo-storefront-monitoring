import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MAX_AGE_MINUTES, decideScheduledRun } from '../scripts/layer2-gate.mjs';

const SITE = 'apgo-my';
const health = (layer2) => ({
  ok: true,
  sites: [
    { siteId: 'other-site', layers: [{ layer: 'layer2', status: 'ok', ageSeconds: 60 }] },
    { siteId: SITE, layers: [{ layer: 'layer1', status: 'ok', ageSeconds: 120 }, ...(layer2 ? [layer2] : [])] },
  ],
});
const decide = (layer2, options) => decideScheduledRun(health(layer2), { siteId: SITE, ...options });
const minutes = (value) => ({ ageSeconds: value * 60 });

test('a daily that passed recently means the late scheduled run is waste', () => {
  const decision = decide({ layer: 'layer2', status: 'ok', ...minutes(240) });
  assert.equal(decision.run, false);
  assert.equal(decision.ageMinutes, 240);
  assert.match(decision.reason, /passed 240 min ago/);
  assert.equal(decide({ layer: 'layer2', status: 'ok', ...minutes(479) }).run, false, 'just inside the window');
});

test('a daily that failed must not suppress its own retry', () => {
  /* finalize writes the daily heartbeat before it decides to fail, so a failed
     daily leaves a fresh heartbeat with status error. Reading only the age is
     what kept Layer 2 red from 2026-09-14 to 09-20: the 02:10 dispatch failed,
     and the 06:35 scheduled run then skipped instead of retrying. */
  const decision = decide({ layer: 'layer2', status: 'error', ...minutes(240) });
  assert.equal(decision.run, true);
  assert.equal(decision.status, 'error');
  assert.match(decision.reason, /status is error/);
  // Anything that is not a clean pass runs.
  for (const status of ['error', 'failed', 'transient', '', null, undefined]) {
    assert.equal(decide({ layer: 'layer2', status, ...minutes(60) }).run, true, `status ${JSON.stringify(status)}`);
  }
});

test('a stale heartbeat runs whatever its status says', () => {
  assert.equal(decide({ layer: 'layer2', status: 'ok', ...minutes(DEFAULT_MAX_AGE_MINUTES) }).run, true, 'exactly at the limit is stale');
  assert.equal(decide({ layer: 'layer2', status: 'ok', ...minutes(700) }).run, true);
  assert.match(decide({ layer: 'layer2', status: 'ok', ...minutes(700) }).reason, /700 min old/);
  assert.equal(decide({ layer: 'layer2', status: 'ok', ...minutes(60) }, { maxAgeMinutes: 30 }).run, true, 'the limit is configurable');
});

test('anything unreadable runs: a wasted batch costs minutes, a suppressed retry costs a day', () => {
  assert.equal(decide(null).run, true, 'no layer2 row at all');
  assert.equal(decide({ layer: 'layer2', missing: true }).run, true);
  assert.equal(decide({ layer: 'layer2', status: 'ok', ageSeconds: 'not a number' }).run, true);
  assert.equal(decide({ layer: 'layer2', status: 'ok' }).run, true, 'no age field');
  assert.equal(decideScheduledRun(null, { siteId: SITE }).run, true, '/health could not be parsed');
  assert.equal(decideScheduledRun({}, { siteId: SITE }).run, true);
  assert.equal(decideScheduledRun({ sites: [] }, { siteId: SITE }).run, true);
  assert.equal(decideScheduledRun(health({ layer: 'layer2', status: 'ok', ...minutes(10) }), { siteId: 'unknown-site' }).run, true, 'another site cannot decide for this one');
});

test('the gate reads the right site and the right layer', () => {
  // A healthy layer1 must not be mistaken for a healthy layer2.
  assert.equal(decide(null).run, true);
  const decision = decide({ layer: 'layer2', status: 'ok', ...minutes(10) });
  assert.equal(decision.run, false);
  // Another site's fresh, passing layer2 is present in the fixture and ignored.
  assert.equal(decideScheduledRun(health(null), { siteId: SITE }).run, true);
});
