/* Decides whether a failed workflow run deserves a Telegram message.

   A single failed run is usually transient (2026-09-14 01:45 UTC: one
   ECONNRESET fetching the Worker; the Dispatcher re-ran the workflow inside
   its 60-minute back-off and it passed). The message only helps when the
   failure repeats, so by default the notification waits for the second
   consecutive failure of the same workflow file. Layer 2 runs once a day and
   opts out (`MONITOR_NOTIFY_MIN_CONSECUTIVE=1`): its second failure would be
   tomorrow.

   Pure functions here; the GitHub call is injected so it can be tested. */

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
