import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePush, verifyWebhookSignature } from '../workers/dispatcher/index.mjs';

async function signature(body, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

test('dispatcher verifies the raw GitHub webhook body', async () => {
  const body = new TextEncoder().encode('{"ref":"refs/heads/main"}');
  assert.equal(await verifyWebhookSignature(body, await signature(body, 'secret'), 'secret'), true);
  assert.equal(await verifyWebhookSignature(body, await signature(body, 'wrong'), 'secret'), false);
});

test('dispatcher only accepts registered main pushes with a full SHA', () => {
  const payload = {
    ref: 'refs/heads/main', after: 'a'.repeat(40), deleted: false,
    repository: { id: 1154313539, full_name: 'anpuuuuu/apgo-theme' },
  };
  assert.equal(validatePush(payload, 'push').accepted, true);
  assert.equal(validatePush({ ...payload, ref: 'refs/heads/dev' }, 'push').accepted, false);
  assert.equal(validatePush({ ...payload, repository: { id: 1, full_name: 'evil/repo' } }, 'push').status, 403);
  assert.equal(validatePush({ ...payload, after: 'short' }, 'push').status, 400);
});
