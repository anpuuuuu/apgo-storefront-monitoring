# APGO Central Storefront Monitoring

公开中央 Repo：`anpuuuuu/apgo-storefront-monitoring`。目标是约 10 分钟内确认整站/API 故障、每日与每次 Theme 更新后验证真实购物路径，并用 GA4 检查业务漏斗。配置与状态从第一天使用 Site Namespace；首个站点为 `apgo-my`。

**当前：部分 Live（2026-09-03 18:09 MYT）**。中央正式接管 Layer 2 与网站自检/Layer 3 Self-test；Layer 1/3 仍由原 Worker 服务。GA4 暂留旧 Theme Repo，中央 Layer 4 暂停且不计为验收通过。具体归属、证据及回退见 [切换记录](docs/CUTOVER-LAYER23.md)。

| Layer | 负责内容 | 频率 | 执行位置 |
|---|---|---|---|
| 1 | Homepage + `/cart.js` 存活、速度、恢复 | Cloudflare 每 5 分钟 | `workers/error-monitor/` |
| 2 | 广告 Landing Page 与真实浏览器购物流程 | 每日 09:37 MYT；每次 Theme 更新后 | `site-health-v2.yml` |
| 3 | 第一方 JS、资源、Cart API 错误 | 实时收集；Worker 每 5 分钟聚合 | Theme snippet + Worker |
| 4 | GA4 实时事件与每日完整漏斗 | 每 30 分钟；每日 12:17/14:47 MYT | `monitor-alerts.yml` |

## Layer 1

- Cloudflare Cron `*/5 * * * *` 并行检查 `https://apgo.my/` 与 `https://apgo.my/cart.js`。
- 10 秒超时；连续两次失败才告警；故障每 60 分钟重报；成功一次即 Recovery。HTTP 429 单独计数：那是 Shopify 在限流探测器而不是网站故障，连续 3 次（15 分钟）才以 `[Layer 1 Throttled]` 提示，不计入失败次数。
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

页头购物车数量检查（`assertHeaderCartCount`）：先等 5 秒看气泡是否等于 `/cart.js` 的 `item_count`；不一致时等过主题的 10 秒 sessionStorage 缓存后刷新页面再核对一次，刷新后一致只在 heartbeat detail 记一笔 `header_cart_bubble_lag`，刷新后仍不一致才算失败。原因：促销页默认档位一次加 9 包后，店铺规则会再自动送 1 个赠品，主题气泡不会得到通知（2026-09-14 起每天一条失败通知，Wade 确认是有意的促销规则）。

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
- 同一 Signature 24 小时内只进一次 Digest（2026-09-13/15 两个签名在旧的 2 小时窗口下各发了 4 次，没有新信息）；D1 照存每一笔事件。已知 Signature 可在 `known_signatures.muted=1` 静音（手动 Workflow `D1 maintenance` → `mute-signature`）；要先看讯息文字再决定，用 `D1 maintenance` → `list-signatures`（`alert_log` 的 detail 只存前 200 字；每个签名附 `js_errors` 最近一次的 source 与页面，30 天外为 null）。Critical Cart Error 仍是 2 小时窗口。
- 资源错误的来源若是「店铺域名 + `/extensions/…`」，归为 `client-rewrite`：Shopify 只从 `cdn.shopify.com` 提供 app 扩展资源，把主机改写成店铺域名的是抓取器/镜像代理，不进 Digest，D1 照存。
- `/web-pixels@.../worker.modern.js` 与 “Failed to load web worker for pixel” 归类为 `SHOPIFY-PLATFORM/WEB-PIXELS`；至少 15 Sessions、5 Networks 才告警，六小时内不重复。
- Cart Network Signature 若全部事件都发生在 `page_leaving=1` 且页面为 `hidden/unloaded`，仍保留 D1 证据但不进入 Digest；只要有任何可见或非离页样本，原有门槛继续生效。
- Signature 计算前会把 message 中的 URL、≥8 位十六进制串与 ≥4 位数字归一化为占位符，同一错误家族不会因内嵌地址/编号而裂成多个 Signature（分类判断仍使用原文）。
- `page_url` 只保存 path，`source` 只保存 origin + path；query string 会被移除，Gift Card identifier 会被替换为 `[redacted]`。
- Error 保留 30 天，Alert 保留 90 天。
- 手动网页自测：`https://apgo.my/?apgo_em_test=1`；自动每日自测由 `monitor-self-health.yml` 使用 Heartbeat Token 发出经过认证的 Self-test。公开网页触发的 Self-test 不得写入 Heartbeat。

