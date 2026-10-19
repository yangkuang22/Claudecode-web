#!/usr/bin/env node
// Claude Web — 零依赖的 Claude Code 网页聊天前端（Linux / macOS / Windows / Termux）
// 用法: node server.js [--port 8765] [--host 127.0.0.1] [--cwd 项目目录] [--lan] [--no-token] [--open | --no-open]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);
const IS_WIN = process.platform === 'win32';
const START_CWD = path.resolve(arg('cwd', process.cwd()));
const HOST = flag('lan') ? '0.0.0.0' : arg('host', '127.0.0.1');
// Windows / macOS 默认启动后自动打开浏览器
const AUTO_OPEN = flag('open') || (!flag('no-open') && (IS_WIN || process.platform === 'darwin'));
let PORT = parseInt(arg('port', '8765'), 10);
// 运行时数据（上传文件、回溯备份、令牌等）放在用户目录，不混进代码目录
const DATA_DIR = process.env.CLAUDE_WEB_DATA || path.join(os.homedir(), '.claude-web');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 找到 claude 可执行文件。Windows 上可能是原生安装的 claude.exe，也可能是 npm 安装的 claude.cmd
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (!IS_WIN) return 'claude';
  const dirs = (process.env.PATH || '').split(path.delimiter).map((d) => d.replace(/"/g, ''))
    .concat([path.join(os.homedir(), '.local', 'bin'), path.join(process.env.APPDATA || '', 'npm')]);
  for (const d of dirs) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const p = path.join(d, 'claude' + ext);
      try { if (d && fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return 'claude';
}
const CLAUDE_BIN = findClaude();
if (IS_WIN && CLAUDE_BIN === 'claude') {
  console.error('\n  ⚠ 没有找到 Claude Code（claude.exe / claude.cmd）。请先安装并登录：https://docs.claude.com/claude-code');
  console.error('    如果装在特殊位置，可设置环境变量 CLAUDE_BIN 为 claude 的完整路径\n');
}
function spawnClaude(cliArgs, opts) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(CLAUDE_BIN)) {
    // .cmd 只能通过 cmd.exe 运行；参数都经过校验，只含安全字符
    const line = [CLAUDE_BIN, ...cliArgs].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true, windowsHide: true });
  }
  return spawn(CLAUDE_BIN, cliArgs, { ...opts, windowsHide: true });
}
// 停止进程。Windows 没有 SIGINT，用 taskkill 连同子进程一起结束
function killProc(child, force) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {}); return; }
  try { child.kill(force ? 'SIGKILL' : 'SIGINT'); } catch {}
}
function openBrowser(url) {
  const cmd = IS_WIN ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
}
const LOCAL_ONLY = HOST === '127.0.0.1' || HOST === 'localhost';
// 仅本机访问时不需要令牌；开放局域网时使用固定令牌（保存在 token 文件里，网址不会每次变）
// --no-token：局域网也不要令牌（自己家里一个人用时省事，但同一网络的任何人都能打开）
const TOKEN = (() => {
  if (LOCAL_ONLY || flag('no-token')) return null;
  const f = path.join(DATA_DIR, 'token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
})();
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const INDEX_HTML = path.join(__dirname, 'index.html');
const SID_RE = /^[0-9a-f-]{36}$/;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// 回复里可以直接显示的媒体文件（不含 svg：它能带脚本）
const MEDIA_TYPES = {
  ...IMAGE_TYPES, '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
// 告诉 Claude 这个前端能显示本地图片 / 视频
const WEB_PROMPT = '你正在通过一个网页前端和用户对话，回复按 Markdown 渲染。'
  + '要给用户看本地的图片或视频时，用 Markdown 图片语法 ![说明](文件绝对路径) 引用，网页会直接显示出来'
  + '（支持 png jpg gif webp bmp avif mp4 webm mov）；路径里有空格时写成 ![说明](<路径>)。';

const sessionDir = (cwd) => path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
function checkDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('路径必须是绝对路径');
  const r = path.resolve(p);
  if (!fs.statSync(r).isDirectory()) throw new Error('不是文件夹: ' + r);
  return r;
}

// ---------- 运行中的 claude 进程（每个项目最多一个） ----------
// 输出行全部缓存，断线（如手机锁屏）后可以从任意位置重新接上
const runs = new Map(); // cwd -> { id, cwd, child, lines, done, listeners, sessionId }
const activeRun = (cwd) => { const r = runs.get(cwd); return r && !r.done ? r : null; };
const findRun = (id) => [...runs.values()].find((r) => r.id === id);

function buildContent(message, attachments) {
  const content = [];
  const notes = [];
  for (const a of attachments) {
    const ext = path.extname(a.path).toLowerCase();
    let size = 0;
    try { size = fs.statSync(a.path).size; } catch { continue; }
    if (IMAGE_TYPES[ext] && size <= 3.7 * 1024 * 1024) {
      content.push({ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: fs.readFileSync(a.path).toString('base64') } });
    }
    notes.push(`- ${a.name}: ${a.path}`);
  }
  if (notes.length) content.push({ type: 'text', text: '📎 用户上传了以下文件（需要时可用 Read 等工具读取）:\n' + notes.join('\n') });
  if (message) content.push({ type: 'text', text: message });
  return content;
}

