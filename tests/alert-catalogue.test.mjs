import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlert, duration, localTime, plain } from '../workers/alert-format.mjs';
import {
  blindAlert,
  layer1DownAlert,
  layer1RecoveryAlert,
  layer1SlowAlert,
  nextBlindState,
} from '../workers/error-monitor/uptime.mjs';
import { browserDigestAlert, criticalCartAlert } from '../workers/error-monitor/errors.mjs';
import { orderGapAlert, orderPushAlert, orderRecoveryAlert } from '../workers/error-monitor/orders.mjs';
import { postDeployFailureAlert, tickFailureAlert } from '../workers/dispatcher/index.mjs';
import { RULE_COPY, businessAlert, businessRecoveryAlert, emptyWindowAlert, settledWindow } from '../scripts/ga4-anomaly-lib.mjs';
import { dailyFunnelAlert, dailyQualityAlert } from '../scripts/ga4-daily-alert-lib.mjs';
import { investigationAlert } from '../scripts/checkout-probe-lib.mjs';
import { watchAlert, watchRecoveryAlert } from '../scripts/storefront-watch-lib.mjs';
import { eveningSummaryAlert } from '../scripts/evening-summary-lib.mjs';
import { layer2Alert } from '../scripts/layer2-alert-lib.mjs';
import { activeActionsIncident, alertFromPrepared, workflowFailureAlert } from '../scripts/workflow-failure-notify-lib.mjs';
import { retiredLandingAlert } from '../scripts/discover-ad-targets.mjs';

/* Every notification the monitoring can send, rendered once with realistic
   input. Most of these paths only run when something has actually gone
   wrong, so a mistake in one would otherwise surface for the first time in
   the middle of an incident — the worst moment to find out. */

const NOW = Date.parse('2026-10-06T02:39:00Z'); // 10:39 MYT
const SITE = { id: 'apgo-my', label: 'APGO MY' };
const WINDOW = settledWindow(NOW, { timeZone: 'Asia/Kuala_Lumpur' });
const okProbe = { add: { status: 200, ok: true }, cart: { itemCount: 1, totalPrice: 15800, currency: 'MYR' }, ratesStatus: 200, rates: [{ name: 'West Malaysia Shipping 3-5 Days', price: 2.9, currency: 'MYR' }], rateLimited: false, error: null };
const ATC_PAGE = { id: 'apgo-my-MY-android-chromium-ad-1', device: 'android-chromium', landingPath: '/products/pocket-friendly-deals', classification: 'storefront_failure', advertising: { sessions: 3674 }, attempts: [{ error: 'Error: \u001b[2mexpect(\u001b[22m locator).toBeVisible() failed' }] };

