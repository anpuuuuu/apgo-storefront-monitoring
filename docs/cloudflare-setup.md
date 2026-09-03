# Cloudflare 设置（Layer 1、3 与 Heartbeat）

监控复用 APGO Cloudflare 账号中的：

- D1 数据库 `apgo-monitoring`：保存 uptime、Heartbeat、前端错误和告警状态。
- Worker `apgo-error-monitor`：执行五分钟存活检测、接收浏览器错误，并提供 `/health` 与受保护的 `/heartbeat`。

## GitHub Secrets

打开 [Central Repo Actions secrets](https://github.com/anpuuuuu/apgo-storefront-monitoring/settings/secrets/actions)，重新建立所需值；GitHub 无法读取旧 Repo 的 Secret。

| Name | 用途 |
|---|---|
| `CF_API_TOKEN` | 部署 Worker、执行 D1 Migration 和 Layer 4 状态读写 |
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `TELEGRAM_BOT_TOKEN` | 正式告警 |
| `TELEGRAM_CHAT_ID` | 告警目标群组 |
| `MONITOR_HEARTBEAT_TOKEN` | GitHub 与 Worker 间的 Heartbeat 认证 |

中央 Cloudflare API Token 需要选定账户的 Workers Scripts / Edit、D1 / Edit 和 Dispatcher 去重用的 Workers KV Storage / Edit。当前 Token 是账户级授权，不应描述为仅限单个 Worker。Token 不要写入文件、Workflow 日志或对话。

建议在 Repo 根目录运行 `& .\scripts\configure-production-secrets.ps1`，并且只在脚本显示 `1/3`、`2/3`、`3/3` 的隐藏输入提示后粘贴对应值。若终端只显示普通 `PS>` 提示，先不要粘贴任何 Token。脚本会先在线验证凭证，再通过标准输入写入 GitHub Secrets，不会显示凭证内容。

实际双 Token 配置：旧 Theme GitHub Secret 对应 Error Worker 的 `MONITOR_HEARTBEAT_TOKEN`；中央 GitHub Secret 同名，但对应 Worker 的 `MONITOR_HEARTBEAT_TOKEN_NEXT`。代码同时接受两者，**没有**名为 `MONITOR_HEARTBEAT_TOKEN_CURRENT` 的配置。只有旧 Layer 4 和旧自检全部退役后才能撤销旧值；先保留已验证的中央 NEXT，再逐步收敛，不能同时移除两者。Dispatcher App 私钥/Webhook Secret 与这组 Heartbeat Token 无关，不能随旧 Theme 退役删除。

## 首次部署

1. 手动运行 [Deploy monitoring Workers](https://github.com/anpuuuuu/apgo-storefront-monitoring/actions/workflows/deploy-worker.yml)。
2. 只允许从受保护的 `main` 部署。D1 Migration 默认关闭，仅明确选择 `apply_d1_migration=true` 才先备份并应用；普通部署不自动迁移。
3. 第一次部署保持 `CRON_ENABLED=false`，避免未验证前正式告警。
4. 从日志取得 `workers.dev` URL，设置 Repository Variable `MONITOR_WORKER_URL`。
5. 将 `${MONITOR_WORKER_URL}/beacon` 写入 `snippets/apgo-error-monitor.liquid`。
6. 验证 `/health`、Heartbeat、非法 Origin、Layer 3 self-test、D1 与 Telegram。
7. 全部通过后才把 `CRON_ENABLED` 改为 `true` 重新部署。

当前中央部署 Workflow 会同步 Dispatcher Secrets，但不会自动覆写 Error Worker Secrets；Error Worker 部署保留既有密钥。凭证退役必须单独核对 Secret 名称、用途与已验证的中央心跳，不能以普通部署成功代替密钥验证。

本节首次部署步骤不适用于当前在用的 Worker：URL、Cron 和 D1 已正式运行，完成 Repo 迁移不需要改 Theme snippet 或关掉 Cron。当前接管/回退应以 [CUTOVER-LAYER23.md](CUTOVER-LAYER23.md) 和 [FINAL-CUTOVER.md](FINAL-CUTOVER.md) 为准。

## 回退

紧急时把 `CRON_ENABLED` 改回 `false` 并重新部署。Theme 的 Error Monitor 所有发送均为 fail-safe，不会阻止页面渲染、加购或 Checkout。
