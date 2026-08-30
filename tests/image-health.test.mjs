import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { classifyVisibleImages } = require('../scripts/image-health.cjs');

test('an incomplete image remains diagnostic instead of becoming a broken-image failure', () => {
  assert.deepEqual(
    classifyVisibleImages([{ src: 'https://cdn.example/image.png', complete: false, width: 0 }]),
    { state: 'loading', detail: 'https://cdn.example/image.png' }
  );
});

test('a completed zero-width image is a confirmed failure', () => {
  assert.deepEqual(
    classifyVisibleImages([{ src: 'https://cdn.example/broken.png', complete: true, width: 0 }]),
    { state: 'failed', detail: 'broken:https://cdn.example/broken.png' }
  );
});

test('an explicit image network error is a confirmed failure', () => {
  const source = 'https://cdn.example/network.png';
  assert.deepEqual(
    classifyVisibleImages([{ src: source, complete: false, width: 0 }], new Map([[source, 'HTTP 503']])),
    { state: 'failed', detail: `network:${source}:HTTP 503` }
  );
});

test('loaded visible images pass', () => {
  assert.deepEqual(
    classifyVisibleImages([{ src: 'https://cdn.example/ok.png', complete: true, width: 800 }]),
    { state: 'loaded', detail: '' }
  );
});