## Layer 4

认证使用 GitHub OIDC/WIF，不使用或保存 JSON Service Account Key。

每 30 分钟判断**一个已经补齐的 30 分钟时段**：`page_view`、`view_item`、`add_to_cart`、`begin_checkout`、`purchase`。

- 判断的不是「刚刚这半小时」。`settled_lag_minutes: 120` 往回推两小时再对齐到半点，所以每次看的时段结束于 90–119 分钟前、开始于 120–149 分钟前。`19,49 * * * *` 的排程刚好让两次运行落在 `:00` 和 `:30` 两个时段，一个时段只读一次、也不会跳过。
- 为什么不再用 `runRealtimeReport`：那是另一条管线，跟基线用的 `runReport` 对不上。2026-09-20 同一个时段两边相差 36%，而且实时接口最后一小时几乎是空的、90–60 分钟那段只补到一半——拿没补完的跟补完的比，进结账天生被砍得最狠。拿同一套规则回放 35 天已结算数据是**每 17.5 天误报一次**，线上跑实时数据是**每 3 天一次**。噪音在数据源，不在判断逻辑。
- 代价：发现时间从约 1 小时变成约 2.5 小时（两个相邻时段确认）。这条规则因此定位成慢的兜底；要快就靠合成探测那条线（下节）。

### 合成结账探测（快线）

`scripts/storefront-watch.mjs`，每 20 分钟跑一次，`storefront-watch.yml`。

漏斗规则是**从顾客行为反推**店有没有坏，所以必须等数据补齐、等相邻两个时段确认。这条线**直接自己当顾客**：拿一个真实商品加进真实购物车，用 86900 这个邮编问 `/cart/shipping_rates.json`，看回来的答案是不是一个人能拿去结账的。

- **只走公开的购物车接口**：加购 → 查运费 → 清空。**永远不打开结账页、不碰付款、不产生订单。** 请求带探测 UA、不跑 JavaScript，所以不进 GA4，不会污染漏斗规则读的数字。
- **判坏的依据是事实，不是统计**：加购失败、加购后购物车还是空的、运费查询非 200、或者**查询成功但一个运送方式都没有**。最后这条就是 2026-09-15 的形状——购物车好好的、请求全是 200，只是没有任何运送方式可选，人就结不了账。
- **测不准永远不等于店坏了**：429 限流、超时、运费还在计算（202）、商品读不到，都记成 unmeasured。2026-09-15 一个被限流的 runner 让 8 个商品里 7 个看起来是死的，而同一个探测从家用 IP 全过。
- **连续两次才报**（相隔 20 分钟）。信号是确定性的，第二次失败不是「硬币又是正面」，是同一个事实被看到两次。测不准的那一次**维持**计数而不是清零——不然一个又坏又在限流我们的店会永远在 broken / unmeasured 之间跳，永远凑不满两次。
- **探测哪些商品**：一个固定的 canary（广告商品 / Layer 2 fixture 的第一个）每次都测，因为全店性的故障（运费区域、结账设置、主题发布）在任何商品上都看得到；另外一个轮着测，让只坏一个商品的情况最终也能被发现，同时不用每 20 分钟扫全目录去挣一个限流。
- **排程走 Dispatcher**：GitHub 对高频 cron 只送达约 18%，所以 `*/20` 那行只是冗余。真正的排程是 Dispatcher Worker 看 `watch` 心跳超过 18 分钟就派发一次。`watch` 是 Layer 4 的快线、不是第五层，但它需要独立心跳，否则排程会跟 GA4 那条绑死。
- **`mode: observe` 起步**（`storefront_watch.mode`）。头几天要的是实测，不是信任；日志显示它在一个正常营业的店上持续报 ok 之后再 arm。
- 连续窗口按**时段身份**算，不按运行时刻算：重跑、手动派发、runner 迟到都可能把同一个时段读两次，那只算一次观测（`windowKey` 去重）。中间漏掉一个时段则重新计数。
- 当前值与基线来自**同一次查询**（按 `hour` 过滤后 28 天只有几千行），所以两边是同一种测量、只是不同日子。GA4 报告若被行数上限截断，直接记 `baseline_truncated` 并跳过判断——半截基线跟「店里很安静」长得一模一样。

