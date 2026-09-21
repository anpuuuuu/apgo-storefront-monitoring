/* Pure decision logic for the synthetic checkout watch. No env, no network,
   so `node --test` can import it directly.

   Layer 4 now judges a settled GA4 window and needs two adjacent slots to
   confirm, which puts detection at about two and a half hours. That is the
   right trade for a statistical rule -- the noise was in the data source, and
   waiting for settled data is what removed it -- but it leaves a hole where a
   storefront can be unsellable and nothing says so.

   This fills the hole from the other side. Instead of inferring from shopper
   behaviour, it acts like a shopper: add a real product to a real cart, ask
   for shipping rates to a real postcode, and see whether the answer is one a
   customer could check out with. It never opens the checkout page, never
   fills payment, never creates an order -- public cart endpoints only.

   The signal is deterministic, which is the whole point. "Nobody checked out
   for 30 minutes" is evidence; "the cart returned no shipping method" is a
   fact, and a fact does not need two hours of settling to be believed. */

/* 2026-09-15 is the failure this exists for: free shipping was switched off
   on an advertised product, add_to_cart stayed healthy, begin_checkout went
   to zero. A shopper reaching shipping saw nothing they could pick. GA4
   noticed at 00:46 through the funnel; a cart probe would have seen an empty
   shipping_rates array on the first run after the change. */
export const BROKEN = 'broken';
export const OK = 'ok';
export const UNMEASURED = 'unmeasured';

/* Which products this run probes.

   The canaries are fixed because a storefront-wide break -- shipping zones,
   checkout settings, a bad theme deploy -- shows up on any product, and a
   fast line is worth nothing if it waits for the rotation to come round. The
   rotating slot exists so a break confined to one product is still found
   eventually, without probing the whole catalogue every 20 minutes and
   earning a rate limit. */
export function pickHandles(handles, { canaries = 1, rotating = 1, runIndex = 0 } = {}) {
  const list = [...new Set((handles || []).map((h) => String(h || '').trim()).filter(Boolean))];
  if (!list.length) return [];
  const fixed = list.slice(0, Math.max(0, canaries));
  const pool = list.slice(fixed.length);
  if (!pool.length || rotating <= 0) return fixed;
  const picked = [];
  for (let i = 0; i < Math.min(rotating, pool.length); i += 1) {
    picked.push(pool[(Math.abs(runIndex) + i) % pool.length]);
  }
  return [...fixed, ...picked];
}

/* One product's verdict.

   Anything that means "we could not measure" must never read as "the store is
   broken" -- the 429 lesson from 2026-09-15, when a throttled runner made
   seven of eight products look dead while the same probe from a home IP
   passed. Throttling, timeouts and a shipping quote still being calculated
   are all absence of evidence. */
export function judgeProbe(probe) {
  const reasons = [];
  if (!probe) return { status: UNMEASURED, reasons: ['没有探测结果'] };
  if (probe.rateLimited) return { status: UNMEASURED, reasons: ['被 Shopify 限流（429），这次测不准'] };
  if (probe.error) return { status: UNMEASURED, reasons: [`探测出错：${probe.error}`] };

  if (probe.add && probe.add.ok === false) return { status: BROKEN, reasons: [`加购失败（${probe.add.error || probe.add.status}）`] };
  if (probe.add && probe.add.status && probe.add.status >= 400) return { status: BROKEN, reasons: [`加购失败（HTTP ${probe.add.status}）`] };
  if (!probe.add) return { status: UNMEASURED, reasons: ['没走到加购'] };
  if (!probe.cart) return { status: UNMEASURED, reasons: ['读不到购物车'] };
  if (Number(probe.cart.itemCount) < 1) return { status: BROKEN, reasons: ['加购之后购物车还是空的'] };

  // A quote that is still being calculated is slow, not broken.
  if (probe.ratesStatus === 202) return { status: UNMEASURED, reasons: ['运费还在计算，这次没等到'] };
  if (probe.ratesStatus !== 200) {
    return { status: BROKEN, reasons: [`拿不到运费（HTTP ${probe.ratesStatus ?? '无回应'}${probe.ratesError ? `：${probe.ratesError}` : ''}）`] };
  }
  if (!Array.isArray(probe.rates)) return { status: UNMEASURED, reasons: ['运费回应不是列表'] };
  if (probe.rates.length === 0) {
    // The 9/15 shape: the cart is fine and the quote succeeded, it just has
    // nothing in it. A shopper here cannot choose a shipping method, so they
    // cannot check out, so this is a broken store even though every request
    // returned 200.
    return { status: BROKEN, reasons: ['运费查询成功但一个运送方式都没有 → 这个购物车结不了账'] };
  }
  return { status: OK, reasons };
}

/* The run's verdict. Products that could not be measured are set aside rather
   than counted as healthy: a run where the only measurable product is broken
   is a broken run, and a run where nothing could be measured is not a pass. */
