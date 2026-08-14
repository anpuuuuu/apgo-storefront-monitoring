# APGO 网站健康监控（Synthetic Monitoring）

用 GitHub Actions + Playwright 定时模拟真实顾客走关键流程（打开商品页 → 点「加入购物车」→ 验证购物车里真的有东西），任何一步失败就发 Telegram 告警。

背景：2026 年 8 月，theme 的一个 bug 让 v3 商品页的加购按钮**静默失效了 4 天**才被发现（修复见 commit `106eaf5`）。该 bug 没有抛出任何 JS 错误，Sentry 类错误监控抓不到——只有「真浏览器点一遍按钮」能发现。这套系统就是为此而建。

## 检查内容

对 `sites.json` 里每个 `enabled: true` 的 Shopify 站点跑三项：

| 检查 | 抓什么故障 |
|---|---|
| 首页可访问（HTTP < 400） | 站点整体挂掉、域名/SSL 问题 |
| Cart API（`POST /cart/add.js` 已知 variant → 验证 `item_count`） | 商品下架、variant 失效、后台配置错误 |
| **真浏览器加购**（打开商品页 → 处理赠品选择器 → 点加购按钮 → 验证购物车） | **前端 JS 静默失效（8 月 bug 的类型）**、按钮被挡、theme 改坏 |

对营运无副作用：加购不扣库存、不产生订单；监控流量会屏蔽 GA4/Meta/TikTok 等分析脚本，不污染数据；User-Agent 带 `APGO-HealthCheck` 标记，需要时可在日志里过滤。

## 触发时机

1. **定时巡检**：每小时（`.github/workflows/site-health.yml` 里的 cron `7 * * * *`）
2. **部署后自检**：每次 push 到 main 且改动 theme 文件（含 Shopify 后台改 theme 后的自动同步 commit）
3. **手动**：GitHub → Actions → Site health → Run workflow

> ⚠️ 定时 cron 只在**默认分支（main）**生效，所以本目录合并进 main 后巡检才会开始跑。

## 上线步骤（约 5 分钟）

### 1. 建 Telegram bot

1. Telegram 搜 `@BotFather` → 发送 `/newbot` → 按提示取名 → 拿到 **bot token**（形如 `1234567890:AAxxxx...`）
2. 把这个 bot 加进要收告警的**群组**
3. 在群里随便发一条消息，然后浏览器打开（换成你的 token）：
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   在返回的 JSON 里找 `"chat":{"id":-100xxxxxxxxxx` —— 这个**负数**就是群的 chat_id
4. 先测试通路（换成你的 token 和 chat_id）：

   ```
   curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" -d chat_id=<CHAT_ID> -d text="APGO 监控测试"
   ```

   群里收到消息即为成功。

### 2. 设 GitHub Secrets

Repo → Settings → Secrets and variables → Actions → New repository secret，新增两个：

- `TELEGRAM_BOT_TOKEN` = bot token
- `TELEGRAM_CHAT_ID` = 群的 chat_id（负数）

Secrets 没设时检查照常跑，只是失败不会发 Telegram（workflow 日志里会提示）。

### 3. 合并到 main

合并后每小时自动巡检 + 每次 theme 更新自动加测。可先在 Actions 页手动 Run workflow 验证一次全绿。

## 如何接入更多网站

**再加一个 Shopify 店（如 apgo.com.tw）**：编辑 `sites.json` 里的 `apgo-tw` 占位——`enabled` 改 `true`，`products` 填 1–2 个长期在架、库存深的商品 handle，`apiCheckVariantId` 填一个在售 variant 的数字 ID。不用改任何代码。

**接入自建网站（如洗衣精订阅站）**：在 `tests/` 下新增一份 spec（参照 `shopify-storefront.spec.js` 的结构），覆盖它的关键流程（首页 → 方案页 → 进入结账第一步）；建议同时在该站加一个 `/health` 端点（检查数据库、周期扣款任务心跳），spec 里一并打这个端点。

**换监控商品**（商品下架/售罄时测试会明确报 `replace this monitoring product`）：改 `sites.json` 里对应的 `handle` 即可。

## 调整巡检频率

改 workflow 里的 cron。注意：私有 repo 的 GitHub Actions 免费额度是 2000 分钟/月，每轮约 2–3 分钟——每小时 ≈ 1500 分钟/月（安全），每 30 分钟 ≈ 3000 分钟/月（会超额）。想要更高频率且不吃额度，可把同一份 Playwright 脚本托管到 Checkly（免费版含浏览器检查额度）。

## 本地运行

```
cd monitoring
npm install
npx playwright install chromium
npx playwright test
```

失败时 `test-results/` 里有截图和 trace（`npx playwright show-trace <trace.zip>` 查看）。