排程由 Dispatcher Worker 的 Cloudflare Cron（`*/5`）负责：读取 `/health`，Layer 4 心跳 ≥28 分钟就 `workflow_dispatch` 一次 `realtime`；UTC 04:25 / 06:55 之后各派发一次 `daily-primary` / `daily-confirm`；Layer 3 心跳 >90 分钟派发 self-health。GitHub 自己的 `19,49 * * * *` 与 daily cron 保留作冗余——GitHub 对高频 cron 只送达约 18%，对每日 cron 会晚 4–6 小时，不能单独依赖。KV 锁、最近 15 分钟已有 run、以及失败后 60 分钟退避都会阻止重复派发。

- 告警送达：首次触发后状况持续，按 `realert_schedule_hours: [1, 2, 3]` 在 +1h、+2h、+3h 各提醒一次，之后每 3 小时，每条注明「第 N 次提醒，已持续 X」；恢复时发 🟢（静默）。文案带「先查什么」（运费 / 折扣 / 库存 / 结账设置 / 主题或 app 更新）和当时正在产生加购的商品页（按 `unifiedScreenName` 拆，**取的是被判断的那个时段**，不是发告警的那一刻）。2026-09-15 的 free-shipping 事故在旧的 6 小时平铺重报下 00:46 响过一次后 07:16 才再响，中间被淹没在杂讯里。
- Collection：Layer 1 正常、同期中位数 ≥10、连续两个窗口 page_view=0。
- ATC：同期中位数 ≥8、连续两个窗口 add_to_cart=0。
- Checkout：当前 ATC ≥5、同期 Checkout ≥2、连续两个窗口 Checkout=0。 2026-09-15 00:46 / 07:16 MYT 两次触发（ATC 5 / 7）经店主确认是真实事件：广告商品的 free shipping 被误关，顾客加购后不结账——**不要用「Shopify 最近有别的订单」压掉这条**，别的商品有人下单不能证明广告商品的结账没坏（#58 曾这么做，已回退）。
- 「连续两个窗口」要求样本相邻：距上一次采样超过 45 分钟视为覆盖缺口，计数从 1 重来；不足 15 分钟视为同一窗口重复采样，不累加。每次采样记入 `ga4:realtime:coverage`，日报计算前一天的窗口覆盖率，低于 80% 记 `REALTIME_COVERAGE_LOW`。
- 偏离带规则 `add_to_cart_drop` / `begin_checkout_drop` **2026-09-21 退役**（observe 09-08，armed 09-11）。拿 35 天已结算数据回放：`add_to_cart_drop` 触发 3 次（20260902-1800、20260905-2000、20260907-1930），**每一次成交都在同时段中位数之上**，其中两次的下一格分别是 500% 和 600%——一分钱没丢；它还要求当前值 >0，所以「加购完全归零」这个最该报的情况它反而不报，而那本来就归 `add_to_cart_zero` 管。`begin_checkout_drop` 35 天**零触发**，连 9/15 免运费事故的两个窗口都没抓到。
- 9/15 真事故的签名是**加购正常甚至偏高、进结账归零、成交归零**——人一直在加购，就是没人结账。这正是零检测规则在看的东西；偏离带规则一直在它周围量，从没量到它。阈值留在 `ga4.realtime.drop` 里没删，是为了让诊断能拿新数据重新定价，不必从头吵一遍。
- 不因 30 分钟没有 Purchase 单独告警。Purchase 一层改由平台推送的订单心跳负责（下节）；GA4 侧只保留交叉检查 `purchase_tracking_gap`：Worker 最近 20 分钟内查过订单、最新订单在 25 分钟内、同期 purchase 中位数 ≥1 而当前 purchase=0，相邻三窗 → 追踪断了，不是生意问题（`ga4.realtime.drop.purchase_tracking_mode`，单独开关，仍为 observe：POS / 草稿订单等未追踪渠道会让 GA4 合理地没有 purchase）。

