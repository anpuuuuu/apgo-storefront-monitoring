# APGO 网站健康监控（四层体系）

所有告警统一发到 Telegram 群「网站检测系统」。四层各抓一类故障，互为兜底：

| 层 | 干什么 | 频率 | 跑在哪 | 状态 |
|---|---|---|---|---|
| **1 拨测** | 网站活着吗（首页 + `/cart.js`） | ~10 分钟 | `uptime.yml` → `scripts/uptime-check.sh` | ✅ |
| **2 合成监控** | 关键流程走得通吗（真浏览器加购） | 每小时 + 每次 theme 更新 | `site-health.yml` → Playwright | ✅ |
| **3 前端报错** | 访客浏览器里 JS 报错即上报（未知坏法也抓得到） | 实时收集 + 每小时汇总 | theme snippet → Cloudflare Worker → `monitor-alerts.yml` | 🔧 等 CF token |
| **4 业务指标** | 白天加购数异常为 0 就报警（最后兜底） | 每小时 | `monitor-alerts.yml` → GA4 API | ✅ 观察模式运行中 |

背景：2026 年 8 月，theme 的一个 bug 让 v3 商品页的加购按钮**静默失效了 4 天**才被发现（修复见 `106eaf5`）。该 bug 没有抛出任何 JS 错误——所以第 2 层（真浏览器点按钮）是主力，第 3 层抓会报错的坏法，第 1 层管「整站挂了」的分钟级发现，第 4 层管「前面全漏掉但钱的信号不会骗人」。

存储：监控状态和错误记录存在 Cloudflare D1 数据库 `apgo-monitoring`（隔离、免费额度内）。阈值集中在 `alerts-config.json`，改配置不用动代码。

## 第 1 层：Uptime 拨测

- 每 ~10 分钟 curl 首页 + `/cart.js`（GitHub cron 有几分钟抖动，实际 10–15 分钟）
- 失败等 30 秒复查一次，双失败才算宕机 → 告警；持续宕机每小时重报一次（不刷屏）；恢复时发「✅ 已恢复，宕机约 X 分钟」
- D1 不可用时退化为无状态模式：照样告警（可能重复），绝不漏报
- 测试告警链路：Actions → Uptime → Run workflow → 勾 `force_fail`（不打真站）

## 第 2 层：合成监控（原有系统，未改动）

对 `sites.json` 里每个 `enabled` 的 Shopify 站跑三项：首页可访问、Cart API（`POST /cart/add.js` → 验证 `item_count`）、**真浏览器加购**（处理赠品选择器 → 点按钮 → 验证购物车）。加购不扣库存、不产生订单；屏蔽 GA4/Meta/TikTok 等分析请求不污染数据；UA 带 `APGO-HealthCheck` 标记。失败时 Telegram 告警 + 上传 trace/截图 artifact（7 天）。

### 第 2 层告警分诊速查

| 告警里的失败项 | 多半是什么 | 要做什么 |
|---|---|---|
| `/cart/add.js HTTP status` 且详情是 5xx | Shopify 后端短暂抖动（检查已内建 ~40 秒重试，仍失败说明还在持续） | 等下一轮；连续 ≥2 轮失败才需要排查 |
| `Sold out — replace this monitoring product` | 监控用的商品售罄/下架了 | 换 `sites.json` 里的 handle，不是站点故障 |
| `cart item_count did not increase` | 前端加购真的坏了（8 月 bug 同类型），或写入接口持续故障 | 手机开商品页实测加购；再对照 cart API 项区分前端/后端 |

（2026-08-19 曾发生 `/cart/add.js` 503 约 1 分钟后自愈的真实案例，当时的检查重试间隔太密导致告警；现已拉开重试间隔，同类抖动不再响铃。）

## 第 3 层：前端 JS 报错监控（自建，无 Sentry）