export function judgeRun(judgements) {
  const measured = (judgements || []).filter((entry) => entry.status !== UNMEASURED);
  const broken = measured.filter((entry) => entry.status === BROKEN);
  if (!measured.length) return { status: UNMEASURED, broken: 0, measured: 0 };
  if (broken.length === measured.length) return { status: BROKEN, broken: broken.length, measured: measured.length };
  if (broken.length) return { status: 'degraded', broken: broken.length, measured: measured.length };
  return { status: OK, broken: 0, measured: measured.length };
}

/* Consecutive-run confirmation.

   Two runs 20 minutes apart, rather than one, because a deploy, a theme
   publish or a Shopify hiccup can make a single run look broken. Two is
   enough: the signal is deterministic, so a second failure is not the second
   coin landing heads, it is the same fact observed twice.

   A run that could not measure anything holds the streak where it is instead
   of clearing it. Throttling must not be able to reset a genuine failure back
   to zero and keep the alert away forever. */
export function nextWatchState(previous, verdict, nowMs, settings = {}) {
  const need = Number(settings.consecutive_failures) || 2;
  const prior = { consecutive: 0, active: false, lastAlertedAt: 0, ...(previous || {}) };
  const failing = verdict.status === BROKEN || (settings.alert_on_degraded && verdict.status === 'degraded');

  let consecutive = Number(prior.consecutive) || 0;
  if (verdict.status === UNMEASURED) {
    // hold
  } else if (failing) {
    consecutive += 1;
  } else {
    consecutive = 0;
  }

  const confirmed = consecutive >= need;
  const realertMs = (Number(settings.realert_hours) || 2) * 3_600_000;
  const shouldAlert = confirmed && (!prior.active || nowMs - (Number(prior.lastAlertedAt) || 0) >= realertMs);
  const recovered = prior.active && verdict.status === OK;

  return {
    confirmed,
    shouldAlert,
    recovered,
    next: {
      consecutive,
      active: recovered ? false : prior.active || shouldAlert,
      lastAlertedAt: shouldAlert ? nowMs : Number(prior.lastAlertedAt) || 0,
      brokenSince: consecutive === 1 ? new Date(nowMs).toISOString() : (consecutive ? prior.brokenSince || new Date(nowMs).toISOString() : null),
      alertCount: shouldAlert ? (Number(prior.alertCount) || 0) + 1 : (recovered ? 0 : Number(prior.alertCount) || 0),
      status: verdict.status,
      checkedAt: new Date(nowMs).toISOString(),
      runIndex: (Number(prior.runIndex) || 0) + 1,
    },
  };
}

const rateText = (rate) => `${rate.name} ${Number(rate.price) === 0 ? '免运' : `${rate.currency || 'MYR'} ${Number(rate.price).toFixed(2)}`}`;

/* The message says what a shopper would have hit, and names the product, so
   the first thing the owner does is open that page rather than ask which. */
export function watchMessage({ results, verdict, alertCount = 1, brokenSince = null, nowMs = Date.now(), siteLabel = '', runUrl = '' }) {
  const header = alertCount > 1
    ? `🔴 [结账探测] 仍然结不了账（第 ${alertCount} 次提醒）`
    : `🔴 [结账探测] 机器人走不完结账流程${siteLabel ? ` · ${siteLabel}` : ''}`;
  const lines = [header];
  if (brokenSince) {
    const minutes = Math.round((nowMs - Date.parse(brokenSince)) / 60_000);
    if (Number.isFinite(minutes) && minutes > 0) lines.push(`已持续约 ${minutes} 分钟`);
  }
  for (const entry of results) {
    const mark = entry.judgement.status === BROKEN ? '✖' : entry.judgement.status === OK ? '✔' : '—';
    lines.push(`${mark} ${entry.title || entry.handle}`);
    for (const reason of entry.judgement.reasons) lines.push(`    ${reason}`);
    if (entry.judgement.status === OK && entry.probe?.rates?.length) {
      lines.push(`    运费：${entry.probe.rates.map(rateText).join(' · ')}`);
    }
  }
  if (verdict.status === BROKEN) {
    lines.push('');
    lines.push('先查：运费区域与免运门槛、结账设置、库存，以及主题或 app 最近有没有更新。');
    lines.push('这是机器人真的走了一遍：加入购物车 → 查运费。它没有、也不会打开结账页或付款。');
  }
  if (runUrl) lines.push(runUrl);
  return lines.join('\n');
}

export function recoveryMessage({ results, brokenSince, nowMs = Date.now(), runUrl = '' }) {
  const minutes = brokenSince ? Math.round((nowMs - Date.parse(brokenSince)) / 60_000) : null;
  const ok = results.filter((entry) => entry.judgement.status === OK);
  const lines = [`🟢 [结账探测] 又能结账了${Number.isFinite(minutes) && minutes > 0 ? `，坏了约 ${minutes} 分钟` : ''}`];
  for (const entry of ok.slice(0, 3)) {
    lines.push(`✔ ${entry.title || entry.handle}${entry.probe?.rates?.length ? ` · ${entry.probe.rates.map(rateText).join(' · ')}` : ''}`);
  }
  if (runUrl) lines.push(runUrl);
  return lines.join('\n');
}
