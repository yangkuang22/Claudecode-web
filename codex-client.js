'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform !== 'win32') return 'codex';
  for (const dir of (process.env.PATH || '').split(path.delimiter).concat(path.join(process.env.APPDATA || '', 'npm'))) {
    for (const ext of ['.exe', '.cmd']) {
      const p = path.join(dir.replace(/"/g, ''), 'codex' + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return 'codex';
}

// npm 的 Windows 启动器用 node 直接运行，避免经过 cmd 的二次参数解释。
function launch(args, options = {}) {
  let bin = findCodex();
  if (process.platform === 'win32' && /\.cmd$/i.test(bin)) {
    const script = path.join(path.dirname(bin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!fs.existsSync(script)) throw new Error('请把 CODEX_BIN 指向 codex.exe，或使用 npm 安装的 Codex。');
    args = [script, ...args]; bin = process.execPath;
  }
  return spawn(bin, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

class CodexClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pending = new Map(); this.sequence = 0; this.closed = false; this.stderr = '';
    this.child = launch(['app-server', ...options.args || []], { cwd: options.cwd || process.cwd(), env: options.env || process.env });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && !msg.method) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpcCode: msg.error.code }));
        else p.resolve(msg.result);
      } else this.emit('message', msg);
    });
    this.child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('error', e => this.fail(new Error('无法启动 Codex：' + e.message)));
    this.child.on('exit', code => { this.fail(new Error('Codex 进程已结束（' + code + '）' + this.stderr.slice(-1000))); this.emit('exit', code); });
    this.ready = this.request('initialize', {
      clientInfo: { name: 'codex_web', title: 'Codex Web', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    }).then(() => this.send({ method: 'initialized', params: {} }));
    // 构造后调用方可能稍后才 await ready。
    this.ready.catch(() => {});
  }
  send(msg) { if (this.closed) throw new Error('Codex 连接已关闭'); this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  request(method, params = {}, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时：' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  reply(id, result) { this.send({ id, result }); }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  close() {
    if (this.closed) return;
    this.closed = true; this.fail(new Error('Codex 连接已关闭')); this.lines.close();
    this.child.stdin.end();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 1500); timer.unref();
  }
}

const PERMISSIONS = {
  workspace: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  readOnly: { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  full: { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' },
};

function seedItems(turns) {
  return turns.map(t => ({ type: 'message', role: t.role, content: [{ type: t.role === 'assistant' ? 'output_text' : 'input_text', text: t.content }] }));
}

module.exports = { CodexClient, PERMISSIONS, seedItems, findCodex };
