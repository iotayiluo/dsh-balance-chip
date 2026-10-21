# 余额挂件 · Balance Widget

在 DeepSeek Harness 的 Web 界面左侧边栏底部（设置/账户那一行上方）显示已登录 DeepSeek 账户的剩余余额；鼠标悬停还会列出 **302.AI（生图中转）**、**APIYI（API易）** 账户余额和更新时间。

![侧边栏效果](.verify/balance-chip-latest.png)

## 行为

- **显示位置**：`sidebar.footer.action` 插槽，和 Settings 同一行区域；侧边栏收窄成 56px 图标栏时只显示金额。
- **DeepSeek 余额**：Host 端 `ctx.deepseekAccount.getBalance()`，和「设置 → 账户」里的余额是同一份数据。
- **302.AI 余额**：Host 端用生图插件那把 key（凭据引用 `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY`）请求 302.AI 的 `GET /dashboard/balance`，显示在悬停提示里。
- **APIYI 余额**：Host 端用个人访问令牌（`nap_...`，存放在 `F:\DSH\talk\.secrets\apiyi-token.txt`，一行）请求 `GET https://api.apiyi.com/api/user/self`，把 `quota ÷ 500000` 显示成美元。
- **只在变化时更新，没有定时轮询**：Host 监听事件，在余额可能变化时才读一次，并且读到的值和上次显示的值不一样才推送给页面：
  - DeepSeek：每次工具调用结束（一个模型步骤消耗了 token）、Agent 回到空闲（一轮对话结束）、账户登出/过期时刷新。
  - 302.AI / APIYI：生图类工具（`generate_image` / `generate_images` / `edit_image` 等）结束时刷新；对应凭据变化时也会刷新。
  - **复读确认（60 秒 + 180 秒）**：因为平台扣费可能滞后，每次事件触发的读取之后，会在 60 秒和 180 秒各再读一次确认；复读不循环，同样只有值变化才推送。若期间又有新的事件读取，复读时间以最后一次读取为准。
  - 打开页面时推送一次当前值；点击挂件可立即手动刷新三者；窗口重新获得焦点/可见时也会各读一次，避免后台漏掉的推送导致显示过期。
  - 因为读取由 Host 侧事件驱动，窗口在后台也能正常收到变化后的推送。
- **状态**：
  - 绿色点 + `余额 ¥45.47`：正常，显示充值余额；赠送余额为 0 时只在悬停提示里出现。
  - 灰色点 + `未登录`：本机没有已登录的 DeepSeek 账户凭据，可在「设置 → 账户」登录。
  - 黄色/红色点 + `读取失败`：平台请求失败或网络不可用，点击重试。
  - 悬停提示里的 302.AI 行还会显示 `读取中…`、`未配置 API Key`、`API Key 未开启余额权限`、`读取失败`；APIYI 行会显示 `未配置个人访问令牌`、`令牌无效或无权限`、`读取失败`。
- 悬停提示里的「更新时间」是上一次数值发生变化的时间；没有变化时不会跳。
- **右键挂件**：弹出上下文菜单，列出 DeepSeek、302.AI、APIYI 余额，**点击任一余额会在系统默认浏览器里打开对应充值页**（DeepSeek 用账户返回的 `topUpUrl`；302.AI 默认打开 `https://dash.302ai.cn/user-center/charge`；APIYI 默认打开 `https://api.apiyi.com/account/profile`，均可用环境变量覆盖）。菜单里还有「刷新余额」和更新时间。
- 账户 token、302 API key、APIYI 个人访问令牌都不会进入浏览器，只由 Host 使用。

![右键菜单](.verify/balance-menu.png)

**302.AI 充值页的登录态**：插件只负责用默认浏览器（本机为 Edge）打开充值页，不保存 302 账号密码。能否直接显示已登录取决于该浏览器里的 302 会话：在 Edge 里登录一次并保持后，之后点开就是充值页；如果 Edge 设置了退出时清理 Cookie 或使用无痕模式，则每次都需要重新登录。

