#!/usr/bin/env node
// DeepSeek 子代理：通过 stdio 按行收发 JSON-RPC，由 claude-web 作为 MCP 服务启动。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const MAX_OUT = 24000;
const MODEL = process.env.DEEPSEEK_MODEL || '';
const LEAD_PERM = process.env.DEEPSEEK_PERM;
const WRITE_OK = process.env.DEEPSEEK_WRITE !== '0' && LEAD_PERM !== 'plan';
const NATIVE_TEST = process.env.DEEPSEEK_NATIVE_TEST === '1'; // 仅测试：使用默认 Claude 账号，不读取 DeepSeek 配置。
const CONFIG_ERROR = 'DeepSeek 配置无效，请在网页的「子代理 → DeepSeek 设置」中设置 DeepSeek API 密钥并选择模型。';
const WORKER_RULES = 'You are a literal worker executing a precise spec from a lead engineer. '
  + 'Follow the steps in order and exactly as written. Respect the file list and prohibitions on every turn. '
  + 'Do not improvise or ask questions. If a step is ambiguous, impossible, denied, or its assumptions fail, '
  + 'stop immediately and report BLOCKED at that step with what you found.';
const STOP_RULE = 'Do not guess. If a step is impossible, ambiguous, or the code does not match what the step expects, '
  + 'STOP immediately and report BLOCKED at that step with what you found. Do not improvise a fix.';
const DISALLOWED = ['Task', 'Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'WebSearch', 'CronCreate', 'ScheduleWakeup'];
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_ALLOWED = ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)'];
const running = new Map();
const scopes = new Map(); // 同一个 MCP 进程里，追问沿用原任务的权限和文件清单。

// 按顺序回传网页事件。未设置地址时可独立运行。
let eventQueue = Promise.resolve();
function emit(toolUseId, ev) {
  const url = process.env.CLAUDE_WEB_EVENTS;
  if (!url) return;
  const body = JSON.stringify({ toolUseId: toolUseId || '', ...ev });
  eventQueue = eventQueue.then(() => new Promise((resolve) => {
    try {
      const target = new URL(url);
      const transport = target.protocol === 'https:' ? https : http;
      const req = transport.request(target, {
        method: 'POST', agent: false, timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.on('end', resolve);
        res.on('error', resolve);
        res.resume();
      });
      req.on('error', resolve);
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end(body);
    } catch { resolve(); }
  }));
}

function backend() {
  if (!/^[a-z0-9][a-z0-9_.:/@-]*$/i.test(MODEL)) throw new Error(CONFIG_ERROR);
  if (NATIVE_TEST) return null;
  try {
    const { apiKey, baseUrl } = JSON.parse(fs.readFileSync(process.env.DEEPSEEK_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof apiKey !== 'string' || !apiKey.trim() || typeof baseUrl !== 'string') throw new Error();
    if (!['https:', 'http:'].includes(new URL(baseUrl).protocol)) throw new Error();
    if (!process.env.DEEPSEEK_HOME) throw new Error();
    const dir = path.resolve(process.env.DEEPSEEK_HOME);
    const normalHome = path.join(os.homedir(), '.claude');
    const checkDir = (candidate, normal) => {
      const relative = path.relative(normal, candidate);
      if (!relative || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..')) throw new Error();
    };
    checkDir(dir, normalHome);
    fs.mkdirSync(dir, { recursive: true });
    checkDir(fs.realpathSync(dir), fs.existsSync(normalHome) ? fs.realpathSync(normalHome) : normalHome);
    return { apiKey: apiKey.trim(), baseUrl, dir };
  } catch { throw new Error(CONFIG_ERROR); }
}

function workerEnv(config, perm) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'IS_SANDBOX'].includes(name) || name.startsWith('ANTHROPIC_')
      || (name.startsWith('CLAUDE_CODE_') && name !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) delete env[key];
  }
  if (config) Object.assign(env, {
    CLAUDE_CONFIG_DIR: config.dir,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_AUTH_TOKEN: config.apiKey,
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '600000',
  });
  if (perm === 'bypassPermissions') env.IS_SANDBOX = '1';
  return env;
}

