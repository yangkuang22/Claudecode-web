# Codex Web 开发约定

- 用简体中文交流，界面文字和代码注释使用中文。
- 这是运行在用户电脑上的 Codex CLI 网页客户端，不部署到静态站点或云端 Worker。
- 保持零 npm 运行时依赖，使用 Node.js 20+ 的内置模块。
- `server.js` 负责 HTTP、上传、本地文件、项目记忆与预设文件。
- `codex-client.js` 负责 app-server 的 JSON-RPC、握手和进程生命周期。
- `codex-backend.js` 负责会话、注入、指令恢复、流式事件、审批和用量。
- `presets.js` 负责 ST 装配和校验，`index.html` 是离线可用的单文件界面。
- 接口以本机 `codex app-server generate-json-schema` 输出为准，不猜测版本能力。
- 不截断或覆写用户的 Codex JSONL，会话操作使用 app-server 接口。
- 只读临时会话元数据获取默认基础指令，临时会话不请求模型，完成后删除。
- 保留 ST 角色、启用状态和排序；assistant 示例必须作为真实 assistant 历史注入。
- 基础指令可每轮更新；历史示例仅在新会话注入一次，不能重复污染上下文。
- 不提交私人预设、令牌、会话、上传文件或含个人信息的截图。
- 提交前运行 `npm run check` 与 `npm test`。
- 安装 Codex 时额外运行真实协议集成测试：PowerShell 中 `$env:CODEX_WEB_INTEGRATION='1'; npm test`。
- 集成测试使用隔离的临时 CODEX_HOME 和本地假模型端点，不读取真实登录凭据，不消耗模型额度。
- 界面变更检查桌面明暗主题和手机尺寸，确认无横向溢出，预设编辑及选择可用。
