#!/usr/bin/env node
// Codex Web — 零依赖的 Codex CLI 网页聊天前端（Linux / macOS / Windows / Termux）
// 用法: node server.js [--port 8766] [--host 127.0.0.1] [--cwd 项目目录] [--lan] [--no-token] [--open | --no-open]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { CodexBackend } = require('./codex-backend');
const { assembleFromST, validatePreset } = require('./presets');

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
let PORT = parseInt(arg('port', '8766'), 10);
// 运行时数据（上传文件、回溯备份、令牌等）放在用户目录，不混进代码目录
// 独立于原 Claude Web 的运行时数据，避免互相覆盖。
const DATA_DIR = path.resolve(process.env.CODEX_WEB_DATA || path.join(os.homedir(), '.codex-web'));
fs.mkdirSync(DATA_DIR, { recursive: true });

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
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const INDEX_HTML = path.join(__dirname, 'index.html');
const SID_RE = /^[0-9a-f-]{36}$/;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// 回复里可以直接显示的媒体文件（不含 svg：它能带脚本）
const MEDIA_TYPES = {
  ...IMAGE_TYPES, '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
// 告诉 Codex 这个前端能显示本地图片 / 视频
const WEB_PROMPT = '你正在通过一个网页前端和用户对话，回复按 Markdown 渲染。'
  + '要给用户看本地的图片或视频时，用 Markdown 图片语法 ![说明](文件绝对路径) 引用，网页会直接显示出来'
  + '（支持 png jpg gif webp bmp avif mp4 webm mov）；路径里有空格时写成 ![说明](<路径>)。';

// ============ 预设系统（用酒馆 ST 格式 json，按角色+顺序组装；预设内容由用户自行放入 presets/） ============
const PRESETS_DIR = path.join(__dirname, 'presets');
try { fs.mkdirSync(PRESETS_DIR, { recursive: true }); } catch {}
// 把一份 ST 预设拆成：system 字段 / 种进会话开头的 user、assistant 轮 / 第一条消息前的文本
// 如实按预设的角色+顺序组装：
//   role=system → 开头连续的替换 Codex 基础指令
//   role=assistant → 真 assistant 历史消息
//   role=user → 并进相邻的 user 消息
//   Chat History 标记 → 不再分前后：标记之后的条目按原顺序挪到聊天历史之前，和前面的条目接着排
// 为什么不像酒馆那样把标记后的内容贴在最新消息后：codex 会把整条消息存进历史，要么每轮多一份，
// 要么每轮从旧消息上剥掉——剥掉会让上一轮存下的缓存全部对不上，工具调用多时整段历史缓存失效。
// 全部放在聊天历史前面、只出现一次，缓存就不会被打断。
// 返回：systemField(系统字段) / seedTurns(种进会话开头的 user/assistant 轮) /
//       historyHead(最后一个 assistant 之后的文本，只拼在新会话第一条消息前)
// 酒馆预设常同时有 100000（默认顺序）和 100001（预设自己的顺序），优先用 100001
const PRESET_RE = /^[^\/\\]+\.json$/;
function loadPresetFile(file) {
  if (!PRESET_RE.test(file || '')) return null;
  try { const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8')); validatePreset(data); return data; } catch { return null; }
}

// 选了预设就用预设装配；没选返回 null（=普通 agent，不替换系统提示词）
function getAssembled(file) { const d = loadPresetFile(file); return d ? assembleFromST(d) : null; }
function listPresets() {
  let files = []; try { files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => { let name = f; try { name = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')).name || f; } catch {} return { file: f, name }; });
}

function checkDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('路径必须是绝对路径');
  const r = path.resolve(p);
  if (!fs.statSync(r).isDirectory()) throw new Error('不是文件夹: ' + r);
  return fs.realpathSync.native(r);
}

// Codex 的进程和会话由独立适配层维护。
const backend = new CodexBackend(DATA_DIR, WEB_PROMPT + '项目补充记忆在 .codex/web-memory/MEMORY.md，存在时请按需读取。');
const runs = backend.runs;
const activeRun = cwd => backend.active(cwd);
const findRun = id => backend.find(id);
const startRun = options => backend.start(options);

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
  res.on('close', () => r.listeners.delete(fn)); // 断线不杀进程，任务继续在后台跑
}

const getUsage = () => backend.usage();
const listProjects = () => backend.listProjects(START_CWD);
const listSessions = cwd => backend.listSessions(cwd);
const loadHistory = (cwd, id) => backend.history(cwd, id);
const deleteSession = (cwd, id) => backend.delete(cwd, id);
const renameSession = (cwd, id, title) => backend.rename(cwd, id, title);
function readHead(p, bytes) { const fd = fs.openSync(p, 'r'); try { const b = Buffer.alloc(Math.min(fs.fstatSync(fd).size, bytes)); fs.readSync(fd, b); return b.toString(); } finally { fs.closeSync(fd); } }

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

// ---------- 项目补充记忆与 AGENTS.md ----------
const memoryDir = cwd => path.join(cwd, '.codex', 'web-memory');
function codexMdCandidates(cwd) {
  return [
    { path: path.join(cwd, 'AGENTS.md'), label: '项目 AGENTS.md', desc: '项目开发约定' },
    { path: path.join(cwd, 'AGENTS.override.md'), label: '项目 AGENTS.override.md', desc: '优先于同目录 AGENTS.md' },
    { path: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'AGENTS.md'), label: '全局 AGENTS.md', desc: '个人全局约定' },
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
  const codex = codexMdCandidates(cwd).map((c) => {
    let st = null; try { st = fs.statSync(c.path); } catch {}
    return { ...c, name: path.basename(c.path), exists: !!st, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
  });
  return { dir, memory, codex };
}
// 只允许访问：项目补充记忆目录下的 .md 文件，或固定的 AGENTS.md 位置
function checkMemPath(cwd, p) {
  const r = path.resolve(String(p || ''));
  const dir = memoryDir(cwd);
  if (path.dirname(r) === dir && /^[^\/\\]+\.md$/.test(path.basename(r))) return r;
  if (codexMdCandidates(cwd).some((c) => c.path === r)) return r;
  throw new Error('不允许访问这个文件');
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
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {} }
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://x');
  const q = (k) => url.searchParams.get(k) || '';
  const origin = req.headers.origin;
  const host = req.headers.host || '';
  if ((LOCAL_ONLY && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) ||
      (origin && origin !== 'http://' + host) || req.headers['sec-fetch-site'] === 'cross-site') {
    return json(res, 403, { error: '不允许跨站访问本机服务' });
  }
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
          cwd, name: path.basename(cwd) || cwd, startCwd: START_CWD, app: 'codex-web',
          running: r ? { id: r.id, sessionId: r.sessionId } : null,
          busyProjects: [...runs.values()].filter((x) => !x.done).map((x) => x.cwd),
        });
      }
      case '/api/models':
        return json(res, 200, await backend.models());
      case '/api/respond': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        backend.respond(body.runId, String(body.requestId), body);
        return json(res, 200, { ok: true });
      }
      case '/api/usage':
        return json(res, 200, await getUsage());
      case '/api/projects':
        return json(res, 200, await listProjects());
      case '/api/presets':
        return json(res, 200, listPresets());
      case '/api/preset': {
        if (req.method === 'GET') {
          const d = loadPresetFile(q('file'));
          return d ? json(res, 200, d) : json(res, 404, { error: '预设不存在' });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (!PRESET_RE.test(body.file || '')) return json(res, 400, { error: '文件名无效' });
          validatePreset(body.data);
          fs.writeFileSync(path.join(PRESETS_DIR, body.file), JSON.stringify(body.data, null, 2));
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (!PRESET_RE.test(q('file') || '')) return json(res, 400, { error: '文件名无效' });
          fs.rmSync(path.join(PRESETS_DIR, q('file')), { force: true });
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: 'method' });
      }
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
        return json(res, 200, await listSessions(checkDir(q('cwd'))));
      case '/api/history':
        return json(res, 200, await loadHistory(checkDir(q('cwd')), q('id')));
      case '/api/session':
        if (req.method !== 'DELETE') return json(res, 405, { error: 'DELETE only' });
        await deleteSession(checkDir(q('cwd')), q('id'));
        return json(res, 200, { ok: true });
      case '/api/session/rename': {
        const body = await readBody(req);
        await renameSession(checkDir(body.cwd), body.id, body.title);
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
          if (['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.effort)) cur.effort = body.effort;
          if (typeof body.perm === 'string' && /^[a-zA-Z]+$/.test(body.perm)) cur.perm = body.perm;
          if (typeof body.preset === 'string' && (!body.preset || PRESET_RE.test(body.preset))) cur.preset = body.preset;
          fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\n');
        }
        return json(res, 200, cur);
      }
      case '/api/media': {
        // Codex 在回复里引用的本地图片 / 视频（只允许这些扩展名；支持 Range，视频可以拖动进度）
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
        if (body.rewindTo && !SID_RE.test(body.rewindTo)) return json(res, 400, { error: '无效的消息 ID' });
        if (body.preset && !loadPresetFile(body.preset)) return json(res, 400, { error: '预设不存在或格式错误' });
        const assembled = getAssembled(body.preset);
        const r = startRun({
          cwd, message, attachments, sessionId, assembled, rewindTo: body.rewindTo,
          model: /^[\w.\-\[\]]+$/.test(body.model || '') ? body.model : null,
          effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.effort) ? body.effort : null,
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
          await backend.stop(r);
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
  console.log('\n  \x1b[1;37m◉ Codex Web\x1b[0m  ' + (already ? '已经在运行中' : '初始项目: \x1b[1m' + START_CWD + '\x1b[0m'));
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
    // 端口被占用：如果是已经在运行的 Codex Web，直接复用它
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/info', timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => {
        let ok = false;
        try { const j = JSON.parse(b); ok = j.app === 'codex-web'; } catch {}
        if (ok) { printUrl(makeLink(), true); console.log('  （网页里可以切换到任意项目，无需重复启动）\n'); process.exit(0); }
        console.error(`\n  ❌ 端口 ${PORT} 被其他程序占用，可用 codex-web --port 其他端口\n`); process.exit(1);
      });
    });
    req.on('error', () => { console.error(`\n  ❌ 端口 ${PORT} 被占用\n`); process.exit(1); });
  });
  server.listen(PORT, HOST, () => {
    PORT = server.address().port;
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
const shutdown = () => { backend.close(); server.close(); setTimeout(() => process.exit(0), 1800).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
listen();