// 回溯：把会话文件截断到指定用户消息之前（原文件先备份），之后 --resume 就从那里接着聊
// 返回 false 表示截断后已经没有对话内容，需要开新会话
function rewindSession(cwd, sessionId, uuid) {
  if (!SID_RE.test(sessionId || '')) throw new Error('没有可回溯的会话');
  const f = path.join(sessionDir(cwd), sessionId + '.jsonl');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.includes(`"uuid":"${uuid}"`) && l.includes('"type":"user"'));
  if (idx < 0) throw new Error('找不到要回溯的消息，刷新页面后再试');
  const bdir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(f, path.join(bdir, `${sessionId}-${Date.now()}.jsonl`));
  const keep = lines.slice(0, idx);
  // 截断点之后的会话标题记录保留下来
  for (const l of lines.slice(idx)) if (/"type":"(custom-title|ai-title)"/.test(l)) keep.push(l);
  const hasConversation = keep.some((l) => /"type":"(user|assistant)"/.test(l) && !l.includes('"isMeta":true'));
  if (!hasConversation) { fs.rmSync(f, { force: true }); return false; }
  fs.writeFileSync(f, keep.filter((l) => l.trim()).join('\n') + '\n');
  return true;
}

function startRun({ cwd, message, attachments, sessionId, model, effort, permissionMode }) {
  const cliArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (sessionId) cliArgs.push('--resume', sessionId);
  if (model) cliArgs.push('--model', model);
  if (effort) cliArgs.push('--effort', effort);
  if (permissionMode) cliArgs.push('--permission-mode', permissionMode);
  cliArgs.push('--append-system-prompt', WEB_PROMPT);
  const env = { ...process.env };
  // root 用户下 Claude Code 默认拒绝 bypassPermissions，IS_SANDBOX=1 可解除这个限制
  if (permissionMode === 'bypassPermissions') env.IS_SANDBOX = '1';

  const child = spawnClaude(cliArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const r = { id: crypto.randomUUID(), cwd, child, lines: [], done: false, listeners: new Set(), sessionId };
  runs.set(cwd, r);

  const push = (line) => {
    r.lines.push(line);
    for (const fn of r.listeners) fn(line);
  };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) r.sessionId = ev.session_id;
        if (ev.type === 'user' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)
            && !ev.message.content.some((b) => b.type === 'tool_result')) continue; // 用户消息回显，前端已显示
      } catch { continue; }
      push(line);
    }
  });
  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf += d.toString(); });
  const finish = (code) => {
    if (r.done) return;
    if (code && errBuf.trim()) push(JSON.stringify({ type: 'web_error', message: errBuf.trim().slice(-2000) }));
    push(JSON.stringify({ type: 'web_done', code, sessionId: r.sessionId }));
    r.done = true;
    for (const fn of r.listeners) fn(null);
    r.listeners.clear();
  };
  child.on('close', finish);
  child.on('error', (e) => { errBuf += String(e); finish(1); });
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: buildContent(message, attachments) } }) + '\n');
  return r;
}

function streamRun(r, from, req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'X-Run-Id': r.id,
  });
  res.flushHeaders();
  for (let i = from; i < r.lines.length; i++) res.write(r.lines[i] + '\n');
  if (r.done) return res.end();
  const fn = (line) => (line === null ? res.end() : res.write(line + '\n'));
  r.listeners.add(fn);
  req.on('close', () => r.listeners.delete(fn)); // 断线不杀进程，任务继续在后台跑
}

