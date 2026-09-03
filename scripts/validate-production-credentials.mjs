import { pathToFileURL } from 'node:url';
import { d1, site } from './monitor-lib.mjs';

// A manual rollout probe, not a website incident. Never log Telegram response bodies.
export async function validateCredentials({ env = process.env, request = fetch, query = d1, log = console.log } = {}) {
  for (const name of ['MONITOR_SITE_ID', 'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  try {
    const rows = await query('SELECT 1 AS ok');
    if (Number(rows[0]?.ok) !== 1) throw new Error('Invalid response');
  } catch { throw new Error('Credential validation failed: D1 read probe'); }
  log('D1 authenticated read probe passed. No production state changed.');

  async function api(method, body = {}) {
    let response;
    try {
      response = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error(`Telegram ${method}: request failed`); }
    if (!response.ok) throw new Error(`Telegram ${method}: HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    if (!data?.ok) throw new Error(`Telegram ${method}: invalid API result`);
    return data.result;
  }
  const bot = await api('getMe');
  if (!bot.is_bot) throw new Error('Telegram identity is not a bot');
  const chat = await api('getChat', { chat_id: env.TELEGRAM_CHAT_ID });
  if (String(chat.id) !== env.TELEGRAM_CHAT_ID || !['group', 'supergroup'].includes(chat.type)) {
    throw new Error('Telegram destination is not the configured monitoring group');
  }
  log('Telegram bot and configured group verified.');
  for (const phase of ['Failure notification delivery', 'Recovery notification delivery']) {
    const message = await api('sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `[${site.alertLabel || site.name}][MIGRATION TEST / 迁移测试]\n${phase}: test only.\n通知连接测试，不代表网站故障或正式监控恢复。\n${env.RUN_URL || ''}`,
      disable_web_page_preview: true,
    });
    if (!message.message_id || String(message.chat?.id) !== env.TELEGRAM_CHAT_ID) {
      throw new Error('Telegram did not confirm delivery to the configured group');
    }
    log(`${phase} confirmed by Telegram.`);
  }
  log('Credential validation complete; schedules, production heartbeat and Worker code unchanged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateCredentials().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