### 订单心跳（平台推送）

商业健康的真相来源是第一方订单流，不经过顾客浏览器、不受 consent 与广告拦截影响。任何平台只要能在「订单创建」时发一个 HTTP 请求就能接入，不需要给监控任何平台 API 权限：

```
POST https://apgo-error-monitor.wadeyeh.workers.dev/orders/event
Authorization: Bearer <该站点的 ORDER_EVENT_TOKEN>
Content-Type: application/json
{ "siteId": "apgo-my", "orderId": "<平台订单 ID>", "createdAt": "<ISO 8601>", "test": false }
```

- Shopify：Flow「Order created → Send HTTP request」，body 用 Liquid 模板填上面四个字段（`{{ order.id }}`、`{{ order.createdAt }}`、`{{ order.test }}`）。WooCommerce / 自建站 / Make 同样格式。
- Worker 以 `orderId` 去重（平台重试不会重复计数），`test: true` 直接丢弃，订单时间保存在 D1 `state` 的 `<site>:orders:log`（保留 35 天），最新一笔在 `<site>:orders:last` 供 GA4 交叉检查读取。
- 每 10 分钟评估「距上一单多久」，对比**一个固定阈值 7 小时**；超过两倍算 critical，6 小时内不重复。**恢复必须由新订单触发**，阈值变化永远不会产生「订单恢复了」。
- 为什么是一个固定值而不是分时段的模型：455 笔真实订单（2026-09-09 至 09-20）显示间隔中位数 19 分钟、p90 1h19m，正常日最长间隔 5h51m，唯一更长的 8h01m 是 09-15 免运费事故。拿这批数据回放，7 小时只触发一次（就是那次事故），4 小时触发 9 次且全部落在老板确认正常的日子。旧的分桶 p90 模型做不到：4 小时窗口在正常情况下有 3.6% 的时间是零订单，同一个小时桶的订单数从 4 到 17 不等，分布宽度盖过了信号——这就是它在三个健康日里响了 11 次的原因。
- 这条规则**刻意是慢的兜底**，回答「生意是不是真的停了」。快速发现结账坏掉是漏斗规则的事：09-15 那次 GA4 在 00:46 就响了，比 7 小时的间隔规则早五个小时。
- 告警文案里带同时段流量（读 GA4 侧写的 `<site>:ga4:realtime:last`）：流量正常 → 「重点查结账」；流量也低 → 「可能是广告停了或淡时段」。**流量从不用来压制告警**，只用来指方向；GA4 数据太旧就明说读不到。
- 心跳 detail 里带 `observedMaxGapMinutes` 与 `observedP90GapMinutes`（最近 28 天实测），阈值要调时看这两个数字，不要凭感觉。
- 推送源自身的健康单独看：从未收到推送记 `orders_push_missing`；超过 24 小时没有任何推送记 `orders_push_stale` 并提示先检查 Flow，而不是把它读成零销售。
- 启用方式（每站点）：`config/sites.json` 加 `"orders": {"source": "push", "tokenEnv": "ORDER_EVENT_TOKEN_<SITE>"}` 并 `npm run generate:sites`；GitHub secret `ORDER_EVENT_TOKEN_<SITE>` 放一串随机值（部署 Workflow 在 secret 存在时才上传，不存在则跳过）；平台侧用同一个值当 Bearer。Worker var `ORDERS_MODE`：observe 只写 `would_alert` / `would_recover`；**2026-09-11 起 armed，2026-09-21 换成固定阈值**。要回退成静默把它改成 `observe` 再部署即可，阈值本身在 `ORDER_LIMITS.gapMinutes`。

