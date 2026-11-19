#!/usr/bin/env node
// Claude Web — 零依赖的 Claude Code 网页聊天前端（Linux / macOS / Windows / Termux）
// 用法: node server.js [--port 8765] [--host 127.0.0.1] [--cwd 项目目录] [--lan] [--no-token] [--open | --no-open]
'use strict';
const http = require('http');
const net = require('net');
const tls = require('tls');
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
// 必须是绝对路径：sys 文件路径要传给 claude，claude 的 cwd 和本进程不同
const DATA_DIR = path.resolve(process.env.CLAUDE_WEB_DATA || path.join(os.homedir(), '.claude-web'));
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

// ============ 多账号：每个账号一个配置目录，切换只换目录，从不登出 ============
// Claude Code 的登录凭据存在配置目录（CLAUDE_CONFIG_DIR，默认 ~/.claude）的 .credentials.json 里。
// 默认账号 = ~/.claude（不设 CLAUDE_CONFIG_DIR）；其它账号各有一个目录 ~/.claude-web/accounts/<id>/，各自登录一次，之后一直保持。
// 会话记录要共用（网页读的是 ~/.claude/projects，切账号后还能接着聊）：账号目录里的 projects 等用目录链接
// （Windows 是 junction，不需要管理员）指向 ~/.claude 里的同名目录；settings.json 用 --settings 传进去。
// 删除账号只删本机目录，不调用登出。
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SHARED_DIRS = ['projects', 'skills', 'agents', 'commands', 'plugins'];
const ACC_ID_RE = /^[a-z0-9]{8}$/;
const DEFAULT_ACCOUNT = { id: 'default', name: '默认', dir: CLAUDE_HOME, isDefault: true };
function loadAccounts() {
  try { const a = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); return Array.isArray(a) ? a.filter((x) => x && ACC_ID_RE.test(x.id)) : []; } catch { return []; }
}
const saveAccounts = (list) => fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list.map(({ id, name, at }) => ({ id, name, at })), null, 2) + '\n');
function getAccount(id) {
  if (!id || id === 'default') return DEFAULT_ACCOUNT;
  const a = loadAccounts().find((x) => x.id === id);
  return a ? { ...a, dir: path.join(ACCOUNTS_DIR, a.id), isDefault: false } : null;
}
// 账号目录里补上指向 ~/.claude 的目录链接（每次用之前都调一下：~/.claude 里后来才出现的目录也能链上）
function prepareAccount(acct) {
  if (!acct || acct.isDefault) return;
  fs.mkdirSync(acct.dir, { recursive: true });
  for (const n of SHARED_DIRS) {
    const target = path.join(CLAUDE_HOME, n), link = path.join(acct.dir, n);
    try { fs.lstatSync(link); continue; } catch {} // 已经有了（链接或账号自己的目录）就不动
    if (n === 'projects') fs.mkdirSync(target, { recursive: true });
    else if (!fs.existsSync(target)) continue;
    try { fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir'); } catch (e) { console.error(`  [账号] 链接 ${link} 失败：${e.message}`); }
  }
}
// 删除账号目录：先拆掉目录链接（只删链接本身），确认 ~/.claude 里的原目录还在，再删账号自己的文件
function removeAccountDir(acct) {
  const dir = path.resolve(acct.dir);
  if (acct.isDefault || path.dirname(dir) !== path.resolve(ACCOUNTS_DIR)) throw new Error('不能删除这个目录');
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.lstatSync(p).isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } }
  }
  if (!fs.existsSync(path.join(CLAUDE_HOME, 'projects')) && names.includes('projects')) throw new Error('安全检查没通过：~/.claude/projects 不见了，停止删除');
  for (const n of fs.readdirSync(dir)) if (fs.lstatSync(path.join(dir, n)).isSymbolicLink()) throw new Error('还有没拆掉的链接：' + n);
  fs.rmSync(dir, { recursive: true, force: true });
}
// 非默认账号的额外参数：共用 ~/.claude/settings.json
const accountArgs = (acct) => (acct && !acct.isDefault && fs.existsSync(path.join(CLAUDE_HOME, 'settings.json')) ? ['--settings', path.join(CLAUDE_HOME, 'settings.json')] : []);
const accountLoggedIn = (acct) => acct.isDefault || fs.existsSync(path.join(acct.dir, '.credentials.json'));
// 登录状态（邮箱、套餐、到期时间），用 `claude auth status --json`；缓存 1 分钟
const acctStatusCache = new Map();
function accountStatus(acct, force) {
  const c = acctStatusCache.get(acct.id);
  if (!force && c && Date.now() - c.at < 60e3) return Promise.resolve(c.st);
  prepareAccount(acct);
  return new Promise((resolve) => {
    let out = '';
    const child = spawnClaude(['auth', 'status', '--json'], { cwd: DATA_DIR, env: claudeEnv(acct), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => killProc(child, true), 20e3);
    const done = () => {
      clearTimeout(timer);
      let st = { loggedIn: false };
      try {
        const j = JSON.parse(out.slice(out.indexOf('{')));
        st = { loggedIn: !!j.loggedIn, email: j.email || '', plan: j.subscriptionType || j.planTier || '', expiresAt: j.loginExpiresAt || null, method: j.authMethod || '' };
      } catch { st.error = out.trim().slice(0, 300) || '读取登录状态失败'; }
      acctStatusCache.set(acct.id, { at: Date.now(), st });
      resolve(st);
    };
    child.on('close', done);
    child.on('error', done);
  });
}
// 打开一个设好账号目录的终端窗口，在里面运行 claude，由用户自己 /login（和平时在终端里登录一样）
function loginCommand(acct) {
  const q = (s) => (IS_WIN ? `"${s}"` : `'${s}'`);
  return IS_WIN ? `set CLAUDE_CONFIG_DIR=${acct.dir}&& claude` : `CLAUDE_CONFIG_DIR=${q(acct.dir)} claude`;
}
function openLoginWindow(acct) {
  if (!IS_WIN) return false;
  prepareAccount(acct);
  const f = path.join(acct.dir === CLAUDE_HOME ? DATA_DIR : acct.dir, 'login.cmd');
  const lines = [
    '@echo off', 'chcp 65001 >nul', `title Claude 登录 - ${acct.name.replace(/[&|<>^%"]/g, '')}`,
    'echo.', `echo   这是账号「${acct.name.replace(/[&|<>^%"]/g, '')}」的登录窗口（配置目录 ${acct.dir}）`,
    'echo   在下面的 Claude Code 里输入 /login 登录。登录好以后关掉这个窗口，回网页刷新账号列表。',
    'echo   注意：登录会用默认浏览器打开 claude.ai，浏览器走哪个节点，登录时 Anthropic 看到的就是哪个 IP。',
    'echo.', `call "${CLAUDE_BIN}"`,
  ];
  fs.writeFileSync(f, lines.join('\r\n') + '\r\n');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "Claude 登录" "${f}""`],
    { env: claudeEnv(acct), detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.on('error', () => {}); child.unref();
  acctStatusCache.delete(acct.id);
  return true;
}

// ============ Codex 子代理：Claude 当主模型，子任务交给 Codex（GPT）============
// 选了 Codex 模型时，用 --mcp-config 挂上 bin/codex-mcp.js（把 codex exec 包成 codex_task / codex_continue 两个工具），
// 并禁用 Claude 自带的 Task/Agent 子代理。Codex 账号同样一个目录一个（CODEX_HOME），切换不登出。
function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (IS_WIN) {
    const js = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return js;
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      for (const ext of ['.exe']) { const p = path.join(d.replace(/"/g, ''), 'codex' + ext); try { if (d && fs.statSync(p).isFile()) return p; } catch {} }
    }
    return null;
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, 'codex'); try { if (d && fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}
const CODEX_BIN = findCodex();
const CODEX_MCP = path.join(__dirname, 'bin', 'codex-mcp.js');
const CODEX_HOME_DEFAULT = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_ACC_DIR = path.join(DATA_DIR, 'codex-accounts');
const CODEX_ACC_FILE = path.join(DATA_DIR, 'codex-accounts.json');
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_DEFAULT = { id: 'default', name: '默认', dir: CODEX_HOME_DEFAULT, isDefault: true };
function loadCodexAccounts() {
  try { const a = JSON.parse(fs.readFileSync(CODEX_ACC_FILE, 'utf8')); return Array.isArray(a) ? a.filter((x) => x && ACC_ID_RE.test(x.id)) : []; } catch { return []; }
}
const saveCodexAccounts = (list) => fs.writeFileSync(CODEX_ACC_FILE, JSON.stringify(list.map(({ id, name, at }) => ({ id, name, at })), null, 2) + '\n');
function getCodexAccount(id) {
  if (!id || id === 'default') return CODEX_DEFAULT;
  const a = loadCodexAccounts().find((x) => x.id === id);
  return a ? { ...a, dir: path.join(CODEX_ACC_DIR, a.id), isDefault: false } : null;
}
// 登录状态：只读本机的 auth.json（不联网）。ChatGPT 登录时 id_token 里有邮箱和套餐
function codexAccountStatus(acct) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(acct.dir, 'auth.json'), 'utf8')); } catch { return { loggedIn: false }; }
  const st = { loggedIn: !!(j.tokens || j.OPENAI_API_KEY), method: j.tokens ? 'chatgpt' : j.OPENAI_API_KEY ? 'apikey' : '' };
  try {
    const tok = j.tokens && (typeof j.tokens.id_token === 'string' ? j.tokens.id_token : j.tokens.id_token && j.tokens.id_token.raw_jwt);
    if (tok) {
      const pl = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      st.email = pl.email || '';
      const au = pl['https://api.openai.com/auth'] || {};
      st.plan = au.chatgpt_plan_type || '';
    }
  } catch {}
  return st;
}
function codexLoginCommand(acct) {
  return IS_WIN ? `set CODEX_HOME=${acct.dir}&& codex login` : `CODEX_HOME='${acct.dir}' codex login`;
}
function openCodexLoginWindow(acct) {
  if (!IS_WIN || !CODEX_BIN) return false;
  fs.mkdirSync(acct.dir, { recursive: true });
  const nm = acct.name.replace(/[&|<>^%"]/g, '');
  const run = /\.js$/i.test(CODEX_BIN) ? `"${process.execPath}" "${CODEX_BIN}"` : `"${CODEX_BIN}"`;
  const f = path.join(acct.isDefault ? DATA_DIR : acct.dir, 'codex-login.cmd');
  fs.writeFileSync(f, ['@echo off', 'chcp 65001 >nul', `title Codex 登录 - ${nm}`, 'echo.',
    `echo   这是 Codex 账号「${nm}」的登录窗口（目录 ${acct.dir}）`,
    'echo   会用默认浏览器打开 ChatGPT 登录页；浏览器走哪个节点，OpenAI 看到的就是哪个 IP。',
    'echo   登录完成后关掉这个窗口，回网页刷新。', 'echo.', `call ${run} login`, 'echo.', 'pause'].join('\r\n') + '\r\n');
  const env = claudeEnv(); env.CODEX_HOME = acct.dir;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "Codex 登录" "${f}""`],
    { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.on('error', () => {}); child.unref();
  return true;
}
// 模型列表来自 Codex 自己缓存的 models_cache.json（只列 visibility=list 的）
function codexModels() {
  for (const home of [CODEX_HOME_DEFAULT, ...loadCodexAccounts().map((a) => path.join(CODEX_ACC_DIR, a.id))]) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
      const ms = (Array.isArray(d) ? d : d.models || []).filter((m) => m && m.slug && m.visibility === 'list');
      if (ms.length) return ms.map((m) => ({ slug: m.slug, name: m.display_name || m.slug, desc: m.description || '',
        defaultEffort: m.default_reasoning_level || '', efforts: (m.supported_reasoning_levels || []).map((x) => x.effort).filter((x) => CODEX_EFFORTS.includes(x)) }));
    } catch {}
  }
  return [];
}
// 给 claude 的 MCP 配置文件
function codexMcpConfig(sub, permissionMode, tmpFile, runId, eventKey) {
  const acct = getCodexAccount(sub.account) || CODEX_DEFAULT;
  const env = { CODEX_BIN, CODEX_MODEL: sub.model, CODEX_EFFORT: sub.effort || 'high', CODEX_WRITE: permissionMode === 'plan' ? '0' : '1' };
  if (!acct.isDefault) env.CODEX_HOME = acct.dir;
  // Codex 的过程实时发回网页（/api/codex-event）
  const host = ['0.0.0.0', '::', 'localhost'].includes(HOST) ? '127.0.0.1' : HOST;
  env.CLAUDE_WEB_EVENTS = `http://${host}:${PORT}/api/codex-event?` + new URLSearchParams({ run: runId, k: eventKey, ...(TOKEN ? { t: TOKEN } : {}) });
  // alwaysLoad：工具说明直接放进 Claude 的工具列表。不加的话 MCP 工具被放进「延迟加载」，
  // Claude 只看到名字、要先 ToolSearch 才知道怎么用，实际几乎不会去用。
  // timeout：单次调用的硬上限（毫秒）。Codex 做大任务可能要很久
  return tmpFile(JSON.stringify({ mcpServers: { codex: { type: 'stdio', command: process.execPath, args: [CODEX_MCP], env, timeout: 3600000, alwaysLoad: true } } }));
}
// Codex 过程记录：每次委派一个文件（按 Claude 的 tool_use_id），翻看历史会话时用
const CODEX_TRACE_DIR = path.join(DATA_DIR, 'codex-trace');
const TOOL_ID_RE = /^[\w-]{8,80}$/;
const CODEX_LEAD_PROMPT = '\n\n# 子代理：Codex（重要）\n'
  + '用户在网页里选择了让 Codex（OpenAI GPT 模型）当你的子代理，目的是把具体的干活工作交给它、节省你的额度。Claude 自带的 Task / Agent 子代理已关闭。\n'
  + '你的角色是主管：理解需求、拆分任务、给 Codex 写清楚任务书、审核它的结果、和用户沟通。具体的干活默认交给 mcp__codex__codex_task：\n'
  + '- 需要读三个以上文件、在代码库里搜索或摸清结构 → 委派（mode=read）\n'
  + '- 写新代码、改多处代码、实现功能、重构 → 委派（mode=write）\n'
  + '- 跑测试、复现和排查 bug、装依赖、构建 → 委派\n'
  + '- 重要改动完成后的独立复查 → 再委派一次 mode=read 的检查\n'
  + '只有这些自己做：不用查代码就能回答的问题、一两行的小改动、核实 Codex 结论时读一两个文件抽查。拿不准时委派。\n'
  + '大任务拆成几个互不重叠的子任务（不要让两个子任务改同一个文件），能并行的在同一条回复里一起发出。\n'
  + 'Codex 看不到这段对话，也不能问你问题：task 写目标，context 写用户要什么、已知信息、约定和你已经做过的事，files 列出相关文件，done_criteria 写怎么算完成。\n'
  + 'Codex 返回后，关键结论要抽查核实再告诉用户；需要补充或返工时用 mcp__codex__codex_continue 接着同一个 thread_id。'
  + '如果用户明确说「你自己做」「别用 Codex」，就照用户说的。';
// 从 /api/chat 的请求里取子代理设置；没选 Codex 模型返回 null（= Claude 自己负责）
function subagentFrom(body) {
  if (typeof body.codexModel !== 'string' || !/^[\w.\-]+$/.test(body.codexModel)) return null;
  return { model: body.codexModel, effort: CODEX_EFFORTS.includes(body.codexEffort) ? body.codexEffort : 'high', account: typeof body.codexAccount === 'string' ? body.codexAccount : 'default' };
}

// ============ 出口锁：claude 只走指定代理，出口 IP 不对就拦 ============
// 配置在 ~/.claude-web/egress.json（bin/egress-init.js 生成），没有这个文件就不启用，行为和以前一样。
// 三层：① 独立 xray 只有节点一个出站（节点挂了就连不上，不会走本机）② 防火墙只许 claude.exe 连本机（bin/egress-firewall.ps1）
//       ③ 这里定时经代理查出口 IP：不在允许列表就拦下新消息并停掉正在跑的任务；代理连不上只拦新消息（claude 本来也出不去）
const EGRESS_FILE = process.env.CLAUDE_WEB_EGRESS || path.join(DATA_DIR, 'egress.json');
let EGRESS = null;
try {
  EGRESS = JSON.parse(fs.readFileSync(EGRESS_FILE, 'utf8'));
  const u = new URL(EGRESS.proxy);
  if (u.protocol !== 'http:') throw new Error('proxy 只支持 http://');
  EGRESS.expectIp = Array.isArray(EGRESS.expectIp) ? EGRESS.expectIp : [];
  EGRESS.expectCountry = Array.isArray(EGRESS.expectCountry) ? EGRESS.expectCountry.map((c) => String(c).toUpperCase()) : [];
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`\n  ✗ 出口锁配置 ${EGRESS_FILE} 有误：${e.message}\n    为了不走本机 IP，服务不启动。修好或删掉这个文件再试。\n`); process.exit(1); }
  EGRESS = null;
}
const egress = { state: EGRESS ? 'checking' : 'off', ip: '', loc: '', at: 0, error: '' };
// 启动 claude 用的环境变量：指定账号的配置目录；开了出口锁就强制走代理（清掉原有的各种大小写的代理变量再设）
function claudeEnv(acct) {
  const env = { ...process.env };
  if (acct && !acct.isDefault) env.CLAUDE_CONFIG_DIR = acct.dir;
  if (!EGRESS) return env;
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  env.HTTPS_PROXY = env.HTTP_PROXY = env.https_proxy = env.http_proxy = EGRESS.proxy;
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1';
  if (EGRESS.disableNonessential !== false) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; // 关掉遥测、错误上报、自动更新
  return env;
}
// 经代理请求一个回显 IP 的地址（CONNECT + TLS，零依赖），返回 { ip, loc }
function traceViaProxy(target) {
  return new Promise((resolve, reject) => {
    const pu = new URL(EGRESS.proxy), tu = new URL(target);
    const host = tu.hostname, port = +tu.port || 443;
    let sock = null, done = false;
    const fin = (err, v) => { if (done) return; done = true; clearTimeout(timer); try { sock && sock.destroy(); } catch {} err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => fin(new Error('超时')), 12000);
    const headers = { Host: `${host}:${port}` };
    if (pu.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(pu.username) + ':' + decodeURIComponent(pu.password)).toString('base64');
    const req = http.request({ host: pu.hostname.replace(/^\[|\]$/g, ''), port: +pu.port || 80, method: 'CONNECT', path: `${host}:${port}`, headers, agent: false });
    req.on('connect', (res, socket) => {
      sock = socket;
      if (res.statusCode !== 200) return fin(new Error('代理返回 ' + res.statusCode));
      const s = tls.connect({ socket, servername: host }, () => {
        s.write(`GET ${tu.pathname}${tu.search} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: curl/8\r\n\r\n`);
      });
      let b = ''; s.on('data', (d) => { b += d; if (b.length > 65536) s.destroy(); });
      s.on('close', () => {
        const body = b.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        let ip = (body.match(/^ip=(\S+)/m) || [])[1] || '';
        if (!ip) ip = (body.match(/\b(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+)\b/i) || [])[1] || '';
        fin(ip ? null : new Error('没拿到 IP'), { ip, loc: ((body.match(/^loc=(\S+)/m) || [])[1] || '').toUpperCase() });
      });
      s.on('error', (e) => fin(e));
    });
    req.on('error', (e) => fin(e));
    req.end();
  });
}
const TRACE_URLS = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://api.ipify.org/'];
let egressChecking = null;
function checkEgress() {
  if (!EGRESS) return Promise.resolve(egress);
  if (egressChecking) return egressChecking;
  egressChecking = (async () => {
    // 允许列表每次现读，改了 egress.json 不用重启（proxy / xray 改了要重启）
    try {
      const f = JSON.parse(fs.readFileSync(EGRESS_FILE, 'utf8'));
      if (Array.isArray(f.expectIp)) EGRESS.expectIp = f.expectIp;
      if (Array.isArray(f.expectCountry)) EGRESS.expectCountry = f.expectCountry.map((c) => String(c).toUpperCase());
    } catch {}
    let got = null, err = '';
    for (const u of [EGRESS.checkUrl, ...TRACE_URLS].filter(Boolean)) {
      try { got = await traceViaProxy(u); break; } catch (e) { err = (e && e.message) || String(e); }
    }
    const prev = egress.state;
    if (!got) Object.assign(egress, { state: 'down', ip: '', loc: '', error: '连不上代理（' + err + '）' });
    else {
      const okIp = !EGRESS.expectIp.length || EGRESS.expectIp.includes(got.ip);
      const okLoc = !EGRESS.expectCountry.length || !got.loc || EGRESS.expectCountry.includes(got.loc);
      if (okIp && okLoc) Object.assign(egress, { state: 'ok', ...got, error: '' });
      else {
        Object.assign(egress, { state: 'bad', ...got, error: `出口变成了 ${got.ip}${got.loc ? '（' + got.loc + '）' : ''}，不是允许的 ${EGRESS.expectIp.join(', ') || EGRESS.expectCountry.join(', ')}` });
        stopAllRuns('出口检查没通过，已停止任务：' + egress.error);
      }
    }
    egress.at = Date.now();
    if (egress.state !== prev) console.log(`  [出口] ${egress.state === 'ok' ? '✓ ' + egress.ip + ' ' + egress.loc : '✗ ' + egress.error}`);
    return egress;
  })().finally(() => { egressChecking = null; });
  return egressChecking;
}
function stopAllRuns(reason) {
  for (const r of runs.values()) {
    if (r.done) continue;
    r.push(JSON.stringify({ type: 'web_error', message: reason }));
    killProc(r.child, true);
  }
}
// 发消息前用：15 秒内检查过且正常就直接放行，否则现查一次
async function egressReady() {
  if (!EGRESS) return null;
  const st = egress.state === 'ok' && Date.now() - egress.at < 15e3 ? egress : await checkEgress();
  return st.state === 'ok' ? null : st.error || '出口检查没通过';
}
// 守护 xray：端口上已经有程序在听（上次没关掉的 xray，或你自己起的代理）就直接用，否则拉起来，退出了自动重启
let xrayProc = null, xrayOut = '';
function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => end(false)); s.on('connect', () => end(true)); s.on('error', () => end(false));
  });
}
async function superviseXray() {
  if (!EGRESS || !EGRESS.xray || !EGRESS.xray.bin) return;
  if (xrayProc && xrayProc.exitCode === null) return;
  const pu = new URL(EGRESS.proxy);
  if (await portOpen(pu.hostname.replace(/^\[|\]$/g, ''), +pu.port || 80)) return;
  try {
    xrayProc = spawn(EGRESS.xray.bin, ['run', '-c', EGRESS.xray.config], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) { console.error('  [出口] 启动 xray 失败：' + e.message); return; }
  const keep = (d) => { xrayOut = (xrayOut + d).slice(-3000); };
  xrayProc.stdout.on('data', keep); xrayProc.stderr.on('data', keep);
  xrayProc.on('error', (e) => console.error('  [出口] 启动 xray 失败：' + e.message));
  xrayProc.on('exit', (code) => {
    console.error(`  [出口] xray 退出（${code}），2 秒后重启。最后的输出：\n${xrayOut.slice(-600)}`);
    setTimeout(() => superviseXray().then(() => setTimeout(checkEgress, 1500)), 2000);
  });
}
if (EGRESS) {
  superviseXray().then(() => setTimeout(checkEgress, 1500));
  setInterval(() => { superviseXray(); checkEgress(); }, Math.max(15, +EGRESS.interval || 60) * 1000);
}

// 新版 claude 默认 --system-prompt-snapshot on：会话第一次请求时录下系统提示词，之后每轮/每次 --resume 都原样重发，
// 后来传的 --system-prompt-file 被忽略（改预设、中途开关预设对已有会话都不生效）。
// 酒馆是每次请求现拼，所以关掉。旧版本不认识这个参数会报错，启动时先看 --help 里有没有。
// --append-system-prompt-file：用来把预设排到系统字段最后（网页说明走 --system-prompt-file 排前面）。
// 帮助里只在 --bare 说明中以 --append-system-prompt[-file] 出现，不支持时退回旧顺序。
// --thinking-display：默认（showThinkingSummaries 没开）claude 请求的是 omitted，思考块是空的，网页看不到内容。
// --permission-prompt-tool stdio：权限请求（包括 AskUserQuestion 提问）通过 stdin/stdout 交给网页回答。
let SNAPSHOT_FLAG = false, APPEND_FILE_FLAG = false, THINKING_FLAG = false, PROMPT_TOOL_FLAG = false;
try {
  const hc = spawnClaude(['--help'], { stdio: ['ignore', 'pipe', 'pipe'], env: claudeEnv() });
  let ho = ''; hc.stdout.on('data', (d) => { ho += d; });
  hc.on('close', () => {
    SNAPSHOT_FLAG = /--system-prompt-snapshot/.test(ho);
    APPEND_FILE_FLAG = /--append-system-prompt-file|--append-system-prompt\[-file\]/.test(ho);
    PROMPT_TOOL_FLAG = /--permission-prompt-tool/.test(ho);
  });
  hc.on('error', () => {});
} catch {}
// --thinking-display 是隐藏参数，--help 里没有。用空输入试一下：不认识会报 unknown option，
// 认识的话只会报「没有输入」，不会调用模型
try {
  const tc = spawnClaude(['-p', '--thinking-display', 'summarized'], { stdio: ['ignore', 'pipe', 'pipe'], env: claudeEnv() });
  let te = ''; tc.stdout.on('data', (d) => { te += d; }); tc.stderr.on('data', (d) => { te += d; });
  tc.on('close', () => { THINKING_FLAG = te.length > 0 && !/unknown option/i.test(te); });
  tc.on('error', () => {});
} catch {}
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

// ============ 预设系统（用酒馆 ST 格式 json，按角色+顺序组装；预设内容由用户自行放入 presets/） ============
const PRESETS_DIR = path.join(__dirname, 'presets');
try { fs.mkdirSync(PRESETS_DIR, { recursive: true }); } catch {}
// 把一份 ST 预设拆成：system 字段 / 种进会话开头的 user、assistant 轮 / 第一条消息前的文本
// 如实按预设的角色+顺序组装：
//   role=system → 开头连续的进 system 字段（API 只有一个 system 字段）
//   role=assistant → 真 assistant 消息（伪装）
//   role=user → 并进相邻的 user 消息
//   Chat History 标记 → 不再分前后：标记之后的条目按原顺序挪到聊天历史之前，和前面的条目接着排
// 为什么不像酒馆那样把标记后的内容贴在最新消息后：claude 会把整条消息存进历史，要么每轮多一份，
// 要么每轮从旧消息上剥掉——剥掉会让上一轮存下的缓存全部对不上，工具调用多时整段历史缓存失效。
// 全部放在聊天历史前面、只出现一次，缓存就不会被打断。
// 返回：systemField(系统字段) / seedTurns(种进会话开头的 user/assistant 轮) /
//       historyHead(最后一个 assistant 之后的文本，只拼在新会话第一条消息前)
// 酒馆预设常同时有 100000（默认顺序）和 100001（预设自己的顺序），优先用 100001
function pickOrder(d) {
  const po = (d && Array.isArray(d.prompt_order)) ? d.prompt_order : [];
  const o = po.find((x) => x && x.character_id === 100001) || po[0];
  return (o && Array.isArray(o.order)) ? o.order : [];
}
function assembleFromST(d) {
  const byId = {}; for (const p of (d.prompts || [])) byId[p.identifier] = p;
  const order = pickOrder(d);
  const sys = [], turns = [];
  let buf = '', leading = true;
  const pushAssistant = (c) => {
    if (buf.trim()) { turns.push({ role: 'user', content: buf.trim() }); buf = ''; turns.push({ role: 'assistant', content: c }); }
    else if (turns.length && turns[turns.length - 1].role === 'assistant') turns[turns.length - 1].content += '\n\n' + c; // 连续 assistant 合并成一条
    else { if (!turns.length) turns.push({ role: 'user', content: '继续。' }); turns.push({ role: 'assistant', content: c }); } // API 要求开头必须 user
  };
  for (const item of order) {
    const p = byId[item.identifier] || {};
    if (p.marker) continue; // Chat History 等标记只是占位，跳过，后面的条目接着排
    if (!item.enabled) continue;
    const c = p.content || ''; if (!c.trim()) continue;
    const role = p.role || 'system';
    // 只有「开头连续的 system」进 system 字段；一旦出现 assistant/user，后面的 system 按原位转成 user
    if (leading && role === 'system') { sys.push(c); continue; }
    leading = false;
    if (role === 'assistant') pushAssistant(c);
    else buf += (buf ? '\n\n' : '') + c;  // user，或排在 assistant 之后的 system（转 user，留在原位）
  }
  // 最后一个 assistant 之后的文本（historyHead）：只拼在新会话第一条真实消息前面，之后的消息都不带。
  // 不能单独种成一条 user：种子以 user 结尾时，claude --resume 会自己补一条 "No response requested." 的 assistant。
  return { systemField: sys.join('\n\n'), seedTurns: turns, historyHead: buf.trim() };
}
const PRESET_RE = /^[^\/\\]+\.json$/;
function loadPresetFile(file) {
  if (!PRESET_RE.test(file || '')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8')); } catch { return null; }
}
// 选了预设就用预设装配；没选返回 null（=普通 agent，不替换系统提示词）
function getAssembled(file) { const d = loadPresetFile(file); return d ? assembleFromST(d) : null; }
function listPresets() {
  let files = []; try { files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => { let name = f; try { name = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')).name || f; } catch {} return { file: f, name }; });
}

// ---------- 显示时剥掉预设拼进去的文字 ----------
// historyHead 拼在新会话第一条消息前，claude 会把整条存进 jsonl；网页显示历史、会话标题时剥掉，只显示原文。
// 记录在 inject/<会话ID>.json。{prefix, suffix} 是旧版本（每轮贴前缀/后缀）留下的记录，也只在显示时剥，不再改 jsonl。
const INJECT_DIR = path.join(DATA_DIR, 'inject');
const injectFile = (sid) => path.join(INJECT_DIR, sid + '.json');
function loadInjects(sid) {
  if (!/^[0-9a-f-]{36}$/.test(sid || '')) return [];
  try { const a = JSON.parse(fs.readFileSync(injectFile(sid), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveInject(sid, rec) {
  rec = { prefix: rec.prefix || '', suffix: rec.suffix || '', head: rec.head || '' };
  if (!/^[0-9a-f-]{36}$/.test(sid || '') || (!rec.prefix && !rec.suffix && !rec.head)) return;
  const list = loadInjects(sid);
  if (list.some((x) => (x.prefix || '') === rec.prefix && (x.suffix || '') === rec.suffix && (x.head || '') === rec.head)) return;
  list.push(rec);
  try { fs.mkdirSync(INJECT_DIR, { recursive: true }); fs.writeFileSync(injectFile(sid), JSON.stringify(list)); } catch {}
}
// 显示用：head 也当前缀剥
const displayInjects = (sid) => loadInjects(sid).flatMap((x) => [x, { prefix: x.head || '', suffix: '' }]);
// 拼法和 startRun 一致：前缀 + '\n\n' + 消息 + '\n\n' + 后缀；前缀、后缀各自完全匹配才剥
function stripInjected(text, injects) {
  if (typeof text !== 'string') return text;
  let t = text;
  for (const { prefix } of injects) {
    if (!prefix) continue;
    if (t.startsWith(prefix + '\n\n')) { t = t.slice(prefix.length + 2); break; }
    if (t === prefix) { t = ''; break; }
  }
  for (const { suffix } of injects) {
    if (!suffix) continue;
    if (t.endsWith('\n\n' + suffix)) { t = t.slice(0, t.length - suffix.length - 2); break; }
    if (t === suffix) { t = ''; break; }
  }
  return t;
}

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
  // 只剩预设种子（伪装对话）也算空：开新会话，重新种子 + 第一条消息前拼 historyHead
  const hasConversation = keep.some((l) => /"type":"(user|assistant)"/.test(l) && !l.includes('"isMeta":true') && !l.includes('"seed":true'));
  if (!hasConversation) { fs.rmSync(f, { force: true }); return false; }
  fs.writeFileSync(f, keep.filter((l) => l.trim()).join('\n') + '\n');
  return true;
}

// 种一个带「用户→AI 自我确认」的新会话文件，返回新 sessionId（供 --resume）。
// 这两条带 seed:true，loadHistory 会跳过不显示，但二进制读文件时会把它们作为真历史发给模型。
// 把预设的 user/assistant 轮如实种进新会话，--resume 时作为真历史发给模型
function seedWritingSession(cwd, turns) {
  const sid = crypto.randomUUID();
  const dir = sessionDir(cwd); fs.mkdirSync(dir, { recursive: true });
  const ts = () => new Date().toISOString();
  const lines = [{ type: 'mode', mode: 'normal', sessionId: sid }, { type: 'permission-mode', permissionMode: 'auto', sessionId: sid }];
  let parent = null;
  for (const t of (turns || [])) {
    const uuid = crypto.randomUUID();
    const msg = t.role === 'assistant' ? { role: 'assistant', content: [{ type: 'text', text: t.content }] } : { role: 'user', content: t.content };
    lines.push({ parentUuid: parent, isSidechain: false, cwd, sessionId: sid, version: '2.1.289', seed: true, type: t.role, userType: 'external', message: msg, uuid, timestamp: ts() });
    parent = uuid;
  }
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sid;
}

const THINKING_DISPLAYS = ['summarized', 'highlights', 'omitted'];
function startRun({ cwd, message, attachments, sessionId, model, effort, permissionMode, thinking, assembled, account, subagent }) {
  const isNew = !sessionId;
  // 选了预设 + 新会话：按预设把 user/assistant 轮种进去，再 --resume
  if (assembled && assembled.seedTurns && assembled.seedTurns.length && isNew) {
    try { sessionId = seedWritingSession(cwd, assembled.seedTurns); } catch {}
  }
  // head：预设里最后一个 assistant 之后的文本，只拼在新会话第一条消息前（之后一直留在历史开头）
  const head = (isNew && assembled && assembled.historyHead) || '';
  const cliArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (sessionId) cliArgs.push('--resume', sessionId);
  if (model) cliArgs.push('--model', model);
  if (effort) cliArgs.push('--effort', effort);
  if (permissionMode) cliArgs.push('--permission-mode', permissionMode);
  if (SNAPSHOT_FLAG) cliArgs.push('--system-prompt-snapshot', 'off'); // 系统提示词每轮按当前预设现发，不沿用会话开头录下的
  if (THINKING_FLAG && thinking) cliArgs.push('--thinking-display', thinking);
  // 需要人回答的请求（提问、执行命令的审批等）发到 stdout 等网页回答；不加的话 -p 模式下一律自动拒绝
  if (PROMPT_TOOL_FLAG) cliArgs.push('--permission-prompt-tool', 'stdio');
  prepareAccount(account);
  cliArgs.push(...accountArgs(account));
  const runId = crypto.randomUUID(), eventKey = crypto.randomBytes(12).toString('hex');
  const sysFiles = [];
  const tmpFile = (text) => {
    const f = path.join(DATA_DIR, 'sys-' + crypto.randomBytes(4).toString('hex') + '.txt');
    fs.writeFileSync(f, text); sysFiles.push(f); return f;
  };
  // Codex 子代理：挂 MCP、关掉 Claude 自带子代理；自动放行 codex 工具（default / plan 模式下仍会弹框问）
  let webPrompt = WEB_PROMPT;
  if (subagent && subagent.model && CODEX_BIN) {
    cliArgs.push('--mcp-config', codexMcpConfig(subagent, permissionMode, tmpFile, runId, eventKey), '--disallowedTools', 'Task,Agent');
    if (['acceptEdits', 'auto', 'bypassPermissions'].includes(permissionMode)) cliArgs.push('--allowedTools', 'mcp__codex__codex_task,mcp__codex__codex_continue');
    webPrompt += CODEX_LEAD_PROMPT;
  }
  if (assembled && assembled.systemField) {
    // 预设里开头连续的 system 进系统字段，--system-prompt-file 完全替换官方 system。
    // 系统字段排列顺序（claude 固定）：计费标记 → 身份行 → system-prompt-file → WebSearch 说明等 → append
    // 所以网页说明放 file、预设放 append-file，预设就排在系统字段最后。
    try {
      if (APPEND_FILE_FLAG) cliArgs.push('--system-prompt-file', tmpFile(webPrompt), '--append-system-prompt-file', tmpFile(assembled.systemField));
      else cliArgs.push('--system-prompt-file', tmpFile(assembled.systemField), '--append-system-prompt', webPrompt); // 旧版 claude
    } catch { cliArgs.push('--append-system-prompt', webPrompt); }
  } else {
    cliArgs.push('--append-system-prompt', webPrompt);
  }
  const env = claudeEnv(account);
  // root 用户下 Claude Code 默认拒绝 bypassPermissions，IS_SANDBOX=1 可解除这个限制
  if (permissionMode === 'bypassPermissions') env.IS_SANDBOX = '1';

  const child = spawnClaude(cliArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // asks：等网页回答的请求 request_id -> request
  const r = { id: runId, eventKey, cwd, child, lines: [], done: false, listeners: new Set(), sessionId, asks: new Map(), account: account.id };
  runs.set(cwd, r);

  const push = (line) => {
    r.lines.push(line);
    for (const fn of r.listeners) fn(line);
  };
  r.push = push;
  child.stdin.on('error', () => {}); // 进程已退出时写 stdin 会 EPIPE，忽略
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
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) { r.sessionId = ev.session_id; saveInject(r.sessionId, { head }); }
        if (ev.type === 'user' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)
            && !ev.message.content.some((b) => b.type === 'tool_result')) continue; // 用户消息回显，前端已显示
        if (ev.type === 'control_request' && ev.request_id) {
          if (ev.request?.subtype === 'can_use_tool') r.asks.set(ev.request_id, ev.request);
          else { // 其它控制请求网页处理不了，直接回错误，免得 claude 一直等
            writeStdin(r, { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: '网页前端不支持这个请求' } });
            continue;
          }
        }
        if (ev.type === 'control_cancel_request' && ev.request_id) r.asks.delete(ev.request_id);
        if (ev.type === 'rate_limit_event') saveRateLimit(ev.rate_limit_info, account);
        // 一轮结束：关掉 stdin，claude 才会退出（stdin 开着时它会继续等下一条消息）
        if (ev.type === 'result' && !ev.parent_tool_use_id) { r.asks.clear(); try { child.stdin.end(); } catch {} }
      } catch { continue; }
      push(line);
    }
  });
  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf += d.toString(); });
  const finish = (code) => {
    if (r.done) return;
    for (const f of sysFiles) { try { fs.rmSync(f, { force: true }); } catch {} }
    if (code && errBuf.trim()) push(JSON.stringify({ type: 'web_error', message: errBuf.trim().slice(-2000) }));
    push(JSON.stringify({ type: 'web_done', code, sessionId: r.sessionId }));
    r.done = true;
    for (const fn of r.listeners) fn(null);
    r.listeners.clear();
  };
  child.on('close', finish);
  child.on('error', (e) => { errBuf += String(e); finish(1); });
  // 新会话第一条消息前拼上预设的 historyHead；拼法改了的话 stripInjected 要跟着改
  const userMsg = (head ? head + '\n\n' : '') + message;
  const first = { type: 'user', message: { role: 'user', content: buildContent(userMsg, attachments) } };
  // 能回答权限请求时 stdin 保持打开（收到 result 再关），否则和以前一样写完就关
  if (PROMPT_TOOL_FLAG) writeStdin(r, first); else child.stdin.end(JSON.stringify(first) + '\n');
  return r;
}
function writeStdin(r, obj) {
  try { if (!r.done && r.child.stdin.writable) { r.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } } catch {}
  return false;
}
// 网页回答一个权限请求。AskUserQuestion：answers = { 问题原文: 答案 }；其它工具：允许 / 拒绝
// updatedInput 用服务端记下的原始 input，不信任网页传来的工具参数
function answerAsk(r, requestId, { behavior, answers, message }) {
  const req = r.asks.get(requestId);
  if (!req) throw new Error('这个请求已经结束或已回答');
  let response;
  if (behavior === 'allow') {
    const input = req.input || {};
    if (req.tool_name === 'AskUserQuestion') {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const a = {};
      for (const q of qs) {
        const v = answers && answers[q.question];
        if (typeof v !== 'string' || !v.trim()) throw new Error('还有问题没回答：' + q.question);
        a[q.question] = v.trim().slice(0, 4000);
      }
      response = { behavior: 'allow', updatedInput: { ...input, answers: a } };
    } else response = { behavior: 'allow', updatedInput: input };
  } else {
    const def = req.tool_name === 'AskUserQuestion' ? '用户跳过了这些问题，没有回答。请按你自己的判断继续。' : '用户拒绝了这个操作。';
    response = { behavior: 'deny', message: (typeof message === 'string' && message.trim()) ? message.trim().slice(0, 4000) : def };
  }
  if (!writeStdin(r, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })) throw new Error('任务已经结束');
  r.asks.delete(requestId);
  // 记进输出流：断线重连 / 刷新页面重放时，网页知道这个请求已经回答过了
  r.push(JSON.stringify({ type: 'web_ask_done', request_id: requestId, behavior: response.behavior, answers: response.updatedInput?.answers || null }));
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
// 新版 claude 的 `/usage` 在 -p 模式下不再输出「xx% used」额度行，只剩用量分析。
// 额度改从每次对话输出的 rate_limit_event 里取（unifiedWindows：five_hour / seven_day ...，utilization 0~1，resetsAt 秒），
// 存到 ratelimit.json；旧版 claude 仍能从 /usage 解析出来时以 /usage 为准。
// 每个账号一份：默认账号 ratelimit.json，其它 ratelimit-<id>.json
const rateLimitFile = (acct) => path.join(DATA_DIR, acct && !acct.isDefault ? `ratelimit-${acct.id}.json` : 'ratelimit.json');
function saveRateLimit(info, acct) {
  if (!info || typeof info !== 'object') return;
  const w = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
  if (!w || !Object.keys(w).length) return;
  try { fs.writeFileSync(rateLimitFile(acct), JSON.stringify({ at: Date.now(), windows: w })); } catch {}
  usageCache.delete((acct || DEFAULT_ACCOUNT).id);
}
const RL_LABELS = { five_hour: '当前 5 小时窗口', seven_day: '本周（所有模型）', seven_day_opus: '本周（Opus）', seven_day_sonnet: '本周（Sonnet）' };
function rateLimitWindows(acct) {
  let d; try { d = JSON.parse(fs.readFileSync(rateLimitFile(acct), 'utf8')); } catch { return null; }
  const now = Date.now(), windows = [];
  for (const [k, v] of Object.entries(d.windows || {})) {
    if (!v || typeof v.utilization !== 'number') continue;
    const resetAt = v.resetsAt ? v.resetsAt * 1000 : 0;
    // 已经过了重置时间：额度清零（下次对话会拿到新数据）
    const pct = resetAt && resetAt < now ? 0 : Math.round(v.utilization * 1000) / 10;
    windows.push({ label: RL_LABELS[k] || k, pct, resetAt });
  }
  return windows.length ? { at: d.at, windows } : null;
}
const usageCache = new Map(); // 账号 id -> 结果
function getUsage(force, acct) {
  acct = acct || DEFAULT_ACCOUNT;
  const c = usageCache.get(acct.id);
  if (!force && c && Date.now() - c.at < 60e3) return Promise.resolve(c);
  if (!accountLoggedIn(acct)) return Promise.resolve({ at: Date.now(), windows: [], notes: [`账号「${acct.name}」还没登录`] });
  if (EGRESS && egress.state !== 'ok') return Promise.resolve({ at: Date.now(), windows: [], notes: ['出口检查没通过，暂不查询用量'] });
  prepareAccount(acct);
  return new Promise((resolve) => {
    const child = spawnClaude(['-p', '/usage', '--no-session-persistence', ...accountArgs(acct)], { cwd: DATA_DIR, env: claudeEnv(acct), stdio: ['ignore', 'pipe', 'pipe'] });
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
      let dataAt = 0;
      if (!windows.length) {
        const rl = rateLimitWindows(acct);
        if (rl) { windows.push(...rl.windows); dataAt = rl.at; notes.length = 0; }
        else notes.splice(0, notes.length, '还没有额度数据：发一条消息后就会显示（新版 Claude Code 只在对话时返回额度；用 API Key 时没有额度信息）');
      }
      const result = { at: Date.now(), dataAt, windows, notes };
      usageCache.set(acct.id, result);
      resolve(result);
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
    const injects = displayInjects(f.slice(0, -6));
    try {
      for (const line of readHeadTail(p, 256 * 1024).split('\n')) {
        if (!line.includes('"type":"user"') && !line.includes('title"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'custom-title' && o.customTitle != null) customTitle = o.customTitle;
        if (o.type === 'ai-title' && o.aiTitle && !/^Resume session /.test(o.aiTitle)) aiTitle = o.aiTitle;
        if (!title && o.type === 'user' && !o.isMeta && !o.isSidechain && !o.seed && !isSystemPrompt(o)) {
          const c = o.message && o.message.content;
          const t = stripInjected(textOfUserContent(c), injects);
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
  fs.rmSync(injectFile(id), { force: true });
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
  const injects = displayInjects(id);
  for (const line of raw.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || o.isMeta || o.seed) continue;
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
      const t = stripInjected(textOfUserContent(c), injects); // 最新一条还带着前缀/后缀，显示时剥掉
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
          egress,
        });
      }
      case '/api/egress': {
        // 出口状态；force=1 立刻重查
        if (q('force') === '1') await checkEgress();
        return json(res, 200, { ...egress, expectIp: EGRESS ? EGRESS.expectIp : [], proxy: EGRESS ? EGRESS.proxy : '' });
      }
      case '/api/usage':
        return json(res, 200, await getUsage(q('force') === '1', getAccount(q('account')) || DEFAULT_ACCOUNT));
      case '/api/accounts': {
        // GET：账号列表和登录状态；POST {name}：新建账号；PUT {id,name}：重命名；DELETE ?id=：删除（只删本机，不登出）
        if (req.method === 'GET') {
          const list = [DEFAULT_ACCOUNT, ...loadAccounts().map((a) => getAccount(a.id))];
          const force = q('force') === '1';
          const sts = await Promise.all(list.map((a) => accountStatus(a, force)));
          return json(res, 200, list.map((a, i) => ({ id: a.id, name: a.name, isDefault: a.isDefault, dir: a.dir, ...sts[i], loginCommand: loginCommand(a) })));
        }
        const body = req.method === 'DELETE' ? {} : await readBody(req);
        const name = String(body.name || '').trim().replace(/[\r\n]/g, ' ').slice(0, 40);
        if (req.method === 'POST') {
          if (!name) return json(res, 400, { error: '请填写账号名称' });
          const list = loadAccounts();
          const acct = { id: crypto.randomBytes(4).toString('hex'), name, at: Date.now() };
          list.push(acct); saveAccounts(list);
          const a = getAccount(acct.id); prepareAccount(a);
          return json(res, 200, { id: a.id, name: a.name, loginCommand: loginCommand(a), opened: body.openLogin ? openLoginWindow(a) : false });
        }
        if (req.method === 'PUT') {
          const list = loadAccounts(), a = list.find((x) => x.id === body.id);
          if (!a) return json(res, 404, { error: '没有这个账号' });
          if (!name) return json(res, 400, { error: '请填写账号名称' });
          a.name = name; saveAccounts(list);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          const a = getAccount(q('id'));
          if (!a || a.isDefault) return json(res, 400, { error: '默认账号不能删除' });
          if ([...runs.values()].some((r) => !r.done && r.account === a.id)) return json(res, 409, { error: '这个账号还有任务在跑，先停掉' });
          removeAccountDir(a);
          saveAccounts(loadAccounts().filter((x) => x.id !== a.id));
          acctStatusCache.delete(a.id); usageCache.delete(a.id);
          try { fs.rmSync(rateLimitFile(a), { force: true }); } catch {}
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: 'method' });
      }
      case '/api/codex-event': {
        // codex-mcp.js 发来的 Codex 过程：推进输出流（网页实时显示），并按 tool_use_id 记到文件
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const r = findRun(q('run'));
        if (!r || q('k') !== r.eventKey) return json(res, 403, { error: 'bad key' });
        const b = await readBody(req);
        const ev = { type: 'web_codex', tool_use_id: TOOL_ID_RE.test(b.toolUseId || '') ? b.toolUseId : '', kind: String(b.kind || ''), text: String(b.text || '').slice(0, 20000) };
        if (b.code !== undefined) ev.code = b.code;
        if (b.output) ev.output = String(b.output).slice(0, 4000);
        if (b.id) ev.id = String(b.id).slice(0, 80);
        if (!r.done) r.push(JSON.stringify(ev));
        if (ev.tool_use_id) {
          try { fs.mkdirSync(CODEX_TRACE_DIR, { recursive: true }); fs.appendFileSync(path.join(CODEX_TRACE_DIR, ev.tool_use_id + '.jsonl'), JSON.stringify({ ...ev, at: Date.now() }) + '\n'); } catch {}
        }
        return json(res, 200, { ok: true });
      }
      case '/api/codex-trace': {
        const id = q('id');
        if (!TOOL_ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
        let lines = []; try { lines = fs.readFileSync(path.join(CODEX_TRACE_DIR, id + '.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
        return json(res, 200, lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      }
      case '/api/codex': {
        // GET：是否装了 Codex、模型列表、账号和登录状态；POST {name}：新建账号；DELETE ?id=：移除（只删本机，不登出）；
        // POST /api/codex?login=<id>：打开登录窗口
        if (req.method === 'GET') {
          const accts = [CODEX_DEFAULT, ...loadCodexAccounts().map((a) => getCodexAccount(a.id))];
          return json(res, 200, { available: !!CODEX_BIN, models: codexModels(), efforts: CODEX_EFFORTS,
            accounts: accts.map((a) => ({ id: a.id, name: a.name, isDefault: a.isDefault, dir: a.dir, loginCommand: codexLoginCommand(a), ...codexAccountStatus(a) })) });
        }
        if (req.method === 'POST' && q('login')) {
          const a = getCodexAccount(q('login'));
          if (!a) return json(res, 404, { error: '没有这个账号' });
          return json(res, 200, { opened: openCodexLoginWindow(a), loginCommand: codexLoginCommand(a) });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const name = String(body.name || '').trim().replace(/[\r\n]/g, ' ').slice(0, 40);
          if (!name) return json(res, 400, { error: '请填写账号名称' });
          const list = loadCodexAccounts();
          const rec = { id: crypto.randomBytes(4).toString('hex'), name, at: Date.now() };
          list.push(rec); saveCodexAccounts(list);
          const a = getCodexAccount(rec.id);
          fs.mkdirSync(a.dir, { recursive: true });
          // 沿用默认账号的 config.toml（Windows 沙箱等设置），不含登录信息
          try { fs.copyFileSync(path.join(CODEX_HOME_DEFAULT, 'config.toml'), path.join(a.dir, 'config.toml')); } catch {}
          return json(res, 200, { id: a.id, name: a.name, opened: body.openLogin ? openCodexLoginWindow(a) : false, loginCommand: codexLoginCommand(a) });
        }
        if (req.method === 'DELETE') {
          const a = getCodexAccount(q('id'));
          if (!a || a.isDefault) return json(res, 400, { error: '默认账号不能移除' });
          if (path.dirname(path.resolve(a.dir)) !== path.resolve(CODEX_ACC_DIR)) return json(res, 400, { error: '目录不对，停止删除' });
          fs.rmSync(a.dir, { recursive: true, force: true });
          saveCodexAccounts(loadCodexAccounts().filter((x) => x.id !== a.id));
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: 'method' });
      }
      case '/api/accounts/login': {
        // 打开这个账号的登录终端窗口（仅 Windows；其它系统返回命令让用户自己在终端里运行）
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const a = getAccount(body.id);
        if (!a) return json(res, 404, { error: '没有这个账号' });
        return json(res, 200, { opened: openLoginWindow(a), loginCommand: loginCommand(a) });
      }
      case '/api/projects':
        return json(res, 200, listProjects());
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
          if (THINKING_DISPLAYS.includes(body.thinking)) cur.thinking = body.thinking;
          if (typeof body.account === 'string' && getAccount(body.account)) cur.account = body.account;
          if (typeof body.codexModel === 'string' && /^[\w.\-]*$/.test(body.codexModel)) cur.codexModel = body.codexModel;
          if (CODEX_EFFORTS.includes(body.codexEffort)) cur.codexEffort = body.codexEffort;
          if (typeof body.codexAccount === 'string' && getCodexAccount(body.codexAccount)) cur.codexAccount = body.codexAccount;
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
        if (body.codexModel && !CODEX_BIN) return json(res, 400, { error: '没有找到 Codex（codex 命令），子代理请先切回「Claude」' });
        if (body.codexModel && !getCodexAccount(body.codexAccount)) return json(res, 400, { error: '选中的 Codex 账号已经不存在了，请重新选择' });
        if (body.codexModel && !codexAccountStatus(getCodexAccount(body.codexAccount)).loggedIn) return json(res, 400, { error: 'Codex 账号还没登录：在「子代理」里点「Codex 账号」登录' });
        const account = getAccount(body.account);
        if (!account) return json(res, 400, { error: '选中的账号已经不存在了，请重新选择账号' });
        if (!accountLoggedIn(account)) return json(res, 400, { error: `账号「${account.name}」还没登录：在「账号」里点「登录」，在弹出的窗口里 /login` });
        const egressErr = await egressReady();
        if (egressErr) return json(res, 503, { error: '出口检查没通过，这条消息没有发出：' + egressErr, egress });
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
        const assembled = getAssembled(body.preset);  // 选了预设就装配：替换 system + 种自攻击 + 后置
        const r = startRun({
          cwd, message, attachments, sessionId, assembled,
          model: /^[\w.\-\[\]]+$/.test(body.model || '') ? body.model : null,
          effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort) ? body.effort : null,
          permissionMode: /^[a-zA-Z]+$/.test(body.permissionMode || '') ? body.permissionMode : null,
          thinking: THINKING_DISPLAYS.includes(body.thinking) ? body.thinking : null,
          account,
          subagent: subagentFrom(body),
        });
        return streamRun(r, 0, req, res);
      }
      case '/api/attach': {
        const r = findRun(q('run'));
        if (!r) return json(res, 404, { error: 'no such run' });
        return streamRun(r, Math.max(0, parseInt(q('from') || '0', 10) || 0), req, res);
      }
      case '/api/answer': {
        // 回答 claude 中途的提问（AskUserQuestion）或操作审批
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const r = findRun(body.run);
        if (!r || r.done) return json(res, 404, { error: '任务已经结束' });
        answerAsk(r, String(body.requestId || ''), {
          behavior: body.behavior === 'allow' ? 'allow' : 'deny',
          answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
          message: body.message,
        });
        return json(res, 200, { ok: true });
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
const shutdown = () => {
  for (const r of runs.values()) if (!r.done) killProc(r.child, true);
  if (xrayProc) { xrayProc.removeAllListeners('exit'); killProc(xrayProc, true); }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
listen();
