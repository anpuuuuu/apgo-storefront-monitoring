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

## Production resources

- Error Worker: `https://apgo-error-monitor.wadeyeh.workers.dev`
- Dispatcher: `https://apgo-monitor-dispatcher.wadeyeh.workers.dev`
- D1: `apgo-monitoring` / `c75e84af-67df-4761-a559-2b0c1d904989`
- Dispatcher KV: `apgo-monitor-dispatch-deliveries` / `640c1b6bdbd442c18c28ba6c83a63566`
- GA4 Property: `547019474`
- GCP project: `helical-canto-505209-j7` (`223821071753`)
- GA4 service account: `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`

## Remaining external setup

### GitHub App

Create private App `APGO Storefront Monitor` and install it only on the Theme and central repositories.

- Permissions: Contents Read, Actions Write, Metadata Read.
- Event: Push.
- Webhook: `https://apgo-monitor-dispatcher.wadeyeh.workers.dev/github/webhook`.
- Central variable: `MONITOR_GITHUB_APP_ID`.
- Central secrets: `MONITOR_GITHUB_APP_PRIVATE_KEY`, `MONITOR_GITHUB_WEBHOOK_SECRET`.
- Dispatcher Worker secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, Telegram token/chat ID.

The Dispatcher currently has no GitHub App secrets, so real Theme Push dispatch is not active yet.

### Remaining central secrets

- New least-privilege `CF_API_TOKEN` scoped only to the two Workers, D1 and KV.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (copy from the secure owner record or rotate; existing secret values cannot be read back).

Never copy credentials into this public Repo, logs or artifacts.

## Required validation before Shadow

1. Verify a signed Theme `main` Push dispatches the exact full SHA once and duplicate delivery IDs are ignored.
2. Manually run Layer 2 Daily three times and Post-deploy three times.
3. Validate Layer 4 realtime/daily GA4 access through the new WIF provider.
4. Validate Error Worker health, Layer 3 self-test, D1 writes and Telegram operational alerts.
5. Confirm Browser artifacts contain no Cart token, customer data or credentials.

Only then set `MONITOR_SCHEDULE_ENABLED=true` while keeping `MONITOR_MODE=shadow` for 48 hours. Shadow must not send business Telegram or write production heartbeat.

Validation counter as of this update: Central Daily `0/3`; Central Post-deploy `0/3`. The first repaired Central Daily Shadow run was intentionally not counted because an older Theme Post-deploy run overlapped it and caused synthetic rate limiting. WIF, exact Theme SHA and GA4 discovery pass. Official Android full commerce passes. The clean Theme Post-deploy run `33304748324` has already passed its MY/SG iPhone WebKit read-only checks, including the previously failing detergent option path, and is still completing the remaining serial journeys. Central validation resumes only after that run finishes. The 48-hour Shadow window has not started.

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