### 调查员（告警后的自动排查，阶段 1a）

`scripts/investigator.mjs`（纯逻辑在 `scripts/checkout-probe-lib.mjs`）。armed 规则**首次**响铃后，紧接着发一条静默的 🔎：

1. 取 GA4 realtime 最近 30 分钟 `add_to_cart` 最多的页面标题，用公开 `/products.json` 的商品标题对回 handle（标题不跟 handle 走，只能按标题对）。
2. 前 3 个商品各自用一个全新的 cart cookie（省掉开头的清空）：`POST /cart/clear.js` → `POST /cart/add.js` 加 1 件 → `GET /cart.js` → `GET /cart/shipping_rates.json`（邮编 86900 / MY / Johor，Shopify 要求马来西亚必须带州）→ `POST /cart/clear.js`。只走公开购物车接口，不进结账页、不填付款、不产生订单；服务端 fetch 不会触发 GA4 事件或 Layer 3 beacon。
3. 与每日快照比：商品 `updated_at` 变了、价格/可购买状态变了、加 1 件后购物车件数变了（自动赠品规则变了）、运费选项消失/变价/免运消失、运费查询失败。
4. 结论按经验规则排：加购失败 → 拿不到运费方案 → 免运消失 → 商品被修改过 → 其他变化 → 没发现异常（并说明覆盖不到结账页本身）；连商品都对不上时也照发，讲明没跑起来。修复仍由人做。

HTTP 429 是 Shopify 在限流探测自己，不是店铺故障（和 Layer 1 的处理一致）。探测会退避重试（Retry-After 优先，否则 5s/10s），仍被限流就在讯息里标 🚫 并写明「限流的是监控，不是店铺」，结论绝不会因此说店铺坏了，快照比对也会跳过这一笔。GitHub runner 的出口 IP 是共享的，2026-09-15 14:04 UTC 的首次快照 8 个商品被限流 7 个，同样的探测从家用 IP 全部通过；因此每个商品之间留白（告警时 4 秒，每日快照 20 秒）。

🔎 会响铃，和它跟随的业务告警一样：这条才是告诉你「去哪里看」的讯息，查不到原因时更要讲出来，否则你无法分辨是没查还是查了没事。每次事故最多一条（只在首次告警后触发，重报时不再发）。探测自身失败（超时、店铺连不上）只写 `alert_log` 的 `investigation_failed`，不进群。

每日快照：`monitor-alerts.yml` 的 `daily-primary`（Dispatcher 04:25 UTC 后派发）跑 `node scripts/investigator.mjs snapshot`，对象是 GA4 付费流量落地的商品 + `fixtures` 里的促销/赠品/bundle/普通商品，存 D1 `state` 的 `<site>:probe:snapshot:latest`（上一份滚到 `:previous`）。设定在 `config/alerts-config.json` 的 `investigator`（`mode: off` 关闭）。探测失败只写 `alert_log` 的 `investigation_failed`，不进群。

## 讯息静默策略

所有讯息都进同一个 Telegram 群，但只有需要有人**现在**处理的才响铃（`disable_notification=false`），其余静默送达（进群不响）：

