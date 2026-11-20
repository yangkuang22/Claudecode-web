# Claude Web

给 [Claude Code](https://docs.claude.com/claude-code) 终端版套一个网页聊天界面。不用再对着终端打字，用浏览器（手机、电脑都行）就能和 Claude Code 对话。

- **零依赖**：只要 Node.js，不用 `npm install` 任何包，没有需要编译的原生模块，所以在 Android Termux / proot 里也能直接跑
- **跨平台**：Windows、macOS、Linux、Android（Termux + proot-distro）
- **用你自己的 Claude Code**：直接调用本机已登录的 `claude` 命令，会话记录和终端版互通（`claude --resume` 能看到网页里的对话，反之亦然）

## 功能

| 功能 | 说明 |
|---|---|
| 流式聊天 | 逐字输出，Markdown / 表格 / 代码块（一键复制），工具调用折叠卡片，思考过程 |
| 思考过程显示 | 工具栏「思考」按钮切换：显示摘要 / 只看标题 / 不显示（Claude Code 默认不返回思考内容） |
| 中途提问 | Claude 跑到一半想问你时（AskUserQuestion）弹出卡片：点选项或自己输入，提交后接着跑 |
| Codex 子代理 | Claude 当主模型，子任务交给 Codex（GPT）做，用 ChatGPT 订阅额度；Codex 也支持多账号（见下方） |
| 多账号 | 同时保持多个账号登录，工具栏「账号」里切换；切换不登出，会话记录各账号共用（见下方「多账号」） |
| 出口锁 | 可选：claude 只走指定代理，出口 IP 不对就拦消息、停任务（见下方「出口锁」） |
| 操作审批 | 非 bypass 模式下，需要确认的命令 / 改文件弹出「允许 / 拒绝」卡片，拒绝时可以附上原因 |
| 智能滚动 | 往上滑就停止自动跟随，方便边出字边阅读；点 ↓ 或滑回底部恢复 |
| 断线续传 | 手机锁屏、切后台不会中断，回来自动接上 |
| 项目切换 | 网页里浏览任意文件夹打开项目，支持新建文件夹；多个项目可同时运行 |
| 会话管理 | 历史会话列表，重命名（与 `/rename` 互通）、删除 |
| 编辑重发 | 点消息下的「✎ 编辑」，从那条消息重新开始（回溯对话，原记录自动备份） |
| 图片 / 文件 | 拍照、相册、粘贴、拖拽上传；图片直接给 Claude 看，其他文件告诉 Claude 路径 |
| 模型 / effort | 一键切换具体模型（Fable 5.1、Opus 5.5、Opus 4.8……）和思考强度 |
| 权限模式 | acceptEdits / auto / bypassPermissions / plan / default 一键切换 |
| 用量 | 显示订阅的 5 小时窗口和每周额度、重置时间（查询不消耗额度） |
| 常用指令 | 输入 `/` 弹出菜单：`/compact` `/context` `/cost` `/init` 等 |
| 记忆编辑 | 查看、编辑、新建每个项目的自动记忆（memory）和 CLAUDE.md |

## 准备工作

1. 安装 **Node.js 18 或更高版本**：<https://nodejs.org>
2. 安装 **Claude Code** 并在终端里登录一次（运行 `claude`，按提示登录）：<https://docs.claude.com/claude-code>

## 安装和启动

### Windows

**方法一：下载即用（不需要 git）**

1. 在本页面点绿色的 **Code → Download ZIP**，解压到任意位置
2. 双击 `start-windows.bat`（要让同一 WiFi 下的手机也能访问，就双击 `start-windows-lan.bat`）
3. 浏览器会自动打开 <http://127.0.0.1:8765>

**方法二：装成全局命令**

```powershell
npm install -g github:yangkuang22/Claudecode-web
```

之后在任意项目文件夹里打开终端，运行 `claude-web` 即可（会自动打开浏览器）。

### macOS / Linux

```bash
npm install -g github:yangkuang22/Claudecode-web
cd 你的项目
claude-web
```

或者克隆后直接运行：`git clone` 本仓库，然后 `node server.js`。

### Android（Termux + proot-distro）

在 proot 的 Linux 里（已装好 Node 和 Claude Code）：

```bash
git clone https://github.com/yangkuang22/Claudecode-web.git ~/claude-web
ln -sf ~/claude-web/bin/cw ~/.local/bin/cw   # 确保 ~/.local/bin 在 PATH 里
cd 你的项目 && cw
```

更新到最新版：`cd ~/claude-web && git pull`，然后重启 `cw`。

如果以前是把 `server.js` / `index.html` 手动拷到 `~/.claude-web/` 里运行的，可以换成指向仓库的软链接，以后 `git pull` 就自动生效：

```bash
ln -sf ~/claude-web/server.js ~/.claude-web/server.js
ln -sf ~/claude-web/index.html ~/.claude-web/index.html
```

终端里会打印网址，长按即可在浏览器打开。proot 里调不起安卓浏览器；如果想自动打开，可以在 Termux 那一侧读取 `~/.claude-web/last-url.txt` 再用 `termux-open-url` 打开。

## 命令行参数

| 参数 | 作用 |
|---|---|
| `--cwd <目录>` | 初始项目目录（默认是当前目录；网页里随时可以切换） |
| `--port <端口>` | 端口，默认 `8765`。端口上已经有 Claude Web 在跑时会直接复用 |
| `--lan` | 允许局域网里的其他设备访问（会启用访问令牌） |
| `--no-token` | 配合 `--lan`，不启用令牌，网址固定为 `http://局域网IP:端口/`（同一网络的任何人都能打开，只适合自己家里用） |
| `--open` / `--no-open` | 启动后是否自动打开浏览器（Windows / macOS 默认打开） |

环境变量：`CLAUDE_BIN` 指定 claude 可执行文件路径；`CLAUDE_WEB_DATA` 指定数据目录。

## 关于权限

需要授权的操作先按你选的**权限模式**处理；模式规定要问人的（比如 default 下改文件、acceptEdits 下执行命令），会在对话里弹出「允许 / 拒绝」卡片，等你点了再继续。Claude 主动提问（AskUserQuestion）在任何模式下都会弹卡片。

- 任务会一直停在卡片那里等你回答；锁屏、刷新页面后卡片还在，回来接着答就行
- Claude Code 版本太旧、不支持 `--permission-prompt-tool` 时退回旧行为：需要确认的操作一律自动拒绝

- 选 **bypassPermissions（全部允许）** 时，Claude 可以直接执行任何命令、修改任何文件，请确认你信任当前任务
- 在 Linux 上以 root 运行时（比如 Termux proot），Claude Code 默认不允许 bypassPermissions，本工具会自动设置 `IS_SANDBOX=1` 解除这个限制

## Codex 子代理（可选）

工具栏「子代理」：选「Claude」和以前一样；选一个 Codex 模型（如 GPT-6.2-Sol）后，Claude 仍是主模型，但它自带的 Task/Agent 子代理被关掉，改用 `codex_task` 工具把子任务交给 Codex：

- `bin/codex-mcp.js` 把 `codex exec` 包装成 MCP 工具，并把 Claude 写的委派内容套进固定的任务书模板（角色 / 任务 / 背景 / 约束 / 完成标准 / 汇报格式）。sol 系列默认思考强度和输出详细度都是 low，直接用效果差，这里默认用 high
- Codex 的工作（读文件、跑命令、改代码）用的是 ChatGPT 订阅额度；Claude 只花写委派说明和读汇报的那部分
- 权限：plan 模式下 Codex 只读；default 模式下每次委派会弹框确认；其它模式自动放行
- 预设只影响 Claude，不影响 Codex 的任务书
- 怎么区分：带绿色边框和「GPT」标记的「Codex 子代理」卡片里是 GPT 的内容（Claude 写的任务书、GPT 的思考摘要、运行的命令、改的文件、最后交回的汇报），实时更新；卡片外面的文字、思考过程和其它工具调用都是 Claude 的
- Codex 账号：「子代理 → Codex 账号」添加，每个账号一个 `CODEX_HOME` 目录，弹窗里 `codex login` 登录一次，切换不登出
- 开了出口锁时 Codex 也走同一个代理（继承 `HTTPS_PROXY`），但防火墙规则只管 claude.exe，不管 codex

## DeepSeek 子代理（可选）

「子代理」里也可以选 DeepSeek（用你自己的 API Key，按量计费）。第一次在「DeepSeek 设置」里填 Key，Key 存在本机 `~/.claude-web/deepseek.json`，网页只显示末 4 位。

- 实现：`bin/deepseek-mcp.js` 用 DeepSeek 的 Anthropic 兼容接口（`https://api.deepseek.com/anthropic`）跑一个嵌套的 `claude -p`，配置目录独立（`~/.claude-web/deepseek-home`），不会用到你的 Anthropic 登录，会话也不会混进列表
- 和 GPT 的区别：DeepSeek 较弱，工具要求 Claude 写出**逐步的 steps**、可碰的文件清单、禁止事项和要交回的内容；DeepSeek 遇到和步骤不符的情况会停下报 BLOCKED，不自己拿主意。Claude 负责所有判断，DeepSeek 负责把决定「打成代码 / 跑出结果」
- 卡片是蓝色、标记「DS」
- 主模型用 Opus 时委派最积极；Sonnet 当主模型时经常选择自己做

## 多账号

每个账号用一个独立的 Claude Code 配置目录（`~/.claude-web/accounts/<id>/`），各自登录一次后一直保持登录。切换账号只是换一个目录启动 claude，**不会登出任何账号**。

- 「默认」账号就是你原来的 `~/.claude`，什么都不用做
- 添加：工具栏「账号」→「＋ 添加账号」→ 电脑上弹出一个终端窗口，在里面输入 `/login` 登录，登好关掉窗口
- 切换：「账号」里点一下，从下一条消息开始用新账号；正在跑的任务不受影响
- 会话记录、skills、plugins 通过目录链接共用 `~/.claude` 里的，切换账号后还能接着之前的对话聊；`settings.json` 也共用
- 用量按账号分别显示（发过消息的账号才有数据）
- 「移除」只删除本机保存的登录信息，不登出
- 登录时浏览器会打开 claude.ai，**浏览器当时走的节点就是 Anthropic 看到的登录 IP**，登录前确认浏览器走的是你想要的出口

## 出口锁（可选：保证 claude 只从指定 IP 出去）

代理偶尔会挂（比如 v2rayN 的 TUN 模式崩了），这时 claude 可能悄悄走本机网络。出口锁分三层，任何一层失效其它层还能兜住：

| 层 | 作用 | 挂了会怎样 |
|---|---|---|
| ① 专用 xray | claude-web 自己拉起一个 xray，只监听 `127.0.0.1:10900`，**只有你的节点一个出站，没有 direct**；所有 claude 进程强制设置 `HTTPS_PROXY` | 节点不通 → 请求失败，不会换路；xray 退出会自动重启 |
| ② 防火墙 | Windows 防火墙规则：`claude.exe` 只能连 127.0.0.1 / ::1（IPv4、IPv6 都封） | 就算某个模块不认代理变量、TUN 挂了，也连不出去 |
| ③ 出口检查 | 每 60 秒、每次发消息前经代理查一次出口 IP | IP 不在允许列表 → 拦下消息并**立刻停掉正在跑的任务**；代理不通 → 拦下新消息 |

设置步骤（Windows）：

```
node bin\egress-init.js --expect-ip 你的出口IP --country US
```

- 从 v2rayN 正在用的配置（默认 `F:\v2rayN-windows-64\binConfigs\config.json`，可用 `--from` 指定）取出 tag 为 `proxy` 的节点，生成 `~/.claude-web/egress/xray.json` 和 `~/.claude-web/egress.json`（含节点密钥，不在仓库里）
- 会实际测一次出口 IP；不给 `--expect-ip` 时把测到的 IP 写进允许列表，请确认它就是你要的 IP
- 然后**以管理员身份**双击 `bin\egress-firewall.bat` 加防火墙规则（`egress-firewall.bat -Remove` 删除）
- 重启 claude-web。工具栏最左边出现「出口 ✓ US x.x.x.x」，红色表示异常，点一下立刻重查

注意：

- 防火墙规则对**所有** claude.exe 生效，包括终端里直接运行的 claude。终端里也要用的话，在 `~/.claude/settings.json` 里加 `"env": {"HTTPS_PROXY": "http://127.0.0.1:10900", "HTTP_PROXY": "http://127.0.0.1:10900"}`
- 防火墙只管 claude.exe 本身。Claude 执行的 git / curl / npm 等是别的程序，不受规则限制（它们会继承代理变量，但不保证都认）
- 允许列表（`egress.json` 里的 `expectIp` / `expectCountry`）改了立即生效；改 `proxy` / `xray` 要重启 claude-web
- `egress.json` 格式有误时服务拒绝启动（宁可不用，也不走本机 IP）；删掉这个文件就关闭出口锁
- 开启后默认设置 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（关遥测、错误上报、自动更新），不想要就在 `egress.json` 里设 `"disableNonessential": false`

## 安全说明

- 默认只监听 `127.0.0.1`，只有本机能访问，不需要令牌
- 用 `--lan` 开放局域网访问时会启用固定令牌（保存在数据目录的 `token` 文件里），网址里带着它，不要外传
- **不要**把端口暴露到公网

## 数据存放位置

| 内容 | 位置 |
|---|---|
| 会话记录、记忆 | Claude Code 自己的 `~/.claude/projects/`（本工具只读写，不另存） |
| 上传的文件、编辑回溯前的备份、令牌 | `~/.claude-web/`（Windows 是 `C:\Users\你的用户名\.claude-web\`） |

## 常见问题

**提示找不到 claude？** 先在终端里运行 `claude --version` 确认已安装。装在特殊位置的话，用环境变量 `CLAUDE_BIN` 指定完整路径。

**编辑重发会撤销 Claude 改过的文件吗？** 不会，只回溯对话。建议项目用 git 管理。

**模型列表里的老模型用不了？** 列表来自 Claude Code 内置的模型表，你的账号不一定都能用；用不了时回复里会报错，换一个即可。

## 许可证

MIT