## 302.AI 余额需要开权限

302.AI 文档写明余额接口需要给这把 API Key 开启「是否用于系统管理」权限（API 字段 `allow_manage_key`）。没开时接口返回 403，悬停提示会显示 `API Key 未开启余额权限`。

开启方式（二选一）：

1. 到 302.AI 控制台的 API Keys 页面，编辑生图用的这把 key，打开「是否用于系统管理」；或
2. 新建一把勾选该权限的 key，替换「设置 → 插件 → 图像生成」里的 302.AI key（凭据引用不变）。

开启后不用改代码、不用重启：下一次生图或点一下挂件即可看到真实余额。

## APIYI 余额需要个人访问令牌

APIYI（API易）的余额接口用的是**个人访问令牌**（`nap_` 开头），不是模型 API Key。创建步骤：

1. 打开 https://api.apiyi.com/account/profile →「账户选项」→「个人访问令牌」→「创建令牌」；
2. 权限勾选 **个人资料 · 读取**（创建后权限不能修改），有效期建议选久一点；
3. 复制令牌（`nap_...`），存到 `F:\DSH\talk\.secrets\apiyi-token.txt`（一行纯文本）。

保存后点一下挂件或等下一次事件刷新即可看到 APIYI 余额；显示的是 `quota ÷ 500000` 的美元金额。

相关配置可通过启动环境变量覆盖（默认值已适配本机）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_BALANCE_WIDGET_RELAY_BASE` | `https://api.302ai.cn` | 302.AI 接口根地址（海外网络可换成 `https://api.302.ai`） |
| `DSH_BALANCE_WIDGET_RELAY_REF` | `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY` | 用哪个凭据引用取 key |
| `DSH_BALANCE_WIDGET_RELAY_TOPUP` | `https://dash.302ai.cn/user-center/charge` | 右键菜单里 302.AI 余额点击后打开的充值页地址 |
| `DSH_BALANCE_WIDGET_APIYI_TOKEN_FILE` | `F:\DSH\talk\.secrets\apiyi-token.txt` | APIYI 个人访问令牌文件路径 |
| `DSH_BALANCE_WIDGET_APIYI_TOPUP` | `https://api.apiyi.com/account/profile` | 右键菜单里 APIYI 余额点击后打开的充值页/控制台地址 |

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：注册 `balance` / `relay-balance` / `apiyi-balance` 三个一次性接口、`stream`（SSE）推送和 `open-topup`（在默认浏览器打开充值页）；监听 `tools/result`、`agent/status`、账户与凭据事件，按需读取并在值变化时广播。 |
| `client.js` | Client 半：在 `sidebar.footer.action` 注册挂件，订阅 SSE，点击手动刷新，右键弹出三处余额/充值菜单。 |
| `cordis.patch.yml` | Bundle patch，插入一行 `balance-widget`。 |
| `package.json` | Bundle 清单：`dsh.bundle.patch` + `dsh.client`。 |
| `locale/*.json` | 插件管理页显示的标题和描述（中/英）。 |
| `icon.svg` | 插件图标。 |

## 安装 / 卸载

本目录已作为本地 bundle 安装进 `desktop` profile（`link:F:\DSH\talk\balance-widget`），对所有会话生效，重启后仍在。

- 在「插件」页里禁用或移除 `@local/dsh-balance-widget` 即可停用。
- 改代码后：Host 半（`index.js`）需要重载插件（在插件页把 bundle 关掉再打开）或重启应用；Client 半（`client.js`）刷新页面即可重新加载。
- 想改事件合并窗口，改 `index.js` 里的 `ACCOUNT_DEBOUNCE_MS` / `RELAY_DEBOUNCE_MS`。
- 想改显示位置，把 `client.js` 里的 `sidebar.footer.action` 换成其他插槽，例如 `conversation.input.right`。

**换到其他电脑**：见 [INSTALL-other-pc.md](INSTALL-other-pc.md)，或直接解压 `balance-widget-portable.zip` 后按说明安装。
