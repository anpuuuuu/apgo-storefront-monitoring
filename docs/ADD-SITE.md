# Add another storefront

新增网站不复制四层代码，也不建立另一个 Telegram Bot。标准接入流程：

1. 在 `config/sites.json` 新增唯一的 `id/siteId`、显示标签、Storefront Origins、Base URL、Theme Repo 名称与 immutable Repository ID、默认分支、GA4 Property、市场和启用层级。
2. 加入该站 Layer 2 的 Theme Contract、购买路径和必要 Fixture；普通广告 Landing Page 继续由 GA4 自动发现。
3. 执行 `npm run generate:sites`。这会同时更新 Error Worker 与 Dispatcher 使用的 Site Catalog；不要直接手改生成文件。
4. 安装 `APGO Storefront Monitor` GitHub App 到新 Theme Repo，并确认 Push Payload 的 Repository ID 与配置相同。
5. 将新 GA4 Property 授予现有只读 Service Account Viewer 权限。中央 Repo WIF 不因新增网站而改变。
6. 手动跑 Layer 1、Layer 2 Daily/Post-deploy、Layer 3 self-test、Layer 4 validate 各三次。
7. 先对新 Site 开 Shadow，对比 48 小时后才启用正式 Heartbeat 和 `[SITE LABEL][Layer N]` Telegram。

CI 会拒绝重复 Site ID、Repository ID、Repository 名称、Storefront Origin、缺字段或未重新生成的 Catalog。浏览器提交的 Site ID 永远不受信任；Layer 3 只根据合法 Origin 映射。