| 响铃 | 静默 |
|---|---|
| Layer 1 连续失败（down） | Layer 1 recovery / throttled / slow |
| Layer 3 Critical Cart Error（Shopify 5xx） | Layer 3 Browser Error Digest |
| 心跳 critical（stale） | 心跳 delayed / recovery |
| Layer 4 业务规则（armed）首报与重报 | Layer 4 恢复 🟢、日报数据质量 |
| 订单心跳 warning / critical | 订单心跳 recovery、推送缺失/停滞提示 |
| Layer 4 日报 armed 告警 | Workflow 失败通知、Dispatcher 失败通知 |
| 调查员 🔎（跟在业务告警后面） | — |

原因：只要杂讯和真事在手机上长得一样，剩下的杂讯就会持续消耗对这个群的信任；让「响」稀有而且只对应真事。

Workflow 失败通知（`scripts/workflow-failure-notify.mjs`）只在同一 workflow 文件**连续第二次**失败时才发（查 GitHub Actions 最近的 completed run；查不到时照发）。单次瞬时错误（如 2026-09-14 01:45 UTC 的一次 `ECONNRESET`）由 Dispatcher 的 back-off 补跑吸收。Layer 2 一天一次，设 `MONITOR_NOTIFY_MIN_CONSECUTIVE=1` 每次都发。

## Heartbeat 与自监控

| Layer | Stale |
|---|---:|
| 1 | 15 分钟 |
| 2 | 30 小时 Warning；36 小时 Critical |
| 3 | 26 小时 |
| 4 | 90 分钟 |

- Worker Cron 检查 Layer 2/3/4。
- Dispatcher Cron 每 5 分钟按 `/health` 心跳年龄补派 Layer 4 realtime（≥28 分钟）、每日两阶段、Layer 3 自检，以及 Layer 2 daily（UTC 02:10 = 10:10 MYT 之后心跳仍超过 6 小时就派 `site-health-v2.yml cadence=daily`，每站点每日一次；`site-health-v2.yml` 的 `gate` job 会让迟到的 GitHub 排程在心跳 8 小时内新鲜时跳过，避免同一天跑两遍浏览器批次）；`SCHEDULER_ENABLED=false` 关闭，`SCHEDULER_DRY_RUN=true` 只记录决策。
- GitHub 每小时检查 Worker `/health`、Layer 1、Layer 2/4 最近 scheduled run；Layer 4 超过 45 分钟无完成 run 时补派，作为低于 90 分钟 warning 线的第二兜底。
- Workflow 成功但 Heartbeat 写入失败仍视为失败。

## Secrets 与 Variables

Secrets：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`MONITOR_HEARTBEAT_TOKEN`、`MONITOR_GITHUB_APP_PRIVATE_KEY`、`MONITOR_GITHUB_WEBHOOK_SECRET`；可选 `ORDER_EVENT_TOKEN_APGO_MY`（订单心跳推送的共享密钥，同一值填在 Shopify Flow 的 Authorization header）。

Variables：`GCP_WIF_PROVIDER`、`MONITOR_WORKER_URL`、`MONITOR_DISPATCHER_URL`、`MONITOR_GITHUB_APP_ID`、`MONITOR_MODE`、`MONITOR_SCHEDULE_ENABLED`。`MONITOR_LAYER4_PAUSED=true` 暂停中央 Layer 4 定时、自检恢复触发与 Dispatcher 派发（`trigger=scheduler` 的 run 会被跳过），不影响 Layer 2 广告清单发现，也不代表 GA4 验收通过；长时间暂停时同时把 Dispatcher 的 `SCHEDULER_ENABLED` 改为 `false`，避免每 15 分钟产生一条 skipped run。Dispatcher Worker 自身的 `vars`：`CENTRAL_REPOSITORY`、`MONITOR_WORKER_URL`、`SCHEDULER_ENABLED`、`SCHEDULER_DRY_RUN`（在 `workers/dispatcher/wrangler.jsonc`）。`MONITOR_SHADOW_STARTED_AT`、`MONITOR_SHADOW_REVIEW_AFTER` 记录观察时间，不自动触发 Cutover。GA4 Property ID 属于 Site 配置，不再用单一 Repo Variable。

