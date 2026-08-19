#!/usr/bin/env node
/* Sends a Telegram message summarizing failed checks from Playwright's JSON
   report (../results.json). Called by the site-health workflow on failure.
   Always exits 0 — a broken notification must not mask the original failure. */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RUN_URL = process.env.RUN_URL || '';
const SHORT_SHA = (process.env.GITHUB_SHA || '').slice(0, 7);

async function main() {
  if (!TOKEN || !CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping Telegram notification.');
    return;
  }

  const failed = [];
  let total = 0;
  try {
    const report = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'results.json'), 'utf8')
    );
    const walk = (suite, crumbs) => {
      for (const spec of suite.specs || []) {
        total += 1;
        if (spec.ok === false) {
          const title = [...crumbs, spec.title].join(' › ');
          /* First meaningful line of the final attempt's error, so the group
             can triage (e.g. "Received: 503") without opening the run. */
          let detail = '';
          try {
            const results = (spec.tests && spec.tests[0] && spec.tests[0].results) || [];
            const last = results[results.length - 1];
            const raw = ((last && last.error && last.error.message) || '').replace(
              /\[[0-9;]*m/g,
              ''
            );
            detail = raw.split('\n').find((l) => l.trim()) || '';
            if (detail.length > 110) detail = `${detail.slice(0, 110)}…`;
          } catch (_) {}
          failed.push(detail ? `${title}\n   ↳ ${detail}` : title);
        }
      }
      for (const child of suite.suites || []) walk(child, [...crumbs, child.title]);
    };
    for (const fileSuite of report.suites || []) walk(fileSuite, []);
  } catch (err) {
    failed.push(`(could not parse results.json: ${err.message})`);
  }

  const lines = [
    '🚨 APGO 网站健康检查失败',
    '',
    ...(failed.length ? failed.map((f) => `❌ ${f}`) : ['(未能定位具体失败项，请看 run 日志)']),
    '',
    total ? `共 ${total} 项检查，${failed.length} 项未通过` : '',
    '💡 若下一轮巡检自动恢复，多为平台短暂抖动，可不处理',
    SHORT_SHA ? `Commit: ${SHORT_SHA}` : '',
    RUN_URL ? `详情: ${RUN_URL}` : '',
  ].filter(Boolean);

  const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: lines.join('\n'),
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    console.error(`Telegram API error ${resp.status}: ${await resp.text()}`);
  } else {
    console.log('Telegram notification sent.');
  }
}

main().catch((err) => console.error('notify failed:', err));