const CATALOGUE = {
  'layer1 down': layer1DownAlert({ label: 'APGO MY', sample: { id: 'apgo-my:homepage', status: 503, error: 'HTTP 503', url: 'https://apgo.my/' }, failures: 2, nowMs: NOW }),
  'layer1 cart down': layer1DownAlert({ label: 'APGO MY', sample: { id: 'apgo-my:cart-api', status: 0, error: 'timeout', url: 'https://apgo.my/cart.js' }, failures: 3, nowMs: NOW }),
  'layer1 recovered': layer1RecoveryAlert({ label: 'APGO MY', sample: { id: 'apgo-my:homepage', status: 200, latencyMs: 412, url: 'https://apgo.my/' }, nowMs: NOW }),
  'layer1 slow': layer1SlowAlert({ label: 'APGO MY', sample: { id: 'apgo-my:homepage', latencyMs: 6123, url: 'https://apgo.my/' }, slowSamples: 3, nowMs: NOW }),
  'monitoring paused': blindAlert('open', { label: 'APGO MY', state: { sinceMs: NOW, affected: ['watch', 'layer4'] }, nowMs: NOW }),
  'monitoring paused long': blindAlert('escalate', { label: 'APGO MY', state: { sinceMs: NOW - 7 * 3_600_000, affected: ['layer4'] }, nowMs: NOW }),
  'monitoring resumed': blindAlert('close', { label: 'APGO MY', state: { sinceMs: NOW - 3 * 3_600_000, affected: ['watch', 'layer4'] }, nowMs: NOW }),
  'critical cart error': criticalCartAlert({ siteLabel: 'APGO MY', page_url: '/products/pocket-friendly-deals', status: 502, action: 'add', message: 'Bad Gateway', signature: 'abc123' }, NOW),
  'browser digest': browserDigestAlert([{ site_id: 'apgo-my', kind: 'error', sessions: 4, networks: 3, occurrences: 7, message: 'Required ref not found', pages: '/products/a,/cart', signature: 's1' }], 1, NOW),
  'browser digest with cart': browserDigestAlert([{ site_id: 'apgo-my', kind: 'cart', sessions: 3, networks: 2, occurrences: 3, message: 'Failed to fetch', pages: '/cart', signature: 's2' }], 1, NOW),
  'no orders': orderGapAlert(SITE, { severity: 'warning', ageMinutes: 430, thresholdMinutes: 420 }, NOW - 430 * 60_000, 'Asia/Kuala_Lumpur', null, NOW),
  'no orders critical': orderGapAlert(SITE, { severity: 'critical', ageMinutes: 900, thresholdMinutes: 420 }, NOW - 900 * 60_000, 'Asia/Kuala_Lumpur', null, NOW),
  'orders resumed': orderRecoveryAlert(SITE, NOW, NOW - 8 * 3_600_000, 'Asia/Kuala_Lumpur', NOW),
  'order push missing': orderPushAlert(SITE, 'missing', { nowMs: NOW }),
  'order push stale': orderPushAlert(SITE, 'stale', { ageMinutes: 1600, nowMs: NOW }),
  'post-deploy not checked': postDeployFailureAlert({ label: 'APGO MY' }, 'delivery-1', new Error('HTTP 500'), NOW),
  'scheduler tick failed': tickFailureAlert(new Error('GitHub workflow dispatch HTTP 500'), NOW),
  ...Object.fromEntries(Object.keys(RULE_COPY).flatMap((rule) => [
    [`business ${rule}`, businessAlert({ rule, site: 'APGO MY', nowMs: NOW, window: WINDOW, detail: { current: { add_to_cart: 0 }, baseline: { add_to_cart: 12.5 } }, screensLine: '加入购物车主要来自：Pocket（12）', probeLine: '🤖 结账探测：覆盖该时段跑了 3 次，全部成功加购并拿到运费', runUrl: 'https://x/run' })],
    [`business ${rule} ongoing`, businessAlert({ rule, site: 'APGO MY', alertCount: 3, abnormalSince: new Date(NOW - 2 * 3_600_000).toISOString(), nowMs: NOW, window: WINDOW, detail: { current: { begin_checkout: 0 }, baseline: { begin_checkout: 3 } } })],
    [`business ${rule} recovered`, businessRecoveryAlert({ rule, site: 'APGO MY', lastedMs: 5_400_000, nowMs: NOW, detail: { current: { add_to_cart: 14 } } })],
  ])),
  'ga4 empty windows': emptyWindowAlert({ site: 'APGO MY', consecutive: 6, window: WINDOW, baselinePageView: 187.5, nowMs: NOW }),
  'daily payment drop': dailyFunnelAlert({ site: 'APGO MY', targetDate: '20261005', armed: [{ label: 'all', issues: ['checkout_to_purchase'] }], nowMs: NOW }),
  'daily mixed drop': dailyFunnelAlert({ site: 'APGO MY', targetDate: '20261005', armed: [{ label: 'device:mobile', issues: ['view_to_atc', 'atc_to_checkout'] }], nowMs: NOW }),
  'daily data quality': dailyQualityAlert({ site: 'APGO MY', targetDate: '2026-10-05', issues: [{ code: 'PURCHASE_REVENUE_MISSING', message: '40 transactions, zero revenue' }], nowMs: NOW }),
  'investigation found': investigationAlert({ ruleLabel: '有人加购，但没人进结账', address: { zip: '86900' }, results: [{ handle: 'p', title: 'P', count: 7, probe: { ...okProbe, rates: [] }, changes: [], hadSnapshot: true }], snapshotTakenAt: '2026-10-05T04:25:00Z', siteLabel: 'APGO MY', nowMs: NOW }),
  'investigation empty': investigationAlert({ ruleLabel: '加入购物车突然没了', address: { zip: '86900' }, results: [], unmatched: [], siteLabel: 'APGO MY', nowMs: NOW }),
  'watch broken': watchAlert({ results: [{ handle: 'p', title: 'P', probe: { ...okProbe, rates: [] }, judgement: { status: 'broken', reasons: ['运费查询成功但一个运送方式都没有 → 这个购物车结不了账'] } }], verdict: { status: 'broken', measured: 1, broken: 1 }, brokenSince: new Date(NOW - 40 * 60_000).toISOString(), nowMs: NOW, siteLabel: 'APGO MY' }),
  'watch recovered': watchRecoveryAlert({ results: [{ handle: 'p', title: 'P', probe: okProbe, judgement: { status: 'ok', reasons: [] } }], brokenSince: new Date(NOW - 60 * 60_000).toISOString(), nowMs: NOW, siteLabel: 'APGO MY' }),
  'evening clean': eveningSummaryAlert({ label: 'APGO MY', reportDate: '20261005', cutoffLabel: '20:00', counts: { begin_checkout: 120, purchase: 85 }, orders: { count: 58, lastAt: NOW - 3_600_000 }, health: { monitoringOperational: true, checksPassing: true, layers: [] }, completionState: { active: false }, abandoned: { status: 'ok', count: 12, precision: 'EXACT' }, layer1Probes: { homepage: { samples: 288, successes: 288, throttles: 0 } }, timeZone: 'Asia/Kuala_Lumpur', nowMs: NOW }),
  'evening with issues': eveningSummaryAlert({ label: 'APGO MY', reportDate: '20261005', cutoffLabel: '20:00', counts: { begin_checkout: 0, purchase: 0 }, orders: { count: 0, lastAt: null }, health: { monitoringOperational: false, checksPassing: false, layers: [{ layer: 'layer2', status: 'failed', ageSeconds: 600 }, { layer: 'watch', status: 'delayed', ageSeconds: 6000 }] }, completionState: { active: true }, abandoned: { status: 'error' }, layer1Probes: null, timeZone: 'Asia/Kuala_Lumpur', nowMs: NOW }),
  'workflow keeps failing': workflowFailureAlert({ workflowFile: 'monitor-alerts.yml', workflow: 'Layer 4 GA4 business monitoring', job: 'ga4', commit: '8b2eb7c', consecutive: 3, site: 'APGO MY', runUrl: 'https://x/run', nowMs: NOW }),
  'deploy failed': workflowFailureAlert({ workflowFile: 'deploy-worker.yml', workflow: 'Deploy', job: 'deploy', nowMs: NOW }),
  'retired landing traffic': retiredLandingAlert([{ landingPath: '/products/atomic-crystal-merdeka-set', latestDate: '20261005', sessions: 120, addToCarts: 28, checkouts: 10 }], 'APGO MY', NOW),
  ...Object.fromEntries([
    ['layer2 storefront', { failed: [ATC_PAGE] }],
    ['layer2 several', { failed: [ATC_PAGE, { ...ATC_PAGE, id: 'b', device: 'iphone-webkit' }] }],
    ['layer2 planning', { planningFailed: true, planError: 'AD_DISCOVERY_FAILED: token' }],
    ['layer2 missing', { missing: ['a', 'b'] }],
    ['layer2 rate limited', { failed: [{ ...ATC_PAGE, classification: 'MONITOR_RATE_LIMIT' }] }],
    ['layer2 challenge', { failed: [{ ...ATC_PAGE, classification: 'MONITOR_ACCESS_CHALLENGE' }] }],
    ['layer2 stale config', { failed: [{ ...ATC_PAGE, classification: 'TEST_CONFIG_STALE' }] }],
  ].map(([name, input]) => [name, alertFromPrepared(layer2Alert({ site: 'APGO MY', ...input }), { runUrl: 'https://x/run', nowMs: NOW })])),
};

