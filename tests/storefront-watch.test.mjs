import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BROKEN,
  OK,
  UNMEASURED,
  judgeProbe,
  judgeRun,
  nextWatchState,
  pickHandles,
  recoveryMessage,
  watchMessage,
} from '../scripts/storefront-watch-lib.mjs';

const okProbe = (overrides = {}) => ({
  handle: 'apgo-laundry',
  add: { status: 200, ok: true, error: null },
  cart: { itemCount: 1 },
  ratesStatus: 200,
  rates: [{ name: 'Standard', price: 0, currency: 'MYR' }],
  ratesError: null,
  rateLimited: false,
  error: null,
  ...overrides,
});

test('a healthy probe passes', () => {
  assert.equal(judgeProbe(okProbe()).status, OK);
});

test('a successful quote with no shipping methods is a broken store', () => {
  /* The 2026-09-15 shape. Every request returned 200 and the cart was fine;
     there was simply nothing the shopper could pick, so they could not check
     out. This is the case the whole probe exists for. */
  const judgement = judgeProbe(okProbe({ rates: [] }));
  assert.equal(judgement.status, BROKEN);
  assert.match(judgement.reasons[0], /结不了账/);
});

test('throttling is never reported as a broken store', () => {
  // 2026-09-15: a throttled runner made 7 of 8 products look dead while the
  // same probe from a home IP passed.
  assert.equal(judgeProbe(okProbe({ rateLimited: true, rates: [], ratesStatus: 429 })).status, UNMEASURED);
  assert.equal(judgeProbe(okProbe({ error: 'fetch failed' })).status, UNMEASURED);
});

test('a shipping quote still being calculated is slow, not broken', () => {
  assert.equal(judgeProbe(okProbe({ ratesStatus: 202, rates: null })).status, UNMEASURED);
});

test('a failed add and an empty cart are both broken', () => {
  assert.equal(judgeProbe(okProbe({ add: { status: 422, ok: false, error: 'sold out' } })).status, BROKEN);
  assert.equal(judgeProbe(okProbe({ cart: { itemCount: 0 } })).status, BROKEN);
});

test('a non-200 rates response is broken, a missing one is not measured', () => {
  assert.equal(judgeProbe(okProbe({ ratesStatus: 500, rates: null, ratesError: 'server error' })).status, BROKEN);
  assert.equal(judgeProbe(okProbe({ ratesStatus: null, rates: null })).status, BROKEN);
  assert.equal(judgeProbe(null).status, UNMEASURED);
});

test('unmeasured products are set aside, not counted as healthy', () => {
  const only = judgeRun([{ status: UNMEASURED }, { status: UNMEASURED }]);
  assert.equal(only.status, UNMEASURED, 'a run that measured nothing is not a pass');

  const mixed = judgeRun([{ status: UNMEASURED }, { status: BROKEN }]);
  assert.equal(mixed.status, BROKEN, 'the only product we could measure was broken');

  assert.equal(judgeRun([{ status: OK }, { status: BROKEN }]).status, 'degraded');
  assert.equal(judgeRun([{ status: OK }, { status: OK }]).status, OK);
});

test('two consecutive failures confirm, one does not', () => {
  const settings = { consecutive_failures: 2, realert_hours: 2 };
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  const broken = { status: BROKEN, broken: 1, measured: 1 };

  const first = nextWatchState(null, broken, t0, settings);
  assert.equal(first.confirmed, false);
  assert.equal(first.shouldAlert, false);

  const second = nextWatchState(first.next, broken, t0 + 20 * 60_000, settings);
  assert.equal(second.confirmed, true);
  assert.equal(second.shouldAlert, true);
  assert.equal(second.next.alertCount, 1);
});

test('a run that measured nothing holds the streak instead of clearing it', () => {
  /* Otherwise a store that is broken AND throttling us would alternate
     broken / unmeasured forever and never reach two in a row. */
  const settings = { consecutive_failures: 2 };
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  const first = nextWatchState(null, { status: BROKEN }, t0, settings);
  const blind = nextWatchState(first.next, { status: UNMEASURED }, t0 + 20 * 60_000, settings);
  assert.equal(blind.next.consecutive, 1, 'held, not cleared');
  assert.equal(blind.shouldAlert, false, 'and not advanced either');
  const third = nextWatchState(blind.next, { status: BROKEN }, t0 + 40 * 60_000, settings);
  assert.equal(third.shouldAlert, true);
});

test('a healthy run clears the streak and recovers an open alert', () => {
  const settings = { consecutive_failures: 2 };
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  let state = nextWatchState(null, { status: BROKEN }, t0, settings);
  state = nextWatchState(state.next, { status: BROKEN }, t0 + 20 * 60_000, settings);
  assert.equal(state.next.active, true);

  const healed = nextWatchState(state.next, { status: OK, measured: 2 }, t0 + 40 * 60_000, settings);
  assert.equal(healed.next.consecutive, 0);
  assert.equal(healed.recovered, true);
  assert.equal(healed.next.active, false);
  assert.equal(healed.next.alertCount, 0);
});

