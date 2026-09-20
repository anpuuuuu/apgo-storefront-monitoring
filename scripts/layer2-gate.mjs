#!/usr/bin/env node
/* Decides whether a late scheduled Layer 2 run should still do the work.

   The Dispatcher Cron dispatches today's daily at 02:10 UTC when GitHub's own
   01:37 cron has not delivered. When that cron then arrives hours later, a
   fresh Layer 2 heartbeat proves the daily already ran, and re-running a
   50-minute browser batch (with its cart writes) would be waste.

   But "already ran" is not the same as "already passed". `finalize` writes the
   daily heartbeat before it decides whether to fail, so a failed daily leaves a
   fresh heartbeat whose status is `error` — and the old gate, which read only
   the age, then skipped the scheduled run. The day got one attempt instead of
   two, and if that attempt failed the layer stayed red until tomorrow. Layer 2
   was red from 2026-09-14 to 09-20 with every "schedule success" in between
   being a skip, not a pass.

   So: skip only when the heartbeat is both fresh and healthy. Anything else,
   including an unreadable /health, runs — a wasted batch costs minutes, a
   suppressed retry costs a day of coverage. */

export const DEFAULT_MAX_AGE_MINUTES = 480;

/* Pure. `health` is the parsed /health body, or null when it could not be
   read. Returns { run, reason, ageMinutes, status }. */
export function decideScheduledRun(health, { siteId, maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES, layer = 'layer2' } = {}) {
  const site = (health?.sites || []).find((entry) => entry.siteId === siteId);
  const row = (site?.layers || []).find((entry) => entry.layer === layer);
  if (!row || row.missing) return { run: true, reason: 'no heartbeat on record', ageMinutes: null, status: null };

  const ageSeconds = Number(row.ageSeconds);
  if (!Number.isFinite(ageSeconds)) return { run: true, reason: 'heartbeat age unreadable', ageMinutes: null, status: row.status ?? null };
  const ageMinutes = Math.round(ageSeconds / 60);
  const status = row.status ?? null;

  if (ageMinutes >= maxAgeMinutes) return { run: true, reason: `heartbeat is ${ageMinutes} min old`, ageMinutes, status };
  if (status !== 'ok') return { run: true, reason: `today's daily reported ${ageMinutes} min ago but its status is ${status}`, ageMinutes, status };
  return { run: false, reason: `today's daily passed ${ageMinutes} min ago`, ageMinutes, status };
}

async function main() {
  const eventName = process.env.EVENT_NAME || '';
  if (eventName !== 'schedule') {
    return { run: true, reason: `event is ${eventName || '(unset)'}, not a late scheduled run`, ageMinutes: null, status: null };
  }
  const base = String(process.env.MONITOR_WORKER_URL || '').replace(/\/$/, '');
  const siteId = process.env.SITE_ID || 'apgo-my';
  const maxAgeMinutes = Number(process.env.MONITOR_GATE_MAX_AGE_MINUTES || DEFAULT_MAX_AGE_MINUTES);
  if (!base) return { run: true, reason: 'MONITOR_WORKER_URL is not set', ageMinutes: null, status: null };

  let health = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 20_000);
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal, headers: { 'user-agent': 'APGO-Layer2-Gate/1.0' } });
      // /health answers 503 when Layer 1 is unhealthy but the body is still valid.
      health = await response.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { run: true, reason: `/health unreadable: ${String(error?.message || error).slice(0, 120)}`, ageMinutes: null, status: null };
  }
  return decideScheduledRun(health, { siteId, maxAgeMinutes });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const decision = await main();
  console.log(JSON.stringify({ event: 'layer2_gate', ...decision }));
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import('node:fs');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
  }
}
