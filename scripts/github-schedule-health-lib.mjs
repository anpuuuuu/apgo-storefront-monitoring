const NEUTRAL_CONCLUSIONS = new Set(['cancelled', 'skipped']);

export function isWorkflowPaused(workflow, layer4Paused = 'false') {
  if (!['true', 'false', ''].includes(layer4Paused)) throw new Error('Invalid MONITOR_LAYER4_PAUSED');
  return workflow === 'monitor-alerts.yml' && layer4Paused === 'true';
}

/**
 * GitHub concurrency keeps at most one running and one pending run. A newer
 * push can therefore replace a pending scheduled run even when
 * cancel-in-progress is false. Such a cancellation is not a failed monitor.
 * We still fail if the newest meaningful scheduled result failed, or if the
 * last meaningful result becomes stale.
 */
export function selectMeaningfulScheduledRun(workflowRuns = []) {
  const completed = workflowRuns.filter((run) => run.status === 'completed');
  const ignored = completed.filter((run) => NEUTRAL_CONCLUSIONS.has(run.conclusion));
  const run = completed.find((candidate) => !NEUTRAL_CONCLUSIONS.has(candidate.conclusion));
  return { run, ignored };
}

export function selectWorkflowFreshnessRun(workflowRuns = [], eligibleEvents = ['schedule', 'workflow_dispatch']) {
  const eligible = workflowRuns.filter((run) => !run.event || eligibleEvents.includes(run.event));
  const active = eligible.find((run) => run.status !== 'completed') || null;
  return { ...selectMeaningfulScheduledRun(eligible), active };
}