- `snippets/apgo-error-monitor.liquid`（~2KB，`<head>` 最顶端）捕获 `window.onerror` + `unhandledrejection`
- **只上报本站资产**（`cdn.shopify.com/**/assets/*` 或本域内联）的错误；浏览器扩展、第三方脚本（Shogun/abpilot/商家贴的 CDN 脚本）、跨域 `Script error.` 一律丢弃——宁可漏报第三方，不给误报刷屏
- 每个访客 session 同错误只报一次、每次浏览最多 5 条；snippet 不含任何密钥
- Worker `apgo-error-monitor`（`cloudflare/worker/`）接收：丢弃巡检流量、限流（10 条/IP/分钟）、字段截断、IP 只存加盐哈希 → 写入 D1
- 每小时 `scripts/js-error-alert.mjs` 汇总：同一错误 **≥3 个访客**受影响、或**全新错误**出现 ≥2 次 → Telegram；同错误 6 小时冷却
- **静音误报**：把告警消息转发给 Claude，说「静音这个」即可（写 `known_signatures.muted=1`）；不用碰任何后台
- 自测：任何页面加 `?apgo_em_test=1` 会发一条 `apgo-em-selftest` 测试上报
- 已知局限：`theme.shogun.landing.liquid` 由 Shogun 自动生成、可能被它重写抹掉 snippet；第 2 层的 `expectErrorMonitor` 断言会在每小时巡检里发现这种情况

## 第 4 层：GA4 业务指标兜底

- 每小时查 GA4 Realtime API 近 30 分钟的 `add_to_cart` 数；与 28 天分时段中位数基线比对
- 仅在「平时该时段中位数 ≥3」的活跃时段检测；**连续 2 次为 0** 才触发
- 先跑**观察模式** 1–2 周（只记 `alert_log.would_alert`，不发通知），复盘调阈值后把 `alerts-config.json` 的 `ga4.mode` 改为 `"armed"` 正式开启
- 告警文案自带歧义提示：可能是网站坏了，也可能是 GA4 采集断了（都值得查）
- 测试：Run workflow 勾 `validate_ga4`（列出实时事件名）或 `simulate_zero`（走一遍告警逻辑）

## GitHub Secrets / Variables 总表

| Secret | 用途 | 设置文档 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 所有层的告警通道 | 本文末尾 |
| `CF_API_TOKEN` / `CF_ACCOUNT_ID` | 第 1/3/4 层的状态存储 + Worker 部署 | `docs/cloudflare-setup.md` |
| Repository Variable `GA4_PROPERTY_ID` / `GCP_WIF_PROVIDER` | 第 4 层通过 GitHub OIDC 读取 GA4；不保存 JSON key | `docs/ga4-setup.md` |

任何必要配置未设时对应功能**优雅跳过**，不影响其他层。

## 如何接入更多网站

**再加一个 Shopify 店（如 apgo.com.tw）**：编辑 `sites.json` 里的 `apgo-tw` 占位——`enabled` 改 `true`，`products` 填 1–2 个长期在架、库存深的商品 handle，`apiCheckVariantId` 填在售 variant 的数字 ID。第 1、2 层立即生效；第 3 层需在 Worker 的 `OWN_ORIGINS` 加上新域名。

**接入自建网站（如洗衣精订阅站）**：`tests/` 下新增一份 spec 覆盖它的关键流程，建议该站加 `/health` 端点；第 1 层只要 `sites.json` 有 `baseUrl` 就会拨测。

**换监控商品**（下架/售罄时测试会明确报 `replace this monitoring product`）：改 `sites.json` 里对应的 `handle`。

## Telegram bot 设置（已完成，供参考）

1. `@BotFather` → `/newbot` → 拿 token；把 bot 加进告警群
2. 群里发条消息 → 开 `https://api.telegram.org/bot<TOKEN>/getUpdates` 找 `"chat":{"id":-100...}`（负数）
3. Repo Settings → Secrets 加 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`

## 本地运行（第 2 层）

```
cd monitoring
npm install
npx playwright install chromium
npx playwright test
```

失败时 `test-results/` 里有截图和 trace（`npx playwright show-trace <trace.zip>`）。

## 巡检频率与额度

repo 目前是 public，GitHub Actions 免费无限。若转 private：免费额度 2000 分钟/月，第 2 层每轮 2–3 分钟（每小时 ≈ 1500 分钟/月），第 1 层每轮 <1 分钟——两者相加会超额，需要降频或升级方案。
