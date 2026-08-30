# APGO Central Storefront Monitoring

公开中央 Repo：`anpuuuuu/apgo-storefront-monitoring`。目标是约 10 分钟内确认整站/API 故障、每日与每次 Theme 更新后验证真实购物路径，并用 GA4 检查业务漏斗。配置与状态从第一天使用 Site Namespace；首个站点为 `apgo-my`。

| Layer | 负责内容 | 频率 | 执行位置 |
|---|---|---|---|
| 1 | Homepage + `/cart.js` 存活、速度、恢复 | Cloudflare 每 5 分钟 | `workers/error-monitor/` |
| 2 | 广告 Landing Page 与真实浏览器购物流程 | 每日 09:37 MYT；每次 Theme 更新后 | `site-health-v2.yml` |
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

配置集中在 `config/sites.json`。每天通过 WIF 只读 GA4 最近 3 天的付费 Landing Page，去除 UTM 后合并并优先选择有 ATC/Checkout 的页面，最多检查 10 个；GA4/Auth 失败明确报告 `AD_DISCOVERY_FAILED`。

- 每天 MYT 09:37：流量最高的 3 个可购买 Landing Page 由 Android Chromium 执行完整 Add → Cart → Checkout；iPhone WebKit 对相同页面验证 Safari 渲染、图片、CTA 与选项状态，但不写购物车。其余最多 7 个页面按日期轮换 Android/iPhone，只读验证；Desktop 每个市场只跑基础 Smoke。
- 每次 `main` Theme 更新后等待 3 分钟，再按同一职责检查当前广告页面：Android 负责完整购买，iPhone 负责 Safari 只读交互；连续 Push 只保留最新 Commit。
- 没有付费 Landing Page 时仍执行一条 Android 核心购买流程和一条 iPhone 只读 UI 流程，不会产生空的绿色结果。
- Theme Contract 改为结构校验：确认 Tab/Offer/Promotion 字段和引用有效，但不再复制保存每个后台 Block 的固定预期。
- 广告 Journey 在运行时发现页面上的 Promotion、Gift Picker、Cart Offer 和限购状态，验证选项不会被重新渲染清空，并逐项比对 Cart Snapshot 与 Checkout。
- 第一次失败保存证据，等待 60 秒后以全新 Browser Context 复测；第二次成功记为 `transient/flaky` 且不发正式告警，两次失败才告警。Cloudflare 持续挑战与 Fixture 过期有独立分类。
- 所有 Journey 在一个 Batch Runner 内严格串行；先完成全部只读检查，再执行 Android 购物车写入。Chromium 与 WebKit 各安装一次，每个 Journey 使用全新 Browser Context 并保留独立证据。只有每日完整结果写 Layer 2 Heartbeat；Post-deploy 不能掩盖漏跑的 Daily。
- `/cart`、`/checkout`、`/account` 等系统 Landing Page 使用专用 Smoke，不会被误当作商品页执行加购。
- Cart 写入 Journey 之间有 10 分钟冷却；同一 Journey 两次持续收到 429 后打开 Circuit Breaker，后续 Cart 写入会被标记为 `MONITOR_RATE_LIMIT` 并停止，不会用限流覆盖最初的 Storefront 证据。GitHub-hosted WebKit 不执行 Cart API 写入，因为隔离测试已确认其持续触发 Shopify 429；本地 iPhone WebKit 完整流程仍通过，不能把云端限流误报为顾客 Safari 故障。
- 每个旅程开始/结束清空购物车；UA 为 `APGO-HealthCheck`；GA4/Meta/TikTok/Clarity 等请求被阻止。
- Shopify `429` 优先尊重 `Retry-After`，否则使用 15/45/90 秒退避；持续 429 明确报告为 `MONITOR_RATE_LIMIT`，不归类为商品配置失效，也不自动重跑整套真实写入。
- 失败上传 Screenshot、Trace、Console、Network 和最终 Cart JSON；关闭 Video，避免单次失败产生数百 MB 无效文件。

本地：

```powershell
npm ci
npx playwright install chromium webkit
npm run test:light
npm run test:full
npm run validate:layer2
npm run test:layer2-config
```

V2 只保留每天 MYT 09:37 与每次 `main` 更新后的巡检；旧 Workflow 保留手动回退入口，不设 Schedule。

## Layer 3

`snippets/apgo-error-monitor.liquid` 接入 Theme、Password、Shogun Landing 和 Gift Card。

