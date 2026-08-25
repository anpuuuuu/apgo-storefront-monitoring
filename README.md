# APGO 四层网站监控

目标：约 10 分钟内确认整站/API 故障，约 1 小时内发现购物流程故障，并用 GA4 检查业务漏斗异常。所有正式告警送到现有 Telegram 群。

| Layer | 负责内容 | 频率 | 执行位置 |
|---|---|---|---|
| 1 | Homepage + `/cart.js` 存活、速度、恢复 | Cloudflare 每 5 分钟 | `cloudflare/worker/` |
| 2 | MY/SG 真实浏览器购物流程 | Android 主巡检每小时；完整每日两次 | `site-health-v2.yml`（分阶段上线） |
| 3 | 第一方 JS、资源、Cart API 错误 | 实时收集；Worker 每 5 分钟聚合 | Theme snippet + Worker |
| 4 | GA4 实时事件与每日完整漏斗 | 每 30 分钟；每日 12:17/14:47 MYT | `monitor-alerts.yml` |

## Layer 1

- Cloudflare Cron `*/5 * * * *` 并行检查 `https://apgo.my/` 与 `https://apgo.my/cart.js`。
- 10 秒超时；连续两次失败才告警；故障每 60 分钟重报；成功一次即 Recovery。
- 连续三次超过 5 秒发 Slow Response。
- D1 保存样本、状态、告警和 Scheduled Time 去重。
- `CRON_ENABLED` 是上线闸门。初次部署为 `false`；HTTP、D1、Telegram、Heartbeat 验证完成后才改成 `true`。
- 新 Cron 稳定 24 小时后，删除 `.github/workflows/uptime.yml` 的 `schedule`，只保留手动/Push 诊断。

## Layer 2

配置全部集中在 `sites.json`，商品、Variant、市场金额或促销预期过期时抛出 `TEST_CONFIG_STALE`，不会伪装成网站故障。矩阵由 `scripts/layer2-config.mjs` 从配置动态产生，不再写死 APGO Job。

- 每小时/Push：Pixel 7 等效 Android 执行 Homepage → 活动入口 → Gift Picker/普通 V3/洗衣精 PDP → Cart → Checkout；Desktop Chromium 执行基础 Smoke。
- 完整：Android 验证 Detergent、Glaze、推荐和 Golden Bull；Desktop Chromium、Android Chromium 与 iPhone WebKit 分别验证 MY/SG 核心 Cart/Checkout。
- Detergent 会验证准确付费/赠品数量、金额和小计；Glaze 会验证 Trigger、准确 Add-on Variant/市场促销价、上限与失效；推荐区会分别验证 `ADD` 和 `SELECT OPTIONS`。
- Golden Bull 自动发现可见 Campaign Section，验证 Promotion ID 唯一、Position 连续、图片/链接、Carousel、Add 与 Buy Now 只加一次。
- 第一次失败保存证据，等待 60 秒后以全新 Browser Context 复测；第二次成功记为 `transient/flaky` 且不发正式告警，两次失败才告警。Cloudflare 持续挑战与 Fixture 过期有独立分类。
- 每个矩阵 Job 独立 Runner 且 `max-parallel=1`，避免同时制造大量 Cart API 请求。全部预期 Journey 都返回结果后才写包含 Site/Market/Device/Journey 摘要的 Layer 2 Heartbeat。
- 每个旅程开始/结束清空购物车；UA 为 `APGO-HealthCheck`；GA4/Meta/TikTok/Clarity 等请求被阻止。
- Shopify `429` 优先尊重 `Retry-After`，否则使用 15/45/90 秒退避；持续 429 明确报告为 `MONITOR_RATE_LIMIT`，不归类为商品配置失效，也不自动重跑整套真实写入。
- 失败上传 Screenshot、Trace、Console、Network 和最终 Cart JSON；关闭 Video，避免单次失败产生数百 MB 无效文件。

本地：

```powershell
cd monitoring
npm ci
npx playwright install chromium
npm run test:light
npm run test:full
npm run validate:layer2
npm run test:layer2-config
```

V2 上线闸门：先手动运行 `Storefront browser health v2 (staged)` 三轮；三轮均通过后才为 V2 加入 Schedule。旧 Layer 2 在 V2 Scheduled 连续成功 48 小时前保留，避免切换期间出现覆盖空窗。

## Layer 3

`snippets/apgo-error-monitor.liquid` 接入 Theme、Password、Shogun Landing 和 Gift Card。