// ---------- 用量（订阅额度） ----------
// 用 `claude -p /usage` 获取，不调用模型、不消耗额度；结果缓存 1 分钟
let usageCache = null;
function getUsage(force) {
  if (!force && usageCache && Date.now() - usageCache.at < 60e3) return Promise.resolve(usageCache);
  return new Promise((resolve) => {
    const child = spawnClaude(['-p', '/usage', '--no-session-persistence'], { cwd: DATA_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => killProc(child, true), 60e3);
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const windows = [];
      const notes = [];
      for (const l of lines) {
        const m = l.match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+))?$/i);
        if (m) windows.push({ label: m[1], pct: parseFloat(m[2]), resets: m[3] || '' });
        else if (!/^warning:/i.test(l)) notes.push(l);
      }
      usageCache = { at: Date.now(), windows, notes };
      resolve(usageCache);
    });
  });
}

// ---------- 项目 & 会话 ----------
function textOfUserContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text' && !b.text.startsWith('📎')).map((b) => b.text).join('\n');
  return '';
}
const isNoise = (t) => !t || /^\s*<(command-|local-command|system-reminder)/.test(t) || t.startsWith('Caveat:');
// Claude Code 自己塞进会话的“用户”消息（后台任务完成通知等），不是用户本人发的
const isSystemPrompt = (o) => o.promptSource === 'system' || (!!o.origin && !!o.origin.kind && o.origin.kind !== 'human');

function readHead(p, bytes) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(Math.min(fs.fstatSync(fd).size, bytes));
    fs.readSync(fd, b, 0, b.length, 0);
    return b.toString();
  } finally { fs.closeSync(fd); }
}

function listProjects() {
  const out = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    const stats = files.map((f) => ({ f, m: fs.statSync(path.join(full, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    let cwd = null;
    for (const { f } of stats.slice(0, 5)) {
      const m = readHead(path.join(full, f), 128 * 1024).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) { cwd = JSON.parse('"' + m[1] + '"'); break; }
    }
    if (!cwd || sessionDir(cwd) !== full) continue;
    try { if (!fs.statSync(cwd).isDirectory()) continue; } catch { continue; }
    out.set(cwd, { cwd, name: path.basename(cwd) || cwd, mtime: stats[0].m, count: files.length });
  }
  if (!out.has(START_CWD)) out.set(START_CWD, { cwd: START_CWD, name: path.basename(START_CWD) || START_CWD, mtime: 0, count: 0 });
  return [...out.values()].sort((a, b) => b.mtime - a.mtime);
}

function browse(p) {
  const dir = checkDir(p || os.homedir());
  const dirs = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch {} }
    if (isDir) dirs.push(e.name);
  }
  dirs.sort((a, b) => (a.startsWith('.') - b.startsWith('.')) || a.localeCompare(b));
  const drives = [];
  if (IS_WIN) for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(c + ':\\'); drives.push(c + ':\\'); } catch {} }
  return {
    path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), home: os.homedir(), drives,
    dirs: dirs.map((name) => ({ name, path: path.join(dir, name) })),
  };
}

function readHeadTail(p, bytes) {
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= bytes * 2) { const b = Buffer.alloc(size); fs.readSync(fd, b, 0, size, 0); return b.toString(); }
    const h = Buffer.alloc(bytes), t = Buffer.alloc(bytes);
    fs.readSync(fd, h, 0, bytes, 0); fs.readSync(fd, t, 0, bytes, size - bytes);
    return h.toString() + '\n' + t.toString();
  } finally { fs.closeSync(fd); }
}

