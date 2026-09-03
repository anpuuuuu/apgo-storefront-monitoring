# Authorized partial Live cutover

The owner explicitly approved skipping the 48-hour review and switching Layer 2 plus website/self-test monitoring to Central after the current full Daily run passes. GA4 remains in the old Theme Repo; its permission issue is deferred. The Codex six-hour review automation `apgo-shadow-48` was deleted as requested. No automatic review/acceptance is claimed.

## Gate and current state

- Gate run: [33739738531](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33739738531), central code `e6485d2`, Theme `cfa1bf975157088fc44f32af0023574b2c46c2cc`.
- Gate **passed** at 10:06 UTC: 15 planned/15 received Daily results, all first-attempt successes, zero failed/missing/transient journeys and no rate-limit circuit. Every result used the exact Theme SHA above. Downloaded evidence contained 30 valid JSON files and no credential/Cart-token pattern hits. This Shadow gate did not refresh production Layer 2 heartbeat.
- Partial cutover recorded at **2026-09-03T10:09:03Z / September 3, 18:09 MYT**. Central is Live for Layer 2 and website self-health; GA4 remains with Theme.
- Legacy GA4-only watchdog: Theme PR [#13](https://github.com/anpuuuuu/apgo-theme/pull/13), merged as `eb3b709f226d749bc341428409ed0a0c17856301`. It changes only four monitoring files, preserves rollback default `all`, and passed 29 local monitoring/helper/theme-regression tests.
- Why keep a legacy watchdog: the old self-health workflow also recovers delayed GA4 workflows. Disabling it outright would remove that recovery while the owner expects GA4 to remain operational. Under `MONITOR_SELF_HEALTH_SCOPE=ga4-only`, it neither probes the Worker nor refreshes Layer 3 nor recovers Layer 2.

## Current ownership

| Function | Owner |
| --- | --- |
| Layer 1 Cron, browser error collection/digests | Existing Error Worker, unchanged |
| Layer 2 Daily/Post-deploy and website self-health/Layer 3 self-test | Central Repo, Live |
| Layer 4 GA4 and GA4 schedule-recovery watchdog | Theme Repo, unchanged data logic |
| Central Layer 4 | Paused; not accepted |

## Execution and verification

- Central variables verified: `MONITOR_MODE=live`, `MONITOR_SCHEDULE_ENABLED=true`, `MONITOR_LAYER4_PAUSED=true`. `MONITOR_PARTIAL_CUTOVER_AT` records the cutover time. Old Shadow timestamps remain historical; the owner waived that review, not the pass/fail gate.
- Theme Layer 2 V2 ID `342000196` is `disabled_manually`. Theme self-health ID `338645887` is active with `MONITOR_SELF_HEALTH_SCOPE=ga4-only`; GA4 remains active. Old manual rollback/diagnostic workflows are retained.
- Central Live self-health [33742782522](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742782522) passed. It wrote and read back `apgo-my:layer3` at `2026-09-03T10:09:44.111Z`, source `authenticated-selftest`, mode `live`. The watchdog explicitly excluded central Layer 4 (`paused_by_owner`, `accepted=false`).
- Legacy GA4-only self-health [33742785483](https://github.com/anpuuuuu/apgo-theme/actions/runs/33742785483) passed. Worker/Layer 1 and Layer 3 steps were skipped; Layer 2 was logged as `owned_by_central`, and only old GA4 schedule freshness was checked. Its existing GA4 recovery logic is unchanged.
- Actual Theme merge triggered one central Post-deploy [33742755562](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742755562). Exact-SHA resolution, three-minute wait, Theme contract and GA4 non-revenue discovery passed. Browser batch is **still running** at this record; do not claim its final result before examining the summary. No duplicate manual cart-writing run was launched.
- `/health` at `2026-09-03T10:12:10Z` reported all namespaced production layers healthy: Layer 1 at `10:10:38.923Z`, Layer 2 at `07:17:49.069Z` (old successful Daily), Layer 3 at `10:09:44.111Z`, Layer 4 at `09:55:32.778Z` (old official GA4). Historical unnamespaced keys are not the current site state.
- **Pending:** first scheduled Central Live Daily and its `playwright-central-daily` heartbeat; current Post-deploy final evidence; deferred GA4 permission/acceptance and final migration cleanup. No Worker deploy, D1 change, credentials revocation or storefront edit occurred during this cutover.

## Controlled sequence used

1. Require gate workflow success, complete matching Daily results for all planned journeys, no rate-limit circuit, and safe evidence. If it fails, leave official monitoring untouched and investigate; skipping 48 hours does not waive a failed test.
2. Verify no old Layer 2/self-health run is in flight. Disable old Layer 2 workflow ID `342000196`. Briefly disable old self-health ID `338645887` during scope change; keep old GA4 workflow active throughout.
3. Set central `MONITOR_MODE=live`, leave schedules on and `MONITOR_LAYER4_PAUSED=true`. Do not change Worker settings, secrets, D1 schema or storefront files.
4. Set Theme `MONITOR_SELF_HEALTH_SCOPE=ga4-only`; merge Theme PR #13, then re-enable its self-health workflow only as the GA4 watchdog. The monitoring-only Theme commit can trigger the existing App's central Post-deploy check; do not also start a duplicate cart-writing run.
5. Manually run central self-health and the legacy GA4-only watchdog. Verify central authenticated Layer 3 heartbeat, legacy exclusion of Layer 2/3 work, fresh production Layer 1, and successful GitHub App dispatch of the exact Theme SHA.
6. Keep the last successful official Daily heartbeat until the next Central Live Daily completes; do not fabricate a new Layer 2 heartbeat from deployment activity or claim a Post-deploy run is Daily. The preceding gate run validates behavior, while the first scheduled Live Daily must still be checked for its new `playwright-central-daily` heartbeat.
7. Record actual variable changes, workflow states, run IDs and outstanding first-Live-Daily/GA4 verification. Preserve old code and credentials for rollback; do not declare the complete four-layer migration finished.

## Rollback without deleting data

1. Set central `MONITOR_MODE=shadow` and `MONITOR_SCHEDULE_ENABLED=false`. Check for in-flight central runs; a variable change does not cancel them.
2. Set Theme `MONITOR_SELF_HEALTH_SCOPE=all` and enable old Layer 2 ID `342000196` and self-health ID `338645887`.
3. Confirm official heartbeats resume independently. Keep the old GA4 workflow enabled and central Layer 4 paused.
4. No Worker rollback, D1 reverse migration, token revocation or storefront change is required for this limited cutover.
