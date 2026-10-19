# Claude Web

给 [Claude Code](https://docs.claude.com/claude-code) 终端版套一个网页聊天界面。不用再对着终端打字，用浏览器（手机、电脑都行）就能和 Claude Code 对话。

- **零依赖**：只要 Node.js，不用 `npm install` 任何包，没有需要编译的原生模块，所以在 Android Termux / proot 里也能直接跑
- **跨平台**：Windows、macOS、Linux、Android（Termux + proot-distro）
- **用你自己的 Claude Code**：直接调用本机已登录的 `claude` 命令，会话记录和终端版互通（`claude --resume` 能看到网页里的对话，反之亦然）

## 功能

| 功能 | 说明 |
|---|---|
| 流式聊天 | 逐字输出，Markdown / 表格 / 代码块（一键复制），工具调用折叠卡片，思考过程 |
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

网页里没法像终端那样逐条弹窗确认，所以需要授权的操作会按你选的**权限模式**自动处理，被拒绝的操作会在回复下方列出来。

- 选 **bypassPermissions（全部允许）** 时，Claude 可以直接执行任何命令、修改任何文件，请确认你信任当前任务
- 在 Linux 上以 root 运行时（比如 Termux proot），Claude Code 默认不允许 bypassPermissions，本工具会自动设置 `IS_SANDBOX=1` 解除这个限制

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
