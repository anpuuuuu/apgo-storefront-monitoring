/* Decides whether a failed workflow run deserves a Telegram message.

   A single failed run is usually transient (2026-09-14 01:45 UTC: one
   ECONNRESET fetching the Worker; the Dispatcher re-ran the workflow inside
   its 60-minute back-off and it passed). The message only helps when the
   failure repeats, so by default the notification waits for the second
   consecutive failure of the same workflow file. Layer 2 runs once a day and
   opts out (`MONITOR_NOTIFY_MIN_CONSECUTIVE=1`): its second failure would be
   tomorrow.

   Pure functions here; the GitHub call is injected so it can be tested. */

import { buildAlert } from '../workers/alert-format.mjs';

const NEUTRAL_CONCLUSIONS = new Set(['cancelled', 'skipped']);

/* "owner/repo/.github/workflows/monitor-alerts.yml@refs/heads/main" → "monitor-alerts.yml" */
export function workflowFileFromRef(ref) {
  const match = String(ref || '').match(/\.github\/workflows\/([^@/]+?)(?:@|$)/);
  return match ? match[1] : '';
}

/* Walks the workflow's completed runs (newest first), skipping the current
   run and cancelled/skipped ones. Returns the conclusion of the run right
   before this one and how many consecutive non-success runs precede it. */
export function runHistory(runs, currentRunId) {
  if (!Array.isArray(runs)) return null;
  let previous = null;
  let failures = 0;
  for (const run of runs) {
    if (String(run.id) === String(currentRunId)) continue;
    if (run.status !== 'completed' || NEUTRAL_CONCLUSIONS.has(run.conclusion)) continue;
    if (previous === null) previous = run.conclusion;
    if (run.conclusion === 'success') break;
    failures += 1;
  }
  return { previous, failures };
}

export function shouldNotifyFailure({ runs, currentRunId, minConsecutive = 2 }) {
  const required = Math.max(1, Number(minConsecutive) || 1);
  if (required === 1) return { notify: true, reason: 'every_failure' };
  const history = runHistory(runs, currentRunId);
  // Unreadable history must not hide a real outage: send rather than skip.
  if (!history) return { notify: true, reason: 'run_history_unavailable' };
  if (history.previous === null) return { notify: true, reason: 'no_previous_run' };
  const consecutive = history.failures + 1;
  if (consecutive >= required) return { notify: true, reason: `consecutive_failures:${consecutive}` };
  return { notify: false, reason: 'first_failure_after_success' };
}

export async function fetchWorkflowRuns({ repo, workflowFile, token, fetchImpl = globalThis.fetch }) {
  if (!repo || !workflowFile || !token || typeof fetchImpl !== 'function') return null;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=completed&per_page=10`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'apgo-storefront-monitoring',
      },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return Array.isArray(body?.workflow_runs) ? body.workflow_runs : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- *
   What the owner reads when a monitoring workflow fails.
 * ---------------------------------------------------------------------- */

/* The workflows, named the way the owner would. A failing workflow is the
   monitor's own problem, so none of these is ever red. */
export const WORKFLOW_NAMES = {
  'monitor-alerts.yml': '业务指标',
  'monitor-self-health.yml': '监控自检',
  'site-health-v2.yml': '购物流程测试',
  'site-health.yml': '旧版网站检查',
  'deploy-worker.yml': '监控部署',
  'storefront-watch.yml': '结账探测',
};

export function workflowFailureAlert({ workflowFile = '', workflow = '', job = '', commit = '', detail = '', consecutive = null, site = '', runUrl = '', nowMs = Date.now() }) {
  const name = WORKFLOW_NAMES[workflowFile] || workflow || '某个监控程序';
  const deploy = workflowFile === 'deploy-worker.yml';
  return buildAlert({
    level: 'watch',
    title: deploy ? '监控程序部署失败' : `「${name}」监控连续出错`,
    site,
    store: '店铺不受影响',
    lines: [
      deploy
        ? '刚才更新监控程序没有成功，线上还是旧版本在跑。'
        : `这个监控程序${consecutive ? `连续 ${consecutive} 次` : ''}运行失败，这段时间它看不到店铺的这部分情况。网站和购物车仍有第 1 层看着。`,
    ],
    atMs: nowMs,
    details: [
      [workflow, job].filter(Boolean).join(' / '),
      commit ? `commit ${commit}` : '',
      detail,
    ],
    link: runUrl,
  });
}

/* A message prepared by the step that understands the failure — Layer 2's
   aggregate knows which journey failed and why, the generic notifier does
   not. Anything malformed falls back to the generic message rather than
   sending nothing. */
export function alertFromPrepared(prepared, { site = '', runUrl = '', nowMs = Date.now() } = {}) {
  if (!prepared || typeof prepared !== 'object' || !prepared.title || !prepared.level) return null;
  try {
    return buildAlert({
      level: prepared.level,
      title: prepared.title,
      site: prepared.site || site,
      store: prepared.store,
      action: prepared.action,
      lines: Array.isArray(prepared.lines) ? prepared.lines : [],
      atMs: nowMs,
      details: Array.isArray(prepared.details) ? prepared.details : [],
      link: runUrl,
    });
  } catch {
    return null;
  }
}

/* Is GitHub Actions itself having an incident, or did one end within the
   grace period?

   2026-10-06: Actions could not assign runners from 03:11 to 06:49 MYT. The
   Worker already reports "monitoring paused" once for an outage like that,
   so a workflow that fails during one is the same event and must not add a
   message of its own. That night the notifier sent "Layer 4 GA4 monitor
   failed, consecutive failures: 3" — GA4 had never run, and the count
   included runs that never got a machine. */
export function activeActionsIncident(incidents, nowMs = Date.now(), { graceMinutes = 30 } = {}) {
  for (const incident of Array.isArray(incidents) ? incidents : []) {
    const components = (incident.components || []).map((component) => String(component.name || ''));
    const named = `${incident.name || ''} ${components.join(' ')}`;
    if (!/actions/i.test(named)) continue;
    const startedMs = Date.parse(incident.created_at || '');
    if (!Number.isFinite(startedMs) || startedMs > nowMs) continue;
    const resolvedMs = Date.parse(incident.resolved_at || '');
    if (!Number.isFinite(resolvedMs) || nowMs - resolvedMs <= graceMinutes * 60_000) return incident;
  }
  return null;
}

/* GitHub's own status page. Unreachable or malformed means "no known
   incident", so the notifier falls back to speaking rather than staying
   quiet about a failure it could not explain. */
export async function fetchGithubIncidents({ fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://www.githubstatus.com/api/v2/incidents.json', { signal: controller.signal });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body?.incidents) ? body.incidents : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
