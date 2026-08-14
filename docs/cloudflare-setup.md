# Cloudflare 设置（第 1/3/4 层需要，约 10 分钟）

监控系统用你 Cloudflare 账号里的两样东西：

- **D1 数据库 `apgo-monitoring`**（已由 Claude 建好）：存监控状态和前端错误记录
- **Worker `apgo-error-monitor`**（代码在 `monitoring/cloudflare/worker/`，等你完成下面步骤后由 GitHub Actions 自动部署）：接收访客浏览器的报错

你只需要做一件事：**创建一个 API token 并放进 GitHub secrets**。token 只存在 GitHub secrets 里，不需要发给任何人。

## 第 1 步：创建 API token

1. 打开 <https://dash.cloudflare.com/profile/api-tokens>
2. 点 **Create Token**
3. 选模板 **Edit Cloudflare Workers** → **Use template**
4. 在 **Permissions** 区块，点 **+ Add more** 加一条：
   - `Account` / `D1` / `Edit`
5. **Account Resources** 选你的账号；**Zone Resources** 保持模板默认即可
6. **Continue to summary** → **Create Token**
7. 复制生成的 token（只显示这一次）

## 第 2 步：找到 Account ID

打开 <https://dash.cloudflare.com> → 点进 **Workers & Pages** → 右侧栏就有 **Account ID**，点 Copy。

## 第 3 步：加进 GitHub secrets

打开 <https://github.com/anpuuuuu/apgo-theme/settings/secrets/actions> → **New repository secret**，加两条：

| Name | Value |
|---|---|
| `CF_API_TOKEN` | 第 1 步复制的 token |
| `CF_ACCOUNT_ID` | 第 2 步复制的 Account ID |

## 完成之后

在群里或对话里说一声「CF 弄好了」，Claude 会：

1. 触发 `Deploy error-monitor worker` workflow 部署 Worker，拿到它的公网地址
2. 把地址填进 `snippets/apgo-error-monitor.liquid`，测试整条链路
3. 测试通过后才把 snippet 接进 theme（会先跟你确认）

> 补充：这个 token 权限只有「改 Workers + 改 D1」，动不了你的域名解析、防火墙等其他 Cloudflare 设置。想撤销随时回到 API Tokens 页面删掉即可。
