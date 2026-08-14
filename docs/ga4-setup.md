# GA4 授权设置（第 4 层需要，约 30–45 分钟）

第 4 层要读 GA4 的「加入购物车（add_to_cart）」事件数，跟历史基线比对，白天连续为 0 就报警。这需要给监控系统一个**只读** GA4 的机器人账号（服务账号）。步骤略繁琐但都是点按钮，跟着做即可；卡在任何一步直接把截图丢给 Claude。

## 第 1 步：建 Google Cloud 项目（如果还没有）

1. 打开 <https://console.cloud.google.com>，用管理 GA4 的那个 Google 账号登录
2. 顶部项目下拉 → **New Project** → 名字填 `apgo-monitoring` → **Create**，然后切换到这个项目

## 第 2 步：启用 Analytics Data API

1. 打开 <https://console.cloud.google.com/apis/library>
2. 搜索 **Google Analytics Data API** → 点进去 → **Enable**

## 第 3 步：创建服务账号 + 下载密钥

1. 打开 <https://console.cloud.google.com/iam-admin/serviceaccounts>
2. **Create service account** → 名字填 `apgo-ga4-reader` → **Create and continue** → 角色留空直接 **Done**（GA4 权限在第 4 步单独给）
3. 点进刚建的服务账号 → **Keys** 页签 → **Add key → Create new key → JSON → Create**，浏览器会下载一个 `.json` 文件
4. 顺便复制服务账号的邮箱地址（形如 `apgo-ga4-reader@apgo-monitoring.iam.gserviceaccount.com`）

## 第 4 步：把服务账号加进 GA4

1. 打开 <https://analytics.google.com> → 左下角 **Admin（管理）**
2. 确认顶部选中的是 apgo.my 用的那个 property
3. **Property Access Management（资源存取权管理）** → 右上 **+** → **Add users**
4. 贴上第 3 步的服务账号邮箱 → 角色选 **Viewer（检视者）** → **Add**
5. 顺便看一下 **Property Settings（资源设定）** 里的 **Reporting time zone**，确认是 **Malaysia (GMT+08:00)** —— 不是的话告诉 Claude，检测的时段逻辑要跟着调

## 第 5 步：拿 Property ID

还在 Admin 页：**Property Settings** 最上方的 **PROPERTY ID**（一串数字，如 `3421xxxxx`），复制。

## 第 6 步：加进 GitHub secrets

打开 <https://github.com/anpuuuuu/apgo-theme/settings/secrets/actions> → **New repository secret**，加两条：

| Name | Value |
|---|---|
| `GA4_PROPERTY_ID` | 第 5 步的数字 ID |
| `GCP_SA_KEY` | 用记事本打开第 3 步下载的 `.json`，**整个文件内容**复制贴入 |

贴完后把下载的 `.json` 文件删掉（它等于一把钥匙，不要留在下载文件夹）。

## 完成之后

说一声「GA4 弄好了」，Claude 会先跑一次**门槛验证**（确认 add_to_cart 事件真的出现在 GA4 实时接口里——Shopify 的某些接法不会出现，那样就得换方案），验证通过后第 4 层先以**观察模式**跑 1–2 周（只记录、不打扰），调好阈值再正式开启报警。
