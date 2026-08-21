import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBrowserDigest,
  corsHeaders,
  isCriticalCartError,
  isIgnoredBrowserNoise,
  isIgnoredUserAgent,
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
      networks: 3,
      occurrences: 7,
      message: 'Required ref not found',
      page_url: '/pages/golden-bull-award',
      pages: '/pages/golden-bull-award,/cart',
      facebook_in_app_sessions: 2,
      android_webview_sessions: 1,
      mobile_browser_sessions: 0,
      desktop_browser_sessions: 1,
      source: 'https://apgo.my/assets/component.js',
    },
  ], 3);

  assert.match(message, /Browser Error Digest/);
  assert.match(message, /4 sessions · 3 networks · 7 events/);
  assert.match(message, /Required ref not found/);
  assert.match(message, /Pages \(2\): \/pages\/golden-bull-award \| \/cart/);
  assert.match(message, /Facebook in-app \(2\) · Android WebView \(1\) · Desktop browser \(1\)/);
  assert.match(message, /\+ 2 more signatures retained in D1/);
});

test('social crawlers are ignored without excluding real Facebook in-app shoppers', () => {
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (compatible; meta-externalads/1.1; +https://developers.facebook.com/docs/sharing/webmasters/crawler)'), true);
  assert.equal(isIgnoredUserAgent('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), true);
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (compatible; Facebot/1.0)'), true);
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (Linux; Android 16) [FB_IAB/FB4A;FBAV/526.0.0.0.0;]'), false);
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (Linux; Android 15; Device Build/AP3A; wv) Version/4.0 Chrome/138 Mobile Safari/537.36'), false);
});
