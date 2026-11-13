# Codex Web

给本机 Codex CLI 配一个黑白风格的网页工作空间。直接使用已登录的 `codex`，在电脑或同一局域网的手机上聊天、操作项目。零 npm 运行时依赖，不需要构建或 CDN。

从 [Claude Web](https://github.com/yangkuang22/Claudecode-web) 改造，Codex 版在 **`codex-web` 分支**，原 Claude 版保留在 `main`。

## 快速启动

需要 Node.js 20+、Git，以及已经安装并登录的 Codex CLI。本次使用 **Codex 0.168.0** 开发并测试；旧版本可能缺少历史注入、分页或回溯接口，建议更新。

```sh
npm install -g @openai/codex
codex login
git clone --branch codex-web https://github.com/yangkuang22/Claudecode-web.git codex-web
cd codex-web
node server.js
```

无需运行 `npm install` 安装项目依赖。Windows 可直接双击 **`start-windows.bat`**，默认打开 `http://127.0.0.1:8766`，网页里可切换项目。双击 `start-windows-lan.bat` 允许同一 WiFi 的手机访问，并启用令牌；请使用终端打印的完整网址。

也可以安装成命令：

```sh
npm install -g github:yangkuang22/Claudecode-web#codex-web
cd 你的项目
codex-web
```

## 功能

| 功能 | 行为 |
|---|---|
| 黑白界面 | 跟随系统明暗主题，桌面常驻侧栏，手机抽屉 |
| 流式聊天 | Markdown、代码复制、命令输出、文件变更和思考摘要 |
| 断线续传 | 浏览器断开不停止任务，重连后按事件序号补齐 |
| 会话管理 | 读取 CLI 会话、重命名、删除、编辑重发，浏览目录切换项目 |
| ST 预设 | JSON 导入、导出、新建、编辑、启停、拖动排序 |
| 基础指令替换 | 使用 `baseInstructions`，关闭预设后恢复本机默认指令 |
| assistant 示例 | 真实 assistant 历史消息，新会话只注入一次，网页隐藏示例 |
| 模型与强度 | 动态查询本机 Codex 的模型和 effort |
| 图片与文件 | 拖拽、粘贴、拍照上传；图片作为视觉输入，其他文件提供本机路径 |
| 权限 | 工作目录、只读、完全访问；网页内授权卡片和模型提问 |
| 用量 | Codex 实际返回的额度、重置时间；API key 模式可能无订阅额度 |
| 长期说明 | 编辑项目 `AGENTS.md`、`AGENTS.override.md` 和全局 `AGENTS.md` |
| 补充记忆 | `.codex/web-memory/`，提示 Codex 按需读取，与原生自动记忆分开 |

不同项目可同时运行，同一项目一次处理一条消息。避免 CLI 与网页同时写入同一个会话。

## 预设规则

点击输入框上方「预设」导入 ST JSON，或新建预设；也可以放入安装目录的 `presets/`。`examples/preset.json` 是不含私人内容的示例。

1. 按 `prompt_order` 排序，优先 `character_id: 100001`，只使用启用条目。
2. 开头连续的 `system` 替换 Codex 基础指令，不作为普通用户消息发送。
3. `user` / `assistant` 示例通过 `thread/inject_items` 注入，assistant 使用 `output_text`，保留真实角色。
4. 后续 `system` 按原顺序并入用户文本。最后一个 assistant 后的文本，只放在新会话第一条真实消息前。
5. Chat History 仍是分隔符，后面的条目移到真实历史之前；未实现 ST 的深度注入、角色卡变量、世界书或完整宏引擎。

**中途改预设：** 系统部分在下次发送时更新；user/assistant 示例只在新会话注入。关闭预设不会删除已有示例，想清除示例请新建会话。

恢复会话时，Codex 可能保留旧指令历史，并追加明确的 `<model_instructions>` 替换声明，这是原生行为，不承诺从历史中物理抹掉旧文本。基础指令替换也不移除平台约束、权限、工具说明和项目约定。assistant 历史注入不等于半句回答的强制续写。

默认基础指令通过一个不调用模型的临时会话获取，读取后立即删除。只读 Codex 元数据，不修改内部会话文件；版本不兼容时显示错误，不静默降级成普通聊天消息。

## 权限与数据

- 默认「工作目录」可修改项目，额外权限在网页确认；「只读」需要明确授权才能扩大权限。
- 「完全访问」可操作本机文件和网络，不再逐项确认。
- 默认监听 `127.0.0.1`；`--lan` 默认启用令牌。用于本机或可信局域网，不作为公网多人托管服务。
- 会话由本机 Codex 管理，通常位于 `~/.codex/`，可通过 `CODEX_HOME` 修改。
- 上传、网页设置、指令快照、预设显示记录和编辑备份在 `~/.codex-web/`，与原 Claude Web 分开。
- 编辑重发只回溯对话，不还原文件；回溯前保存 JSON 备份。旧版 legacy 会话可继续，但不支持网页回溯，请新建会话。
- 刷新、锁屏不停止任务；重启 Node 服务会终止任务并清空内存断点缓存，已保存会话仍可恢复。

## 参数与命令

```sh
node server.js --cwd /绝对路径 --port 8766 --no-open
node server.js --lan
```

| 配置 | 说明 |
|---|---|
| `--cwd` | 初始项目，默认当前目录 |
| `--port` | 默认 8766 |
| `--lan` | 开放局域网并启用令牌 |
| `--no-token` | 显式关闭局域网令牌，仅适合可信网络 |
| `--open` / `--no-open` | 开启 / 关闭自动打开浏览器 |
| `CODEX_BIN` | Codex 路径，Windows 支持 `.exe` 和官方 npm 安装器 |
| `CODEX_WEB_DATA` | 网页数据目录 |
| `CODEX_HOME` | Codex 的配置和会话目录 |

支持 `/compact`（不带参数）、`/context`、`/cost`、`/init`、`/clear`、`/model`、`/effort`、`/memory`、`/usage`。命令由后端映射到 Codex 接口。

Windows 的 npm 安装器通过 Node 直接启动，消息走标准输入，避免 CMD 二次转义。Linux/macOS 可直接启动；Android 仍需能运行的 Codex CLI，本次未验证 Termux/proot 的 Codex 安装兼容性。

## 开发验证

```sh
npm run check
npm test
```

默认测试覆盖预设角色、顺序、HTTP、附件、跨站拦截和记忆。安装 Codex 后可额外验证真实协议：

```powershell
$env:CODEX_WEB_INTEGRATION='1'
npm test
```

Linux/macOS：`CODEX_WEB_INTEGRATION=1 npm test`。

集成测试使用隔离临时 `CODEX_HOME` 和本地假模型端点，检查真实 Codex 请求，覆盖指令替换、assistant 历史、预设更新和关闭、恢复、编辑与重命名，不消耗模型额度。

架构：浏览器 → Node HTTP/NDJSON → 本机 `codex app-server` 的 stdio JSON-RPC。

MIT License。
