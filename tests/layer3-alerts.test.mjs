import test from 'node:test';
import assert from 'node:assert/strict';

import {
  browserRealertMs,
  buildBrowserDigest,
  classifyBrowserSignal,
  classifyClientType,
  corsHeaders,
  isCriticalCartError,
  isIgnoredBrowserNoise,
  isIgnoredUserAgent,
  normalizeSignatureText,
  normalizedBrowserSignatureInput,
  originAllowed,
  shouldAlertDigestRow,
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
      category: 'theme',
      stage: '',
      sessions: 4,
      networks: 3,
      occurrences: 7,
      message: 'Required ref not found',
      page_url: '/pages/golden-bull-award',
      pages: '/pages/golden-bull-award,/cart',
      facebook_in_app_sessions: 2,
      instagram_in_app_sessions: 1,
      whatsapp_in_app_sessions: 1,
      android_webview_sessions: 1,
      ios_webview_sessions: 0,
      mobile_browser_sessions: 0,
      desktop_browser_sessions: 1,
      avg_duration_ms: 842,
      offline_events: 1,
      leaving_events: 2,
      visibility_states: 'visible,hidden',
      source: 'https://apgo.my/assets/component.js',
    },
  ], 3);

  assert.match(message, /Browser Error Digest/);
  assert.match(message, /THEME · 4 sessions · 3 networks · 7 events/);
  assert.match(message, /Required ref not found/);
  assert.match(message, /Pages \(2\): \/pages\/golden-bull-award \| \/cart/);
  assert.match(message, /Facebook in-app \(2\) · Instagram in-app \(1\) · WhatsApp in-app \(1\) · Android WebView \(1\) · Desktop browser \(1\)/);
  assert.match(message, /\+ 2 more signatures retained in D1/);
});

test('browser signals are classified and noisy platform errors need stronger evidence', () => {
  assert.equal(classifyBrowserSignal({ kind: 'cart' }), 'cart-network');
  assert.equal(classifyBrowserSignal({ kind: 'cart', stage: 'verified-success' }), 'cart-recovered');
  assert.equal(classifyBrowserSignal({ kind: 'resource', source: 'https://cdn.shopify.com/shopifycloud/shop-js/modules/loader.shop-login-button.js' }), 'shopify-platform');
  assert.equal(classifyBrowserSignal({ kind: 'resource', source: 'https://apgo.my/cdn/fonts/font.woff2' }), 'font-resource');
  assert.equal(classifyBrowserSignal({ kind: 'error', message: 'Required ref productCardLink not found' }), 'theme');

  assert.equal(shouldAlertDigestRow({ category: 'shopify-platform', occurrences: 14, sessions: 14, networks: 8 }), false);
  assert.equal(shouldAlertDigestRow({ category: 'shopify-platform', occurrences: 15, sessions: 15, networks: 5 }), true);
  assert.equal(shouldAlertDigestRow({ category: 'cart-network', occurrences: 3, sessions: 3, networks: 1 }), false);
  assert.equal(shouldAlertDigestRow({ category: 'cart-network', occurrences: 3, sessions: 3, networks: 2 }), true);
  assert.equal(shouldAlertDigestRow({ category: 'cart-recovered', occurrences: 100, sessions: 100, networks: 50 }), false);
  assert.equal(shouldAlertDigestRow({ category: 'theme', occurrences: 3, sessions: 3, networks: 2 }), true);
  assert.equal(browserRealertMs({ category: 'shopify-platform' }), 6 * 60 * 60_000);
});

test('equivalent uncaught platform errors share stable signature input', () => {
  const common = {
    kind: 'error',
    source: 'https://cdn.shopify.com/shopifycloud/shop-js/modules/loader.init-shop-cart-sync.js',
    line: 1,
    action: '',
    stage: '',
  };
  assert.equal(
    normalizedBrowserSignatureInput({ ...common, message: 'Uncaught SyntaxError: Unexpected private name #moveItemsToDefaultSlot' }),
    normalizedBrowserSignatureInput({ ...common, message: 'SyntaxError: Unexpected private name #moveItemsToDefaultSlot' }),
  );
});

test('embedded URLs, hashes and long ids collapse into one signature per error family', () => {
  assert.equal(normalizeSignatureText('Unable to fetch https://apgo.my/cdn/shop/t/141/assets/apgo-pdp.js?v=12345'), 'Unable to fetch <url>');
  assert.equal(normalizeSignatureText('chunk 3f64194b86975454 failed after 128793 ms'), 'chunk <hex> failed after <n> ms');
  const common = { kind: 'error', source: 'https://apgo.my/products/atomic-coating', line: 12, action: '', stage: '' };
  assert.equal(
    normalizedBrowserSignatureInput({ ...common, message: 'Uncaught TypeError: Unable to fetch https://apgo.my/cdn/shop/t/141/assets/a.js?v=111' }),
    normalizedBrowserSignatureInput({ ...common, message: 'TypeError: Unable to fetch https://apgo.my/cdn/shop/t/141/assets/a.js?v=999' }),
  );
  assert.notEqual(
    normalizedBrowserSignatureInput({ ...common, message: 'TypeError: Unable to fetch https://apgo.my/x' }),
    normalizedBrowserSignatureInput({ ...common, message: 'TypeError: window.foo is not a function' }),
  );
});

test('social crawlers are ignored without excluding real Facebook in-app shoppers', () => {
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (compatible; meta-externalads/1.1; +https://developers.facebook.com/docs/sharing/webmasters/crawler)'), true);
  assert.equal(isIgnoredUserAgent('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), true);
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (compatible; Facebot/1.0)'), true);
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (Linux; Android 16) [FB_IAB/FB4A;FBAV/526.0.0.0.0;]'), false);
  assert.equal(isIgnoredUserAgent('Mozilla/5.0 (Linux; Android 15; Device Build/AP3A; wv) Version/4.0 Chrome/138 Mobile Safari/537.36'), false);
});

test('social apps and generic WebViews are classified separately', () => {
  assert.equal(classifyClientType('Mozilla/5.0 [FB_IAB/FB4A;FBAV/575.1.0.55.73;]'), 'facebook');
  assert.equal(classifyClientType('Mozilla/5.0 iPhone Instagram 444.0.0.31.65 Mobile Safari/604.1'), 'instagram');
  assert.equal(classifyClientType('Mozilla/5.0 Android Mobile Safari/537.36 WA4A/2.26.32.83'), 'whatsapp');
  assert.equal(classifyClientType('Mozilla/5.0 (Linux; Android 15; wv) Version/4.0 Chrome/138 Mobile Safari/537.36'), 'android-webview');
  assert.equal(classifyClientType('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/22F76'), 'ios-webview');
  assert.equal(classifyClientType('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36'), 'desktop-browser');
});
