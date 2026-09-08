import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHEDULER_DEFAULTS,
  dailyMarkerKey,
  layerAges,
  planDispatches,
  runGate,
  runSchedulerTick,
} from '../workers/dispatcher/scheduler.mjs';

const SITES = [{ id: 'apgo-my', label: 'APGO MY', enabledLayers: ['layer1', 'layer2', 'layer3', 'layer4'] }];
// Before the 04:25 UTC daily deadline so only the realtime rule is in play.
const NOON = Date.parse('2026-09-08T02:00:00Z');

function health({ layer4 = 60, layer3 = 60, missing = false } = {}) {
  return {
    ok: true,
    sites: [{
      siteId: 'apgo-my',
      layers: missing
        ? [{ layer: 'layer4', missing: true, stale: true }, { layer: 'layer3', missing: true, stale: true }]
        : [{ layer: 'layer4', ageSeconds: layer4 * 60 }, { layer: 'layer3', ageSeconds: layer3 * 60 }],
    }],
  };
}

function run(minutesAgo, { status = 'completed', conclusion = 'success' } = {}) {
  return { id: minutesAgo, status, conclusion, created_at: new Date(NOON - minutesAgo * 60_000).toISOString() };
}

test('layerAges treats a missing health row as infinitely stale', () => {
  assert.deepEqual(layerAges(health({ missing: true }), SITES, 'layer4'), [{ siteId: 'apgo-my', ageSeconds: Number.POSITIVE_INFINITY }]);
  assert.deepEqual(layerAges(health({ layer4: 10 }), SITES, 'layer4'), [{ siteId: 'apgo-my', ageSeconds: 600 }]);
  assert.deepEqual(layerAges(health(), [{ id: 'other', enabledLayers: ['layer1'] }], 'layer4'), []);
});

test('runGate blocks on recent runs and on a recent failure, but not on old or neutral runs', () => {
  const gate = SCHEDULER_DEFAULTS.realtime;
  assert.equal(runGate([run(5, { status: 'in_progress', conclusion: null })], NOON, gate), 'recent_run:in_progress');
  assert.equal(runGate([run(3)], NOON, gate), 'recent_run:completed');
  assert.equal(runGate([run(20, { conclusion: 'failure' })], NOON, gate), 'recent_failure_backoff');
  assert.equal(runGate([run(70, { conclusion: 'failure' })], NOON, gate), null);
  assert.equal(runGate([run(20, { conclusion: 'cancelled' }), run(40)], NOON, gate), null);
  assert.equal(runGate(undefined, NOON, gate), null);
});

test('stale layer4 heartbeat dispatches realtime once, fresh heartbeat does not', () => {
  const stale = planDispatches({ health: health({ layer4: 31 }), now: NOON, sites: SITES });
  assert.deepEqual(stale.decisions.map((d) => [d.workflow, d.inputs.mode, d.lockKey]), [['monitor-alerts.yml', 'realtime', 'dispatch-lock:monitor-alerts:realtime']]);
  const fresh = planDispatches({ health: health({ layer4: 10 }), now: NOON, sites: SITES });
  assert.equal(fresh.decisions.length, 0);
  assert.ok(fresh.skipped.some((entry) => entry.target === 'layer4' && entry.reason === 'fresh'));
});

test('lock, recent run and failure back-off each suppress the realtime dispatch', () => {
  const base = { health: health({ layer4: 45 }), now: NOON, sites: SITES };
  assert.equal(planDispatches({ ...base, locks: new Set(['dispatch-lock:monitor-alerts:realtime']) }).decisions.length, 0);
  assert.equal(planDispatches({ ...base, runs: { 'monitor-alerts.yml': [run(4, { status: 'queued', conclusion: null })] } }).decisions.length, 0);
  const backoff = planDispatches({ ...base, runs: { 'monitor-alerts.yml': [run(30, { conclusion: 'failure' })] } });
  assert.equal(backoff.decisions.length, 0);
  assert.ok(backoff.skipped.some((entry) => entry.reason === 'recent_failure_backoff'));
  assert.equal(planDispatches({ ...base, runs: { 'monitor-alerts.yml': [run(90, { conclusion: 'failure' })] } }).decisions.length, 1);
});

test('a 503 health body with heartbeats still schedules; an unreadable body schedules nothing', () => {
  const degraded = planDispatches({ health: { ok: false, ...health({ layer4: 40 }) }, now: NOON, sites: SITES });
  assert.equal(degraded.decisions.length, 1);
  assert.deepEqual(planDispatches({ health: null, now: NOON, sites: SITES }), { decisions: [], skipped: [{ target: 'all', reason: 'health_unreadable' }] });
  assert.equal(planDispatches({ health: { ok: true }, now: NOON, sites: SITES }).decisions.length, 0);
});

