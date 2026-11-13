'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CodexClient, PERMISSIONS, seedItems } = require('./codex-client');

const SID_RE = /^[0-9a-f-]{36}$/i;
const canonical = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
const samePath = (a, b) => process.platform === 'win32' ? canonical(a).toLowerCase() === canonical(b).toLowerCase() : canonical(a) === canonical(b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CodexBackend {
  constructor(dataDir, webPrompt) {
    this.dataDir = dataDir; this.webPrompt = webPrompt; this.runs = new Map();
    this.metaDir = path.join(dataDir, 'threads'); fs.mkdirSync(this.metaDir, { recursive: true });
  }
  metadata(id) { this.checkId(id); try { return JSON.parse(fs.readFileSync(path.join(this.metaDir, id + '.json'), 'utf8')); } catch { return {}; } }
  saveMetadata(id, value) {
    this.checkId(id); const file = path.join(this.metaDir, id + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file);
  }
  checkId(id) { if (!SID_RE.test(id || '')) throw new Error('无效的会话 ID'); }
  async catalog() {
    if (!this.control || this.control.closed) {
      this.control = new CodexClient();
      this.control.on('exit', () => { this.control = null; });
    }
    const c = this.control; await c.ready; return c;
  }
  active(cwd) { const r = this.runs.get(path.resolve(cwd)); return r && !r.done ? r : null; }
  find(id) { return [...this.runs.values()].find(r => r.id === id); }
  async verify(c, cwd, id) {
    this.checkId(id);
    const { thread } = await c.request('thread/read', { threadId: id });
    if (!samePath(thread.cwd, cwd)) throw new Error('会话不属于当前项目');
    return thread;
  }
  async allThreads(cwd) {
    const c = await this.catalog(); const out = []; let cursor;
    do {
      const page = await c.request('thread/list', { limit: 100, sortKey: 'updated_at', ...(cwd ? { cwd: canonical(cwd) } : {}), ...(cursor ? { cursor } : {}) });
      out.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
  async listSessions(cwd) {
    return (await this.allThreads(cwd)).filter(t => t.preview || t.name).map(t => ({
      id: t.id, title: t.name || this.cleanText(t.id, t.preview).slice(0, 80) || '新对话', mtime: t.updatedAt * 1000,
    }));
  }
  async listProjects(startCwd) {
    const projects = new Map([[startCwd, { cwd: startCwd, name: path.basename(startCwd), mtime: 0, count: 0 }]]);
    for (const t of await this.allThreads()) {
      if (!t.cwd || !fs.existsSync(t.cwd)) continue;
      const p = projects.get(t.cwd) || { cwd: t.cwd, name: path.basename(t.cwd) || t.cwd, mtime: 0, count: 0 };
      p.count++; p.mtime = Math.max(p.mtime, t.updatedAt * 1000); projects.set(t.cwd, p);
    }
    return [...projects.values()].sort((a, b) => b.mtime - a.mtime);
  }
  async turns(c, id) {
    const out = []; let cursor;
    try {
      do {
        const page = await c.request('thread/turns/list', { threadId: id, limit: 100, itemsView: 'full', sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
        out.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      return out;
    } catch (e) {
      // 旧版 CLI 创建的 legacy 会话仍可读取；不编辑底层 JSONL。
      const { thread } = await c.request('thread/read', { threadId: id, includeTurns: true });
      if (thread.historyMode === 'legacy') return thread.turns;
      throw e;
    }
  }
  cleanText(id, text) {
    for (const head of this.metadata(id).heads || []) if (text.startsWith(head + '\n\n')) return text.slice(head.length + 2);
    return text;
  }
  async history(cwd, id) {
    const c = await this.catalog(); await this.verify(c, cwd, id);
    const out = []; const meta = this.metadata(id);
    for (const turn of await this.turns(c, id)) {
      const display = meta.turns?.[turn.id];
      for (const item of turn.items || []) {
        if (item.type === 'userMessage') {
          const content = item.content || [];
          const text = display?.text ?? this.cleanText(id, content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
          const images = content.filter(x => x.type === 'image' || x.type === 'localImage').map(x => x.url || '/api/media?path=' + encodeURIComponent(x.path));
          out.push({ kind: 'user', uuid: turn.id, text, images, files: display?.files || [] });
        } else if (item.type === 'agentMessage' || item.type === 'plan') out.push({ kind: 'text', text: item.text });
        else if (item.type === 'reasoning') out.push({ kind: 'thinking', text: (item.summary || []).join('\n') });
        else if (item.type === 'contextCompaction') out.push({ kind: 'command', text: '— 上下文已压缩 —' });
        else if (item.type !== 'hookPrompt') {
          out.push({ kind: 'tool_use', id: item.id, name: toolName(item), input: toolInput(item) });
          out.push({ kind: 'tool_result', id: item.id, content: toolOutput(item), isError: failed(item) });
        }
      }
    }
    return out;
  }
  async rename(cwd, id, name) {
    const c = await this.catalog(); await this.verify(c, cwd, id);
    await c.request('thread/name/set', { threadId: id, name: String(name).trim().slice(0, 200) || '未命名会话' });
  }
  async delete(cwd, id) {
    if (this.active(cwd)?.sessionId === id) throw new Error('请先停止这个会话');
    const c = await this.catalog(); await this.verify(c, cwd, id);
    await c.request('thread/delete', { threadId: id }); fs.rmSync(path.join(this.metaDir, id + '.json'), { force: true });
  }
  async models() { const c = await this.catalog(); return (await c.request('model/list', {})).data; }
  async usage() {
    try {
      const c = await this.catalog(); const data = await c.request('account/rateLimits/read');
      const buckets = data.rateLimitsByLimitId ? Object.entries(data.rateLimitsByLimitId) : [['codex', data.rateLimits]];
      const windows = [];
      for (const [key, bucket] of buckets) for (const [kind, w] of Object.entries({ primary: bucket?.primary, secondary: bucket?.secondary })) {
        if (!w) continue;
        windows.push({ label: key + ' · ' + (w.windowDurationMins === 300 ? '5 小时窗口' : w.windowDurationMins === 10080 ? '每周额度' : kind === 'primary' ? '主要额度' : '次要额度'), pct: Math.max(0, Math.min(100, w.usedPercent)), reset: w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString('zh-CN') : '' });
      }
      return { windows, notes: windows.length ? ['显示 Codex 返回的实际额度；部分套餐没有此数据。'] : ['当前登录方式未提供订阅额度。'], at: Date.now() };
    } catch (e) { return { windows: [], notes: [e.message], at: Date.now() }; }
  }
  // 默认提示词只读自 Codex 自己创建的临时会话，读取后立即删除，不调用模型。
  // 这样关闭预设时能够恢复当前安装版本的原生指令，而不是沿用上次替换值。
  async nativeBase(c, cwd, model) {
    const { thread } = await c.request('thread/start', { cwd, ...(model ? { model } : {}), sandbox: 'read-only', approvalPolicy: 'never' });
    try {
      await c.request('thread/inject_items', { threadId: thread.id, items: seedItems([{ role: 'assistant', content: '初始化指令快照。' }]) });
      await c.request('thread/unsubscribe', { threadId: thread.id });
      for (let i = 0; i < 30; i++) {
        try {
          const fd = fs.openSync(thread.path, 'r'); let head;
          try { const buf = Buffer.alloc(1024 * 1024); const n = fs.readSync(fd, buf); head = buf.toString('utf8', 0, n); } finally { fs.closeSync(fd); }
          const base = JSON.parse(head.split('\n')[0]).payload.base_instructions.text;
          if (typeof base === 'string') return base;
        } catch {}
        await sleep(50);
      }
      throw new Error('无法读取当前 Codex 的原生指令快照；为避免错误替换，已停止发送。');
    } finally { await c.request('thread/delete', { threadId: thread.id }); }
  }
  start(options) {
    const cwd = path.resolve(options.cwd);
    if (this.active(cwd)) throw new Error('这个项目上一条消息还在处理中');
    const r = { id: crypto.randomUUID(), cwd, lines: [], listeners: new Set(), done: false, sessionId: options.sessionId, approvals: new Map(), stopped: false };
    r.push = ev => { if (r.done) return; const line = JSON.stringify(ev); r.lines.push(line); for (const fn of r.listeners) fn(line); };
    r.finish = () => {
      if (r.done) return;
      r.push({ type: 'web_done', sessionId: r.sessionId }); r.done = true; r.approvals.clear();
      for (const fn of r.listeners) fn(null); r.listeners.clear(); r.client?.close();
    };
    this.runs.set(cwd, r);
    this.execute(r, options).catch(e => { r.push({ type: 'web_error', message: e.message }); r.finish(); });
    return r;
  }
  async execute(r, o) {
    const c = r.client = new CodexClient({ cwd: r.cwd });
    c.on('exit', () => { if (!r.done) { r.push({ type: 'web_error', message: 'Codex 进程意外结束。' }); r.finish(); } });
    c.on('message', msg => {
      const p = msg.params || {};
      if (msg.id !== undefined) {
        if (p.threadId && p.threadId !== r.sessionId) return c.reply(msg.id, { decision: 'decline' });
        if (!['item/tool/requestUserInput', 'item/permissions/requestApproval', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
          c.send({ id: msg.id, error: { code: -32601, message: 'Codex Web 尚未支持此交互：' + msg.method } });
          r.push({ type: 'notice', message: '未支持的交互已拒绝，可在 CLI 中处理：' + msg.method }); return;
        }
        r.approvals.set(String(msg.id), { id: msg.id, method: msg.method, params: p });
        r.push({ type: 'approval', requestId: String(msg.id), method: msg.method, params: p }); return;
      }
      if (p.threadId !== r.sessionId) return;
      if (msg.method === 'turn/started') r.turnId = p.turn.id;
      if (msg.method === 'serverRequest/resolved') r.approvals.delete(String(p.requestId));
      r.push({ type: 'codex', method: msg.method, params: p });
      if (msg.method === 'thread/tokenUsage/updated') {
        const meta = this.metadata(r.sessionId); meta.tokenUsage = p.tokenUsage; this.saveMetadata(r.sessionId, meta);
      }
      if (msg.method === 'turn/completed') {
        if (p.turn.error) r.push({ type: 'web_error', message: p.turn.error.message });
        // 给 turn/start 响应留时间，确保显示元数据先持久化。
        setImmediate(() => { if (r.startSettled) r.finish(); else r.completed = true; });
      }
    });
    await c.ready;
    const permissions = PERMISSIONS[o.permissionMode || 'workspace'];
    if (!permissions) throw new Error('无效的权限模式');
    let meta = r.sessionId ? this.metadata(r.sessionId) : {};
    if (r.sessionId) await this.verify(c, r.cwd, r.sessionId);
    if (o.assembled || meta.nativeBase !== undefined) meta.nativeBase = await this.nativeBase(c, r.cwd, o.model);
    const params = { cwd: r.cwd, ...permissions, ...(o.model ? { model: o.model } : {}) };
    params.developerInstructions = this.webPrompt;
    if (o.assembled) params.baseInstructions = [this.webPrompt, o.assembled.systemField].filter(Boolean).join('\n\n');
    else if (meta.nativeBase !== undefined) params.baseInstructions = meta.nativeBase;
    let result;
    if (r.sessionId) {
      result = await c.request('thread/resume', { ...params, threadId: r.sessionId, excludeTurns: true });
    }
    else { result = await c.request('thread/start', params); r.sessionId = result.thread.id; }
    r.push({ type: 'session', sessionId: r.sessionId, model: result.model || o.model });
    if (o.rewindTo) {
      const turns = await this.turns(c, r.sessionId);
      if (!turns.some(t => t.id === o.rewindTo)) throw new Error('找不到要编辑的消息');
      if (result.thread.historyMode === 'legacy') throw new Error('此旧版会话不支持编辑重发，请新建会话。');
      const backups = path.join(this.dataDir, 'backups'); fs.mkdirSync(backups, { recursive: true });
      fs.writeFileSync(path.join(backups, r.sessionId + '-' + Date.now() + '.json'), JSON.stringify({ turns, meta }, null, 2));
      await c.request('thread/revert', { threadId: r.sessionId, beforeTurnId: o.rewindTo });
    }
    if (!o.sessionId && o.assembled?.seedTurns.length) {
      await c.request('thread/inject_items', { threadId: r.sessionId, items: seedItems(o.assembled.seedTurns) });
      meta.seeded = true;
    }
    const head = !o.sessionId ? o.assembled?.historyHead || '' : '';
    if (head) meta.heads = [...new Set([...(meta.heads || []), head])];
    this.saveMetadata(r.sessionId, meta);
    if (r.stopped) return r.finish();
    if (o.message.startsWith('/compact')) {
      if (o.message !== '/compact') throw new Error('当前接口不支持 /compact 附加参数，请单独发送 /compact。');
      r.startSettled = true;
      await c.request('thread/compact/start', { threadId: r.sessionId }); return;
    }
    if (o.message === '/context' || o.message === '/cost') {
      r.push({ type: 'notice', message: meta.tokenUsage ? JSON.stringify(meta.tokenUsage, null, 2) : '此会话还没有可用的 token 用量。订阅额度请打开用量面板。' }); return r.finish();
    }
    let message = o.message === '/init' ? '请分析当前项目并创建或更新 AGENTS.md，写清项目结构、开发命令和验证方式。' : o.message;
    if (head) message = head + '\n\n' + message;
    const files = o.attachments.filter(a => !/\.(png|jpe?g|webp|gif)$/i.test(a.path));
    if (files.length) message += '\n\n📎 用户上传的文件：\n' + files.map(a => '- ' + a.name + ': ' + a.path).join('\n');
    const input = [{ type: 'text', text: message }, ...o.attachments.filter(a => /\.(png|jpe?g|webp|gif)$/i.test(a.path)).map(a => ({ type: 'localImage', path: a.path }))];
    const turn = await c.request('turn/start', { threadId: r.sessionId, input, ...(o.effort ? { effort: o.effort } : {}) });
    r.turnId = turn.turn.id;
    meta.turns ||= {}; meta.turns[r.turnId] = { text: o.message, files };
    this.saveMetadata(r.sessionId, meta); r.startSettled = true;
    if (r.stopped) await this.stop(r);
    if (r.completed) r.finish();
  }
  async stop(r) {
    if (!r || r.done) return;
    r.stopped = true;
    if (!r.turnId) return;
    try { await r.client.request('turn/interrupt', { threadId: r.sessionId, turnId: r.turnId }, 5000); }
    catch { r.finish(); }
    const timer = setTimeout(() => r.finish(), 5000); timer.unref();
  }
  respond(runId, requestId, answer) {
    const r = this.find(runId), request = r?.approvals.get(requestId);
    if (!r || r.done || !request) throw new Error('这个请求已结束');
    let result;
    if (request.method === 'item/tool/requestUserInput') {
      result = { answers: {} };
      for (const q of request.params.questions || []) result.answers[q.id] = { answers: [String(answer.answers?.[q.id] || '')] };
    } else if (request.method === 'item/permissions/requestApproval') {
      result = { permissions: answer.accept ? request.params.permissions : {}, scope: 'turn' };
    } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
      result = { decision: answer.accept ? 'accept' : 'decline' };
    } else throw new Error('此类交互暂不支持，请停止任务后在 Codex CLI 中处理：' + request.method);
    r.client.reply(request.id, result); r.approvals.delete(requestId);
    r.push({ type: 'approval_resolved', requestId });
  }
  close() { for (const r of this.runs.values()) r.finish(); this.control?.close(); }
}
const failed = item => ['failed', 'declined'].includes(item.status) || !!item.error || (item.exitCode != null && item.exitCode !== 0);
function toolName(item) { return ({ commandExecution: '执行命令', fileChange: '修改文件', webSearch: '搜索网页', imageView: '查看图片', mcpToolCall: item.tool, dynamicToolCall: item.tool })[item.type] || item.type; }
function toolInput(item) { return item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : item.type === 'fileChange' ? { changes: item.changes } : item.arguments || { query: item.query, path: item.path }; }
function toolOutput(item) { return item.aggregatedOutput ?? item.result ?? item.error?.message ?? (item.changes ? item.changes.map(x => x.path + '\n' + (x.diff || '')).join('\n') : item.status || '已完成'); }
module.exports = { CodexBackend, toolName, toolInput, toolOutput, failed };