function listSessions(cwd) {
  const dir = sessionDir(cwd);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    let title = '', customTitle = '', aiTitle = '';
    try {
      for (const line of readHeadTail(p, 256 * 1024).split('\n')) {
        if (!line.includes('"type":"user"') && !line.includes('title"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'custom-title' && o.customTitle != null) customTitle = o.customTitle;
        if (o.type === 'ai-title' && o.aiTitle && !/^Resume session /.test(o.aiTitle)) aiTitle = o.aiTitle;
        if (!title && o.type === 'user' && !o.isMeta && !o.isSidechain && !isSystemPrompt(o)) {
          const c = o.message && o.message.content;
          const t = textOfUserContent(c);
          if (!isNoise(t)) title = t.trim().slice(0, 80);
          else if (Array.isArray(c) && c.some((b) => b.type === 'image' || (b.type === 'text' && b.text.startsWith('📎')))) title = '[附件]';
        }
      }
    } catch {}
    if (!title && !customTitle) continue; // 空会话（如只有 /clear）不显示
    out.push({ id: f.slice(0, -6), title: customTitle || aiTitle || title, renamed: !!customTitle, mtime: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}

function deleteSession(cwd, id) {
  if (!SID_RE.test(id)) throw new Error('无效的会话 ID');
  const r = activeRun(cwd);
  if (r && r.sessionId === id) throw new Error('该会话正在运行，请先停止');
  const dir = sessionDir(cwd);
  fs.rmSync(path.join(dir, id + '.jsonl'), { force: true });
  fs.rmSync(path.join(dir, id), { recursive: true, force: true }); // 会话附带的子代理/工具结果目录
}

function renameSession(cwd, id, title) {
  if (!SID_RE.test(id)) throw new Error('无效的会话 ID');
  const p = path.join(sessionDir(cwd), id + '.jsonl');
  if (!fs.existsSync(p)) throw new Error('会话不存在');
  title = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  // 与 Claude Code 的 /rename 格式一致，终端里 claude --resume 也能看到新名字
  fs.appendFileSync(p, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n');
}

// ---------- 记忆（auto memory + CLAUDE.md） ----------
const memoryDir = (cwd) => path.join(sessionDir(cwd), 'memory');
function claudeMdCandidates(cwd) {
  return [
    { path: path.join(cwd, 'CLAUDE.md'), label: '项目 CLAUDE.md', desc: '项目说明，所有会话都会读取' },
    { path: path.join(cwd, '.claude', 'CLAUDE.md'), label: '项目 .claude/CLAUDE.md', desc: '同上，放在 .claude 目录里' },
    { path: path.join(cwd, 'CLAUDE.local.md'), label: 'CLAUDE.local.md', desc: '仅本机的个人项目说明' },
    { path: path.join(os.homedir(), '.claude', 'CLAUDE.md'), label: '全局 ~/.claude/CLAUDE.md', desc: '对所有项目生效的个人说明' },
  ];
}
function listMemory(cwd) {
  const dir = memoryDir(cwd);
  const memory = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(dir, f), st = fs.statSync(p);
      if (!st.isFile()) continue;
      let desc = '';
      try { const m = readHead(p, 4096).match(/^description:\s*(.+)$/m); if (m) desc = m[1].trim(); } catch {}
      memory.push({ path: p, name: f, desc, size: st.size, mtime: st.mtimeMs });
    }
  } catch {}
  memory.sort((a, b) => (b.name === 'MEMORY.md') - (a.name === 'MEMORY.md') || b.mtime - a.mtime);
  const claude = claudeMdCandidates(cwd).map((c) => {
    let st = null; try { st = fs.statSync(c.path); } catch {}
    return { ...c, name: path.basename(c.path), exists: !!st, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
  });
  return { dir, memory, claude };
}
// 只允许访问：该项目 memory 目录下的 .md 文件，或几个固定的 CLAUDE.md 位置
function checkMemPath(cwd, p) {
  const r = path.resolve(String(p || ''));
  const dir = memoryDir(cwd);
  if (path.dirname(r) === dir && /^[^\/\\]+\.md$/.test(path.basename(r))) return r;
  if (claudeMdCandidates(cwd).some((c) => c.path === r)) return r;
  throw new Error('不允许访问这个文件');
}

function loadHistory(cwd, id) {
  if (!SID_RE.test(id)) return [];
  let raw;
  try { raw = fs.readFileSync(path.join(sessionDir(cwd), id + '.jsonl'), 'utf8'); } catch { return []; }
  const items = [];
  for (const line of raw.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || o.isMeta) continue;
    if (o.type === 'user' && o.message && isSystemPrompt(o)) {
      // 后台任务通知只显示一行摘要，其他系统消息不显示
      const t = textOfUserContent(o.message.content);
      const s = t.match(/<summary>([\s\S]*?)<\/summary>/);
      if (/<task-notification>/.test(t)) items.push({ kind: 'command', text: '⚙ 后台任务：' + (s ? s[1].trim() : '已结束') });
      continue;
    }
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      const images = [], files = [];
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') items.push({ kind: 'tool_result', id: b.tool_use_id, content: b.content, isError: !!b.is_error });
          else if (b.type === 'image' && b.source && b.source.type === 'base64') {
            images.push(b.source.data.length < 3e6 ? `data:${b.source.media_type};base64,${b.source.data}` : null);
          } else if (b.type === 'text' && b.text.startsWith('📎')) {
            for (const m of b.text.matchAll(/^- (.+?): ((?:\/|[A-Za-z]:\\).+)$/gm)) {
              if (!IMAGE_TYPES[path.extname(m[2]).toLowerCase()]) files.push({ name: m[1], path: m[2] }); // 图片已直接显示
            }
          }
        }
      }
      const t = textOfUserContent(c);
      const cmd = t.match(/<command-name>(\/?[^<]+)<\/command-name>(?:[\s\S]*?<command-args>([^<]*)<\/command-args>)?/);
      const out = t.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (cmd) items.push({ kind: 'command', text: (cmd[1].startsWith('/') ? cmd[1] : '/' + cmd[1]) + (cmd[2] ? ' ' + cmd[2] : '') });
      else if (out) { if (out[1].trim()) items.push({ kind: 'command_out', text: out[1].trim() }); }
      else if (o.isCompactSummary) items.push({ kind: 'command', text: '— 上下文已压缩 —' });
      else if (!isNoise(t) || images.length || files.length) {
        items.push({ kind: 'user', uuid: o.uuid, text: isNoise(t) ? '' : t, images, files });
      }
    } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b.type === 'text' && b.text) items.push({ kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking) items.push({ kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') items.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
    }
  }
  return items;
}

function saveUpload(req, name) {
  return new Promise((resolve, reject) => {
    const safe = (path.basename(String(name || 'file')).replace(/[^\w.\-一-龥]/g, '_') || 'file').slice(-100);
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const dir = path.join(UPLOAD_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, crypto.randomBytes(3).toString('hex') + '-' + safe);
    const ws = fs.createWriteStream(p);
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024 * 1024) { req.destroy(); ws.destroy(); fs.rm(p, () => {}); reject(new Error('文件超过 100MB')); }
    });
    req.pipe(ws);
    ws.on('finish', () => resolve({ path: p, name: safe, size }));
    ws.on('error', reject);
  });
}

