#!/usr/bin/env node
import { retiredLandingAlert } from './discover-ad-targets.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
let items = [];
try { items = JSON.parse(process.env.RETIRED_TRAFFIC_JSON || '[]'); } catch { items = []; }
if (!items.length) process.exit(0);
if (!token || !chatId) {
  console.log('Telegram is not configured; retired landing traffic notification skipped.');
  process.exit(0);
}

try {
  const alert = retiredLandingAlert(items, process.env.MONITOR_SITE_LABEL || 'APGO');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: alert.text, disable_web_page_preview: true, disable_notification: alert.silent }),
  });
  if (!response.ok) console.error(`Telegram retired landing notification failed: HTTP ${response.status}`);
  else console.log(JSON.stringify({ event: 'retired_landing_traffic_notified', count: items.length }));
} catch (error) {
  // Evidence delivery must not turn a healthy storefront batch red.
  console.error(`Retired landing notification failed: ${String(error?.message || error).slice(0, 200)}`);
}
