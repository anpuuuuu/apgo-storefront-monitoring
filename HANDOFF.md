# APGO Monitoring Handoff

## 当前设计

- 分支：`codex/monitoring-v2`。
- 所有已提交的 `main` 代码都包含在分支内；另一个 main worktree 的 Cart Offers UI 未提交改动没有被夹带。
- Worker/D1、Layer 2、Layer 3、Layer 4、Heartbeat 与 Workflows 已重构。
- Worker 初始 `CRON_ENABLED=false`，必须完成受控部署验证后才开启。
- GA4 为 `observe`，从 2026-08-20 起至少观察 14 天；API/Auth/Workflow 故障从第一天正式通知。

## 基础设施

- Repo：`anpuuuuu/apgo-theme`
- D1：`apgo-monitoring` / `c75e84af-67df-4761-a559-2b0c1d904989`
- Worker：`apgo-error-monitor`
- GA4 Property：`547019474`
- WIF Provider：repo variable `GCP_WIF_PROVIDER`
- Service Account：`codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`
- `MONITOR_HEARTBEAT_TOKEN` 已创建为 GitHub Secret；不要输出或写进文件。

## 完成上线的顺序

1. Push 分支并手动 dispatch `deploy-worker.yml`；从日志取得 Worker URL。
2. 设置 repo variable `MONITOR_WORKER_URL`。
3. 将同一 URL 写进 Theme snippet、`sites.json` 和 `alerts-config.json`。
4. Worker 保持 Cron 关闭，测试 `/health`、非法 Origin、Payload、Heartbeat、Layer 3 self-test 和 D1。
5. 合并/推送 main，让 Shopify GitHub integration 收到 Theme snippet。
6. 手动跑轻量和 MY/SG 完整 Playwright；全部通过后启用定时。
7. 运行 GA4 validate、daily-primary、daily-confirm。
8. `CRON_ENABLED=true` 后部署；旧 GitHub Uptime 并行 24 小时再移除 schedule。

## 不可误报原则

- 缺 Secret/Variable、WIF 401/403/429、GA 查询错误、D1 错误、Heartbeat 没写入均让 Workflow 非零失败。
- Fixture 下架/售罄/Selector 失效用 `TEST_CONFIG_STALE`。
- Browser Test 必须阻止 Analytics 且不得提交 Checkout。
- 不修改 Shopify 商品、库存、折扣或 AIOD 规则。

## 24 小时与 14 天人工关卡

- Cloudflare Cron 连续稳定 24 小时不是代码测试能代替的；确认后才关闭旧 Uptime schedule。
- GA4 observe 连续 14 天后检查 `alert_log` 的 `would_alert`，确认误报率后由用户决定 `armed`。
