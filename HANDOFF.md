# APGO Monitoring Handoff

## 当前设计

- 分支：`codex/monitoring-v2`。
- 分支与 `main` 已同步到本文件所述监控实现。
- Worker/D1、Layer 2、Layer 3、Layer 4、Heartbeat 与 Workflows 已部署；`2135fec` 暂停的 Layer 3 接入已修正。
- Worker `CRON_ENABLED=true`；5 分钟 Layer 1 已实际触发并写入 D1，`/health` 返回 200。
- Layer 2 V2 为 GA4 广告优先巡检：每天 MYT 09:37 与每次 `main` 更新后运行，自动发现近 3 天付费 Landing Page，并用 Android/iPhone 验证运行时 Promotion、Gift、Cart Offer、Cart 与 Checkout；旧 Layer 2 只保留手动回退。
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

1. ~~移除旧 Uptime schedule~~ ✅ 2026-08-24 已完成（并行 3 天、Worker 每 5 分钟 cron 稳定写入 D1、无漏跑；uptime.yml 保留手动 dispatch 作诊断用）。
2. 保持 GA4 `observe` 满 14 天（至 ~9/3），审查 `would_alert`、阈值与误报记录后，再由用户决定是否切换为 `armed`。
3. 上线后手动运行 Daily 与 Post-deploy 各三轮并观察 48 小时；GA4 新广告需先产生可读取流量才会自动进入巡检。
4. `Missing shadow root`（`assets/critical.js:102` OverflowList）修不修等 Wade 决定：每天 ~25 访客、全在商品页、不挡购买；成因 = 老 iOS 15 不支持声明式 Shadow DOM + 新浏览器上疑似客户端重渲染丢失 shadow root。选项：(a) connectedCallback 防御式降级不 throw（小改）；(b) 深查 morph 重渲染路径正确修复；(c) 静音签名不修。

## 2026-08-24 变更记录

- Worker 签名计算前把 message 中的 URL/≥8 位 hex/≥4 位数字归一化（`normalizeSignatureText`，errors.mjs），修复一类错误裂成 45 个签名的碎片化；分类逻辑仍用原文。旧 `js-alert:*` 冷却与 `known_signatures` 旧签名成为无害孤儿，重复告警若出现属一次性重置。
- codex 8/21-23 已修的真 bug（有回归测试）：`productCardLink` ref 缺失、PDP 加购并发锁、cart 数量更新失败恢复。老浏览器 `#moveItemsToDefaultSlot` SyntaxError 判定为 Shopify 官方 shop-js 问题,已归类 platform 家族降噪。

## 环境事实（agent 换人时省弯路）

- 沙箱连不上 apgo.my（代理 403）、GitHub artifact blob 也被挡 → 实测靠 Actions 跑 + GitHub MCP/`GITHUB_TOKEN` 读日志。
- Cloudflare MCP 能查/改 D1（静音：`UPDATE known_signatures SET muted=1 WHERE signature='<sig>'`），不能部署 Worker → 部署走 deploy-worker.yml。
- Shopify MCP 等 Wade 在 claude.ai 重新授权 apgo.my 店（曾连台湾店已吊销）。
- Wade：非技术、中文、看 Telegram 群「网站检测系统」；改 theme/武装 L4 要他点头。

## 不可误报原则

- 缺 Secret/Variable、WIF 401/403/429、GA 查询错误、D1 错误、Heartbeat 没写入均让 Workflow 非零失败。
- Fixture 下架/售罄/Selector 失效用 `TEST_CONFIG_STALE`。
- Browser Test 必须阻止 Analytics 且不得提交 Checkout。
- 不修改 Shopify 商品、库存、折扣或 AIOD 规则。

## 24 小时与 14 天人工关卡

- Cloudflare Cron 连续稳定 24 小时不是代码测试能代替的；确认后才关闭旧 Uptime schedule。
- GA4 observe 连续 14 天后检查 `alert_log` 的 `would_alert`，确认误报率后由用户决定 `armed`。