- 收集 `window.error`、第一方资源加载失败、`unhandledrejection`、Cart API 失败和 Theme 主动触发的 `apgo:cart-error`。
- 只发送清理后的 path，不发送 query、姓名、邮箱、地址或 cart token。
- Worker 只接受 `config` 中明确登记并由 Worker 映射至 Site ID 的 Storefront Origin，限制 8KB、10 条/IP/分钟；IP 每日散列。
- JS、Promise 与一般 Cart Error：10 分钟内至少 3 次且至少 2 个 Session 才进入告警；资源错误采用较高的 8 次、5 个 Session 门槛。
- 每个 Cron 周期只发送一条 Digest，最多列出 6 个 Signature；其余证据继续保留在 D1，不再为每个失败资源各发一条 Telegram。
- Digest 会列出同一 Signature 影响的所有页面（最多显示 3 个）、不同网络数量，以及 Facebook 内置浏览器、Android WebView、一般手机浏览器和桌面浏览器的 Session 分布，避免把跨页面问题误认为单一商品页故障。
- 只有 Shopify Cart API 实际返回 HTTP 5xx 才会立即发送 Critical Cart Error。`Failed to fetch`、`Load failed` 与 status `0` 属于客户端网络/导航中断，必须达到多人门槛才告警。
- `Failed to fetch` 代表顾客浏览器当次请求确实失败，但不能单独证明 Shopify 服务器故障；必须结合 Layer 1 Cart API、Layer 2 加购测试与不同网络数量判断。监控不会自动重试 Cart POST，避免服务器已收到第一次请求时造成重复加购。
- Browser Error Digest 会列出受影响页面、独立网络数与客户端类型。`meta-externalads`、`facebookexternalhit`、`Facebot` 等社交预览/广告爬虫会在写入 D1 前被过滤；真实顾客使用的 Facebook 内置浏览器 `FB_IAB` 仍会保留。
- 两小时内同 Signature 不重复；已知 Signature 可在 `known_signatures.muted=1` 静音。
- `/web-pixels@.../worker.modern.js` 与 “Failed to load web worker for pixel” 归类为 `SHOPIFY-PLATFORM/WEB-PIXELS`；至少 15 Sessions、5 Networks 才告警，六小时内不重复。
- Cart Network Signature 若全部事件都发生在 `page_leaving=1` 且页面为 `hidden/unloaded`，仍保留 D1 证据但不进入 Digest；只要有任何可见或非离页样本，原有门槛继续生效。
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

`config/alerts-config.json` 默认 `observe`。前 14 天只写 `would_alert`；复盘后人工改为 `armed`。

## Heartbeat 与自监控

| Layer | Stale |
|---|---:|
| 1 | 15 分钟 |
| 2 | 30 小时 Warning；36 小时 Critical |
| 3 | 26 小时 |
| 4 | 90 分钟 |

- Worker Cron 检查 Layer 2/3/4。
- GitHub 每小时检查 Worker `/health`、Layer 1、Layer 2/4 最近 scheduled run。
- Workflow 成功但 Heartbeat 写入失败仍视为失败。

## Secrets 与 Variables

Secrets：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`MONITOR_HEARTBEAT_TOKEN`、`MONITOR_GITHUB_APP_PRIVATE_KEY`、`MONITOR_GITHUB_WEBHOOK_SECRET`。

Variables：`GCP_WIF_PROVIDER`、`MONITOR_WORKER_URL`、`MONITOR_DISPATCHER_URL`、`MONITOR_GITHUB_APP_ID`、`MONITOR_MODE`、`MONITOR_SCHEDULE_ENABLED`。GA4 Property ID 属于 Site 配置，不再用单一 Repo Variable。

任何必要值缺失都必须失败，不再“跳过后显示绿色”。

## Worker 部署与回退

1. `npm run check:worker`。
2. 手动运行 `Deploy monitoring Workers`；D1 Migration 必须另外勾选批准，不会随 Push 自动执行。
3. 从日志取得 `workers.dev` URL，填进 `MONITOR_WORKER_URL`、`alerts-config.json`、`sites.json`、Theme snippet。
4. 首次上线时保持 `CRON_ENABLED=false`，以 `rollout_validation=true` 手动运行 self-health，验证 Beacon、Layer 3 Heartbeat、D1 和 Telegram。
5. 手动跑 Layer 2、Layer 3 self-test、Layer 4 validate；全部通过后才将 `CRON_ENABLED` 改为 `true`。
6. Cron 开启后等待实际的 5 分钟触发，确认 `/health` 返回 200 且包含新鲜的 Layer 1 Heartbeat，再启用 GitHub Browser/Self-health schedules。

中央迁移期默认 `MONITOR_MODE=shadow` 且 `MONITOR_SCHEDULE_ENABLED` 不启用。旧 Theme Repo 继续负责正式告警与 Heartbeat；中央 Repo 的手动验证成功后才进入 48 小时 Shadow，之后由人工 Cutover。

完整迁移、GitHub App、WIF、Secrets 与回退步骤见 `docs/MIGRATION.md`。

紧急回退：先把 `CRON_ENABLED` 改回 `false` 部署；Theme 错误监控 snippet 本身所有发送均为 fail-safe，不会阻挡页面或购物车。
