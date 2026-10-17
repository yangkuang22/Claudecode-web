# Claude Web 项目说明

给 Claude Code 终端版套的网页聊天前端。用户主要在 Android 手机（Termux + proot Debian）上用，也要在 Windows 上用。

## 和用户沟通

- **一律用简体中文回复**，包括长篇总结、表格、清单。用户看不懂英文。
- 代码注释、界面文字也都用中文。

## 架构

只有两个核心文件，**零 npm 依赖**（这是硬性要求：Termux/proot 里装不了需要编译的原生模块）：

- `server.js`：Node 内置 `http` 服务。每条消息启动一次 `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages [--resume 会话ID]`，把 claude 的输出逐行转发给浏览器（NDJSON 流）。
  - 输出行全部缓存在内存里，断线后浏览器用 `/api/attach?run=&from=` 从断点接上
  - 每个项目（cwd）同时最多跑一个任务，不同项目可以并行
  - 会话记录直接读 Claude Code 自己的 `~/.claude/projects/<cwd 编码>/<会话ID>.jsonl`，cwd 编码规则是把非字母数字字符都换成 `-`
  - 运行时数据（上传、回溯备份、令牌、last-url.txt）在 `~/.claude-web/`，可用环境变量 `CLAUDE_WEB_DATA` 改
- `index.html`：单文件前端，原生 JS，自带简易 Markdown 渲染（不依赖 CDN，国内网络也能用）。

## 主要功能对应的实现

| 功能 | 实现要点 |
|---|---|
| 会话重命名 | 往 jsonl 末尾追加 `{"type":"custom-title","customTitle":...}`，与 Claude Code 的 `/rename` 格式一致（last-wins） |
| 编辑重发（回溯） | 把 jsonl 截断到被编辑的用户消息之前（先备份到 `~/.claude-web/backups/`），再 `--resume`；截断后没有对话内容时删掉文件开新会话 |
| 用量 | `claude -p /usage --no-session-persistence`，不调用模型，缓存 60 秒 |
| 斜杠指令 | `/compact` `/context` `/cost` `/init` 直接当消息发给 `claude -p`；`/clear` `/model` 等是前端本地操作 |
| 记忆 | 读写 `~/.claude/projects/<编码>/memory/*.md` 和几个固定位置的 CLAUDE.md，服务端有路径白名单 |
| bypassPermissions | root 用户下 Claude Code 默认禁止，服务端自动加环境变量 `IS_SANDBOX=1` |
| 访问控制 | 只监听 127.0.0.1 时不需要令牌；`--lan` 时启用固定令牌（`~/.claude-web/token`） |

## Windows 适配（在 Linux 上写的，Windows 上尚未实测）

- `findClaude()`：按 PATH、`%USERPROFILE%\.local\bin`、`%APPDATA%\npm` 依次找 `claude.exe` / `claude.cmd`
- `spawnClaude()`：`.cmd` 通过 `cmd.exe /d /s /c` 启动（`windowsVerbatimArguments`）；传给 claude 的参数都经过正则校验，用户消息走 stdin，不进命令行
- `killProc()`：Windows 用 `taskkill /T /F`
- 浏览文件夹返回完整路径和盘符列表；前端路径处理兼容 `\`
- Windows / macOS 启动时自动打开浏览器

## 测试方法

没有测试框架，改完至少：

```
node --check server.js
node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.split('<script>')[1].split('</script>')[0])"
```

然后 `node server.js --port 8790 --no-open` 起服务，用 curl 测接口。需要真正发消息时用 `"model":"haiku"` 省额度；测试时创建的临时项目和会话记录（`~/.claude/projects/` 下）测完要删掉，不要污染用户的会话列表。
