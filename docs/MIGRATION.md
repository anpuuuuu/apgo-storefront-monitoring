# Central monitoring migration runbook

**Current operational state (2026-09-03): full Live ownership since 20:26 MYT.** Central manual Daily, GA4 and self-health acceptance passed; existing Error Worker deployment is owned by protected central main. Theme monitoring code/workflows are retired with frontend trees unchanged. The automatic post-retirement check completed at 21:03 MYT, 13/13 first-attempt passes on the exact retired Theme commit; Daily heartbeat remains independent. Old Theme WIF provider is disabled, its service account binding removed, and all Theme repository Actions Secrets are deleted. The old CF token identity is resolved; no non-monitoring resource use was observed in the audited account/time window, but provider-side revocation is deferred pending definitive sharing disposition. Actual post-cutover scheduled runs remain to be verified, including September 4 Daily; a bounded read-only follow-up is configured. See [FINAL-CUTOVER.md](FINAL-CUTOVER.md). The initial setup and Shadow steps below are historical, not instructions to re-enable the old monitoring owner.

## Identities

- Central repository: `anpuuuuu/apgo-storefront-monitoring` (`1349617089`)
- APGO MY Theme repository: `anpuuuuu/apgo-theme` (`1154313539`)
- Source tag: `monitoring-migration-source-fa976c1`
- Error Worker: `apgo-error-monitor`
- Dispatcher Worker: `apgo-monitor-dispatcher`
- D1: `apgo-monitoring` (`c75e84af-67df-4761-a559-2b0c1d904989`)

Repository IDs and full 40-character SHAs are security boundaries. A repository name alone is never accepted as Theme identity.

## Safe initial state

1. Set Repository Variable `MONITOR_MODE=shadow`.
2. Leave `MONITOR_SCHEDULE_ENABLED` unset until manual Layer 1–4 validation succeeds.
3. Do not disable the Theme Repo workflows.
4. Do not deploy the central Error Worker before a D1 backup and migration approval.

## GitHub App

The private App is active with App ID `4769661` and installation ID `157699088`:

- Repository permissions: Contents Read, Actions Write, Metadata Read.
- Event: Push.
- Webhook URL: `${MONITOR_DISPATCHER_URL}/github/webhook`.
- Install only on `apgo-theme` and `apgo-storefront-monitoring`.

Store the App ID as `MONITOR_GITHUB_APP_ID`; store the PEM and Webhook Secret as `MONITOR_GITHUB_APP_PRIVATE_KEY` and `MONITOR_GITHUB_WEBHOOK_SECRET`. The Dispatcher validates the raw request body, repository ID, `refs/heads/main`, full SHA and delivery ID before requesting a one-hour installation token scoped to the central Repo.

Current verification:

- Repository selection is `selected` and contains exactly the Theme and central repositories.
- Hook ID `672281738` is active with SSL verification, JSON content type and only the Push event.
- GitHub's real Ping delivery returned HTTP 202 from the Dispatcher.
- The retained private-key fingerprint is `SHA256:jDLaQwEqxqoAzk7XW53PJuA0L633l3MK2XlocDwvaYM=`. Do not commit or copy the PEM into this public repository.

For future webhook-secret rotation, run `scripts/sync-github-app-webhook.ps1` with the App ID and local PEM path. It authenticates and verifies that the App hook exists before changing the central/Dispatcher secrets, updates the hook, and requires a signed Dispatcher ping to return HTTP 202.

KV namespace `apgo-monitor-dispatch-deliveries` is bound as `DELIVERIES` in `workers/dispatcher/wrangler.jsonc`. Deploy the Dispatcher manually after its GitHub App secrets exist. Duplicate deliveries remain deduplicated for seven days.

## WIF

Create provider `apgo-storefront-monitoring` in project `helical-canto-505209-j7`, restricted to GitHub `repository_id == 1349617089`. Grant its principal `roles/iam.workloadIdentityUser` on `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`. Set the complete provider resource as Repository Variable `GCP_WIF_PROVIDER`. Do not create a JSON key; keep the old Theme provider throughout Shadow.

## D1 and token transition

1. Export D1 with Wrangler and preserve the artifact.
2. Apply `workers/error-monitor/migrations/0004-site-namespace.sql`.
3. A new central `MONITOR_HEARTBEAT_TOKEN` is created and the running Worker receives it as `MONITOR_HEARTBEAT_TOKEN_NEXT`; its existing `MONITOR_HEARTBEAT_TOKEN` remains the old Theme token.
4. Deploy Error Worker without replacing its existing secrets. New writes use `apgo-my:layerN`; `/health` temporarily reads new keys first and legacy keys second.
5. After Cutover stability, remove the current/old token and legacy WIF binding. Do not delete D1 history.

## Shadow and Cutover

Historical exception: on September 3 the owner first approved partial Shadow, then waived the 48-hour review and approved partial Live. GA4 subsequently passed unrestricted acceptance and its central pause was removed. The original sequence below is retained as context; current ownership and exact credential-retirement exceptions are in [FINAL-CUTOVER.md](FINAL-CUTOVER.md).

1. Add the remaining central `CF_API_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; also add Telegram credentials to the Dispatcher.
2. Send one controlled no-content Theme `main` Push and verify exact-SHA dispatch plus delivery-ID deduplication. Completed on 2026-08-30 with Theme SHA `cfa1bf975157088fc44f32af0023574b2c46c2cc` and delivery `fc7cd1ea-a464-11f1-8a91-d04cef06f4e8`; replay was deduplicated.
3. Run Layer 2 Daily and Post-deploy three times each, Layer 3 self-test, Layer 4 validate, Dispatcher invalid-signature tests and Worker health.
4. Enable `MONITOR_SCHEDULE_ENABLED=true` while keeping `MONITOR_MODE=shadow` for 48 hours. Shadow runs fail visibly and upload results, but do not write production Heartbeat or send business Telegram.
5. Compare central results with the Theme Repo. Any mismatch blocks Cutover.
6. Disable the six Theme monitoring workflows, set central `MONITOR_MODE=live`, and transfer Error Worker deployment ownership.
7. Observe 48 hours for duplicate/missing Push, Schedule, D1, Telegram and Heartbeat events.
8. Remove `monitoring/**` and old workflows from Theme only after stability. Retain the Layer 3 snippet/layout references/cart-error reporting and a pointer to this Repo.

Rollback: re-enable the Theme workflows, set central mode to `shadow`, and deploy the Error Worker commit preceding the namespace rollout. No reverse D1 migration is required.