const ICONS = ['🔴', '🟡', '⚪', '✅', '🔎'];
const RINGS = new Set(['🔴', '🔎']);
/* The old notifications, which the owner could not read. None of these may
   come back in the part of a message written for him. */
const OLD_VOICE = /\[Layer|\[第[1-4]层|Monitoring (Health|Delayed|Recovery)|Scheduler tick|\[Dispatcher\]|Browser Error Digest|daily funnel alert|data quality alert|heartbeat (is|resumed)|has recovered|consecutive probes|\[结账探测\]|当前: \{/;

for (const [name, alert] of Object.entries(CATALOGUE)) {
  test(`notification reads as written for the owner: ${name}`, () => {
    assert.ok(alert && typeof alert.text === 'string', 'renders');
    const lines = alert.text.split('\n');
    const icon = ICONS.find((candidate) => lines[0].startsWith(`${candidate} `));
    assert.ok(icon, `starts with a colour: ${lines[0]}`);
    // Line two answers the owner's two questions: is the store all right, and
    // does he need to do anything.
    assert.match(lines[1], /^.+｜.+$/, `second line: ${lines[1]}`);
    assert.match(alert.text, /\n时间 \d\d\/\d\d \d\d:\d\d/, 'local time, short');
    const ownerPart = alert.text.split('—— 技术细节 ——')[0];
    assert.doesNotMatch(ownerPart, OLD_VOICE, 'no old jargon in the owner part');
    assert.doesNotMatch(alert.text, /\u001b|\[\d{1,2}m/, 'no terminal colour codes');
    assert.doesNotMatch(alert.text, /\*\*/, 'no markdown: Telegram shows it as literal asterisks');
    assert.ok(alert.text.length <= 3900, 'fits a Telegram message');
    // Colour and ringing can never disagree.
    assert.equal(alert.silent, !RINGS.has(icon), `ringing matches ${icon}`);
  });
}

test('only things that need a person now are red', () => {
  const red = Object.entries(CATALOGUE).filter(([, alert]) => alert.text.startsWith('🔴')).map(([name]) => name).sort();
  assert.deepEqual(red, [
    'business add_to_cart_zero',
    'business add_to_cart_zero ongoing',
    'business begin_checkout_zero',
    'business begin_checkout_zero ongoing',
    'business checkout_completion_drop',
    'business checkout_completion_drop ongoing',
    'critical cart error',
    'daily mixed drop',
    'daily payment drop',
    'layer1 cart down',
    'layer1 down',
    'no orders',
    'no orders critical',
    'watch broken',
  ]);
});

test('a problem with the monitoring itself is never red', () => {
  for (const name of ['monitoring paused', 'monitoring paused long', 'scheduler tick failed', 'post-deploy not checked', 'workflow keeps failing', 'deploy failed', 'layer2 rate limited', 'layer2 challenge', 'ga4 empty windows', 'order push missing']) {
    assert.ok(!CATALOGUE[name].text.startsWith('🔴'), name);
    assert.equal(CATALOGUE[name].silent, true, name);
  }
});

/* ---- the GitHub outage of 2026-10-06, replayed ------------------------- */

test('one GitHub outage is two silent messages, not seven', () => {
  /* 03:11-06:49 MYT GitHub could not assign runners. The old logic sent
     delayed, stale and resumed for each of two layers plus a workflow note,
     two of them ringing. Replay the same sequence of heartbeat checks. */
  const start = Date.parse('2026-10-05T19:11:00Z');
  const ticks = [
    { at: 45, critical: [], stale: ['watch'] },                 // watch delayed
    { at: 90, critical: [], stale: ['watch', 'layer4'] },       // layer4 delayed
    { at: 95, critical: ['watch'], stale: ['watch', 'layer4'] }, // watch stale
    { at: 180, critical: ['watch', 'layer4'], stale: ['watch', 'layer4'] }, // layer4 stale
    { at: 185, critical: ['layer4'], stale: ['layer4'] },        // watch resumed
    { at: 195, critical: [], stale: [] },                        // layer4 resumed
  ];
  let state = null;
  const events = [];
  for (const tick of ticks) {
    const step = nextBlindState(state, tick, start + tick.at * 60_000);
    state = step.state;
    if (step.event) events.push({ event: step.event, alert: blindAlert(step.event, { label: 'APGO MY', state: step.event === 'close' ? step.closed : step.state, nowMs: start + tick.at * 60_000 }) });
  }
  assert.deepEqual(events.map((entry) => entry.event), ['open', 'close']);
  assert.ok(events.every((entry) => entry.alert.silent));
  // The recovery names everything that stopped, not just the last layer back.
  assert.match(events[1].alert.text, /结账探测、业务指标恢复回报/);
});

test('an outage that lasts escalates once, to yellow, still silent', () => {
  const start = Date.parse('2026-10-05T00:00:00Z');
  let { state } = nextBlindState(null, { critical: ['layer4'], stale: ['layer4'] }, start);
  const early = nextBlindState(state, { critical: ['layer4'], stale: ['layer4'] }, start + 3 * 3_600_000);
  assert.equal(early.event, null);
  const late = nextBlindState(early.state, { critical: ['layer4'], stale: ['layer4'] }, start + 6 * 3_600_000);
  assert.equal(late.event, 'escalate');
  const again = nextBlindState(late.state, { critical: ['layer4'], stale: ['layer4'] }, start + 9 * 3_600_000);
  assert.equal(again.event, null, 'escalates once');
});

test('a delayed layer alone never opens an incident', () => {
  // GitHub's cron is late all the time; only a critical miss is news.
  assert.equal(nextBlindState(null, { critical: [], stale: ['watch'] }, Date.now()).event, null);
});

test('workflow failures during a GitHub Actions incident stay quiet', () => {
  const incident = [{ name: 'Incident with Actions', created_at: '2026-10-05T19:11:58Z', resolved_at: '2026-10-05T22:49:42Z', components: [{ name: 'Actions' }, { name: 'Pages' }] }];
  assert.ok(activeActionsIncident(incident, Date.parse('2026-10-05T21:30:00Z')), 'during');
  assert.ok(activeActionsIncident(incident, Date.parse('2026-10-05T23:15:00Z')), 'within 30 minutes after');
  assert.equal(activeActionsIncident(incident, Date.parse('2026-10-06T00:00:00Z')), null, 'later failures speak again');
  assert.equal(activeActionsIncident([{ name: 'Incident with Codespaces', created_at: '2026-10-05T19:00:00Z', components: [{ name: 'Codespaces' }] }], Date.parse('2026-10-05T20:00:00Z')), null, 'other services do not count');
  assert.equal(activeActionsIncident(null, Date.now()), null, 'an unreachable status page means speak, not stay quiet');
});

/* ---- the format itself -------------------------------------------------- */

test('time is the store time zone, short', () => {
  assert.equal(localTime(Date.parse('2026-10-05T19:11:26.064Z')), '10/06 03:11');
  assert.equal(duration(3 * 3_600_000 + 9 * 60_000), '3 小时 9 分');
  assert.equal(duration(45 * 60_000), '45 分钟');
  assert.equal(duration(7 * 3_600_000), '7 小时');
});

test('terminal colour codes are removed whether or not the escape byte survived', () => {
  assert.equal(plain('Error: \u001b[2mexpect(\u001b[22m \u001b[31mlocator\u001b[39m [2m).toBeVisible'), 'Error: expect( locator ).toBeVisible');
  // Indentation survives; it groups an item's details under it.
  assert.equal(plain('   运费：MYR 2.90'), '   运费：MYR 2.90');
  assert.equal(plain('a\nb'), 'a b', 'one line stays one line');
});

test('an unknown level is refused rather than sent unformatted', () => {
  assert.throws(() => buildAlert({ level: 'urgent', title: 'x' }), /unknown alert level/);
  assert.throws(() => buildAlert({ level: 'act' }), /title is required/);
});

test('long technical detail is trimmed, never the owner part', () => {
  const alert = buildAlert({ level: 'watch', title: '测试', lines: ['给老板看的一句话'], details: Array.from({ length: 50 }, (_, i) => `detail line ${i} ${'x'.repeat(100)}`) });
  assert.match(alert.text, /给老板看的一句话/);
  assert.match(alert.text, /…/);
  assert.ok(alert.text.length < 2_000);
});
