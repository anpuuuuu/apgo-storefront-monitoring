#!/usr/bin/env node
/* APGO Layer 4: GA4 add_to_cart anomaly detection.
   Hourly: during hours whose 28-day median add-to-cart count is at least
   min_hour_median, query the GA4 Realtime API (last ~30 min); two
   consecutive zero samples trigger. mode "observe" only logs a would_alert
   row to alert_log; "armed" sends Telegram. Counter/baseline state lives in
   D1 (a stateless run can't count "consecutive") — if D1 is unreachable this
   layer SKIPS rather than alerting: a false "sales stopped" alarm is worse
   than a silent metrics gap, and downtime is already covered by layers 1/2.

   Auth is a short-lived OAuth access token minted by GitHub OIDC through
   Google Workload Identity Federation. No service-account JSON key is stored.
   One-off modes:
   - VALIDATE_GA4=true  → list realtime event names, verdict on add_to_cart
                          (the gating check: if absent, this design pivots)
   - SIMULATE_ZERO=true → treat realtime count as 0 to test the alert path */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../alerts-config.json', import.meta.url), 'utf8'));
const G = cfg.ga4;
const DB = cfg.cloudflare.database_id;
const ACC = process.env.CF_ACCOUNT_ID || '';
const CF_TOKEN = process.env.CF_API_TOKEN || '';
const ACCESS_TOKEN = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
const PROP = process.env.GA4_PROPERTY_ID || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const RUN_URL = process.env.RUN_URL || '';
const VALIDATE = process.env.VALIDATE_GA4 === 'true';
const SIMULATE_ZERO = process.env.SIMULATE_ZERO === 'true';

if (!ACCESS_TOKEN || !PROP) {
  console.log('::notice::Google OIDC access token/GA4_PROPERTY_ID 未设定,第 4 层跳过(设置步骤见 monitoring/docs/ga4-setup.md)');
  process.exit(0);
}

async function ga(method, body, token) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.error) throw new Error(`GA4 ${method} 失败: ${j.error.message || JSON.stringify(j.error)}`);
  return j;
}

async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const j = await res.json();
  if (!j.success) throw new Error('D1 query failed: ' + JSON.stringify(j.errors || j));
  return j.result?.[0]?.results ?? [];
}

