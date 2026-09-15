/* silent: deliver to the group without a notification. Monitoring-health and
   informational messages stay on the record but must not ring the phone;
   only things that need a person now do (down, critical cart error, stale
   heartbeat, Layer 4 business rules, order heartbeat). */
export async function sendTelegram(env, text, { silent = false } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error('Telegram Worker secrets are not configured');
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: String(text).slice(0, 3900),
      disable_web_page_preview: true,
      disable_notification: Boolean(silent),
    }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}
