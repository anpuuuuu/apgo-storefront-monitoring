# Partial Shadow observation — September 2026

**Historical record, superseded September 3, 18:09 MYT.** The owner waived the 48-hour review and approved partial Live after Daily run 33739738531 passed with 15/15 first-attempt successes and clean evidence. Central now owns Layer 2 plus website self-health; old Theme retains GA4 and a GA4-only watchdog. The Codex six-hour review automation was deleted. The originally planned window/checklist below is retained for context, not an active gate or claim that 48 hours elapsed. Current state and rollback: [CUTOVER-LAYER23.md](CUTOVER-LAYER23.md).

## Authorized window and scope

- Started: **2026-09-03 17:35 MYT** / `2026-09-03T09:35:32Z`.
- Earliest review: **2026-09-05 17:35 MYT** / `2026-09-05T09:35:32Z`.
- Central code enabling the pause: `e6485d2`, PR [#29](https://github.com/anpuuuuu/apgo-storefront-monitoring/pull/29).
- Variables: `MONITOR_MODE=shadow`, `MONITOR_SCHEDULE_ENABLED=true`, `MONITOR_LAYER4_PAUSED=true`. Exact UTC timestamps are also stored in `MONITOR_SHADOW_STARTED_AT` and `MONITOR_SHADOW_REVIEW_AFTER`.
- Layer 1 and customer Layer 3 use the existing Error Worker. No duplicate Worker, deployment, schema migration or official alert source change was made.
- Central Layer 2 Daily/Post-deploy and hourly self-health collect separate results. Shadow self-tests write only identifiable `kind=selftest` evidence, not production heartbeat or alert state.
- Central Layer 4 is intentionally paused and **unvalidated**. Its watchdog emits `paused_by_owner`, `accepted=false` rather than refreshing heartbeat or restarting it. Manual diagnostics are still callable but must not be run until the owner resumes that task.
- Existing Theme Repo workflows and official Telegram remain unchanged. Pausing central Layer 4 does not turn off the old official GA4 workflow or its existing data-access limitations.
- Layer 2 continues its established read-only GA4 advertising discovery (sessions, ATC, checkout, landing pages). This does not require revenue permission or changing authentication/GA4 settings.

## Initial evidence

- Preflight at `2026-09-03T09:34:51Z`: Worker `/health` HTTP 200; all four namespaced production heartbeats were fresh. Legacy keys are historical and must not be mistaken for current site health.
- Production Layer 2 before/after central self-test: `2026-09-03T07:17:49.069Z`, source `playwright-v2-daily`.
- Production Layer 3 before/after central self-test: `2026-09-03T04:50:39.487Z`, source `authenticated-selftest`.
- Production Layer 4 before/after central self-test: `2026-09-03T08:57:52.106Z`.
- Old official Daily [33723322310](https://github.com/anpuuuuu/apgo-theme/actions/runs/33723322310) passed before observation; Theme SHA `cfa1bf975157088fc44f32af0023574b2c46c2cc`.
- First observation Daily [33739738531](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33739738531): launched 09:35:58 UTC, completed successfully at 10:06 UTC. Summary and batch evidence were inspected: 15/15 first-attempt successes, exact Theme SHA, no failed/missing/transient results or rate-limit circuit, and clean credential/Cart-token scan.
- First observation self-health [33739743499](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33739743499): passed at 09:36:24 UTC. It recognized the active Daily without dispatching a duplicate, excluded paused Layer 4, and verified unique Shadow Layer 3 evidence with `heartbeatSuppressed=true`.
- Pre-observation Layer 2 validation was Daily 3/3 and Post-deploy 3/3; these historical runs do not substitute for results during this new window.

## Review checklist

1. Read central and old Theme Actions results in the observation window. Compare equivalent cadence, market/device and exact Theme SHA; new traffic-derived targets can differ legitimately. Inspect `layer2-summary-*` and failure evidence rather than using the workflow name alone to identify Daily versus Post-deploy.
2. Require at least two completed Daily runs in the window, plus evidence of actual scheduled execution. If GitHub delays/omits scheduled runs, extend observation or report insufficient evidence; elapsed time alone is not acceptance.
3. Check every planned journey has a result, retries are classified, and persistent Shopify 429 is `MONITOR_RATE_LIMIT`, not a customer storefront failure. Do not start extra cart-write journeys simply to check progress.
4. Verify self-tests persist isolated evidence, notifications/production heartbeat are suppressed, and the old official heartbeats continue independently. Review any failed or skipped schedule and any new Dispatcher failure. Do not manufacture a Theme Push when no update occurs; distinguish earlier dispatch validation from new window evidence.
5. Scan downloaded evidence for tokens/customer data before any publication. Do not print secrets, raw Cart tokens or credentials in logs or reports.
6. Record central Layer 4 as paused, not successful. Revenue/GA4 comparison remains outside this window. Do not alter GA4 permissions, tracking or resume Layer 4 without the owner continuing that task.
7. Report findings after the earliest review time. **No automatic Cutover**, disabling Theme workflows, Worker deployment, token revocation or deleting old monitoring files. Full migration still requires resolving GA4 and an explicit Cutover decision.

## Follow-up and pause

The read-only six-hour follow-up `apgo-shadow-48` was **deleted** when the owner waived the review. Do not recreate it without a new request. GitHub and Cloudflare continue independently; there is no app-side periodic review task.

The former Shadow pause instruction is no longer the current ownership rollback: old Layer 2 is now disabled. Use the coordinated rollback in [CUTOVER-LAYER23.md](CUTOVER-LAYER23.md), including restoring old scope/workflow and accounting for in-flight central runs; do not simply turn off the new official monitoring.
