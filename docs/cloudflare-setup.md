# Cloudflare 设置（Layer 1、3 与 Heartbeat）

监控复用 APGO Cloudflare 账号中的：

- D1 数据库 `apgo-monitoring`：保存 uptime、Heartbeat、前端错误和告警状态。
- Worker `apgo-error-monitor`：执行五分钟存活检测、接收浏览器错误，并提供 `/health` 与受保护的 `/heartbeat`。

## GitHub Secrets

打开 [GitHub Actions secrets](https://github.com/anpuuuuu/apgo-theme/settings/secrets/actions)，确认存在：

| Name | 用途 |
|---|---|
| `CF_API_TOKEN` | 部署 Worker、执行 D1 Migration 和 Layer 4 状态读写 |
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `TELEGRAM_BOT_TOKEN` | 正式告警 |
| `TELEGRAM_CHAT_ID` | 告警目标群组 |
| `MONITOR_HEARTBEAT_TOKEN` | GitHub 与 Worker 间的 Heartbeat 认证 |

Cloudflare API Token 最少需要 Account / Workers Scripts / Edit 与 Account / D1 / Edit。Token 不要写入文件、Workflow 日志或对话。

## 首次部署

1. 手动运行 [Deploy APGO monitoring worker](https://github.com/anpuuuuu/apgo-theme/actions/workflows/deploy-worker.yml)。
2. Workflow 先应用 D1 Migration，再部署 Worker。
3. 第一次部署保持 `CRON_ENABLED=false`，避免未验证前正式告警。
4. 从日志取得 `workers.dev` URL，设置 Repository Variable `MONITOR_WORKER_URL`。
5. 将 `${MONITOR_WORKER_URL}/beacon` 写入 `snippets/apgo-error-monitor.liquid`。
6. 验证 `/health`、Heartbeat、非法 Origin、Layer 3 self-test、D1 与 Telegram。
7. 全部通过后才把 `CRON_ENABLED` 改为 `true` 重新部署。

Worker Secrets `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`MONITOR_HEARTBEAT_TOKEN` 由部署 Workflow 注入，不进入代码。

## 回退

紧急时把 `CRON_ENABLED` 改回 `false` 并重新部署。Theme 的 Error Monitor 所有发送均为 fail-safe，不会阻止页面渲染、加购或 Checkout。
