# GA4 授权设置（GitHub OIDC，无 JSON key）

第 4 层读取 GA4 的 `add_to_cart` 事件数，与历史基线比对；白天连续为 0 时才进入告警判断。GitHub Actions 通过 Google Workload Identity Federation（WIF）取得短期只读凭证，仓库和电脑都不保存服务账号 JSON key。

## 已建立的 Google Cloud 配置

| 项目 | 值 |
|---|---|
| Google Cloud Project ID | `helical-canto-505209-j7` |
| Project Number | `223821071753` |
| 服务账号 | `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com` |
| Workload Identity Pool | `github-actions` |
| OIDC Provider | `apgo-theme` |
| 授权仓库 | `anpuuuuu/apgo-theme`（repository ID `1154313539`） |
| GA4 Property ID | `547019474` |

Provider 只接受 GitHub OIDC token 中 `repository_id == 1154313539` 的请求。服务账号只授予该 repository principal `roles/iam.workloadIdentityUser`，GitHub workflow 取得的 access token scope 也限制为 `analytics.readonly`。

## GitHub Repository Variables

打开 [GitHub Actions variables](https://github.com/anpuuuuu/apgo-theme/settings/variables/actions)，确认存在：

| Name | Value |
|---|---|
| `GA4_PROPERTY_ID` | `547019474` |
| `GCP_WIF_PROVIDER` | `projects/223821071753/locations/global/workloadIdentityPools/github-actions/providers/apgo-theme` |

它们是资源识别资料，不是凭证，因此使用 Repository Variables 而不是 Secrets。不要建立 `GCP_SA_KEY`。

## GA4 权限

在 GA4 的 **Admin → Property access management** 中，服务账号必须是当前 apgo.my Property 的 **Viewer**：

`codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`

如果 workflow 的 Google 认证成功、但 Analytics Data API 返回 `403 PERMISSION_DENIED`，先检查这里，而不是创建 JSON key。

## Workflow 门槛验证

1. 打开 [Error and metrics alerts workflow](https://github.com/anpuuuuu/apgo-theme/actions/workflows/monitor-alerts.yml)。
2. 选择 **Run workflow**，开启 `validate_ga4` 后运行。
3. 查看 `GA4 add_to_cart anomaly` job 的日志。
4. 日志会列出 realtime event names，并明确说明有没有 `add_to_cart`。

验证通过后，workflow 会按小时以 observe 模式运行。若 realtime API 没有 `add_to_cart`，停止使用“实时为零”逻辑，改用延迟的 `runReport` 日环比或自建前端事件计数，不能把“采集方式不同”误报成“网站无法加购”。

## 常见故障

- `Unable to exchange GitHub OIDC token`：检查 workflow 是否有 `permissions: id-token: write`，以及 `GCP_WIF_PROVIDER` 是否为上表的完整 provider 路径。
- `iam.serviceAccounts.getAccessToken denied`：检查服务账号 IAM 是否仍有 repository ID `1154313539` 对应的 `roles/iam.workloadIdentityUser` binding。
- Analytics API `403`：检查服务账号是否仍是 GA4 Property Viewer。
- 新建或修改 WIF 后立刻失败：Google IAM 配置传播可能需要几分钟，稍后重跑。

## 安全原则

- 不下载、不传递、不提交服务账号 JSON key。
- 不把 OAuth access token 写入日志或文件；它由 GitHub job 临时生成并在短时间内失效。
- 需要更换仓库时，以新仓库的 immutable repository ID 建立新的 attribute binding，不使用可被改名或抢注的仓库名称作为唯一授权条件。
