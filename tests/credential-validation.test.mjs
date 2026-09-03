import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCredentials } from '../scripts/validate-production-credentials.mjs';

const env = { MONITOR_SITE_ID: 'apgo-my', CF_ACCOUNT_ID: 'test', CF_API_TOKEN: 'fake-cf', TELEGRAM_BOT_TOKEN: 'fake-secret', TELEGRAM_CHAT_ID: '-123' };
const query = async (sql) => { assert.equal(sql, 'SELECT 1 AS ok'); return [{ ok: 1 }]; };
const log = () => {};
test('credential probe sends exactly two labelled tests to the verified group', async () => {
  const methods = [];
  await validateCredentials({ env, query, log, request: async (url, options) => {
    const method = url.split('/').pop(); methods.push(method);
    const body = JSON.parse(options.body);
    let result = { is_bot: true };
    if (method === 'getChat') result = { id: -123, type: 'group' };
    if (method === 'sendMessage') {
      assert.equal(body.chat_id, '-123');
      assert.match(body.text, /MIGRATION TEST/);
      result = { message_id: 1, chat: { id: -123 } };
    }
    return Response.json({ ok: true, result });
  } });
  assert.deepEqual(methods, ['getMe', 'getChat', 'sendMessage', 'sendMessage']);
});
test('D1 rejection stops before Telegram and strips unsafe error content', async () => {
  await assert.rejects(validateCredentials({ env, log, query: async () => { throw new Error('fake-secret'); }, request: () => { assert.fail(); } }), /^Error: Credential validation failed: D1 read probe$/);
});
test('Telegram network failure never includes a credential-bearing URL', async () => {
  await assert.rejects(validateCredentials({ env, log, query, request: async (url) => { throw new Error(url); } }), /^Error: Telegram getMe: request failed$/);
});
test('missing credentials fail rather than skip', async () => {
  await assert.rejects(validateCredentials({ env: {}, log, query }), /Missing MONITOR_SITE_ID/);
});
test('HTTP 403 fails without exposing Telegram response', async () => {
  await assert.rejects(validateCredentials({ env, log, query, request: async () => new Response('fake-secret', { status: 403 }) }), /Telegram getMe: HTTP 403/);
});
