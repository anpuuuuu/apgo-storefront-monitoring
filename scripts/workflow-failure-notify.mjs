#!/usr/bin/env node
/* Generic workflow-failure notification. Unlike telegram-notify.js this does
   not depend on a Playwright results.json file, so it is safe for Worker,
   GA4 and self-health jobs. Notification failure never masks the job that
   already failed. */
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
const title = process.env.ALERT_TITLE || 'APGO monitoring workflow failed';
const runUrl = process.env.RUN_URL || '';
const workflow = process.env.GITHUB_WORKFLOW || '';
const job = process.env.GITHUB_JOB || '';
const commit = (process.env.GITHUB_SHA || '').slice(0, 7);
const detail = String(process.env.ALERT_DETAIL || '').replace(/[\r\n\t]+/g, ' ').slice(0, 300);

if (!token || !chatId) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set - skipping Telegram notification.');
  process.exit(0);
}

try {
  const lines = [
    `🚨 ${title}`,
    workflow ? `Workflow: ${workflow}` : '',
    job ? `Job: ${job}` : '',
    commit ? `Commit: ${commit}` : '',
    detail ? `Detail: ${detail}` : '',
    runUrl ? `Details: ${runUrl}` : '',
  ].filter(Boolean);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join('\n'),
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) console.error(`Telegram API error ${response.status}: ${await response.text()}`);
  else console.log('Telegram workflow-failure notification sent.');
} catch (error) {
  console.error(`Workflow-failure notification failed: ${error?.message || error}`);
}