// ---------- HTTP ----------
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 5e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = (k) => url.searchParams.get(k) || '';
  const authed = !TOKEN || parseCookies(req).cw_token === TOKEN || q('t') === TOKEN;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('缺少访问令牌，请使用终端里打印的完整网址打开。');
    }
    // 令牌存进 cookie，然后跳到干净的网址
    if (TOKEN && q('t')) {
      res.writeHead(302, { 'Set-Cookie': `cw_token=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, Location: '/' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX_HTML).pipe(res);
  }
  if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  if (!authed) return json(res, 401, { error: 'unauthorized' });

  try {
    switch (url.pathname) {
      case '/api/info': {
        let cwd = START_CWD;
        try { if (q('cwd')) cwd = checkDir(q('cwd')); } catch {}
        const r = activeRun(cwd);
        return json(res, 200, {
          cwd, name: path.basename(cwd) || cwd, startCwd: START_CWD,
          running: r ? { id: r.id, sessionId: r.sessionId } : null,
          busyProjects: [...runs.values()].filter((x) => !x.done).map((x) => x.cwd),
        });
      }
      case '/api/usage':
        return json(res, 200, await getUsage(q('force') === '1'));
      case '/api/projects':
        return json(res, 200, listProjects());
      case '/api/browse':
        return json(res, 200, browse(q('path')));
      case '/api/mkdir': {
        const body = await readBody(req);
        const parent = checkDir(body.parent);
        const name = String(body.name || '').trim();
        if (!name || /[\/\\\0:*?"<>|]/.test(name) || name === '.' || name === '..') throw new Error('文件夹名无效');
        const p = path.join(parent, name);
        fs.mkdirSync(p);
        return json(res, 200, { path: p });
      }
      case '/api/sessions':
        return json(res, 200, listSessions(checkDir(q('cwd'))));
      case '/api/history':
        return json(res, 200, loadHistory(checkDir(q('cwd')), q('id')));
      case '/api/session':
        if (req.method !== 'DELETE') return json(res, 405, { error: 'DELETE only' });
        deleteSession(checkDir(q('cwd')), q('id'));
        return json(res, 200, { ok: true });
      case '/api/session/rename': {
        const body = await readBody(req);
        renameSession(checkDir(body.cwd), body.id, body.title);
        return json(res, 200, { ok: true });
      }
      case '/api/memory':
        return json(res, 200, listMemory(checkDir(q('cwd'))));
      case '/api/memfile': {
        if (req.method === 'GET') {
          const p = checkMemPath(checkDir(q('cwd')), q('path'));
          let content = '';
          try { content = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          return json(res, 200, { path: p, content });
        }
        const body = await readBody(req);
        const cwd = checkDir(body.cwd);
        const p = checkMemPath(cwd, body.path);
        if (req.method === 'DELETE') {
          fs.rmSync(p, { force: true });
          // 同时去掉 MEMORY.md 索引里指向它的那一行
          if (path.dirname(p) === memoryDir(cwd) && path.basename(p) !== 'MEMORY.md') {
            const idx = path.join(memoryDir(cwd), 'MEMORY.md');
            try {
              const cur = fs.readFileSync(idx, 'utf8');
              const next = cur.split('\n').filter((l) => !l.includes('](' + path.basename(p) + ')')).join('\n');
              if (next !== cur) fs.writeFileSync(idx, next);
            } catch {}
          }
          return json(res, 200, { ok: true });
        }
        if (req.method !== 'PUT') return json(res, 405, { error: 'method' });
        const isNew = !fs.existsSync(p);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(body.content ?? ''));
        // 新建记忆文件时，在 MEMORY.md 索引里加一行指向它
        if (isNew && body.index && path.dirname(p) === memoryDir(cwd) && path.basename(p) !== 'MEMORY.md') {
          const idx = path.join(memoryDir(cwd), 'MEMORY.md');
          let cur = ''; try { cur = fs.readFileSync(idx, 'utf8'); } catch {}
          const line = `- [${String(body.index).replace(/[\[\]\n]/g, '')}](${path.basename(p)})`;
          fs.writeFileSync(idx, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
        }
        return json(res, 200, { ok: true, path: p });
      }
      case '/api/upload': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        return json(res, 200, await saveUpload(req, q('name')));
      }
      case '/api/file': {
        // 只允许读取上传目录里的文件（用于显示图片缩略图）
        const p = path.resolve(q('path'));
        if (!p.startsWith(UPLOAD_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
        const type = IMAGE_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
        return fs.createReadStream(p).on('error', () => res.end()).pipe(res);
      }
      case '/api/prefs': {
        // 模型 / effort / 权限选择存在服务端，换网址、换设备、重启都保持上一次的选择
        const f = path.join(DATA_DIR, 'prefs.json');
        let cur = {};
        try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (typeof body.model === 'string' && /^[\w.\-\[\]]*$/.test(body.model)) cur.model = body.model;
          if (['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)) cur.effort = body.effort;
          if (typeof body.perm === 'string' && /^[a-zA-Z]+$/.test(body.perm)) cur.perm = body.perm;
          fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\n');
        }
        return json(res, 200, cur);
      }
      case '/api/media': {
        // Claude 在回复里引用的本地图片 / 视频（只允许这些扩展名；支持 Range，视频可以拖动进度）
        let p = q('path').replace(/^file:\/\/\/?/i, '');
        if (/^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(2));
        if (!path.isAbsolute(p) && q('cwd')) p = path.join(q('cwd'), p);
        p = path.resolve(p);
        const type = MEDIA_TYPES[path.extname(p).toLowerCase()];
        if (!type) return json(res, 403, { error: '只能查看图片或视频' });
        let st;
        try { st = fs.statSync(p); } catch { return json(res, 404, { error: '文件不存在' }); }
        if (!st.isFile()) return json(res, 404, { error: '文件不存在' });
        // 同名文件可能被覆盖（比如重复生成），用大小+修改时间做 ETag
        const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, 'Accept-Ranges': 'bytes' };
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (m && (m[1] || m[2])) {
          const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
          const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
          if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
          return fs.createReadStream(p, { start, end }).on('error', () => res.end()).pipe(res);
        }
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        return fs.createReadStream(p).on('error', () => res.end()).pipe(res);
      }
      case '/api/chat': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const cwd = checkDir(body.cwd);
        if (activeRun(cwd)) return json(res, 409, { error: '这个项目上一条消息还在处理中' });
        const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
          .filter((a) => a && typeof a.path === 'string' && path.resolve(a.path).startsWith(UPLOAD_DIR + path.sep))
          .map((a) => ({ path: path.resolve(a.path), name: path.basename(String(a.name || a.path)) }));
        const message = String(body.message || '').trim();
        if (!message && !attachments.length) return json(res, 400, { error: '消息为空' });
        let sessionId = SID_RE.test(body.sessionId || '') ? body.sessionId : null;
        if (body.rewindTo) {
          if (!/^[0-9a-f-]{36}$/.test(body.rewindTo)) return json(res, 400, { error: '无效的消息 ID' });
          if (!rewindSession(cwd, sessionId, body.rewindTo)) sessionId = null;
        }
        const r = startRun({
          cwd, message, attachments,
          sessionId,
          model: /^[\w.\-\[\]]+$/.test(body.model || '') ? body.model : null,
          effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort) ? body.effort : null,
          permissionMode: /^[a-zA-Z]+$/.test(body.permissionMode || '') ? body.permissionMode : null,
        });
        return streamRun(r, 0, req, res);
      }
      case '/api/attach': {
        const r = findRun(q('run'));
        if (!r) return json(res, 404, { error: 'no such run' });
        return streamRun(r, Math.max(0, parseInt(q('from') || '0', 10) || 0), req, res);
      }
      case '/api/stop': {
        const r = findRun(q('run'));
        if (r && !r.done) {
          killProc(r.child, false);
          setTimeout(() => { if (!r.done) killProc(r.child, true); }, 3000);
        }
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    return json(res, 400, { error: String((e && e.message) || e) });
  }
});

function printUrl(link, already) {
  console.log('\n  \x1b[1;38;5;209m✻ Claude Web\x1b[0m  ' + (already ? '已经在运行中' : '初始项目: \x1b[1m' + START_CWD + '\x1b[0m'));
  console.log('\n  在浏览器打开（Termux 中长按网址可直接打开，建议加入书签）:\n');
  console.log('  \x1b[4;36m' + link + '\x1b[0m\n');
  if (!LOCAL_ONLY) console.log(TOKEN ? '  ⚠ 已开放局域网访问，网址中的令牌请勿外泄\n' : '  ⚠ 已开放局域网访问且未启用令牌，同一网络的任何人都能打开\n');
  try { fs.writeFileSync(path.join(DATA_DIR, 'last-url.txt'), link + '\n'); } catch {}
  if (AUTO_OPEN) openBrowser(link);
}
function makeLink() {
  const shownHost = LOCAL_ONLY ? '127.0.0.1' : lanIp();
  return `http://${shownHost}:${PORT}/` + (TOKEN ? `?t=${TOKEN}` : '');
}
function listen() {
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') { console.error(e.message); process.exit(1); }
    // 端口被占用：如果是已经在运行的 Claude Web，直接复用它
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/info', timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => {
        let ok = false;
        try { const j = JSON.parse(b); ok = 'startCwd' in j || j.error === 'unauthorized'; } catch {}
        if (ok) { printUrl(makeLink(), true); console.log('  （网页里可以切换到任意项目，无需重复启动）\n'); process.exit(0); }
        console.error(`\n  ❌ 端口 ${PORT} 被其他程序占用，可用 cw --port 其他端口\n`); process.exit(1);
      });
    });
    req.on('error', () => { console.error(`\n  ❌ 端口 ${PORT} 被占用\n`); process.exit(1); });
  });
  server.listen(PORT, HOST, () => {
    printUrl(makeLink(), false);
    console.log('  按 Ctrl+C 停止\n');
  });
}
// 选真实网卡的局域网地址：跳过代理 TUN、WSL/Hyper-V、Docker、虚拟机网卡，优先 192.168.x / 10.x
function lanIp() {
  const virtual = /tun|tap|vEthernet|WSL|Hyper-V|docker|br-|veth|VMware|VirtualBox|vbox|utun|Loopback|ZeroTier|Tailscale/i;
  let best = null, bestScore = -1;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      let score = virtual.test(name) ? 0 : 2;
      if (/^192\.168\.|^10\./.test(a.address)) score += 1;
      if (score > bestScore) { best = a.address; bestScore = score; }
    }
  }
  return best || '127.0.0.1';
}
const shutdown = () => { for (const r of runs.values()) if (!r.done) killProc(r.child, true); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
listen();
