# Final central ownership and legacy retirement

## Goal and current gates (2026-09-03)

The owner requested completion of the remaining migration, including GA4 acceptance, Central Daily heartbeat, and safe retirement of the old Theme monitoring. No new 48-hour Shadow wait was requested. This is not permission to silently widen GA4 access, revoke unrelated/shared credentials, or change storefront commerce/tracking.

- Central Live Post-deploy [33742755562](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33742755562) completed successfully at 10:42 UTC. Its summary reports `ok`, with no failed, missing or transient journeys. Theme source is `eb3b709f226d749bc341428409ed0a0c17856301`.
- Central **Live Daily** [33748270647](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33748270647) completed successfully at 11:40:34 UTC. Downloaded plan, batch and aggregate evidence contains 15 expected/15 received unique journeys, all passed on their first attempt, with zero failed/missing/transient results. Every result uses exact Theme SHA `eb3b709f226d749bc341428409ed0a0c17856301`. `/health` independently confirms `apgo-my:layer2`, source `playwright-central-daily`, status `ok`, observed at `2026-09-03T11:40:31.963Z`. This verifies manual Live Daily acceptance, not scheduled execution.
- After the owner's explicit confirmation, the service account's direct Property `547019474` No Revenue Metrics restriction was removed and saved. The resulting GA4 access screen confirms **Viewer, No Cost Metrics**; no account-level, Editor, Administrator or cost access was added. API acceptance below now passes. Google Cloud requires separate identity verification before old WIF retirement.
- **Full Live ownership enabled at 12:26 UTC / 20:26 MYT**: central mode Live, schedules enabled, Layer 4 pause false. All six Theme monitoring workflows are disabled with no in-flight legacy runs. The existing Error Worker was deployed successfully from protected central main; its URL/D1/Cron remain unchanged.
- Pre-retirement rollback tag was pushed and remotely verified: Theme `monitoring-pre-retirement-20260903` resolves to `eb3b709f226d749bc341428409ed0a0c17856301`. It is a recovery baseline, not a claim that retirement happened. Before any deletion, re-read current Theme main and preserve subsequent unrelated edits.
- Theme [PR #14](https://github.com/anpuuuuu/apgo-theme/pull/14) retired all 65 tracked monitoring/workflow files and added `MONITORING.md`, merged as `65546a24ba91a607e50e37013931db884b39a1ab`. Post-merge Git comparison proves the entire assets/blocks/config/layout/locales/sections/snippets/templates trees are byte-identical to the rollback tag; the Layer 3 snippet and all layout/cart reporting remain. Untracked local artifacts were preserved. Theme contract validation passed against this retired tree.
- Old WIF Provider is exactly `projects/223821071753/locations/global/workloadIdentityPools/github-actions/providers/apgo-theme`. Live IAM policy inspection via gcloud failed on required reauthentication; no provider or binding was changed. Confirm actual binding/condition before revocation, never infer it from this variable alone.

## Final acceptance evidence

All GA4 runs below used central commit `5aaeeacdc194088f4eff5293fa40e4c878f3bc22`, Live transport and Observe business mode. Old GA4/watchdog were stopped before the first stateful central check.

| Check | Run | Evidence |
| --- | --- | --- |
| Read-only revenue diagnostic | [33754714651](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33754714651) | All three reports unrestricted, positive purchase/item revenue; raw values suppressed |
| Validate | [33754805580](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33754805580) | Queries, storefront health and Live heartbeat succeeded |
| Daily Primary | [33754934057](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33754934057) | Target `20260902`, generated `2026-09-03T12:23:56.634Z`, positive revenue, no data-quality codes |
| Daily Confirm | [33755039926](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33755039926) | Same target; `primaryGeneratedAt` exactly matches this Primary, not the old restricted report |
| Realtime | [33755108270](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33755108270) | Success; D1 heartbeat at `12:25:50.964Z` points to this central run |
| Full central self-health | [33755242476](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33755242476) | Daily and GA4 freshness both verified; independent Layer 3 self-test succeeded |
| Error Worker deployment | [33755751378](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33755751378) | Existing Worker version `15aec2ca-7062-4dc0-9438-b1430c4a3777`; same URL and `*/5 * * * *`; no D1 migration |
| Post-deployment self-health | [33755924252](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33755924252) | Central NEXT-only authentication succeeded; Layer 3 heartbeat `12:34:14.802Z` |

Independent read-only D1 queries confirmed the new Live Daily candidate under `apgo-my:ga4:daily:candidate:20260902` with the expected timestamp and positive transaction/revenue flags. Namespaced Layer 2 and Layer 4 heartbeats point to central runs; unnamespaced historical heartbeat rows remain unchanged from August 28. The automatic Theme-retirement Post-deploy run [33755569816](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/runs/33755569816) is still running at this record; do not launch a duplicate.

## Credential retirement status

- Error Worker legacy `MONITOR_HEARTBEAT_TOKEN` was deleted. Its central `MONITOR_HEARTBEAT_TOKEN_NEXT` and shared Telegram secrets remain; NEXT-only operation was verified after central deployment.
- Theme GitHub secrets `CF_ACCOUNT_ID`, `MONITOR_HEARTBEAT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and all four monitoring variables were removed. No Theme environments exist. The shared Telegram bot itself was not revoked.
- Theme `CF_API_TOKEN` remains temporarily for exact identity resolution. The Cloudflare account has a new dedicated `APGO Central Monitoring - 2026-09` token and several broad/general tokens; names alone cannot prove which old token is monitoring-only or unused elsewhere. The owner has been asked to identify the old token and sharing. Do not guess or revoke a generic token, and do not publish its value.
- Old Google provider/principal retirement remains pending the separate Google Cloud identity challenge. Central provider/service account/pool must be retained.

## Cutover checklist (steps 1–5 executed; credential gates remain)

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
- GA4 revenue is now readable. Before enabling restored legacy GA4, backport the public-log privacy protection; the pre-retirement Daily script printed financial summaries. File recovery alone is not safe authorization to start that old script.

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
