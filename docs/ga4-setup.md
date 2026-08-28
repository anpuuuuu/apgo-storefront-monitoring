# GA4 授权设置（GitHub OIDC，无 JSON key）

第 4 层每 30 分钟读取 GA4 实时漏斗，并每天计算 MY/SG、设备、商品组与页面组表现。GitHub Actions 通过 Google Workload Identity Federation（WIF）取得短期只读凭证，仓库和电脑都不保存服务账号 JSON key。

## 已建立的 Google Cloud 配置

| 项目 | 值 |
|---|---|
| Google Cloud Project ID | `helical-canto-505209-j7` |
| Project Number | `223821071753` |
| 服务账号 | `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com` |
| Workload Identity Pool | `github-actions` |
| 新 OIDC Provider | `apgo-storefront-monitoring`（待建立） |
| 新授权仓库 | `anpuuuuu/apgo-storefront-monitoring`（repository ID `1349617089`） |
| GA4 Property ID | `547019474` |

新 Provider 只接受 GitHub OIDC token 中 `repository_id == 1349617089` 的请求。旧 Theme Provider 在 Shadow 期间保留；Cutover 稳定后再撤销。Workflow access token scope 继续限制为 `analytics.readonly`。

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

## Workflow 门槛验证

1. 打开 [GA4 business monitoring workflow](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/workflows/monitor-alerts.yml)。
2. 选择 **Run workflow**，将 `mode` 设为 `validate` 后运行。
3. 查看 `Run GA4 monitoring` 的日志。
4. 日志会列出最近 30 分钟五个漏斗事件与历史同期中位数，并在成功后写入 Layer 4 Heartbeat。

验证通过后，workflow 每小时第 19、49 分钟以 observe 模式运行；每日 MYT 12:17 初算前一天，14:47 复核。业务异常先观察 14 天，API/Auth/Workflow 故障从第一天正式告警。

## 常见故障

- `Unable to exchange GitHub OIDC token`：检查 workflow 是否有 `permissions: id-token: write`，以及 `GCP_WIF_PROVIDER` 是否为上表的完整 provider 路径。
- `iam.serviceAccounts.getAccessToken denied`：检查服务账号 IAM 是否仍有 repository ID `1154313539` 对应的 `roles/iam.workloadIdentityUser` binding。
- Analytics API `403`：检查服务账号是否仍是 GA4 Property Viewer。
- 新建或修改 WIF 后立刻失败：Google IAM 配置传播可能需要几分钟，稍后重跑。

## 安全原则

- 不下载、不传递、不提交服务账号 JSON key。
- 不把 OAuth access token 写入日志或文件；它由 GitHub job 临时生成并在短时间内失效。
- 需要更换仓库时，以新仓库的 immutable repository ID 建立新的 attribute binding，不使用可被改名或抢注的仓库名称作为唯一授权条件。
