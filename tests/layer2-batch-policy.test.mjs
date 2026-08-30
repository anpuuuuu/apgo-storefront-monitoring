import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  journeyWritesCart,
  opensRateLimitCircuit,
  readJourneyResult,
  writeCircuitBreakerResult,
} from '../scripts/layer2-batch-policy.mjs';

test('only explicit full journeys are treated as cart writers', () => {
  assert.equal(journeyWritesCart({ mode: 'full' }), true);
  assert.equal(journeyWritesCart({ writesCart: true }), true);
  assert.equal(journeyWritesCart({ mode: 'read-only' }), false);
  assert.equal(journeyWritesCart({ mode: 'cart-smoke' }), false);
});

test('persistent rate limits open the batch circuit', () => {
  assert.equal(opensRateLimitCircuit({ finalStatus: 'failed', classification: 'MONITOR_RATE_LIMIT' }), true);
  assert.equal(opensRateLimitCircuit({ finalStatus: 'failed', classification: 'storefront_failure' }), false);
  assert.equal(opensRateLimitCircuit({ finalStatus: 'transient', classification: 'flaky' }), false);
});

test('circuit breaker writes a complete rate-limit result instead of a missing journey', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apgo-layer2-circuit-'));
  const result = writeCircuitBreakerResult(directory, {
    id: 'apgo-my-MY-iphone-ad', site: 'apgo-my', market: 'MY', device: 'iphone-webkit',
    journey: 'ad-demo', suite: 'full', landingPath: '/products/demo', channel: 'Paid Search',
  });
  assert.equal(result.classification, 'MONITOR_RATE_LIMIT');
  assert.equal(readJourneyResult(directory).id, 'apgo-my-MY-iphone-ad');
});
