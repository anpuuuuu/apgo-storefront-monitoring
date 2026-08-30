import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdDiscoveryError,
  buildAdTargets,
  fetchAdReport,
  normalizeLandingPath,
  rowsFromReport,
} from '../scripts/discover-ad-targets.mjs';
import { loadLayer2Config } from '../scripts/layer2-config.mjs';

const config = loadLayer2Config();

test('landing paths remove query strings, hashes and duplicate slashes', () => {
  assert.equal(normalizeLandingPath('/products/demo/?utm_source=meta#buy'), '/products/demo');
  assert.equal(normalizeLandingPath('https://apgo.my//pages/promo/?fbclid=1'), '/pages/promo');
  assert.equal(normalizeLandingPath('(not set)'), '');
});

test('GA4 rows are normalized into named values', () => {
  const rows = rowsFromReport({ rows: [{
    dimensionValues: [{ value: '/products/a' }, { value: 'Paid Social' }, { value: 'Malaysia' }],
    metricValues: [{ value: '4' }, { value: '2' }, { value: '1' }],
  }] });
  assert.deepEqual(rows[0], {
    landingPage: '/products/a', channel: 'Paid Social', country: 'Malaysia',
    sessions: 4, addToCarts: 2, checkouts: 1,
  });
});

test('paid targets merge UTM variants, reject organic and rank commerce activity first', () => {
  const targets = buildAdTargets([
    { landingPage: '/products/a?utm_source=meta', channel: 'Paid Social', country: 'Malaysia', sessions: 5, addToCarts: 1, checkouts: 0 },
    { landingPage: '/products/a?fbclid=x', channel: 'Paid Social', country: 'Malaysia', sessions: 3, addToCarts: 0, checkouts: 0 },
    { landingPage: '/pages/b', channel: 'Paid Search', country: 'Singapore', sessions: 2, addToCarts: 1, checkouts: 1 },
    { landingPage: '/products/organic', channel: 'Organic Search', country: 'Malaysia', sessions: 99, addToCarts: 9, checkouts: 2 },
  ], config);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].landingPath, '/pages/b');
  assert.equal(targets[0].market, 'SG');
  assert.equal(targets[1].landingPath, '/products/a');
  assert.equal(targets[1].sessions, 8);
});

test('target count obeys the configured maximum', () => {
  const copy = structuredClone(config);
  copy.monitoring.layer2.adDiscovery.maxLandingPages = 2;
  const rows = Array.from({ length: 5 }, (_, index) => ({
    landingPage: `/products/${index}`,
    channel: 'Paid Social',
    country: 'Malaysia',
    sessions: 10 - index,
    addToCarts: 0,
    checkouts: 0,
  }));
  assert.equal(buildAdTargets(rows, copy).length, 2);
});

test('target budget preserves the highest-ranked page from each market', () => {
  const copy = structuredClone(config);
  copy.monitoring.layer2.adDiscovery.maxLandingPages = 3;
  const rows = [
    ...Array.from({ length: 4 }, (_, index) => ({
      landingPage: `/products/my-${index}`,
      channel: 'Paid Search', country: 'Malaysia', sessions: 100 - index,
    })),
    { landingPage: '/products/sg-top', channel: 'Paid Search', country: 'Singapore', sessions: 1 },
  ];
  const targets = buildAdTargets(rows, copy);
  assert.equal(targets.length, 3);
  assert(targets.some((target) => target.market === 'SG' && target.landingPath === '/products/sg-top'));
});

test('the same landing page is tested once even when several paid channels use it', () => {
  const targets = buildAdTargets([
    { landingPage: '/products/a?utm_source=google', channel: 'Paid Search', country: 'Malaysia', sessions: 4 },
    { landingPage: '/products/a?utm_source=meta', channel: 'Paid Social', country: 'Malaysia', sessions: 6 },
  ], config);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sessions, 10);
  assert.equal(targets[0].channel, 'Paid Social');
});

test('no paid rows is a valid empty result', () => {
  assert.deepEqual(buildAdTargets([
    { landingPage: '/', channel: 'Direct', country: 'Malaysia', sessions: 10 },
  ], config), []);
});

test('GA4 authentication and API errors are explicit discovery failures', async () => {
  await assert.rejects(() => fetchAdReport({ propertyId: '1', accessToken: '' }), AdDiscoveryError);
  await assert.rejects(() => fetchAdReport({
    propertyId: '1',
    accessToken: 'token',
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
  }), /AD_DISCOVERY_FAILED.*403/);
});
