#!/usr/bin/env node
/* APGO Layer 3: hourly JS-error digest. Reads the last window_minutes of
   js_errors from D1, groups by signature, counts DISTINCT sessions, and
   alerts Telegram when a signature crosses the threshold or appears for the
   first time. known_signatures.muted silences a noisy signature; a per-
   signature cooldown stops hourly repeats. Also runs retention deletes.
   Zero npm dependencies. Always exits 0 — a broken alerter must never mask
   other monitoring jobs. */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../alerts-config.json', import.meta.url), 'utf8'));
const C = cfg.js_errors;
const DB = cfg.cloudflare.database_id;
const ACC = process.env.CF_ACCOUNT_ID || '';
const TOKEN = process.env.CF_API_TOKEN || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const RUN_URL = process.env.RUN_URL || '';
const MIN_SESSIONS = Number(process.env.MIN_SESSIONS_OVERRIDE) > 0
  ? Number(process.env.MIN_SESSIONS_OVERRIDE)
  : C.min_sessions;

if (!ACC || !TOKEN || !DB) {
  console.log('::notice::CF_API_TOKEN/CF_ACCOUNT_ID 未设定,第 3 层告警任务跳过');
  process.exit(0);
}

async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const j = await res.json();
  if (!j.success) throw new Error('D1 query failed: ' + JSON.stringify(j.errors || j));
  return j.result?.[0]?.results ?? [];
}

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('::warning::TELEGRAM secrets 未设定,以下通知未发出:\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  if (!res.ok) console.log('::warning::Telegram 发送失败 HTTP ' + res.status);
}

async function main() {
  const groups = await d1(
    `SELECT signature,
            COUNT(*) AS n,
            COUNT(DISTINCT session_id) AS sessions,
            MIN(message) AS sample_message,
            MIN(source) AS sample_source,
            MIN(page_url) AS sample_url
     FROM js_errors
     WHERE created_at > datetime('now', ?1)
     GROUP BY signature
     ORDER BY sessions DESC, n DESC`,
    [`-${C.window_minutes} minutes`]
  );

  const known = new Map((await d1('SELECT * FROM known_signatures')).map((r) => [r.signature, r]));
  const cooldownRows = await d1("SELECT key, value FROM state WHERE key LIKE 'js_alert:%'");
  const cooldown = new Map(cooldownRows.map((r) => {
    try { return [r.key.slice('js_alert:'.length), JSON.parse(r.value)]; } catch { return [r.key, {}]; }
  }));

  const nowMs = Date.now();
  const alerts = [];
  for (const g of groups) {
    const k = known.get(g.signature);
    if (k && k.muted) continue;
    const isNew = !k;
    if (!(g.sessions >= MIN_SESSIONS || (isNew && g.n >= C.new_signature_min))) continue;
    const cd = cooldown.get(g.signature);
    if (cd?.last_alert_ms && nowMs - cd.last_alert_ms < C.realert_hours * 3600e3) continue;
    alerts.push({ ...g, isNew });
  }

  /* Register every signature seen this window, alerting or not, so "first
     time" can only ever fire once per signature. */
  for (const g of groups) {
    if (!known.has(g.signature)) {
      await d1('INSERT OR IGNORE INTO known_signatures (signature, sample_message) VALUES (?1, ?2)', [
        g.signature,
        g.sample_message,
      ]);
    }
  }

  if (alerts.length) {
    const lines = [`🟠 [第3层·前端报错] apgo.my 过去 ${C.window_minutes} 分钟出现异常 JS 错误:`];
    for (const a of alerts.slice(0, 5)) {
      lines.push('');
      lines.push(`▪️ ${a.isNew ? '(首次出现) ' : ''}${a.sessions} 个访客受影响,共 ${a.n} 次`);
      lines.push(`错误: ${String(a.sample_message).slice(0, 150)}`);
      if (a.sample_source) lines.push(`文件: ${String(a.sample_source).replace(/^https?:\/\//, '').slice(0, 120)}`);
      if (a.sample_url) lines.push(`页面: ${a.sample_url}`);
      lines.push(`签名: ${a.signature}`);
    }
    if (alerts.length > 5) lines.push(`\n…另有 ${alerts.length - 5} 组超过门槛,详见数据库`);
    lines.push('\n说明: 网站前端代码在真实访客的浏览器里报错,可能影响下单。把本条转发给 Claude 可判断严重性或静音误报。');
    if (RUN_URL) lines.push(RUN_URL);
    await tgSend(lines.join('\n'));

    for (const a of alerts) {
      await d1(
        "INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
        ['js_alert:' + a.signature, JSON.stringify({ last_alert_ms: nowMs })]
      );
      await d1("UPDATE known_signatures SET last_alerted_at = datetime('now') WHERE signature = ?1", [a.signature]);
      await d1("INSERT INTO alert_log (layer, kind, detail) VALUES ('js_errors', 'alert', ?1)", [
        JSON.stringify({ signature: a.signature, sessions: a.sessions, n: a.n, message: String(a.sample_message).slice(0, 200) }),
      ]);
    }
    console.log(`已告警 ${alerts.length} 组错误`);
  } else {
    console.log(`检查完成: ${groups.length} 组错误,均未达告警门槛`);
  }

  await d1("DELETE FROM js_errors WHERE created_at < datetime('now', ?1)", [`-${C.retention_days} days`]);
  await d1("DELETE FROM alert_log WHERE created_at < datetime('now', '-90 days')");
}

try {
  await main();
} catch (e) {
  console.log('::error::第 3 层告警任务出错(不影响其他监控): ' + e.message);
}
process.exit(0);
