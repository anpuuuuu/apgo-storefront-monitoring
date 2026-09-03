# Final central ownership and legacy retirement

## Goal and current gates (2026-09-03)

The owner requested completion of the remaining migration, including GA4 acceptance, Central Daily heartbeat, and safe retirement of the old Theme monitoring. No new 48-hour Shadow wait was requested. This is not permission to silently widen GA4 access, revoke unrelated/shared credentials, or change storefront commerce/tracking.

- Central Live Post-deploy [33742755562](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742755562) completed successfully at 10:42 UTC. Its summary reports `ok`, with no failed, missing or transient journeys. Theme source is `eb3b709f226d749bc341428409ed0a0c17856301`.
- One Central **Live Daily** [33748270647](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33748270647) was started manually for final acceptance after the preceding cart writer had finished and cooled down. It must produce complete Daily results and `apgo-my:layer2` source `playwright-central-daily`. It is still running at this record; manual acceptance must not be described as proof of scheduled execution.
- GA4 remains at Google reauthentication for `marketing@apgo.com.my`; the owner has been asked to sign in privately. No password/code was requested and no GA4 permissions changed.
- Central Layer 4 remains paused; Theme GA4 and its GA4-only watchdog remain official. Existing Layer 1/3 Worker remains active. Old code, WIF and secrets are not retired yet.

## Remaining sequence and pass criteria

1. Complete the Live Daily above. Inspect every expected result, exact Theme SHA, evidence hygiene and actual successful heartbeat. A completed Post-deploy cannot stand in for Daily. Also confirm the next actual daily schedule through the normal cloud self-health/Actions record.
2. After Google sign-in, inspect the service account on Property `547019474`. Remove only the authorized No Revenue Metrics restriction, keeping Viewer and other restrictions. If it is inherited, establish the wider scope before changing it. Read-only central `diagnose-revenue` must confirm unrestricted metrics; a nonzero transaction count with restricted zero revenue is not acceptance.
3. Before stateful central GA4 checks, stop old GA4 and its GA4-only watchdog and confirm no old run is in flight. Keep central Layer 4 schedule paused during manual acceptance. Run central `validate`, `daily-primary`, then `daily-confirm`, and `realtime`; verify successful queries/state/heartbeat, matching Primary/Confirm date, and no restricted report reuse. Retain `observe` business mode. If acceptance fails, restore old GA4/watchdog and keep central Layer 4 paused; preserve evidence, never leave both writers enabled.
4. Once manual Layer 4 acceptance passes, enable its central schedule/watchdog and confirm all four namespaced production layers and single alert ownership. No additional Worker is needed; retain existing URL, D1, Cron and site namespace. Record the exact accepted central commit and active Worker version for rollback.
5. Retire old workflows and tracked `monitoring/**` only after gates above. Keep the four layouts, `snippets/apgo-error-monitor.liquid`, cart error reporting and all unrelated Theme files byte-identical. Preserve untracked local artifacts. Keep a pre-retirement tag plus a pointer to this repo and a tested restore procedure.
6. Revoke obsolete access only after its replacement is verified: old repo WIF principal/provider, old monitoring-only Cloudflare token (identify exact token first), old Worker heartbeat value, and old Theme monitoring secrets/variables. Do not revoke the shared Telegram bot token, central WIF service account/pool, Dispatcher App/KV or central NEXT token. Deleting a GitHub Secret is not provider-side revocation. Unknown/shared credential ownership requires clarification, not a guessed delete.

## Deployment protection

Pre-retirement audit found `production.deployment_branch_policy=null` despite main branch protection. The environment now uses custom deployment policies with exactly `main`, type `branch` (policy ID `59011150`); a same-name tag is not allowed. Existing environment protection rules were empty and were checked again before the update. The deployment job also has an explicit `github.ref == 'refs/heads/main'` guard with regression coverage. Local Worker/helper tests pass 46/46; Layer 2/config tests pass 45/45; generated site config is synchronized. These controls do not deploy a Worker or alter storefront UI. [GitHub environment API](https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment), [branch policy API](https://docs.github.com/en/rest/deployments/branch-policies#create-a-deployment-branch-policy).

## Rollback stages

- Before credentials are revoked: pause central Layer 4, account for in-flight jobs, restore old GA4/watchdog; restore old Layer 2/scope `all` only if rolling back those functions too. Central and legacy must not write the same state concurrently.
- After removing tracked legacy code: restore the exact pre-retirement monitoring files/workflows from the retained tag through a normal reviewed commit, without resetting unrelated Theme changes. Then restore ownership gates.
- After credential retirement: rollback requires freshly authorized replacement credentials/WIF bindings; old revoked tokens cannot be recovered. Keep central monitoring operational until replacement authentication is tested. Never promise one-click rollback after credential revocation.

No D1 reverse migration or historic-data deletion is part of retirement. The final report must distinguish manual acceptance, observed schedules, active ownership and any pending external access.
