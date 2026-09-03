# APGO Central Monitoring Handoff

Updated: 2026-09-03 (MYT)

**Latest objective:** full central Live ownership and post-retirement acceptance are verified. Live Daily passed 15/15; the automatic retirement Post-deploy passed 13/13 on the exact retired Theme commit, with no retries/failures/missing results and no Daily-heartbeat overwrite. Unrestricted GA4 diagnostic, Validate, Primary, Confirm, Realtime, full self-health, protected-main Error Worker deployment and NEXT-only self-test all passed. Old Theme WIF is disabled and its repository-ID service account binding removed; central revalidation passed. The only unresolved retirement item is old Cloudflare token identity/sharing; do not revoke a guessed/shared token. See [FINAL-CUTOVER.md](FINAL-CUTOVER.md) for exact evidence and safe credential/rollback gates.

## Current state

- Central public repository: `anpuuuuu/apgo-storefront-monitoring` (`1349617089`).
- Theme repository: `anpuuuuu/apgo-theme` (`1154313539`).
- Migration source tag: `monitoring-migration-source-fa976c1`.
- Central `main` is protected: PR required, `test` required, force-push/deletion disabled.
- **Full Live cutover September 3, 20:26 MYT**: `MONITOR_MODE=live`, `MONITOR_SCHEDULE_ENABLED=true`, `MONITOR_LAYER4_PAUSED=false`. GA4 business mode remains Observe, not Armed.
- Owner waived the 48-hour Shadow review; the six-hour Codex review automation was deleted. [CUTOVER-LAYER23.md](CUTOVER-LAYER23.md) and [SHADOW-OBSERVATION.md](SHADOW-OBSERVATION.md) record earlier stages. Current acceptance and rollback: [FINAL-CUTOVER.md](FINAL-CUTOVER.md).
- Central owns all monitoring workflows and the existing Error Worker deployment. Theme main `65546a24ba91a607e50e37013931db884b39a1ab` contains no tracked monitoring directory or workflows, only a central pointer and the unchanged frontend Layer 3 integration. All six old workflows are disabled. Old heartbeat value and four old repo secrets/all variables were removed; old WIF provider and principal are retired. Only the old CF API token identity/sharing remains unresolved in credential cleanup.
- Theme compatibility fix `e8a9bfa` restored explicit `apgo-my` Layer 2/4 heartbeats and multi-site health parsing; Layer 3/4 namespaced heartbeats were verified healthy on 2026-08-30.
- No Shopify product, discount, inventory, tracking or customer-facing Theme behavior was changed by this migration.

## Completed

- Monitoring Git history was filtered from the Theme Repo and preserved in the central Repo.
- Multi-site layout, site catalog generation, exact Theme SHA validation and Theme Contract support are implemented.
- Layer 2 uses one serial batch runner with fresh Browser Context/evidence per journey.
- Layer 4 and Self-health use site matrices and site-namespaced state.
- Existing `apgo-error-monitor` URL and D1 database remain in service.
- D1 backup was exported before the forward-only namespace migration.
- `js_errors.site_id` was added and historical rows were backfilled as `apgo-my`; no table/history was dropped.
- Error Worker supports origin-to-site mapping, namespaced signatures/state/alerts and Current/Next heartbeat token transition.
- Dispatcher Worker and seven-day delivery-deduplication KV were deployed.
- Invalid Dispatcher signatures return 401; Layer 3 authenticated self-test and namespaced Layer 1 heartbeat were verified.
- Unit, contract, Worker dry-run, YAML and GitHub `monitoring-ci` checks pass.
- GitHub secret scanning and push protection are enabled with no current alerts.
- Layer 2 image verification now treats an incomplete lazy image as diagnostic and fails only on a completed zero-width image or an explicit network/HTTP failure; both originally reported images returned HTTP 200.
- Android Chromium owns the top-three Add → Cart → Checkout writes. GitHub-hosted iPhone WebKit is read-only after isolated official runs reproduced persistent Shopify 429 even after ten-minute cooldown; local iPhone WebKit full commerce still passes.
- All read-only journeys run before cart writers, writers remain serial with ten-minute cooling, and persistent 429 opens a `MONITOR_RATE_LIMIT` circuit instead of becoming a Storefront failure.
- Mobile option checks derive radio groups from customer-visible labels. This fixes the confirmed false failure where an iPhone run selected a CSS-hidden desktop scent control; the reported detergent path now passes locally in iPhone WebKit.
- Error Worker version `c656b275-8273-4c79-ad83-90573435f5b0` classifies Storefront Web Pixels as Shopify Platform and suppresses only all-leaving hidden Cart fetch aborts from Digest alerts.
- Central WIF provider `apgo-storefront-monitoring` is restricted to immutable central repository ID `1349617089`; GA4 discovery succeeded without a JSON key.
- Private GitHub App `APGO Storefront Monitor` was recreated and verified on 2026-08-30:
  - App ID `4769661`; installation ID `157699088`; webhook hook ID `672281738`.
  - Repository selection is `selected` and contains only `anpuuuuu/apgo-theme` and `anpuuuuu/apgo-storefront-monitoring`.
  - Permissions are Contents Read, Actions Read/Write and mandatory Metadata Read; the only subscribed event is Push.
  - GitHub delivery `8534ebd4-a461-11f1-86be-7987820d3fff` reached the Dispatcher and returned HTTP 202 in 0.06 seconds.
  - Central variables/secrets and Dispatcher App/Webhook secrets are synchronized. The active private-key fingerprint is `SHA256:jDLaQwEqxqoAzk7XW53PJuA0L633l3MK2XlocDwvaYM=`; the unused retry key was deleted.
  - `scripts/sync-github-app-webhook.ps1` authenticates and probes the hook before rotating any shared secret, then verifies the final hook and a signed Dispatcher ping.
