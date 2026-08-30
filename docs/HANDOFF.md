# APGO Central Monitoring Handoff

Updated: 2026-08-30 (MYT)

## Current state

- Central public repository: `anpuuuuu/apgo-storefront-monitoring` (`1349617089`).
- Theme repository: `anpuuuuu/apgo-theme` (`1154313539`).
- Migration source tag: `monitoring-migration-source-fa976c1`.
- Central `main` is protected: PR required, `test` required, force-push/deletion disabled.
- Central mode is deliberately safe: `MONITOR_MODE=shadow` and `MONITOR_SCHEDULE_ENABLED=false`.
- Existing Theme Repo workflows remain the official alert source. Do not disable them yet.
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

## Production resources

- Error Worker: `https://apgo-error-monitor.wadeyeh.workers.dev`
- Dispatcher: `https://apgo-monitor-dispatcher.wadeyeh.workers.dev`
- D1: `apgo-monitoring` / `c75e84af-67df-4761-a559-2b0c1d904989`
- Dispatcher KV: `apgo-monitor-dispatch-deliveries` / `640c1b6bdbd442c18c28ba6c83a63566`
- GA4 Property: `547019474`
- GCP project: `helical-canto-505209-j7` (`223821071753`)
- GA4 service account: `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`

## Remaining external setup

The GitHub App, installation and Dispatcher authentication are complete. The remaining credentials are:

- New least-privilege `CF_API_TOKEN` scoped only to the two Workers, D1 and KV.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (copy from the secure owner record or rotate; existing secret values cannot be read back).
- Add the Telegram token/chat ID to both the central Repository Secrets and Dispatcher Worker secrets.

Never copy credentials into this public Repo, logs or artifacts.

## Required validation before Shadow

1. Send one controlled no-content Theme `main` Push and verify the Dispatcher launches exactly one Central Post-deploy run for the exact full SHA. Replay its delivery ID and confirm deduplication.
2. Manually run Layer 2 Daily three times and Post-deploy three times.
3. Validate Layer 4 realtime/daily GA4 access through the new WIF provider.
4. Validate Error Worker health, Layer 3 self-test, D1 writes and Telegram operational alerts.
5. Confirm Browser artifacts contain no Cart token, customer data or credentials.

Only then set `MONITOR_SCHEDULE_ENABLED=true` while keeping `MONITOR_MODE=shadow` for 48 hours. Shadow must not send business Telegram or write production heartbeat.

Validation counter as of this update: Central Daily `0/3`; Central Post-deploy `0/3`. WIF, exact Theme SHA, GA4 discovery, GitHub App authentication, signed Dispatcher ping and selected-repository installation all pass. The latest official Theme Post-deploy run `33305592587` completed successfully after the Layer 2 root fixes. The 48-hour Shadow window has not started.

## Next actions in order

1. Add the remaining least-privilege Cloudflare and Telegram secrets; verify they do not appear in logs or artifacts.
2. Perform the controlled Theme Push/duplicate-delivery test described above.
3. Run Central Layer 2 Daily three times and Post-deploy three times; all six must complete without Storefront false failures or monitor rate-limit masking.
4. Manually validate Layer 3 self-test, Layer 4 realtime/daily WIF queries, Worker health, D1 writes, Telegram failure notification and recovery notification.
5. Set `MONITOR_SCHEDULE_ENABLED=true` while keeping `MONITOR_MODE=shadow`, then compare Central and Theme results for 48 hours.
6. If results match, disable the old Theme schedules and switch Central to `MONITOR_MODE=live`; observe another 48 hours.
7. Only after the live window succeeds, remove Theme `monitoring/**` and old workflows, retain the Layer 3 storefront snippet/reporting code, and revoke old WIF/Cloudflare/GitHub credentials.

## Cutover and rollback

After 48 hours of matching central/Theme results:

1. Disable the six Theme monitoring workflows.
2. Set central `MONITOR_MODE=live`.
3. Observe another 48 hours for missing/duplicate Push, schedules, alerts and heartbeat.
4. Remove Theme `monitoring/**` and old workflows only after stability; retain the Layer 3 Theme snippet/layout/cart-error code and a pointer to this Repo.
5. Revoke the old WIF binding and old Cloudflare/GitHub secrets after the final stability window.

Rollback: re-enable Theme workflows, set central mode back to `shadow`, and deploy the Error Worker commit preceding namespace rollout. Do not reverse or drop D1 data.

## Safety rules

- Unknown Site/Repository ID/SHA/config must fail as `TEST_CONFIG_STALE`; never fall back to another site or latest Theme Head.
- GA4/WIF/D1/heartbeat failures must exit non-zero; never skip and show green.
- Browser tests block analytics and must stop before submitting Checkout/payment.
- No JSON service-account key, long-lived PAT or credential may enter source, D1 or artifacts.
- Preserve the local D1 backup until cutover and rollback windows are complete.
