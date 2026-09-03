# GA4 授权设置（GitHub OIDC，无 JSON key）

第 4 层每 30 分钟读取 GA4 实时漏斗，并每天计算 MY/SG、设备、商品组与页面组表现。GitHub Actions 通过 Google Workload Identity Federation（WIF）取得短期只读凭证，仓库和电脑都不保存服务账号 JSON key。

## 已建立的 Google Cloud 配置

| 项目 | 值 |
|---|---|
| Google Cloud Project ID | `helical-canto-505209-j7` |
| Project Number | `223821071753` |
| 服务账号 | `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com` |
| Workload Identity Pool | `github-actions` |
| 新 OIDC Provider | `apgo-storefront-monitoring`（已建立并验证） |
| 新授权仓库 | `anpuuuuu/apgo-storefront-monitoring`（repository ID `1349617089`） |
| GA4 Property ID | `547019474` |

新 Provider 只接受 GitHub OIDC token 中 `repository_id == 1349617089` 的请求。2026-09-03 完成正式接管后，旧 `apgo-theme` Provider 已停用，旧 repository ID `1154313539` 的 Workload Identity User binding 已移除。中央 Provider、Pool、服务账号及 `1349617089` binding 保留。Workflow access token scope 继续限制为 `analytics.readonly`。

2026-09-03 20:26 MYT 起为完整中央 Live：中央 Layer 2/4 使用新 WIF，Layer 4 已解除暂停；六个旧 Theme 监控 Workflow 全部停用。营收诊断、Validate、Primary、Confirm、Realtime、自检和实际心跳已验证。详细运行记录见 [最终接管记录](FINAL-CUTOVER.md)。

## GitHub Repository Variables

打开 [Central Repo Actions variables](https://github.com/anpuuuuu/apgo-storefront-monitoring/settings/variables/actions)，确认存在：

| Name | Value |
|---|---|
| `GCP_WIF_PROVIDER` | `projects/223821071753/locations/global/workloadIdentityPools/github-actions/providers/apgo-storefront-monitoring` |

它们是资源识别资料，不是凭证，因此使用 Repository Variables 而不是 Secrets。不要建立 `GCP_SA_KEY`。

## GA4 权限

在 GA4 的 **Admin → Property access management** 中，服务账号必须是当前 apgo.my Property 的 **Viewer**：

`codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`

如果 workflow 的 Google 认证成功、但 Analytics Data API 返回 `403 PERMISSION_DENIED`，先检查这里，而不是创建 JSON key。

2026-09-03 经用户明确确认，已撤销该 Property 的直接 `No Revenue Metrics` 限制；保存后为 **Viewer、No Cost Metrics**。API 已验证所需营收指标不再受限，无须修改 Tracking。未增加 Editor/Administrator 或费用读取权限。将来若遇到继承限制，不能直接扩大 Account/Group 权限，须先确认影响范围。依据：[Google 数据权限说明](https://support.google.com/analytics/answer/9305587?hl=en)。

## Workflow 门槛验证

1. 打开 [GA4 business monitoring workflow](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/workflows/monitor-alerts.yml)。
2. 选择 **Run workflow**，将 `mode` 设为 `validate` 后运行。
3. 查看 `Run GA4 monitoring` 的日志。
4. 日志会列出最近 30 分钟五个漏斗事件与历史同期中位数，并在成功后写入 Layer 4 Heartbeat。

`validate` 不读取营收，不足以证明 Daily 可用。完整接管还须运行 `diagnose-revenue` 确认 `activeMetricRestrictions` 不再限制所需指标，并让 `daily-primary`、`daily-confirm`、`realtime` 全部通过。同一生产 state 不能由新旧任务并行写入：验证/切换按 [最终接管记录](FINAL-CUTOVER.md) 执行。不得把受限的零值日报当成有效收入基准。

确认切换后才取消 `MONITOR_LAYER4_PAUSED`，让中央每小时第 19、49 分钟运行；每日 MYT 12:17 初算前一天，14:47 复核。沿用 `observe`，本次迁移不自动改为 `armed`；API/Auth/Workflow 故障仍正式告警。

## 常见故障

- `Unable to exchange GitHub OIDC token`：检查 workflow 是否有 `permissions: id-token: write`，以及 `GCP_WIF_PROVIDER` 是否为上表的完整 provider 路径。
- `iam.serviceAccounts.getAccessToken denied`：中央检查 repository ID `1349617089` 对应的 `roles/iam.workloadIdentityUser` binding；`1154313539` 是已撤销的旧 Theme 身份，不能混用或为排错盲目恢复。
- Analytics API `403`：检查服务账号是否仍是 GA4 Property Viewer。
- 新建或修改 WIF 后立刻失败：Google IAM 配置传播可能需要几分钟，稍后重跑。

## 安全原则

- 不下载、不传递、不提交服务账号 JSON key。
- 不把 OAuth access token 写入日志或文件；它由 GitHub job 临时生成并在短时间内失效。
- 需要更换仓库时，以新仓库的 immutable repository ID 建立新的 attribute binding，不使用可被改名或抢注的仓库名称作为唯一授权条件。
