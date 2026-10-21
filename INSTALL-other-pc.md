# 在其他电脑上安装「余额挂件」

插件是纯 JavaScript 的本地 bundle，不需要编译、没有 npm 依赖；复制目录 + 安装即可。适用于同一代 DeepSeek Harness 桌面版（0.2.x），Windows / macOS / Linux 都可以。

## 方式 A：从 GitHub 仓库安装（推荐，不用拷贝文件）

在另一台电脑的 DSH 里打开「插件」→「添加插件」→「安装第三方插件」，输入：

```
https://github.com/iotayiluo/dsh-balance-chip.git
```

勾选信任并点「安装」，完成后刷新页面。

> 目标电脑需要装有 Git（插件管理器用 pnpm 拉取仓库时会调用它）。没装的话可以用免安装的 MinGit：下载
> https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip
> 解压到固定目录，把里面的 `cmd` 目录加进 PATH 即可（不需要管理员权限）。

## 方式 B：从 npm 安装（可选，需先发布）

插件发布到 npm 后（包名 `dsh-balance-chip`），在另一台电脑上：

1. 打开侧边栏「插件」→「添加插件」→ 选「安装第三方插件」；
2. 在包名框输入 `dsh-balance-chip`；
3. Registry 选官方 npm（新发布的包在 npmmirror 上可能要等同步）；
4. 勾选信任并点「安装」，完成后刷新页面。

## 方式 C：从本地目录安装

## 1. 复制插件目录

把这台电脑上的 `balance-widget` 整个文件夹复制到新电脑的一个**固定位置**，例如：

```
D:\DSH\plugins\balance-widget
```

也可以直接解压随附的 `balance-widget-portable.zip`（解压后得到 `balance-widget` 文件夹）。

> ⚠️ 安装方式是「链接这个目录」，所以之后**不要移动或删除**它；换位置后需要在新位置重新安装一次。

## 2. 安装到 DSH profile

在新电脑的 DSH 里打开一个会话，让 Agent 安装本地 bundle，直接说：

```
用 plugin_manager install_bundle 安装本地 bundle：D:\DSH\plugins\balance-widget
```

安装成功后，侧边栏底部（设置那一行上方）会出现余额挂件；如果没出现，刷新一下页面。

## 3. DeepSeek 余额

在新电脑的 DSH「设置 → 账户」登录 DeepSeek 账户即可。没登录时挂件显示「未登录」，登录后自动显示余额。

## 4. 302.AI 余额（可选）

插件默认用凭据引用 `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY` 取 302.AI 的 key（和这台机器一样，来自 image-gen 插件）。新电脑二选一：

- **推荐（不装 image-gen 也行）**：在新电脑的 `%USERPROFILE%\.dsh\.env`（macOS/Linux 为 `~/.dsh/.env`）里加一行：

  ```ini
  DSH_IMAGE_GEN_OPENAI_COMPAT_KEY=sk-你的302密钥
  ```

  然后重启 DSH。凭据服务会从 harness home 的 `.env` 读取它。

- 或者：新电脑也装 image-gen 插件，在「设置 → 插件 → 图像生成」里填同一个 302.AI key。

没配置时 302 行会显示「未配置 API Key」，不影响另外两个余额。

## 5. APIYI 余额（可选）

把本机的这个文件：

```
F:\DSH\talk\.secrets\apiyi-token.txt
```

复制到新电脑插件父目录下的 `.secrets\` 里，例如：

```
D:\DSH\plugins\.secrets\apiyi-token.txt
```

（一行 `nap_...` 开头的个人访问令牌，不要有别的字符。）

插件默认按「插件目录/../.secrets/apiyi-token.txt」找它；也可以设环境变量 `DSH_BALANCE_WIDGET_APIYI_TOKEN_FILE` 指向任意绝对路径。

没配置时 APIYI 行显示「未配置个人访问令牌」。

## 6. 302.AI 充值页的登录态

与插件无关：在新电脑的**默认浏览器**里登录一次 `https://dash.302ai.cn` 并保持登录（别用无痕、别设置退出清 Cookie），之后右键点 302 余额就能直达充值页且是登录状态。

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_BALANCE_WIDGET_RELAY_BASE` | `https://api.302ai.cn` | 302.AI 接口根地址（海外可换 `https://api.302.ai`） |
| `DSH_BALANCE_WIDGET_RELAY_REF` | `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY` | 用哪个凭据引用取 302 key |
| `DSH_BALANCE_WIDGET_RELAY_TOPUP` | `https://dash.302ai.cn/user-center/charge` | 右键 302 余额打开的充值页 |
| `DSH_BALANCE_WIDGET_APIYI_TOKEN_FILE` | `<插件目录>/../.secrets/apiyi-token.txt` | APIYI 个人访问令牌文件 |
| `DSH_BALANCE_WIDGET_APIYI_TOPUP` | `https://api.apiyi.com/account/profile` | 右键 APIYI 余额打开的充值/控制台页 |

## 装好后怎么检查

1. 侧边栏底部出现 `● 余额 ¥…`；
2. 鼠标悬停能看到 DeepSeek / 302.AI / APIYI 三行和更新时间；
3. 右键挂件弹出三行余额 + 「刷新余额」；
4. 点击某行余额会用系统默认浏览器打开对应充值页。

如果挂件没出现：

- 到「插件」页确认 `@local/dsh-balance-widget` 已启用；
- 刷新页面；
- 确认那台电脑的 DSH 有 `sidebar.footer.action` 插槽（0.2.x 桌面版都有）；
- 302 余额显示「未配置」是第 4 步没做，APIYI 显示「未配置」是第 5 步没做，都不影响其他余额。