test('degraded does not page unless asked to', () => {
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  const degraded = { status: 'degraded', broken: 1, measured: 2 };
  let quiet = nextWatchState(null, degraded, t0, { consecutive_failures: 2 });
  quiet = nextWatchState(quiet.next, degraded, t0 + 20 * 60_000, { consecutive_failures: 2 });
  assert.equal(quiet.shouldAlert, false, 'one product of two is the investigator\'s job, not a page');

  let loud = nextWatchState(null, degraded, t0, { consecutive_failures: 2, alert_on_degraded: true });
  loud = nextWatchState(loud.next, degraded, t0 + 20 * 60_000, { consecutive_failures: 2, alert_on_degraded: true });
  assert.equal(loud.shouldAlert, true);
});

test('a confirmed alert does not repeat until the realert window passes', () => {
  const settings = { consecutive_failures: 2, realert_hours: 2 };
  const t0 = Date.parse('2026-09-21T10:00:00Z');
  const broken = { status: BROKEN };
  let state = nextWatchState(null, broken, t0, settings);
  state = nextWatchState(state.next, broken, t0 + 20 * 60_000, settings);
  assert.equal(state.shouldAlert, true);

  const soon = nextWatchState(state.next, broken, t0 + 40 * 60_000, settings);
  assert.equal(soon.shouldAlert, false, 'still broken 20 minutes later is not news');

  const later = nextWatchState(state.next, broken, t0 + 3 * 3_600_000, settings);
  assert.equal(later.shouldAlert, true);
  assert.equal(later.next.alertCount, 2);
});

test('handles: the canary is always probed, the rest rotate', () => {
  const all = ['canary', 'a', 'b', 'c'];
  assert.deepEqual(pickHandles(all, { canaries: 1, rotating: 1, runIndex: 0 }), ['canary', 'a']);
  assert.deepEqual(pickHandles(all, { canaries: 1, rotating: 1, runIndex: 1 }), ['canary', 'b']);
  assert.deepEqual(pickHandles(all, { canaries: 1, rotating: 1, runIndex: 3 }), ['canary', 'a'], 'wraps around');
  // A break in the storefront shows on any product, so the canary must never
  // be rotated out; a break in one product is found by the rotation.
  for (let run = 0; run < 10; run += 1) {
    assert.equal(pickHandles(all, { canaries: 1, rotating: 1, runIndex: run })[0], 'canary');
  }
});

test('handles: duplicates, blanks and short lists do not break the pick', () => {
  assert.deepEqual(pickHandles(['a', 'a', '', null, 'b'], { canaries: 1, rotating: 1 }), ['a', 'b']);
  assert.deepEqual(pickHandles(['only'], { canaries: 1, rotating: 1 }), ['only']);
  assert.deepEqual(pickHandles([], { canaries: 1, rotating: 1 }), []);
  assert.deepEqual(pickHandles(['a', 'b', 'c'], { canaries: 2, rotating: 0 }), ['a', 'b']);
});

test('the alert says what a shopper would have hit, and names the product', () => {
  const results = [
    { handle: 'apgo-laundry', title: 'APGO Laundry Salt', probe: okProbe({ rates: [] }), judgement: judgeProbe(okProbe({ rates: [] })) },
    { handle: 'apgo-mold', title: 'APGO Mold Remover', probe: okProbe(), judgement: judgeProbe(okProbe()) },
  ];
  const text = watchMessage({
    results,
    verdict: { status: BROKEN },
    alertCount: 1,
    brokenSince: new Date(Date.parse('2026-09-21T10:00:00Z')).toISOString(),
    nowMs: Date.parse('2026-09-21T10:40:00Z'),
    siteLabel: 'APGO MY',
    runUrl: 'https://example.test/run',
  });
  assert.match(text, /APGO Laundry Salt/);
  assert.match(text, /结不了账/);
  assert.match(text, /已持续约 40 分钟/);
  // The message has to say the probe never checks out, because someone will
  // eventually ask whether the monitor is placing orders.
  assert.match(text, /不会打开结账页或付款/);
  assert.match(text, /example\.test\/run/);
});

test('recovery names how long it was broken', () => {
  const results = [{ handle: 'h', title: 'APGO Laundry Salt', probe: okProbe(), judgement: judgeProbe(okProbe()) }];
  const text = recoveryMessage({
    results,
    brokenSince: new Date(Date.parse('2026-09-21T10:00:00Z')).toISOString(),
    nowMs: Date.parse('2026-09-21T11:00:00Z'),
  });
  assert.match(text, /又能结账了/);
  assert.match(text, /60 分钟/);
});

test('the watch ships in observe and the probe address is the investigator one', async () => {
  const config = JSON.parse(await readFile(new URL('../config/alerts-config.json', import.meta.url), 'utf8'));
  const watch = config.storefront_watch;
  assert.equal(watch.mode, 'observe', 'arm it on evidence, not on the day it was written');
  assert.equal(watch.consecutive_failures, 2);
  // It shares the investigator's address rather than defining a second one:
  // two postcodes drifting apart would make the two probes disagree.
  assert.ok(config.investigator.address.zip, 'the watch reads investigator.address');
});

test('the site catalog lets the watch write a heartbeat', async () => {
  /* The heartbeat endpoint rejects any layer the site does not declare, so
     without this the watch runs, passes, and silently reports nothing --
     and the Dispatcher never schedules it. */
  const catalog = await readFile(new URL('../workers/site-catalog.generated.mjs', import.meta.url), 'utf8');
  assert.match(catalog, /"watch"/);
});
