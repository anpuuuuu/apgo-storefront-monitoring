# Final central ownership and legacy retirement

## Goal and current gates (2026-09-03)

The owner requested completion of the remaining migration, including GA4 acceptance, Central Daily heartbeat, and safe retirement of the old Theme monitoring. No new 48-hour Shadow wait was requested. This is not permission to silently widen GA4 access, revoke unrelated/shared credentials, or change storefront commerce/tracking.

- Central Live Post-deploy [33742755562](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742755562) completed successfully at 10:42 UTC. Its summary reports `ok`, with no failed, missing or transient journeys. Theme source is `eb3b709f226d749bc341428409ed0a0c17856301`.
- Central **Live Daily** [33748270647](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33748270647) completed successfully at 11:40:34 UTC. Downloaded plan, batch and aggregate evidence contains 15 expected/15 received unique journeys, all passed on their first attempt, with zero failed/missing/transient results. Every result uses exact Theme SHA `eb3b709f226d749bc341428409ed0a0c17856301`. `/health` independently confirms `apgo-my:layer2`, source `playwright-central-daily`, status `ok`, observed at `2026-09-03T11:40:31.963Z`. This verifies manual Live Daily acceptance, not scheduled execution.
- After the owner's explicit confirmation, the service account's direct Property `547019474` No Revenue Metrics restriction was removed and saved. The resulting GA4 access screen confirms **Viewer, No Cost Metrics**; no account-level, Editor, Administrator or cost access was added. Central API acceptance is next. CLI IAM reauthentication is a separate gate.
- Central Layer 4 remains paused; Theme GA4 and its GA4-only watchdog remain official. Existing Layer 1/3 Worker remains active. Old code, WIF and secrets are not retired yet.
- Pre-retirement rollback tag was pushed and remotely verified: Theme `monitoring-pre-retirement-20260903` resolves to `eb3b709f226d749bc341428409ed0a0c17856301`. It is a recovery baseline, not a claim that retirement happened. Before any deletion, re-read current Theme main and preserve subsequent unrelated edits.
- Read-only dependency audit found only six tracked Theme workflows, all monitoring-owned, and no tracked frontend reference into `monitoring/`. Retain `snippets/apgo-error-monitor.liquid` (baseline blob `4a84619ad4346acfdac1008967fea04aaf93a3a0`) and the entire assets/blocks/config/layout/locales/sections/snippets/templates trees. All six old workflow files and `monitoring/**` still exist.
- Old WIF Provider is exactly `projects/223821071753/locations/global/workloadIdentityPools/github-actions/providers/apgo-theme`. Live IAM policy inspection via gcloud failed on required reauthentication; no provider or binding was changed. Confirm actual binding/condition before revocation, never infer it from this variable alone.

## Remaining sequence and pass criteria

1. Complete the Live Daily above. Inspect every expected result, exact Theme SHA, evidence hygiene and actual successful heartbeat. A completed Post-deploy cannot stand in for Daily. Also confirm the next actual daily schedule through the normal cloud self-health/Actions record.
2. After Google sign-in, inspect the service account on Property `547019474`. Remove only the authorized No Revenue Metrics restriction, keeping Viewer and other restrictions. If it is inherited, establish the wider scope before changing it. Read-only central `diagnose-revenue` must confirm unrestricted metrics; a nonzero transaction count with restricted zero revenue is not acceptance.
3. Before stateful central GA4 checks, stop old GA4 and its GA4-only watchdog and confirm no old run is in flight. Keep central Layer 4 schedule paused during manual acceptance. Run central `validate`, `daily-primary`, then `daily-confirm`, and `realtime`; verify successful queries/state/heartbeat, matching Primary/Confirm date, and no restricted report reuse. Retain `observe` business mode. If acceptance fails, restore old GA4/watchdog and keep central Layer 4 paused; preserve evidence, never leave both writers enabled.
4. Once manual Layer 4 acceptance passes, enable its central schedule/watchdog and confirm all four namespaced production layers and single alert ownership. No additional Worker is needed; retain existing URL, D1, Cron and site namespace. Record the exact accepted central commit and active Worker version for rollback.
5. Retire old workflows and tracked `monitoring/**` only after gates above. Keep the four layouts, `snippets/apgo-error-monitor.liquid`, cart error reporting and all unrelated Theme files byte-identical. Preserve untracked local artifacts. Keep a pre-retirement tag plus a pointer to this repo and a tested restore procedure.
6. Revoke obsolete access only after its replacement is verified: old repo WIF principal/provider, old monitoring-only Cloudflare token (identify exact token first), old Worker heartbeat value, and old Theme monitoring secrets/variables. Do not revoke the shared Telegram bot token, central WIF service account/pool, Dispatcher App/KV or central NEXT token. Deleting a GitHub Secret is not provider-side revocation. Unknown/shared credential ownership requires clarification, not a guessed delete.

