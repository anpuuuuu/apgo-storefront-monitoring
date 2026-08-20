# 交接文档：APGO 四层监控系统（给接手的 agent）

> 2026-08-19 由上一个 Claude session 写。读完本文 + `README.md` 即可接手。
> 品牌主 Wade 非技术背景、主要说中文、告警都看 Telegram 群「网站检测系统」。

## 系统现状（全部已在 main 上运行）

| 层 | 状态 | 说明 |
|---|---|---|
| 1 拨测 | ✅ 运行中 | `uptime.yml` 每 ~10 分钟 curl apgo.my 首页 + /cart.js；CF secrets 未设前是无状态模式（会重复告警、无恢复通知），设好自动升级 |
| 2 合成监控 | ✅ 运行中 | `site-health.yml` 每小时 + 每次 theme push，真浏览器加购；已验证能抓真实故障（见下面事件史） |
| 3 前端报错 | 🔧 代码全好，未通电 | Worker 未部署（等 Wade 的 CF token）；theme snippet 已在 repo（`snippets/apgo-error-monitor.liquid`）但**未被任何 layout 引用**，是死代码，且端点 URL 还是占位符 |
| 4 业务指标 | 🔧 代码全好，未通电 | 等 Wade 的 GA4 secrets；配置里是 observe 模式 |

基础设施：Cloudflare D1 库 `apgo-monitoring`（id `c75e84af-67df-4761-a559-2b0c1d904989`，4 张表见 `cloudflare/worker/schema.sql`，已建好）。阈值集中在 `alerts-config.json`。GitHub secrets 现有 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`。

## 接下来要做的事（按触发条件）

### A. Wade 说「CF 弄好了」（他要照 `docs/cloudflare-setup.md` 加 `CF_API_TOKEN` + `CF_ACCOUNT_ID` 两个 secrets）

1. 手动 dispatch `Deploy error-monitor worker` workflow → 从 run 日志里拿 worker 的 `*.workers.dev` URL
2. 把 URL 填进两处：`snippets/apgo-error-monitor.liquid` 的 `EP='REPLACE_WITH_WORKER_URL'` 和 `alerts-config.json` 的 `cloudflare.worker_url`
3. curl 实测 worker 全分支：有效 payload→204 且 D1 有行（用 MCP `d1_database_query` 查）、>8KB→413、UA 含 `APGO-HealthCheck`→204 无行、同 IP 连发 11 条→429、缺字段→400
4. **跟 Wade 确认后**才动 theme：4 个 layout 各在 `<head>` 后加一行 `{% render 'apgo-error-monitor' %}`——`layout/theme.liquid`（第 7 行 `<head>` 之后）、`layout/password.liquid`、`layout/theme.shogun.landing.liquid`（此文件是 Shogun 自动生成、可能被重写，已知局限）、`templates/gift_card.liquid`。这是**全项目唯一改线上 theme 行为的步骤**，独立 commit，push 后盯自动触发的 Playwright run + 让 Wade 手机开一下网站
5. 上线后：访问 `https://apgo.my/?apgo_em_test=1`（手机+电脑）→ D1 里应出现 2 个 session 的 `apgo-em-selftest` 行；把 `monitoring/sites.json` 里 apgo-my 的 `expectErrorMonitor` 改 `true`（巡检从此断言 snippet 存活）；dispatch `monitor-alerts.yml` 带 `min_sessions_override=1` 测通告警 → 然后 `UPDATE known_signatures SET muted=1 WHERE sample_message='apgo-em-selftest'` 静音自测签名
6. 头一两周每天用 MCP 查一眼 `js_errors`，静音良性噪音（预计 1–2 个）

### B. Wade 说「GA4 弄好了」（他要照 `docs/ga4-setup.md` 加 `GA4_PROPERTY_ID` + `GCP_SA_KEY`）

注意：他复用现成的服务账号 `codex-ga4-reader@helical-canto-505209-j7.iam.gserviceaccount.com`（原 doc 里的新建步骤他跳过了）。

1. **门槛验证先行**：晚间繁忙时段 dispatch `monitor-alerts.yml` 勾 `validate_ga4` → 日志里看 realtime 事件名单里**有没有 `add_to_cart`**。没有 = Shopify 走服务端上报、零值检测设计不成立，**停下换方案**（退路：runReport 滞后日环比，或用第 3 层管道自建加购计数），别硬上
2. 验证通过 → 什么都不用做，observe 模式自动开始跑（每小时,只记 `alert_log` 的 `would_alert` 行、不发通知）
3. 1–2 周后用 MCP 查 `alert_log` 复盘 would_alert,向 Wade 汇报误报率,必要时调 `alerts-config.json` 的 `ga4.min_hour_median` → 他点头后把 `ga4.mode` 改 `"armed"`（一行 commit）

### C. 日常值守

- 群里出巡检告警时：先看 Telegram 消息里的错误详情行（会写 HTTP 状态码）。分诊表在 `README.md`「第 2 层告警分诊速查」。5xx 且下轮恢复 = 平台抖动,结案不用动
- L3 通电后若某错误签名是误报：`UPDATE known_signatures SET muted=1 WHERE signature='<sig>'`（MCP d1_database_query,database_id 见上）
- 想接 apgo.com.tw：改 `sites.json` 的 apgo-tw 占位 + Worker `OWN_ORIGINS` 加域名

## 关键环境事实（能省你很多弯路）

- **沙箱连不上 apgo.my**（出口代理 403,artifact 的 azure blob 也被挡）→ 所有实测都通过 push/dispatch 让 GitHub Actions 跑,用 GitHub MCP 读日志
- Playwright 失败 artifact 下载不了,但 `get_job_logs` 里有错误详情,通常够用
- Cloudflare MCP 能建/查 D1,但**不能部署 Worker** → 部署走 `deploy-worker.yml`（wrangler-action）
- Shopify MCP 之前连的是台湾店(apgo.tw),已按 Wade 要求吊销、等他重新授权选 **apgo.my**;确认方法:`get-shop-info` 看 domain
- GitHub cron 抖动大(名义每小时,实际迟 40–50 分钟常见);runner 偶发网络慢(8/19 apt 源挂起吃掉整个 job,已加 5 分钟降级兜底)
- Wade 的 Supabase「Maestro」项目有 31 张表没开 RLS(anon key 可读写)——与监控无关的既有安全隐患,已提醒过他,他还没处理

## 事件史（背景）

- **2026-08 初**：theme bug 让 v3 商品页加购静默失效 4 天（修复 `106eaf5`,无 JS 报错,只有真浏览器能抓）→ 整套系统的起因
- **2026-08-19**：Shopify POST /cart/add.js 503 约 1 分钟自愈,巡检 10 分钟内告警（系统首次真实触发,工作正常）;复盘后加了抗抖动重试、告警带错误详情、CI 两处加固