- Controlled Theme commit `cfa1bf975157088fc44f32af0023574b2c46c2cc` changed no storefront files or rendered content. GitHub delivery `fc7cd1ea-a464-11f1-8a91-d04cef06f4e8` dispatched the exact SHA once; replaying the same delivery returned `duplicate: true` and did not create another Workflow run.
- Central Post-deploy run [`33308733492`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33308733492) completed successfully: all 13 Journeys passed on their first attempt with no Storefront failures or transient retries.
- Central Post-deploy run [`33311151713`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33311151713) also completed successfully: 13/13 Journeys, no failures, no missing results, no transient retries and no sensitive-pattern evidence files.
- Central Post-deploy run [`33312648953`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33312648953) completed the third validation with the same result: 13/13 Journeys, no failures, missing results or transient retries, and a clean evidence scan. Post-deploy validation is now `3/3`.
- The first Daily diagnostic run exposed one transient iPhone WebKit monitor-input issue. Its trace showed the option chip initially covered by the sticky buy bar while Playwright retried scroll/click positions; the picker asset and storefront listener were healthy, and eight isolated iPhone sessions passed. PR [`#21`](https://github.com/anpuuuuu/apgo-storefront-monitoring/pull/21) now waits for picker readiness, centers the visible chip and verifies its hit target before the real click. No Theme/storefront code changed.
- Central Daily runs [`33368898065`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33368898065), [`33371855523`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33371855523) and [`33375533482`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33375533482) each completed with 15/15 first-attempt successes, no failed/missing/transient result, no second-attempt evidence, valid JSON evidence and zero credential/Cart-token pattern hits. Daily validation is now `3/3`.
- PR [`#23`](https://github.com/anpuuuuu/apgo-storefront-monitoring/pull/23) separated read-only Layer 4 validation requirements from stateful D1 credentials. Central run [`33378562035`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33378562035) then verified the new Repository-ID-restricted WIF provider, GA4 realtime and historical queries, and Worker health. It read all five funnel events successfully and correctly suppressed the Layer 4 production Heartbeat in Shadow mode.
- Central self-health run [`33378623513`](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33378623513) verified the live Worker endpoint, the fresh namespaced Layer 1 Cron heartbeat, and an authenticated Layer 3 beacon. The self-test wrote `apgo-my:layer3` and immediately read it back as healthy from D1.
- PR [#25](https://github.com/anpuuuuu/apgo-storefront-monitoring/pull/25), merged as `0276019`, completed resumable credential setup and GA4 Shadow state isolation. Local checks passed: 45 Layer 2/config tests, 34 Worker/helper tests, the PowerShell setup test, and both Worker dry-runs; required cloud CI also passed.
- Credential validation [33736074523](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33736074523) passed on 2026-09-03: authenticated D1 read, Telegram bot/group verification and two explicitly labelled migration-test messages. Telegram confirmed both deliveries to the configured group. This validates notification transport, not an actual production incident/recovery.
- Dispatcher deployment [33736077305](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33736077305) synchronized all five App/Webhook/Telegram secrets. Version `23c82a03-2d55-4830-99e2-c63c6528bad9` is deployed; `/health` returns 200 and unsigned Webhooks return 401. Error Worker, D1 schema and storefront files were not deployed or changed.
- Stateful Layer 4 Daily Primary [33736053254](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33736053254), Confirm [33736146209](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33736146209), and Realtime [33736149576](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33736149576) passed. Confirm read the isolated Primary generated at `2026-09-03T08:56:31.829Z`; production heartbeats and business Telegram were suppressed. No service-account JSON key was used.
- PR [#27](https://github.com/anpuuuuu/apgo-storefront-monitoring/pull/27), merged as `2998f67`, isolated Layer 3 Shadow self-tests: the beacon uses a unique session ID and no Heartbeat authorization; a read-only D1 query verifies that exact non-critical self-test. The self-test step runs independently even if another health check fails. Uptime Shadow runs are stateless, suppress Telegram and still exit nonzero on failed probes.
- Shadow self-health [33737403523](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33737403523) passed with `evidenceVerified=true` and `heartbeatSuppressed=true`. Production Layer 3 `observedAt` remained `2026-09-03T04:50:39.487Z` before/after the run. Shadow Uptime [33737400524](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33737400524) also passed without production alert/state writes.
- The September 2 GA4 result contains 27 transactions but restricted revenue values. Read-only diagnostic [33737401030](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33737401030) confirmed `metadata.schemaRestrictionResponse.activeMetricRestrictions`: `purchaseRevenue`, `grossPurchaseRevenue`, `totalRevenue`, `eventValue`, `itemRevenue` and `itemsPurchased` are restricted as `REVENUE_DATA`. The service account cannot read those metrics; returned zero is not evidence of zero sales or missing storefront tracking. [Google's metadata reference](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData) explains that active restrictions are returned when the caller is denied the data.
- The regular GA4 helper now rejects active metric restrictions with `GA4_METRIC_ACCESS_RESTRICTED` before calculating/saving the report. Only the explicit read-only revenue diagnostic opts in to inspect restricted responses. Existing restricted reports remain historical evidence, not valid Revenue/AOV baselines.
- The owner initially authorized removing only the service account's No Revenue Metrics restriction, keeping Viewer, but subsequently **paused the permission change** when Google required reauthentication on September 3. No GA4 access, role, tracking, product or storefront change was made. Do not resume the permission change without the owner continuing that task.

## Production resources

- Error Worker: `https://apgo-error-monitor.wadeyeh.workers.dev`
- Dispatcher: `https://apgo-monitor-dispatcher.wadeyeh.workers.dev`
- D1: `apgo-monitoring` / `c75e84af-67df-4761-a559-2b0c1d904989`
- Dispatcher KV: `apgo-monitor-dispatch-deliveries` / `640c1b6bdbd442c18c28ba6c83a63566`
- GA4 Property: `547019474`
- GCP project: `helical-canto-505209-j7` (`223821071753`)
- GA4 service account: `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`

## Remaining external setup

The GitHub App, installation and Dispatcher authentication are complete. The owner has now saved `CF_API_TOKEN` (2026-09-03 08:32 UTC), `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (08:50 UTC) to central Repository Secrets through hidden input. Only secret names/timestamps were checked; values were not read back.

- The replacement Cloudflare token has Workers Scripts Edit, D1 Edit and KV Edit on the selected account. Cloudflare's token UI scoped these permissions to the account, **not individual Workers/databases**; the owner accepted this scope. It has no DNS or billing permissions.
- Telegram group discovery now requires the fresh, explicitly addressed `/monitor_setup@<verified-bot>` command and exact group selection. `-TelegramOnly` resumes without changing the saved Cloudflare token. API exceptions are reduced to safe stage/status hints and the window stays open for errors.
- Credential validation and Dispatcher synchronization are complete; run links are recorded above. Never claim credentials can be read back from GitHub.
- Shadow GA4 reads/writes are now isolated under `apgo-my:shadow:*`; Live continues using `apgo-my:*`. Daily Confirm must find that same mode's Primary result instead of silently passing when it is missing.

Never copy credentials into this public Repo, logs or artifacts.

The bootstrap Cloudflare token created on 2026-08-30 was accidentally entered at a plain PowerShell prompt. It was revoked immediately, disappeared from the Cloudflare token list, and was never stored in GitHub. It must not be reused. When replacement credentials are ready, run `scripts/configure-production-secrets.ps1` and paste values only after the numbered hidden-input prompt appears; never paste a credential at a normal `PS>` prompt.

## Required validation before Shadow

1. Send one controlled no-content Theme `main` Push and verify the Dispatcher launches exactly one Central Post-deploy run for the exact full SHA. Replay its delivery ID and confirm deduplication.
2. Manually run Layer 2 Daily three times and Post-deploy three times.
3. Validate Layer 4 realtime/daily GA4 access through the new WIF provider. Authentication and state isolation passed, but Daily revenue acceptance is incomplete because of the confirmed metric-access restriction. Re-run Primary then Confirm after the owner resumes and the restriction is removed; do not count old restricted-zero reports as a pass.
4. Validate Error Worker health, Layer 3 self-test, D1 writes and Telegram operational alerts. Worker/Layer 3/D1 validation and labelled failure/recovery message transport are complete.
5. Confirm Browser artifacts contain no Cart token, customer data or credentials.

The owner approved a partial exception on September 3: start Layer 1/2/3 and self-health observation while Layer 4 remains paused and unvalidated. Full acceptance still requires the GA4 checks above. Shadow must not send business Telegram or write production heartbeat.

Validation counter: Layer 2 pre-observation Central Daily `3/3`; Central Post-deploy `3/3`, with clean evidence scans. Credentials, Telegram transport, Dispatcher synchronization, GA4 state isolation and Layer 3 Shadow isolation pass. Partial Shadow started September 3, 17:35 MYT; the owner subsequently waived the review and approved partial Live at 18:09 MYT after the additional Daily gate passed. GA4 permission repair and unrestricted Daily Primary/Confirm remain pending. No Worker deployment was performed for this partial cutover.

- PR [#29](https://github.com/anpuuuuu/apgo-storefront-monitoring/pull/29), `e6485d2`, gates the central Layer 4 schedule and its watchdog recovery with `MONITOR_LAYER4_PAUSED`; explicit manual diagnostics remain available only when intentionally requested. CI passed including 45 Worker/helper tests and 45 Layer 2/config tests.
- Initial Shadow self-health [33739743499](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33739743499) succeeded. The real watchdog reports Layer 4 `paused_by_owner`, `accepted=false`, and did not dispatch it. Layer 3 evidence was verified without refreshing production heartbeat.
- Initial observation Daily [33739738531](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33739738531) completed successfully: 15/15 first-attempt successes, no failed/missing/transient results or rate-limit circuit, exact Theme SHA and clean evidence scan. It was the final gate for the owner-approved partial cutover, not a production heartbeat write.
- Theme PR [#13](https://github.com/anpuuuuu/apgo-theme/pull/13), `eb3b709`, introduced the GA4-only legacy watchdog (29 local tests passed). Central Live self-health [33742782522](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742782522) and legacy GA4-only check [33742785483](https://github.com/anpuuuuu/apgo-theme/actions/runs/33742785483) both passed. The central self-test wrote `apgo-my:layer3` at `2026-09-03T10:09:44.111Z`; the legacy check skipped Layer 1/2/3 work and retained GA4 recovery.

## Next actions in order

1. First Live Post-deploy [33742755562](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742755562) has completed successfully; summary is `ok` with no failed/missing/transient journeys. Final manual Live Daily [33748270647](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33748270647) is running. Require its complete results and `playwright-central-daily` heartbeat, and separately verify actual scheduled Daily execution. Keep the valid prior official Daily heartbeat meanwhile; never manufacture it from Post-deploy. No Codex review automation remains; cloud monitoring continues independently.
2. The owner has resumed full migration; Google reauthentication is still pending. Verify the correct Property/service account and remove only the approved revenue restriction while keeping Viewer; inherited wider scope needs confirmation. Follow the single-writer GA4 acceptance sequence in [FINAL-CUTOVER.md](FINAL-CUTOVER.md). Until then keep central Layer 4 paused and do not count it as accepted.
3. Do not describe partial Live as complete four-layer migration. Central Layer 4 stays paused and old Theme GA4/watchdog stays operational until separate acceptance and cutover approval.
4. Final cleanup is deferred: retain Theme `monitoring/**`, rollback workflows, WIF and credentials. They are still required by official GA4. Keep Layer 3 storefront snippet/reporting code permanently in Theme.

## Cutover and rollback

Current partial cutover and the exact operational rollback are documented in [CUTOVER-LAYER23.md](CUTOVER-LAYER23.md). Rollback Central to Shadow with schedules off, account for in-flight runs, restore Theme scope `all` and enable its Layer 2 workflow. Keep old GA4 active. No Error Worker rollback or reverse D1 migration is needed for this partial switch. The original full-migration sequence in [MIGRATION.md](MIGRATION.md) is not permission to remove active GA4 dependencies.

## Safety rules

- Unknown Site/Repository ID/SHA/config must fail as `TEST_CONFIG_STALE`; never fall back to another site or latest Theme Head.
- GA4/WIF/D1/heartbeat failures must exit non-zero; never skip and show green.
- Browser tests block analytics and must stop before submitting Checkout/payment.
- No JSON service-account key, long-lived PAT or credential may enter source, D1 or artifacts.
- Preserve the local D1 backup until cutover and rollback windows are complete.