test('daily primary and confirm follow their UTC deadlines and markers', () => {
  const day = (clock) => Date.parse(`2026-09-08T${clock}:00Z`);
  const early = planDispatches({ health: health(), now: day('04:20'), sites: SITES });
  assert.ok(!early.decisions.some((d) => d.inputs.mode === 'daily-primary'));
  const due = planDispatches({ health: health(), now: day('04:25'), sites: SITES });
  const primary = due.decisions.find((d) => d.inputs.mode === 'daily-primary');
  assert.equal(primary.markerKey, 'daily:2026-09-08:primary');
  assert.equal(primary.inputs.trigger, 'scheduler');
  const marked = planDispatches({ health: health(), now: day('04:30'), sites: SITES, markers: new Set(['daily:2026-09-08:primary']) });
  assert.ok(!marked.decisions.some((d) => d.inputs.mode === 'daily-primary'));

  const confirmWithoutPrimary = planDispatches({ health: health(), now: day('07:00'), sites: SITES });
  assert.ok(!confirmWithoutPrimary.decisions.some((d) => d.inputs.mode === 'daily-confirm'));
  assert.ok(confirmWithoutPrimary.skipped.some((entry) => entry.reason === 'primary_not_dispatched'));
  const confirm = planDispatches({ health: health(), now: day('07:00'), sites: SITES, markers: new Set(['daily:2026-09-08:primary']) });
  assert.equal(confirm.decisions.find((d) => d.inputs.mode === 'daily-confirm').markerKey, dailyMarkerKey(day('07:00'), 'confirm'));
});

test('one workflow is claimed once per tick: daily wins over realtime, layer3 goes to self-health', () => {
  const plan = planDispatches({ health: health({ layer4: 60, layer3: 100 }), now: Date.parse('2026-09-08T04:30:00Z'), sites: SITES });
  assert.deepEqual(plan.decisions.map((d) => [d.workflow, d.target]), [
    ['monitor-alerts.yml', 'daily-primary'],
    ['monitor-self-health.yml', 'layer3'],
  ]);
  assert.ok(plan.skipped.some((entry) => entry.target === 'layer4' && entry.reason === 'workflow_claimed_this_tick'));
  assert.deepEqual(plan.decisions[1].inputs, { layer3_selftest: 'true', rollout_validation: 'false' });
});

function fakeDeps({ healthBody = health({ layer4: 45 }), runs = {}, dispatchFails = false } = {}) {
  const kv = new Map();
  const calls = { dispatch: [], listRuns: [], notify: [], log: [] };
  return {
    kv,
    calls,
    deps: {
      sites: SITES,
      now: () => NOON,
      log: (line) => calls.log.push(JSON.parse(line)),
      fetchHealth: async () => healthBody,
      listRuns: async (workflow) => { calls.listRuns.push(workflow); return runs[workflow] || []; },
      dispatch: async (workflow, inputs) => {
        if (dispatchFails) throw new Error('GitHub workflow dispatch HTTP 502');
        calls.dispatch.push({ workflow, inputs });
      },
      kvGet: async (key) => kv.get(key) ?? null,
      kvPut: async (key, value) => { kv.set(key, value); },
      notify: async (error) => calls.notify.push(String(error.message)),
    },
  };
}

test('tick writes the lock before dispatching and skips GitHub entirely when everything is fresh', async () => {
  const stale = fakeDeps();
  const result = await runSchedulerTick({ SCHEDULER_DRY_RUN: 'false' }, 1, stale.deps);
  assert.equal(result.dispatched, 1);
  assert.deepEqual(stale.calls.listRuns, ['monitor-alerts.yml']);
  assert.deepEqual(stale.calls.dispatch, [{ workflow: 'monitor-alerts.yml', inputs: SCHEDULER_DEFAULTS.realtime.inputs }]);
  assert.ok(stale.kv.has('dispatch-lock:monitor-alerts:realtime'));
  assert.ok(stale.kv.has('tick:1'));

  const fresh = fakeDeps({ healthBody: health({ layer4: 5 }) });
  await runSchedulerTick({ SCHEDULER_DRY_RUN: 'false' }, 2, fresh.deps);
  assert.deepEqual(fresh.calls.listRuns, []);
  assert.deepEqual(fresh.calls.dispatch, []);
});

test('dry run plans without dispatching or locking; duplicate scheduledTime is ignored', async () => {
  const dry = fakeDeps();
  const result = await runSchedulerTick({ SCHEDULER_DRY_RUN: 'true' }, 3, dry.deps);
  assert.equal(result.dryRun, true);
  assert.equal(result.decisions.length, 1);
  assert.deepEqual(dry.calls.dispatch, []);
  assert.ok(!dry.kv.has('dispatch-lock:monitor-alerts:realtime'));
  const again = await runSchedulerTick({ SCHEDULER_DRY_RUN: 'true' }, 3, dry.deps);
  assert.deepEqual(again, { duplicate: true });
});

test('daily marker is written only after a successful dispatch', async () => {
  const at = Date.parse('2026-09-08T04:30:00Z');
  const ok = fakeDeps({ healthBody: health({ layer4: 5 }) });
  ok.deps.now = () => at;
  await runSchedulerTick({ SCHEDULER_DRY_RUN: 'false' }, 4, ok.deps);
  assert.equal(ok.calls.dispatch[0].inputs.mode, 'daily-primary');
  assert.ok(ok.kv.has('daily:2026-09-08:primary'));

  const failing = fakeDeps({ healthBody: health({ layer4: 5 }), dispatchFails: true });
  failing.deps.now = () => at;
  await assert.rejects(runSchedulerTick({ SCHEDULER_DRY_RUN: 'false' }, 5, failing.deps), /HTTP 502/);
  assert.ok(!failing.kv.has('daily:2026-09-08:primary'));
  assert.deepEqual(failing.calls.notify, ['GitHub workflow dispatch HTTP 502']);
  await assert.rejects(runSchedulerTick({ SCHEDULER_DRY_RUN: 'false' }, 6, failing.deps), /HTTP 502/);
  assert.equal(failing.calls.notify.length, 1, 'second failure inside the throttle window does not page again');
});