async function getState(key) {
  const rows = await d1('SELECT value FROM state WHERE key = ?1', [key]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

async function setState(key, value) {
  await d1(
    "INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
    [key, JSON.stringify(value)]
  );
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

const ADD_TO_CART_FILTER = {
  filter: { fieldName: 'eventName', stringFilter: { value: 'add_to_cart' } },
};

async function realtimeAddToCart(token) {
  const r = await ga(
    'runRealtimeReport',
    {
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: ADD_TO_CART_FILTER,
      minuteRanges: [{ name: 'last30', startMinutesAgo: 29, endMinutesAgo: 0 }],
    },
    token
  );
  return Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0);
}

/* Per-hour median over the trailing baseline_days. Days without a row for a
   given hour count as 0 — missing data IS the signal we median over. */
async function computeBaseline(token) {
  const r = await ga(
    'runReport',
    {
      dateRanges: [{ startDate: `${G.baseline_days}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: 'date' }, { name: 'hour' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: ADD_TO_CART_FILTER,
      limit: 100000,
    },
    token
  );
  const byDateHour = new Map();
  const dates = new Set();
  for (const row of r.rows ?? []) {
    const date = row.dimensionValues[0].value;
    const hour = Number(row.dimensionValues[1].value);
    dates.add(date);
    byDateHour.set(`${date}|${hour}`, Number(row.metricValues[0].value));
  }
  /* Generate the full trailing date list so all-zero days still contribute. */
  const allDates = [];
  for (let i = 1; i <= G.baseline_days; i++) {
    const d = new Date(Date.now() - i * 86400e3);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: G.timezone }).format(d);
    allDates.push(parts.replaceAll('-', ''));
  }
  const medians = {};
  for (let h = 0; h < 24; h++) {
    const vals = allDates.map((d) => byDateHour.get(`${d}|${h}`) ?? 0).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    medians[h] = vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
  }
  return { medians, computed_at: Date.now(), row_count: r.rows?.length ?? 0 };
}

function currentHourInTz() {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: G.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date())
  );
}

async function main() {
  const token = ACCESS_TOKEN;

  if (VALIDATE) {
    const r = await ga(
      'runRealtimeReport',
      {
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        minuteRanges: [{ name: 'last30', startMinutesAgo: 29, endMinutesAgo: 0 }],
      },
      token
    );
    console.log('=== GA4 Realtime 事件(近30分钟) ===');
    let found = false;
    for (const row of r.rows ?? []) {
      const name = row.dimensionValues[0].value;
      const count = row.metricValues[0].value;
      console.log(`  ${name}: ${count}`);
      if (name === 'add_to_cart') found = true;
    }
    if (!r.rows?.length) console.log('  (无任何事件 — 请在网站有访客的繁忙时段重跑)');
    console.log(
      found
        ? '✅ add_to_cart 出现在 Realtime API 中,第 4 层设计可行'
        : '❌ add_to_cart 未出现在 Realtime API — 若当前确有访客在加购,则零值检测设计不可行,需换方案(见 plan)'
    );
    return;
  }

  /* State store is required beyond this point — skip (not alert) without it. */
  if (!ACC || !CF_TOKEN) {
    console.log('::notice::CF secrets 未设定,第 4 层需要状态存储,本轮跳过');
    return;
  }

  let baseline = await getState('ga4:baseline');
  if (!baseline || Date.now() - baseline.computed_at > 24 * 3600e3) {
    baseline = await computeBaseline(token);
    await setState('ga4:baseline', baseline);
    console.log('基线已刷新(28天各小时中位数): ' + JSON.stringify(baseline.medians));
  }

  const hour = currentHourInTz();
  const median = baseline.medians[hour] ?? 0;
  if (median < G.min_hour_median) {
    console.log(`当前 ${G.timezone} ${hour} 点,基线中位数 ${median} < ${G.min_hour_median},安静时段不检测`);
    return;
  }

  const count = SIMULATE_ZERO ? 0 : await realtimeAddToCart(token);
  const st = (await getState('ga4:apgo-my')) ?? { zeros: 0, last_alert_ms: 0 };
  console.log(`近30分钟 add_to_cart = ${count}(此时段中位数 ${median});此前连续零值 ${st.zeros} 次${SIMULATE_ZERO ? ' [模拟零值]' : ''}`);

  if (count > 0) {
    if (st.zeros !== 0) await setState('ga4:apgo-my', { ...st, zeros: 0 });
    return;
  }

  st.zeros += 1;
  if (st.zeros < G.consecutive_zeros) {
    await setState('ga4:apgo-my', st);
    console.log(`零值 ${st.zeros}/${G.consecutive_zeros},暂不触发`);
    return;
  }

  const detail = { hour, median, zeros: st.zeros, simulated: SIMULATE_ZERO, mode: G.mode };
  if (G.mode !== 'armed') {
    await d1("INSERT INTO alert_log (layer, kind, detail) VALUES ('ga4', 'would_alert', ?1)", [JSON.stringify(detail)]);
    await setState('ga4:apgo-my', st);
    console.log('::warning::[观察模式] 达到告警条件,已记录 would_alert(未发通知)。武装方式: alerts-config.json 的 ga4.mode 改为 "armed"');
    return;
  }

  if (st.last_alert_ms && Date.now() - st.last_alert_ms < G.realert_hours * 3600e3) {
    await setState('ga4:apgo-my', st);
    console.log('冷却期内,不重复告警');
    return;
  }

  await tgSend(`🟡 [第4层·业务指标] GA4 连续 ${st.zeros} 次检测到「加入购物车」为 0
时段: ${G.timezone} ${hour} 点前后(平时此时段中位数约 ${median} 次)${SIMULATE_ZERO ? '\n(这是一次 simulate_zero 测试)' : ''}
两种可能,都值得查:
① 网站加购流程坏了 → 对照最近的第1/2层巡检通知;若巡检正常,更可能是②
② GA4 数据采集断了 → 不影响下单,但广告投放数据正在缺失
${RUN_URL}`);
  await d1("INSERT INTO alert_log (layer, kind, detail) VALUES ('ga4', 'alert', ?1)", [JSON.stringify(detail)]);
  await setState('ga4:apgo-my', { ...st, last_alert_ms: Date.now() });
}

try {
  await main();
} catch (e) {
  console.log('::error::第 4 层任务出错(不影响其他监控): ' + e.message);
}
process.exit(0);
