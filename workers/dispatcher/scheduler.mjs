/* Cloudflare Cron is the reliable scheduler; GitHub Actions is only the
   executor. GitHub delivered roughly one in five of the 30-minute Layer 4
   crons (median gap 158 minutes) and the daily crons four to six hours late,
   so the dispatcher now decides from the Worker /health heartbeats when a
   workflow_dispatch is due. GitHub's own schedule stays as redundancy; a
   duplicate sample is absorbed by the adjacency check in ga4-anomaly.

   Everything in this module is pure or dependency-injected so it can be unit
   tested without KV, fetch or GitHub. */

const NEUTRAL_CONCLUSIONS = new Set(['cancelled', 'skipped']);

export const SCHEDULER_DEFAULTS = {
  realtime: {
    workflow: 'monitor-alerts.yml',
    layer: 'layer4',
    minAgeMinutes: 28,
    lockKey: 'dispatch-lock:monitor-alerts:realtime',
    lockTtlSeconds: 15 * 60,
    recentRunMinutes: 15,
    failureBackoffMinutes: 60,
    inputs: { mode: 'realtime', simulate_zero: 'false', trigger: 'scheduler' },
  },
  daily: {
    workflow: 'monitor-alerts.yml',
    primaryAfterUtc: '04:25',
    confirmAfterUtc: '06:55',
    markerTtlSeconds: 36 * 60 * 60,
    recentRunMinutes: 15,
    failureBackoffMinutes: 60,
  },
  layer3: {
    enabled: true,
    workflow: 'monitor-self-health.yml',
    layer: 'layer3',
    minAgeMinutes: 90,
    lockKey: 'dispatch-lock:monitor-self-health:layer3',
    lockTtlSeconds: 30 * 60,
    recentRunMinutes: 30,
    failureBackoffMinutes: 60,
    inputs: { layer3_selftest: 'true', rollout_validation: 'false' },
  },
  tickTtlSeconds: 10 * 60,
  notifyThrottleKey: 'notify-throttle:scheduler',
  notifyThrottleSeconds: 60 * 60,
};

export function utcDateKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function utcClock(nowMs) {
  return new Date(nowMs).toISOString().slice(11, 16);
}

export function dailyMarkerKey(nowMs, stage) {
  return `daily:${utcDateKey(nowMs)}:${stage}`;
}

/* Age of a layer per site, from the /health body. A site the catalog says
   runs the layer but /health has never seen counts as infinitely stale. */
export function layerAges(health, sites, layer) {
  return sites
    .filter((site) => (site.enabledLayers || []).includes(layer))
    .map((site) => {
      const entry = (health?.sites || []).find((row) => row.siteId === site.id);
      const row = (entry?.layers || []).find((candidate) => candidate.layer === layer);
      const age = row && !row.missing && Number.isFinite(Number(row.ageSeconds)) ? Number(row.ageSeconds) : Number.POSITIVE_INFINITY;
      return { siteId: site.id, ageSeconds: age };
    });
}

/* A run created inside `recentMinutes` (queued, running or just finished)
   means the workflow is already covered. A failed run writes no heartbeat, so
   without the back-off a broken workflow would be re-dispatched every tick
   and page Telegram each time. */
export function runGate(workflowRuns, nowMs, { recentRunMinutes, failureBackoffMinutes }) {
  if (!Array.isArray(workflowRuns)) return null;
  const recent = workflowRuns.find((run) => nowMs - Date.parse(run.created_at) < recentRunMinutes * 60_000);
  if (recent) return `recent_run:${recent.status}`;
  const latest = workflowRuns.find((run) => run.status === 'completed' && !NEUTRAL_CONCLUSIONS.has(run.conclusion));
  if (latest && latest.conclusion !== 'success' && nowMs - Date.parse(latest.created_at) < failureBackoffMinutes * 60_000) {
    return 'recent_failure_backoff';
  }
  return null;
}