- 收集 `window.error`、第一方资源加载失败、`unhandledrejection`、Cart API 失败和 Theme 主动触发的 `apgo:cart-error`。
- 只发送清理后的 path，不发送 query、姓名、邮箱、地址或 cart token。
- Worker 只接受 APGO/Shopify Origin，限制 8KB、10 条/IP/分钟；IP 每日散列。
- JS、Promise 与一般 Cart Error：10 分钟内至少 3 次且至少 2 个 Session 才进入告警；资源错误采用较高的 8 次、5 个 Session 门槛。
- 每个 Cron 周期只发送一条 Digest，最多列出 6 个 Signature；其余证据继续保留在 D1，不再为每个失败资源各发一条 Telegram。
- Digest 会列出同一 Signature 影响的所有页面（最多显示 3 个）、不同网络数量，以及 Facebook 内置浏览器、Android WebView、一般手机浏览器和桌面浏览器的 Session 分布，避免把跨页面问题误认为单一商品页故障。
- 只有 Shopify Cart API 实际返回 HTTP 5xx 才会立即发送 Critical Cart Error。`Failed to fetch`、`Load failed` 与 status `0` 属于客户端网络/导航中断，必须达到多人门槛才告警。
- `Failed to fetch` 代表顾客浏览器当次请求确实失败，但不能单独证明 Shopify 服务器故障；必须结合 Layer 1 Cart API、Layer 2 加购测试与不同网络数量判断。监控不会自动重试 Cart POST，避免服务器已收到第一次请求时造成重复加购。
- Browser Error Digest 会列出受影响页面、独立网络数与客户端类型。`meta-externalads`、`facebookexternalhit`、`Facebot` 等社交预览/广告爬虫会在写入 D1 前被过滤；真实顾客使用的 Facebook 内置浏览器 `FB_IAB` 仍会保留。
- 两小时内同 Signature 不重复；已知 Signature 可在 `known_signatures.muted=1` 静音。
- Signature 计算前会把 message 中的 URL、≥8 位十六进制串与 ≥4 位数字归一化为占位符，同一错误家族不会因内嵌地址/编号而裂成多个 Signature（分类判断仍使用原文）。
- `page_url` 只保存 path，`source` 只保存 origin + path；query string 会被移除，Gift Card identifier 会被替换为 `[redacted]`。
- Error 保留 30 天，Alert 保留 90 天。
- 手动网页自测：`https://apgo.my/?apgo_em_test=1`；自动每日自测由 `monitor-self-health.yml` 使用 Heartbeat Token 发出经过认证的 Self-test。公开网页触发的 Self-test 不得写入 Heartbeat。

## Layer 4

认证使用 GitHub OIDC/WIF，不使用或保存 JSON Service Account Key。

实时每小时第 19、49 分钟读取最近 30 分钟：`page_view`、`view_item`、`add_to_cart`、`begin_checkout`、`purchase`。

- Collection：Layer 1 正常、同期中位数 ≥10、连续两个窗口 page_view=0。
- ATC：同期中位数 ≥3、连续两个窗口 add_to_cart=0。
- Checkout：当前 ATC ≥5、同期 Checkout ≥2、连续两个窗口 Checkout=0。
- 不因 30 分钟没有 Purchase 单独告警。
- API/WIF/D1/Heartbeat 失败必须让 Workflow 失败并发监控故障通知。

每日报告计算三个转化率、Purchasers、Transactions、Revenue、AOV，并拆 MY/SG、device、洗衣精、Aurora、其他 Product、Campaign Page。异常需低于同星期 28 天基准的 50%，且满足最低 ATC/Checkout 样本；12:17 先记录，14:47 仍异常才确认。

`alerts-config.json` 默认 `observe`。前 14 天只写 `would_alert`；复盘后人工改为 `armed`。

## Heartbeat 与自监控

| Layer | Stale |
|---|---:|
| 1 | 15 分钟 |
| 2 | 2 小时 |
| 3 | 26 小时 |
| 4 | 90 分钟 |

- Worker Cron 检查 Layer 2/3/4。
- GitHub 每小时检查 Worker `/health`、Layer 1、Layer 2/4 最近 scheduled run。
- Workflow 成功但 Heartbeat 写入失败仍视为失败。

## Secrets 与 Variables

Secrets：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`MONITOR_HEARTBEAT_TOKEN`。

Variables：`GA4_PROPERTY_ID`、`GCP_WIF_PROVIDER`、`MONITOR_WORKER_URL`。

任何必要值缺失都必须失败，不再“跳过后显示绿色”。

## Worker 部署与回退

1. `npm run check:worker`。
2. 手动运行 `Deploy APGO monitoring worker`；它先应用 D1 Migration，再部署 Worker。
3. 从日志取得 `workers.dev` URL，填进 `MONITOR_WORKER_URL`、`alerts-config.json`、`sites.json`、Theme snippet。
4. 首次上线时保持 `CRON_ENABLED=false`，以 `rollout_validation=true` 手动运行 self-health，验证 Beacon、Layer 3 Heartbeat、D1 和 Telegram。
5. 手动跑 Layer 2、Layer 3 self-test、Layer 4 validate；全部通过后才将 `CRON_ENABLED` 改为 `true`。
6. Cron 开启后等待实际的 5 分钟触发，确认 `/health` 返回 200 且包含新鲜的 Layer 1 Heartbeat，再启用 GitHub Browser/Self-health schedules。

当前上线状态（2026-08-21）：Worker Cron、Browser schedules、Self-health schedules 与 GA4 Observe schedules 已启用；MY/SG 六条完整购物流程及正常 Self-health 已通过。旧 GitHub Uptime 会与 Layer 1 并行 24 小时，确认稳定后才移除其 schedule。

紧急回退：先把 `CRON_ENABLED` 改回 `false` 部署；Theme 错误监控 snippet 本身所有发送均为 fail-safe，不会阻挡页面或购物车。