## Deployment protection

Pre-retirement audit found `production.deployment_branch_policy=null` despite main branch protection. The environment now uses custom deployment policies with exactly `main`, type `branch` (policy ID `59011150`); a same-name tag is not allowed. Existing environment protection rules were empty and were checked again before the update. The deployment job also has an explicit `github.ref == 'refs/heads/main'` guard with regression coverage. Local Worker/helper tests pass 46/46; Layer 2/config tests pass 45/45; generated site config is synchronized. These controls do not deploy a Worker or alter storefront UI. [GitHub environment API](https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment), [branch policy API](https://docs.github.com/en/rest/deployments/branch-policies#create-a-deployment-branch-policy).

Required CI [33748657228](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33748657228) passed; PR #32 merged as `42d57e4a9f5250ca750c9804c2b5d163b017fcf6`. Negative branch dispatch [33748693678](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33748693678) had its entire deploy job skipped before executing any step. This verifies the main-only guard without deploying a Worker.

## Rollback stages

- Before credentials are revoked: pause central Layer 4, account for in-flight jobs, restore old GA4/watchdog; restore old Layer 2/scope `all` only if rolling back those functions too. Central and legacy must not write the same state concurrently.
- After removing tracked legacy code: restore the exact pre-retirement monitoring files/workflows from the retained tag through a normal reviewed commit, without resetting unrelated Theme changes. Then restore ownership gates.
- After credential retirement: rollback requires freshly authorized replacement credentials/WIF bindings; old revoked tokens cannot be recovered. Keep central monitoring operational until replacement authentication is tested. Never promise one-click rollback after credential revocation.

No D1 reverse migration or historic-data deletion is part of retirement. The final report must distinguish manual acceptance, observed schedules, active ownership and any pending external access.

## Financial-data boundary

With revenue access enabled, public Actions logs must not contain the raw diagnostic rows, Daily revenue/AOV values or nested financial summaries. Diagnostic output is limited to metric-access status and positive-value booleans. Daily output contains target/stage, Primary timestamp, baseline dates, counts of checks/anomalies and quality codes; the full report remains in private D1 state/alert records. Shadow side-effect logs suppress their payloads too. This changes logging only, not queries, thresholds, business mode, stored financial values or customer tracking. Privacy regression tests are part of required CI.

### Verified file restoration (September 3)

A temporary `GIT_INDEX_FILE` was seeded from current Theme main `eb3b709f226d749bc341428409ed0a0c17856301`. All 65 tracked legacy monitoring files (including the six workflows) were removed from that isolated index, then restored from `monitoring-pre-retirement-20260903`. Both complete tree hashes were `4046a61654e1fe97ffb5597e4eca77084465ccd6`. The real index, worktree, remote and storefront were not changed. This proves exact file recovery, not the continued validity of credentials after revocation.

After retirement, restore only these paths in a clean recovery branch based on the then-current Theme main. Inspect local changes before running; stop if any target already contains unreviewed work. Do not reset the Theme repository or replace its frontend tree.

```powershell
git restore --source=monitoring-pre-retirement-20260903 --staged --worktree -- monitoring .github/workflows/deploy-worker.yml .github/workflows/monitor-alerts.yml .github/workflows/monitor-self-health.yml .github/workflows/site-health-v2.yml .github/workflows/site-health.yml .github/workflows/uptime.yml
git diff --cached --stat
git diff --cached --exit-code -- assets blocks config layout locales sections snippets templates
```

The last command must succeed: restoration must not alter any storefront tree. Review the restored workflows and ownership/authentication gates before committing through a normal PR. Scheduled triggers in restored YAML are not permission to run both systems concurrently; keep the legacy workflows disabled until central ownership has been paused and replacement authentication verified. Never enable the old deploy workflow automatically.