export function planDispatches({ health, now, locks = new Set(), markers = new Set(), runs = {}, config = SCHEDULER_DEFAULTS, sites = [] }) {
  const decisions = [];
  const skipped = [];
  if (!health || !Array.isArray(health.sites)) {
    return { decisions, skipped: [{ target: 'all', reason: 'health_unreadable' }] };
  }
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const clock = utcClock(nowMs);
  const claimed = new Set();

  const consider = (target, { workflow, inputs, lockKey, lockTtl, markerKey, markerTtl, gate }) => {
    if (claimed.has(workflow)) return skipped.push({ target, reason: 'workflow_claimed_this_tick' });
    if (lockKey && locks.has(lockKey)) return skipped.push({ target, reason: 'locked' });
    if (markerKey && markers.has(markerKey)) return skipped.push({ target, reason: 'already_dispatched_today' });
    const blocked = runGate(runs[workflow], nowMs, gate);
    if (blocked) return skipped.push({ target, reason: blocked });
    claimed.add(workflow);
    return decisions.push({ target, workflow, inputs, lockKey, lockTtl, markerKey, markerTtl, reason: target });
  };

  // Daily deadlines first: they happen once a day and a daily run refreshes
  // the same layer4 heartbeat the realtime rule reads.
  const daily = config.daily;
  const primaryKey = dailyMarkerKey(nowMs, 'primary');
  const confirmKey = dailyMarkerKey(nowMs, 'confirm');
  if (layerAges(health, sites, 'layer4').length) {
    if (clock >= daily.primaryAfterUtc) {
      consider('daily-primary', {
        workflow: daily.workflow,
        inputs: { mode: 'daily-primary', simulate_zero: 'false', trigger: 'scheduler' },
        markerKey: primaryKey,
        markerTtl: daily.markerTtlSeconds,
        gate: daily,
      });
    } else {
      skipped.push({ target: 'daily-primary', reason: 'before_deadline' });
    }
    if (clock >= daily.confirmAfterUtc) {
      if (!markers.has(primaryKey)) skipped.push({ target: 'daily-confirm', reason: 'primary_not_dispatched' });
      else consider('daily-confirm', {
        workflow: daily.workflow,
        inputs: { mode: 'daily-confirm', simulate_zero: 'false', trigger: 'scheduler' },
        markerKey: confirmKey,
        markerTtl: daily.markerTtlSeconds,
        gate: daily,
      });
    } else {
      skipped.push({ target: 'daily-confirm', reason: 'before_deadline' });
    }
  }

  for (const rule of [config.realtime, config.layer3]) {
    if (rule.enabled === false) continue;
    const ages = layerAges(health, sites, rule.layer);
    if (!ages.length) continue;
    const stale = ages.filter((entry) => entry.ageSeconds >= rule.minAgeMinutes * 60);
    if (!stale.length) {
      skipped.push({ target: rule.layer, reason: 'fresh', maxAgeSeconds: Math.max(...ages.map((entry) => entry.ageSeconds)) });
      continue;
    }
    consider(rule.layer, {
      workflow: rule.workflow,
      inputs: rule.inputs,
      lockKey: rule.lockKey,
      lockTtl: rule.lockTtlSeconds,
      gate: rule,
    });
  }

  return { decisions, skipped };
}

function candidateKeys(nowMs, config) {
  return [
    config.realtime.lockKey,
    config.layer3.lockKey,
    dailyMarkerKey(nowMs, 'primary'),
    dailyMarkerKey(nowMs, 'confirm'),
  ];
}

/* deps: { fetchHealth, listRuns, dispatch, kvGet, kvPut, notify, now, log, sites, config }
   Locks are written before the dispatch so a slow GitHub API cannot let the
   next tick double-dispatch; daily markers are written only after a 204. */
export async function runSchedulerTick(env, scheduledTime, deps) {
  const {
    fetchHealth, listRuns, dispatch, kvGet, kvPut, notify,
    now = () => Date.now(), log = (line) => console.log(line), sites = [], config = SCHEDULER_DEFAULTS,
  } = deps;
  const dryRun = env.SCHEDULER_DRY_RUN === 'true';
  const nowMs = now();
  const iso = new Date(nowMs).toISOString();
  const tickKey = `tick:${scheduledTime}`;
  if (await kvGet(tickKey)) {
    log(JSON.stringify({ event: 'scheduler_tick', scheduledTime, duplicate: true }));
    return { duplicate: true };
  }
  await kvPut(tickKey, iso, { expirationTtl: config.tickTtlSeconds });

  try {
    const health = await fetchHealth();
    const present = new Set();
    for (const key of candidateKeys(nowMs, config)) if (await kvGet(key)) present.add(key);
    const base = { health, now: nowMs, locks: present, markers: present, config, sites };

    // Most ticks find every heartbeat fresh; only touch GitHub when something is due.
    const preliminary = planDispatches({ ...base, runs: {} });
    const runs = {};
    for (const workflow of new Set(preliminary.decisions.map((decision) => decision.workflow))) {
      runs[workflow] = await listRuns(workflow);
    }
    const plan = preliminary.decisions.length ? planDispatches({ ...base, runs }) : preliminary;

    const dispatched = [];
    for (const decision of plan.decisions) {
      if (dryRun) { dispatched.push({ ...decision, dryRun: true }); continue; }
      if (decision.lockKey) await kvPut(decision.lockKey, iso, { expirationTtl: decision.lockTtl });
      await dispatch(decision.workflow, decision.inputs);
      if (decision.markerKey) await kvPut(decision.markerKey, iso, { expirationTtl: decision.markerTtl });
      dispatched.push(decision);
    }
    const summary = { event: 'scheduler_tick', scheduledTime, at: iso, dryRun, decisions: plan.decisions, skipped: plan.skipped, dispatched: dispatched.length };
    log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    if (!(await kvGet(config.notifyThrottleKey))) {
      await kvPut(config.notifyThrottleKey, String(error?.message || error).slice(0, 200), { expirationTtl: config.notifyThrottleSeconds });
      await notify(error);
    }
    log(JSON.stringify({ event: 'scheduler_tick_failed', scheduledTime, at: iso, error: String(error?.message || error).slice(0, 500) }));
    throw error;
  }
}