任何必要值缺失都必须失败，不再“跳过后显示绿色”。

## Worker 部署与回退

1. `npm run check:worker`。
2. 手动运行 `Deploy monitoring Workers`；D1 Migration 必须另外勾选批准，不会随 Push 自动执行。
3. 从日志取得 `workers.dev` URL，填进 `MONITOR_WORKER_URL`、`alerts-config.json`、`sites.json`、Theme snippet。
4. 首次上线时保持 `CRON_ENABLED=false`，以 `rollout_validation=true` 手动运行 self-health，验证 Beacon、Layer 3 Heartbeat、D1 和 Telegram。
5. 手动跑 Layer 2、Layer 3 self-test、Layer 4 validate；全部通过后才将 `CRON_ENABLED` 改为 `true`。
6. Cron 开启后等待实际的 5 分钟触发，确认 `/health` 返回 200 且包含新鲜的 Layer 1 Heartbeat，再启用 GitHub Browser/Self-health schedules。

新环境最初应保持 `MONITOR_MODE=shadow`、Schedule 关闭。当前 APGO 已按用户明确批准完成部分切换：`MONITOR_MODE=live`、`MONITOR_SCHEDULE_ENABLED=true`、`MONITOR_LAYER4_PAUSED=true`。旧 Theme Layer 2 已停用，旧自检缩减为 GA4-only，继续保留 GA4 的定时补跑能力；没有双份 Layer 2/Layer 3 自测。

完整迁移、GitHub App、WIF、Secrets 与回退步骤见 `docs/MIGRATION.md`。

当前迁移状态（2026-09-03）：GitHub App、WIF、Worker 与 D1 已完成；此前 Layer 2 Post-deploy `3/3`、Daily `3/3` 通过，本次切换前追加 Daily 亦为 `15/15` 首次通过、无漏测/限流、证据扫描干净。用户随后批准不等 48 小时，现已部分 Live；六小时 Codex 复查已取消。中央 Live 自检与旧 GA4-only Watchdog 均已云端验证通过。新一次更新后浏览器批次仍在运行，首次 Live Daily 心跳待下一次每日任务确认，不把旧 Shadow 成功冒充 Live 心跳。「27 笔交易但营收为零」是服务账号的 `REVENUE_DATA` 读取限制，权限调整和中央 GA4 验收继续暂缓。尚未删除旧监控代码或撤销其凭证，本次未部署 Worker、未修改顾客页面。详情见 `docs/CUTOVER-LAYER23.md` 和 `docs/HANDOFF.md`。

紧急回退：先把 `CRON_ENABLED` 改回 `false` 部署；Theme 错误监控 snippet 本身所有发送均为 fail-safe，不会阻挡页面或购物车。Dispatcher 排程回退：`SCHEDULER_ENABLED=false` 重新部署 dispatcher，GitHub 自身的 cron 与每小时 watchdog 继续运作。

Dispatcher 排程已于 2026-09-09 16:54 MYT 上线（Version `a5921cbc`，`SCHEDULER_ENABLED=true`、`SCHEDULER_DRY_RUN=false`），证据见 `docs/FINAL-CUTOVER.md`。Worker 之间读 `/health` 必须走 Service Binding（`env.MONITOR`），直接 fetch 另一个 workers.dev 会被 Cloudflare 以 1042 拒绝。原上线顺序供新环境参考：合并时 `SCHEDULER_ENABLED=false` → 改 `true` + `SCHEDULER_DRY_RUN=true` 部署并看 ≥2 小时的 `scheduler_tick` 日志 → `SCHEDULER_DRY_RUN=false` 部署，观察 `/health` 的 `layer4.ageSeconds` 连续 2 小时不超过 40 分钟、无重复业务 Telegram。
