import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBrowserDigest,
  corsHeaders,
  isCriticalCartError,
  isIgnoredBrowserNoise,
  originAllowed,
} from '../cloudflare/worker/errors.mjs';
import { cleanPath, cleanSource } from '../cloudflare/worker/security.mjs';

test('only APGO and Shopify storefront origins receive CORS access', () => {
  assert.equal(originAllowed('https://apgo.my'), true);
  assert.equal(originAllowed('https://www.apgo.my'), true);
  assert.equal(originAllowed('https://apgo-dev.myshopify.com'), true);
  assert.equal(originAllowed('https://attacker.example'), false);
  assert.equal(corsHeaders('https://apgo.my')['access-control-allow-origin'], 'https://apgo.my');
  assert.equal(corsHeaders('https://attacker.example')['access-control-allow-origin'], undefined);
});

test('critical cart alerts require a real HTTP 5xx response', () => {
  assert.equal(isCriticalCartError({ kind: 'cart', stage: 'response', status: 503 }), true);
  assert.equal(isCriticalCartError({ kind: 'cart', stage: 'network', status: 0 }), false);
  assert.equal(isCriticalCartError({ kind: 'cart', stage: 'response', status: 429 }), false);
  assert.equal(isCriticalCartError({ kind: 'error', stage: 'response', status: 503 }), false);
});

test('known browser and in-app autofill bridge errors are ignored', () => {
  assert.equal(isIgnoredBrowserNoise({ kind: 'error', message: "Can't find variable: _AutofillCallbackHandler" }), true);
  assert.equal(isIgnoredBrowserNoise({ kind: 'error', message: "undefined is not an object (evaluating 'window.webkit.messageHandlers')" }), true);
  assert.equal(isIgnoredBrowserNoise({ kind: 'error', message: 'Required ref productCardLink not found' }), false);
  assert.equal(isIgnoredBrowserNoise({ kind: 'cart', message: "Can't find variable: _AutofillCallbackHandler" }), false);
});

test('stored paths and sources discard query strings and redact gift card ids', () => {
  assert.equal(
    cleanSource('https://apgo.my/assets/app.js?v=secret&utm_source=meta'),
    'https://apgo.my/assets/app.js',
  );
  assert.equal(
    cleanPath('https://apgo.my/gift_cards/abcd-secret?utm_source=email'),
    '/gift_cards/[redacted]',
  );
});

test('browser digest combines signatures and reports omitted evidence', () => {
  const message = buildBrowserDigest([
    {
      signature: 'abc123',
      kind: 'error',
      stage: '',
      sessions: 4,
      occurrences: 7,
      message: 'Required ref not found',
      page_url: '/pages/golden-bull-award',
      source: 'https://apgo.my/assets/component.js',
    },
  ], 3);

  assert.match(message, /Browser Error Digest/);
  assert.match(message, /4 sessions · 7 events/);
  assert.match(message, /Required ref not found/);
  assert.match(message, /\+ 2 more signatures retained in D1/);
});
