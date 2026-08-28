# Central monitoring migration runbook

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

Create private App `APGO Storefront Monitor` with:

- Repository permissions: Contents Read, Actions Write, Metadata Read.
- Event: Push.
- Webhook URL: `${MONITOR_DISPATCHER_URL}/github/webhook`.
- Install only on `apgo-theme` and `apgo-storefront-monitoring`.

Store the App ID as `MONITOR_GITHUB_APP_ID`; store the PEM and Webhook Secret as `MONITOR_GITHUB_APP_PRIVATE_KEY` and `MONITOR_GITHUB_WEBHOOK_SECRET`. The Dispatcher validates the raw request body, repository ID, `refs/heads/main`, full SHA and delivery ID before requesting a one-hour installation token scoped to the central Repo.

Create KV namespace `apgo-monitor-dispatch-deliveries`, replace the zero placeholder in `workers/dispatcher/wrangler.jsonc`, then deploy the Dispatcher manually. Duplicate deliveries remain deduplicated for seven days.

## WIF

Create provider `apgo-storefront-monitoring` in project `helical-canto-505209-j7`, restricted to GitHub `repository_id == 1349617089`. Grant its principal `roles/iam.workloadIdentityUser` on `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`. Set the complete provider resource as Repository Variable `GCP_WIF_PROVIDER`. Do not create a JSON key; keep the old Theme provider throughout Shadow.

## D1 and token transition

1. Export D1 with Wrangler and preserve the artifact.
2. Apply `workers/error-monitor/migrations/0004-site-namespace.sql`.
3. Set old token as `MONITOR_HEARTBEAT_TOKEN_CURRENT` and new token as `MONITOR_HEARTBEAT_TOKEN`.
4. Deploy Error Worker once with both token secrets. New writes use `apgo-my:layerN`; `/health` temporarily reads new keys first and legacy keys second.
5. After Cutover stability, remove the current/old token and legacy WIF binding. Do not delete D1 history.

## Shadow and Cutover

1. Run Layer 2 Daily and Post-deploy three times each, Layer 3 self-test, Layer 4 validate, Dispatcher invalid-signature tests and Worker health.
2. Enable `MONITOR_SCHEDULE_ENABLED=true` while keeping `MONITOR_MODE=shadow` for 48 hours. Shadow runs fail visibly and upload results, but do not write production Heartbeat or send business Telegram.
3. Compare central results with the Theme Repo. Any mismatch blocks Cutover.
4. Disable the six Theme monitoring workflows, set central `MONITOR_MODE=live`, and transfer Error Worker deployment ownership.
5. Observe 48 hours for duplicate/missing Push, Schedule, D1, Telegram and Heartbeat events.
6. Remove `monitoring/**` and old workflows from Theme only after stability. Retain the Layer 3 snippet/layout references/cart-error reporting and a pointer to this Repo.

Rollback: re-enable the Theme workflows, set central mode to `shadow`, and deploy the Error Worker commit preceding the namespace rollout. No reverse D1 migration is required.
