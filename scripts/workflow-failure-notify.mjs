#!/usr/bin/env node
/* Generic workflow-failure notification. Unlike telegram-notify.js this does
   not depend on a Playwright results.json file, so it is safe for Worker,
   GA4 and self-health jobs. Notification failure never masks the job that
   already failed.

   By default the message is only sent on the second consecutive failure of
   the same workflow file (see workflow-failure-notify-lib.mjs); set
   MONITOR_NOTIFY_MIN_CONSECUTIVE=1 to send on every failure.

   A step that understands the failure better can prepare the message itself
   and point ALERT_FILE at it — Layer 2's aggregate does, because it knows
   which journey failed and whether the storefront or the monitor was at
   fault. Otherwise the message is the generic "this monitor keeps failing".

   Nothing is sent while GitHub Actions itself is having an incident: the
   Worker already reports a monitoring outage once, and a workflow failing
   inside one is the same event. */
import fs from 'node:fs';
import {
  activeActionsIncident,
  alertFromPrepared,
  fetchGithubIncidents,
  fetchWorkflowRuns,
  shouldNotifyFailure,
  workflowFailureAlert,
  workflowFileFromRef,
} from './workflow-failure-notify-lib.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
const runUrl = process.env.RUN_URL || '';
const workflow = process.env.GITHUB_WORKFLOW || '';
const job = process.env.GITHUB_JOB || '';
const commit = (process.env.GITHUB_SHA || '').slice(0, 7);
const site = process.env.MONITOR_SITE_LABEL || '';
const detail = String(process.env.ALERT_DETAIL || '').replace(/[\r\n\t]+/g, ' ').slice(0, 300);

if (!token || !chatId) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set - skipping Telegram notification.');
  process.exit(0);
}

const minConsecutive = Number(process.env.MONITOR_NOTIFY_MIN_CONSECUTIVE || 2);
const workflowFile = workflowFileFromRef(process.env.GITHUB_WORKFLOW_REF);
const runs = minConsecutive > 1
  ? await fetchWorkflowRuns({ repo: process.env.GITHUB_REPOSITORY, workflowFile, token: process.env.GITHUB_TOKEN })
  : null;
const decision = shouldNotifyFailure({ runs, currentRunId: process.env.GITHUB_RUN_ID, minConsecutive });
const incident = decision.notify ? activeActionsIncident(await fetchGithubIncidents()) : null;
console.log(JSON.stringify({
  event: 'workflow_failure_notify',
  workflow: workflowFile,
  minConsecutive,
  ...decision,
  githubIncident: incident ? { name: incident.name, created_at: incident.created_at, resolved_at: incident.resolved_at || null } : null,
}));

function preparedAlert() {
  const file = process.env.ALERT_FILE || '';
  if (!file || !fs.existsSync(file)) return null;
  try {
    return alertFromPrepared(JSON.parse(fs.readFileSync(file, 'utf8')), { site, runUrl });
  } catch {
    return null;
  }
}

// No process.exit() after the GitHub fetch: Node on Windows can abort while
// the socket is still closing. Fall through and let the process end.
if (decision.notify && !incident) try {
  const consecutive = decision.reason.startsWith('consecutive_failures:') ? Number(decision.reason.split(':')[1]) : null;
  const alert = preparedAlert() || workflowFailureAlert({ workflowFile, workflow, job, commit, detail, consecutive, site, runUrl });
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: alert.text.slice(0, 3900),
      disable_web_page_preview: true,
      disable_notification: alert.silent,
    }),
  });
  if (!response.ok) console.error(`Telegram API error ${response.status}: ${await response.text()}`);
  else console.log('Telegram workflow-failure notification sent.');
} catch (error) {
  console.error(`Workflow-failure notification failed: ${error?.message || error}`);
}
