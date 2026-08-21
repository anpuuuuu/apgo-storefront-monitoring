# APGO 四层网站监控

目标：约 10 分钟内确认整站/API 故障，约 1 小时内发现购物流程故障，并用 GA4 检查业务漏斗异常。所有正式告警送到现有 Telegram 群。

| Layer | 负责内容 | 频率 | 执行位置 |
|---|---|---|---|
| 1 | Homepage + `/cart.js` 存活、速度、恢复 | Cloudflare 每 5 分钟 | `cloudflare/worker/` |
| 2 | MY/SG 真实浏览器购物流程 | 轻量每小时；完整每日两次/Theme Push | `site-health.yml` |
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

配置全部集中在 `sites.json`，商品或 Variant 过期时抛出 `TEST_CONFIG_STALE`，不会伪装成网站故障。

- 轻量：Homepage、导航、Layer 3 bootstrap、Cart API、普通/赠品 V3、洗衣精香味/图片/数量总价/正确 Variant、购物车数量/小计/删除。
- 完整：每个市场分别以独立 Session 测试 Detergent、Glaze 和推荐/Checkout；币种；MY 6 包=4+2、9 包=6+3；SG 6 包全数收费；赠品保护；Glaze Trigger/Add-on；Cart Offers Tabs；Checkout 摘要。不会提交订单。
- 每个旅程开始/结束清空购物车；UA 为 `APGO-HealthCheck`；GA4/Meta/TikTok/Clarity 等请求被阻止。
- Shopify `429` 使用 5/15/45 秒退避；持续 429 明确报告为平台限流，不归类为商品配置失效，也不自动重跑整套真实写入。
- 失败上传 Screenshot、Trace、Console、Network 和最终 Cart JSON；关闭 Video，避免单次失败产生数百 MB 无效文件。

本地：

```powershell
cd monitoring
npm ci
npx playwright install chromium
npm run test:light
npm run test:full
```

## Layer 3

`snippets/apgo-error-monitor.liquid` 接入 Theme、Password、Shogun Landing 和 Gift Card。

- 收集 `window.error`、第一方资源加载失败、`unhandledrejection`、Cart API 失败和 Theme 主动触发的 `apgo:cart-error`。
- 只发送清理后的 path，不发送 query、姓名、邮箱、地址或 cart token。
- Worker 只接受 APGO/Shopify Origin，限制 8KB、10 条/IP/分钟；IP 每日散列。
- 非 Critical：10 分钟内至少 3 次且至少 2 个 Session 才告警；两小时同 Signature 不重复。
- 5xx/Network Critical Cart Error 可立即告警。
- Error 30 天、Alert 90 天；已知 Signature 可在 `known_signatures.muted=1` 静音。
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
4. 保持 `CRON_ENABLED=false` 验证 `/health`、Heartbeat、Beacon、D1 和 Telegram。
5. 手动跑 Layer 2、Layer 3 self-test、Layer 4 validate。
6. 改 `CRON_ENABLED=true` 并重新部署。

紧急回退：先把 `CRON_ENABLED` 改回 `false` 部署；Theme 错误监控 snippet 本身所有发送均为 fail-safe，不会阻挡页面或购物车。