function spawnClaude(args, env) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const win = process.platform === 'win32';
  const opts = {
    cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !win,
  };
  if (win && /\.(cmd|bat)$/i.test(bin)) {
    // 和 server.js 一样用 cmd.exe 启动批处理。任务正文走 stdin，不进入命令行。
    if (/[%"\r\n]/.test(bin)) throw new Error('CLAUDE_BIN 包含批处理无法安全接收的字符。');
    const line = [bin, ...args].map((arg) => /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${line}"`],
      { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, opts);
}

function fileList({ write, files }) {
  return [
    write ? 'You may read, modify, or create only the files below.' : 'You may read only the files below. Do not create, edit, or delete any files.',
    ...(files.length ? files.map((file) => '- ' + file) : ['- No files were listed.']),
  ];
}

function brief(a, scope) {
  return [
    '# Role',
    'You are a literal worker executing a lead engineer’s precise spec. The lead cannot answer questions.',
    '', '# Goal', a.task.trim(),
    '', '# Steps', 'Do them in order. Do exactly these steps and nothing else.',
    ...a.steps.map((step, i) => `${i + 1}. ${step.trim()}`),
    '', '# Files', ...fileList(scope),
    '', '# Context', `Working directory: ${process.cwd()}`, a.context?.trim() || 'No additional context.',
    '', '# Prohibitions',
    '- Do not edit files outside the list.',
    '- Do not refactor, rename, reformat, or add features.',
    '- Do not install packages or run destructive commands unless a step explicitly says so.',
    '- ' + STOP_RULE,
    ...(a.do_not || []).map((item) => '- ' + item),
    '', '# Report format',
    '1. Status: DONE or BLOCKED at step N.',
    '2. For each step: what you did and the result.',
    '3. Files changed, with an exact summary.',
    `4. Requested output: ${a.expected_output?.trim() || 'Report only the output specified in the steps.'}`,
    '5. Anything that looked wrong.',
    'Answer in the language of the task.',
  ].join('\n');
}

function toolSummary(name, input, clean) {
  const data = input || {};
  if (['Bash', 'PowerShell'].includes(name)) return clean(`${name}: ${data.command || ''}`).slice(0, 300);
  const detail = data.file_path || data.notebook_path || data.pattern || data.query
    || (input ? JSON.stringify(input) : '');
  return clean(detail ? `${name} ${detail}` : name).slice(0, 300);
}

function tokenSummary(usage) {
  return `输入 ${usage.input_tokens || 0}（缓存 ${usage.cache_read_input_tokens || 0}）· 输出 ${usage.output_tokens || 0} tokens`;
}

function runClaude(rpcId, { prompt, threadId, scope, toolUseId, config }, progress) {
  const { write } = scope;
  const perm = !write ? 'default' : ['bypassPermissions', 'auto'].includes(LEAD_PERM) ? 'bypassPermissions' : 'acceptEdits';
  const denied = [...DISALLOWED];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--permission-prompts', 'none', '--permission-mode', perm, '--append-system-prompt', WORKER_RULES,
    // 避免项目配置加载额外的 MCP 工具、钩子或自动放行规则。
    '--strict-mcp-config', '--setting-sources='];
  if (!write) {
    denied.push(...EDIT_TOOLS, 'PowerShell');
    args.push('--tools', 'Read,Glob,Grep,Bash', '--allowedTools', READ_ALLOWED.join(','));
  } else if (perm === 'acceptEdits') {
    denied.push('Bash', 'PowerShell');
  }
  args.push('--disallowedTools', denied.join(','));
  if (threadId) args.push('--resume', threadId);
  const clean = (value) => {
    const str = String(value ?? '');
    return config ? str.replaceAll(config.apiKey, '[已隐藏]') : str;
  };
  const post = (ev) => emit(toolUseId, ev);
  return new Promise((resolve) => {
    let child;
    try { child = spawnClaude(args, workerEnv(config, perm)); }
    catch { return resolve({ error: '启动 Claude Code 失败，请检查 CLAUDE_BIN。' }); }
    running.set(rpcId, child);
    post({ kind: 'start', text: clean(`${MODEL} · ${write ? '可改文件' : '只读'}${threadId ? ' · 追问' : ''}`) });
    const st = {
      thread: threadId || '', message: '', calls: new Map(), files: new Set(), errors: [], result: null,
    };
    let stderr = '';
    const error = (text) => {
      st.errors.push(text);
      post({ kind: 'error', text });
    };
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    output.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        st.thread = event.session_id;
      } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (!block) continue;
          if (block.type === 'text' && block.text) {
            st.message = clean(block.text);
            progress(st.message.slice(0, 160));
            post({ kind: 'message', text: st.message });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
            const text = clean(block.thinking);
            progress('思考：' + text.slice(0, 140));
            post({ kind: 'reasoning', text });
          } else if (block.type === 'tool_use' && block.id && !st.calls.has(block.id)) {
            const text = toolSummary(clean(block.name), block.input, clean);
            const file = EDIT_TOOLS.has(block.name) ? clean(block.input?.file_path || block.input?.notebook_path) : '';
            st.calls.set(block.id, { text, file });
            progress('运行工具：' + text.slice(0, 120));
            post({ kind: 'cmd_start', id: clean(block.id), text });
            if (file) {
              st.files.add(file);
              post({ kind: 'files', text: file });
            }
            if (block.name === 'WebSearch' && block.input?.query) post({ kind: 'search', text: clean(block.input.query) });
          }
        }
      } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type !== 'tool_result') continue;
          const call = st.calls.get(block.tool_use_id);
          const code = block.is_error ? 1 : 0;
          if (call) call.code = code;
          const content = Array.isArray(block.content)
            ? block.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
            : block.content;
          post({ kind: 'cmd', id: clean(block.tool_use_id), text: call?.text || '', code, output: clean(content).slice(-3000) });
        }
      } else if (event.type === 'result') {
        st.result = event;
        if (event.session_id) st.thread = event.session_id;
        if (event.is_error || event.subtype?.startsWith('error')) {
          const details = Array.isArray(event.errors) ? event.errors.join('\n') : '';
          error(clean(details || event.result || event.subtype || 'Claude Code 返回错误。'));
        }
      } else if (event.type === 'error') {
        error(clean(event.message || event.error?.message || 'Claude Code 返回错误。'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-(4000 + (config?.apiKey.length || 0))); });
    child.on('error', (e) => error(clean('启动 Claude Code 失败：' + e.message)));
    child.on('close', (code, signal) => {
      running.delete(rpcId);
      const diagnostic = clean(stderr).trim().slice(-1500);
      if (!st.result) error(clean(`Claude Code 未返回结果（${signal ? '信号 ' + signal : '退出码 ' + code}）。`)
        + (diagnostic ? '\n' + diagnostic : ''));
      else if (code && diagnostic) st.errors.push(diagnostic);
      post({ kind: 'end', code, text: st.result?.usage ? clean(tokenSummary(st.result.usage)) : '' });
      resolve({ code, signal, st, perm, clean });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function report(r, scope) {
  if (r.error) return { text: r.error, isError: true };
  const { st, clean } = r;
  const last = clean(st.result?.result) || st.message || '（DeepSeek 没有给出最终回复）';
  const calls = [...st.calls.values()];
  const changed = new Set(calls.filter((call) => call.file && call.code === 0).map((call) => call.file));
  const unconfirmed = [...st.files].filter((file) => !changed.has(file));
  const meta = [
    `thread_id: ${clean(st.thread) || '（无）'}${st.thread ? ' ← 使用 deepseek_continue 追问' : ''}`,
    `model: ${clean(MODEL)} · mode: ${scope.write ? 'write' : 'read-only'}${r.perm === 'acceptEdits' ? '（允许改文件，禁止执行 shell 命令）' : ''}`,
  ];
  if (scope.forcedRead) meta.push('当前权限强制只读。');
  if (changed.size) meta.push('已修改的文件：\n' + [...changed].map((file) => '  - ' + file).join('\n'));
  if (unconfirmed.length) meta.push('尝试修改、未确认成功的文件：\n' + unconfirmed.map((file) => '  - ' + file).join('\n'));
  meta.push(`工具调用：${calls.length}${calls.length > 15 ? '（仅列最后 15 条）' : ''}`);
  for (const call of calls.slice(-15)) meta.push(`  - [${call.code ?? '?'}] ${call.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  const permissionDenials = st.result?.permission_denials;
  if (Array.isArray(permissionDenials) && permissionDenials.length) {
    const names = permissionDenials.map((item) => clean(item?.tool_name)).filter(Boolean);
    meta.push(`权限拒绝：${permissionDenials.length}${names.length ? ' · ' + [...new Set(names)].join('、') : ''}`);
  }
  if (st.result?.usage) meta.push(tokenSummary(st.result.usage));
  if (st.errors.length) meta.push('错误：\n' + st.errors.map((error) => '  - ' + error).join('\n'));
  const footer = '\n\n---\n' + meta.join('\n');
  const total = last.length + footer.length;
  const suffix = `\n…（截断，原文 ${total} 字符）`;
  const text = total <= MAX_OUT ? last + footer
    : last.slice(0, Math.max(0, MAX_OUT - footer.length - suffix.length)) + footer.slice(0, MAX_OUT - suffix.length) + suffix;
  const isError = !st.result || st.result.is_error || st.result.subtype?.startsWith('error');
  return { text, isError: Boolean(isError) };
}

// MCP 工具说明和参数描述供主模型读取。
const stringList = { type: 'array', items: { type: 'string', minLength: 1 } };
const TOOLS = [
  {
    name: 'deepseek_task',
    description: 'DeepSeek is a weaker, literal-minded worker. Give it small, mechanical, fully specified tasks: '
      + 'exact edits, tests for cases you list, running a specific command and reporting its output, or finding specific patterns. '
      + 'Do not ask it to design, decide, choose an approach, or investigate open-ended questions. '
      + 'Delegate whenever your spec is shorter than the code it produces (tests from a case list, docstrings, repetitive edits, running commands). Keep each call to one clearly specified unit of work. Always read the files or the diff and review its changes yourself '
      + 'before trusting them. It cannot see this conversation or ask questions.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, description: 'One-sentence goal.' },
        steps: { ...stringList, minItems: 1, description: 'Exact ordered steps: name the file, function, exact edit or command, and what to look for.' },
        files: { ...stringList, description: 'The only files the worker may read. In write mode these are also the only files it may modify or create.' },
        context: { type: 'string', description: 'Background facts needed to execute the steps.' },
        do_not: { ...stringList, description: 'Additional explicit prohibitions.' },
        expected_output: { type: 'string', description: 'Exactly what to report, such as a complete function or a command’s output.' },
        mode: { type: 'string', enum: ['read', 'write'], default: 'read' },
      },
      required: ['task', 'steps', 'files'],
    },
  },
  {
    name: 'deepseek_continue',
    description: 'Resume a DeepSeek worker session using the thread_id returned by a previous call. Give a precise, self-contained follow-up within the original scope.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
      },
      required: ['thread_id', 'message'],
    },
  },
];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const toolReply = (id, { text, isError = true }) => reply(id, { content: [{ type: 'text', text }], isError });
const nonEmpty = (value) => typeof value === 'string' && !!value.trim();
const list = (value) => Array.isArray(value) && value.every(nonEmpty);

async function callTool(id, params) {
  const a = params.arguments || {};
  const token = params._meta?.progressToken;
  const toolUseId = params._meta?.['claudecode/toolUseId'];
  let n = 0;
  const progress = (message) => {
    if (token != null) send({ jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: token, progress: ++n, message } });
  };
  let prompt, scope, threadId;
  if (params.name === 'deepseek_task') {
    if (!nonEmpty(a.task) || !list(a.steps) || !a.steps.length || !list(a.files)) {
      return toolReply(id, { text: '请提供非空 task、至少一个具体步骤 steps，以及文件清单 files。' });
    }
    if ((a.mode !== undefined && !['read', 'write'].includes(a.mode))
      || (a.context !== undefined && typeof a.context !== 'string')
      || (a.do_not !== undefined && !list(a.do_not))
      || (a.expected_output !== undefined && typeof a.expected_output !== 'string')) {
      return toolReply(id, { text: 'mode、context、do_not 或 expected_output 的格式无效。' });
    }
    scope = { write: a.mode === 'write' && WRITE_OK, files: a.files, forcedRead: a.mode === 'write' && !WRITE_OK };
    prompt = brief(a, scope);
  } else if (params.name === 'deepseek_continue') {
    if (typeof a.thread_id !== 'string' || !/^[\w-]{8,80}$/.test(a.thread_id) || !nonEmpty(a.message)) {
      return toolReply(id, { text: '请提供有效的 thread_id 和非空 message。' });
    }
    threadId = a.thread_id;
    scope = scopes.get(threadId) || { write: false, files: null };
    const restrictions = scope.files ? fileList(scope).join('\n') : 'This turn is read-only. Use the file list in the original task.';
    prompt = `# Follow-up scope\n${restrictions}\n${STOP_RULE}\n\n# Follow-up\n${a.message.trim()}`;
  } else return fail(id, -32602, '未知工具。');
  let config;
  try { config = backend(); }
  catch { return toolReply(id, { text: CONFIG_ERROR }); }
  if (scope.forcedRead) progress('当前权限强制只读，DeepSeek 无法修改文件。');
  const r = await runClaude(id, { prompt, threadId, scope, toolUseId, config }, progress);
  if (r.st?.thread && scope.files) scopes.set(r.st.thread, scope);
  toolReply(id, report(r, scope));
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', killChild)
      .on('exit', (code) => { if (code !== 0) killChild(); });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return fail(null, -32700, 'JSON 解析失败。'); }
  if (!m || typeof m.method !== 'string') return fail(m?.id ?? null, -32600, 'JSON-RPC 请求无效。');
  if (m.method === 'notifications/cancelled') {
    const child = running.get(m.params?.requestId);
    if (child) killTree(child);
    return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'deepseek-subagent', version: '1.0.0' } });
  } else if (m.method === 'tools/list') reply(m.id, { tools: TOOLS });
  else if (m.method === 'tools/call') {
    callTool(m.id, m.params || {}).catch(() => toolReply(m.id, { text: 'DeepSeek 子代理处理请求时出错。' }));
  } else if (m.method === 'ping') reply(m.id, {});
  else fail(m.id, -32601, '未知方法。');
});

// 上游关闭 stdin 时，结束仍在运行的子进程及其命令。
input.on('close', () => {
  for (const child of running.values()) killTree(child);
  const deadline = setTimeout(() => process.exit(0), 500);
  deadline.unref();
});
