# APGO Monitoring Handoff

## 当前设计

- 分支：`codex/monitoring-v2`。
- 分支与 `main` 已同步到本文件所述监控实现。
- Worker/D1、Layer 2、Layer 3、Layer 4、Heartbeat 与 Workflows 已部署；`2135fec` 暂停的 Layer 3 接入已修正。
- Worker `CRON_ENABLED=true`；5 分钟 Layer 1 已实际触发并写入 D1，`/health` 返回 200。
- Layer 2 的 MY/SG Detergent、Glaze、推荐/Checkout 六条独立 Journey 已全部通过；Browser 与 Self-health schedules 已开启。
- 旧 GitHub Uptime 继续并行到 Cloudflare Cron 满 24 小时，之后才关闭其 schedule。
- GA4 为 `observe`，从 2026-08-20 起至少观察 14 天；API/Auth/Workflow 故障从第一天正式通知。

## 基础设施

- Repo：`anpuuuuu/apgo-theme`
- D1：`apgo-monitoring` / `c75e84af-67df-4761-a559-2b0c1d904989`
- Worker：`apgo-error-monitor`
- GA4 Property：`547019474`
- WIF Provider：repo variable `GCP_WIF_PROVIDER`
- Service Account：`codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`
- `MONITOR_HEARTBEAT_TOKEN` 已创建为 GitHub Secret；不要输出或写进文件。

## 剩余人工关卡

1. 观察 Cloudflare Cron 与旧 GitHub Uptime 并行满 24 小时；确认没有漏跑、重复通知或异常延迟后，移除 `.github/workflows/uptime.yml` 的 schedule。
2. 保持 GA4 `observe` 满 14 天，审查 `would_alert`、阈值与误报记录后，再由用户决定是否切换为 `armed`。
3. 商品、Variant、价格、赠品或 AIOD 规则变更时，先更新 `sites.json` Fixture，并手动跑完整 Browser suite。

## 不可误报原则

- 缺 Secret/Variable、WIF 401/403/429、GA 查询错误、D1 错误、Heartbeat 没写入均让 Workflow 非零失败。
- Fixture 下架/售罄/Selector 失效用 `TEST_CONFIG_STALE`。
- Browser Test 必须阻止 Analytics 且不得提交 Checkout。
- 不修改 Shopify 商品、库存、折扣或 AIOD 规则。

## 24 小时与 14 天人工关卡

- Cloudflare Cron 连续稳定 24 小时不是代码测试能代替的；确认后才关闭旧 Uptime schedule。
- GA4 observe 连续 14 天后检查 `alert_log` 的 `would_alert`，确认误报率后由用户决定 `armed`。
