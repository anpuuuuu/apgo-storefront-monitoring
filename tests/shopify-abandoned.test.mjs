import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABANDONED_COUNT_QUERY,
  abandonedSearchQuery,
  abandonedWindow,
  appendAbandonedSnapshot,
  fetchAbandonedCount,
  normalizeShopDomain,
  runAbandonedObservation,
} from '../workers/error-monitor/shopify-abandoned.mjs';

const NOW = Date.parse('2026-10-04T02:19:00Z'); // 10:19 MYT
const DAY = 86_400_000;

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    prepare() {
      return {
        bind(...params) {
          return {
            async first() { return rows.has(params[0]) ? { value: rows.get(params[0]) } : null; },
            async run() { rows.set(params[0], params[1]); },
          };
        },
      };
    },
  };
}

test('Shopify domain validation prevents arbitrary outbound hosts', () => {
  assert.equal(normalizeShopDomain('https://apgo-dev.myshopify.com/admin'), 'apgo-dev.myshopify.com');
  assert.throws(() => normalizeShopDomain('https://example.com'), /myshopify\.com/);
  assert.throws(() => normalizeShopDomain(''), /myshopify\.com/);
});

test('the abandoned cohort uses the same settled two-hour window as GA4', () => {
  const window = abandonedWindow(NOW, {
    timeZone: 'Asia/Kuala_Lumpur', checkMinutes: 30, settledLagMinutes: 120, windowMinutes: 120,
  });
  assert.equal(window.startStamp, '202610040630');
  assert.equal(window.endStamp, '202610040830');
  assert.equal(window.endMs - window.startMs, 120 * 60_000);
});

test('the search asks only for unrecovered checkouts created inside the cohort', () => {
  const text = abandonedSearchQuery(Date.parse('2026-10-03T22:30:00Z'), Date.parse('2026-10-04T00:30:00Z'));
  assert.match(text, /created_at:>='2026-10-03T22:30:00\.000Z'/);
  assert.match(text, /created_at:<'2026-10-04T00:30:00\.000Z'/);
  assert.match(text, /recovery_state:not_recovered/);
  assert.doesNotMatch(text, /customer|email|address|lineItems|recoveryUrl/i);
});

test('Admin GraphQL fetch sends the aggregate-only query and parses count precision', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return Response.json({ data: { abandonedCheckoutsCount: { count: 7, precision: 'EXACT' } } });
  };
  const result = await fetchAbandonedCount({
    shopDomain: 'apgo-dev.myshopify.com', accessToken: 'secret-token',
    startMs: Date.parse('2026-10-03T22:30:00Z'), endMs: Date.parse('2026-10-04T00:30:00Z'),
    apiVersion: '2026-10', fetchImpl,
  });
  assert.deepEqual(result, { count: 7, precision: 'EXACT' });
  assert.equal(request.url, 'https://apgo-dev.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(request.options.headers['x-shopify-access-token'], 'secret-token');
  assert.equal(request.body.query, ABANDONED_COUNT_QUERY);
  assert.deepEqual(Object.keys(request.body.variables), ['query']);
});

test('snapshot history replaces the same window and removes expired aggregate rows', () => {
  const first = {
    windowStart: new Date(NOW - 2 * 60 * 60_000).toISOString(),
    windowEnd: new Date(NOW).toISOString(), count: 2, precision: 'EXACT', checkedAt: new Date(NOW).toISOString(),
  };
  const stale = {
    windowStart: new Date(NOW - 40 * DAY).toISOString(),
    windowEnd: new Date(NOW - 40 * DAY + 2 * 60 * 60_000).toISOString(), count: 99, precision: 'EXACT', checkedAt: new Date(NOW - 40 * DAY).toISOString(),
  };
  const log = appendAbandonedSnapshot({ entries: [stale, first] }, { ...first, count: 3 }, NOW);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].count, 3);
});

test('missing optional credentials record not_configured without failing the cron', async () => {
  const DB = memoryDb();
  const site = {
    id: 'apgo-my',
    shopifyAdmin: { shopEnv: 'SHOP', tokenEnv: 'TOKEN', timeZone: 'Asia/Kuala_Lumpur', apiVersion: '2026-10' },
  };
  const result = await runAbandonedObservation({ DB }, site, NOW);
  assert.deepEqual(result, { ok: true, status: 'not_configured' });
  assert.equal(JSON.parse(DB.rows.get('apgo-my:shopify:abandoned:latest')).status, 'not_configured');
});
