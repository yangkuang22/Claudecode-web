#!/usr/bin/env node
// Codex 子代理：零依赖的 MCP 服务（stdio，JSON-RPC 一行一条），由 claude-web 用 --mcp-config 挂给 Claude。
// Claude 当主模型，把子任务通过 codex_task 交给 Codex（GPT 模型）去做，Codex 用的是 ChatGPT 订阅额度，不占 Claude 额度。
//
// GPT 的 sol 系列模型默认思考强度 low、输出详细度 low，直接丢一句话过去效果很差。
// 这里不把 Claude 写的内容原样转发，而是套进固定的任务书模板（角色 / 任务 / 背景 / 约束 / 完成标准 / 汇报格式），
// 并显式设置思考强度和详细度。预设只影响 Claude，不影响这里。
//
// 环境变量（claude-web 设置）：
//   CODEX_BIN         codex 可执行文件或 codex.js（.js 用 node 跑）
//   CODEX_MODEL       模型，如 gpt-6.2-sol
//   CODEX_EFFORT      默认思考强度 low / medium / high / xhigh
//   CODEX_HOME        Codex 账号目录（不设 = ~/.codex）
//   CODEX_WRITE       0 = 只允许只读（Claude 处于 plan 模式时）
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL = process.env.CODEX_MODEL || 'gpt-6.2-sol';
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const DEF_EFFORT = EFFORTS.includes(process.env.CODEX_EFFORT) ? process.env.CODEX_EFFORT : 'high';
const WRITE_OK = process.env.CODEX_WRITE !== '0';
const MAX_OUT = 24000; // 返回给 Claude 的最大字符数，太长会占 Claude 的上下文

function codexCmd() {
  const b = process.env.CODEX_BIN || 'codex';
  return /\.js$/i.test(b) ? [process.execPath, [b]] : [b, []];
}

// ---------- 任务书模板 ----------
function brief({ task, context, files, done_criteria, mode }) {
  const write = mode === 'write' && WRITE_OK;
  const L = [];
  L.push('# Role');
  L.push('You are a senior software engineer working as a delegated sub-agent for a lead agent. '
    + 'The lead cannot see your intermediate steps and has no way to answer questions: work autonomously and finish the job. '
    + 'Only your final message is returned to the lead.');
  L.push('', '# Task', String(task).trim());
  L.push('', '# Context', `Working directory: ${process.cwd()}`);
  if (context && String(context).trim()) L.push(String(context).trim());
  if (Array.isArray(files) && files.length) L.push('', 'Start from these files (read them first):', ...files.map((f) => '- ' + f));
  L.push('', '# Constraints');
  if (write) {
    L.push('- You MAY create and edit files inside the working directory. Keep changes minimal and focused on the task.');
    L.push('- Do not touch files unrelated to the task. Do not reformat or refactor code you were not asked to change.');
    L.push('- Do not run destructive commands (deleting data, git reset/checkout of others\' changes, force pushes). Do not commit or push.');
  } else {
    L.push('- READ-ONLY: do NOT create, edit or delete any files. Investigate and report only.');
  }
  L.push('- Ground every claim in what you actually read or ran. Do not guess file contents, APIs or behaviour; open the file or run the command.');
  L.push('- If something is ambiguous, choose the most reasonable interpretation, state the assumption, and continue.');
  L.push('- Be thorough: check edge cases and callers, not just the first match.');
  L.push('', '# Definition of done');
  L.push(done_criteria && String(done_criteria).trim() ? String(done_criteria).trim()
    : (write ? 'The requested change is implemented and verified (build / tests / a quick run where possible).'
      : 'The question is fully answered with evidence (file paths and line numbers).'));
  L.push('', '# Final message format (this is ALL the lead will see)');
  L.push('1. **Status**: DONE / PARTIAL / BLOCKED — one line.');
  L.push('2. **Result**: the answer or what you changed. Be concrete: file paths with line numbers, function names, exact values.');
  if (write) L.push('3. **Files changed**: list each file with a one-line description of the change.');
  L.push(`${write ? 4 : 3}. **Verification**: commands you ran and their outcome, or why verification was not possible.`);
  L.push(`${write ? 5 : 4}. **Assumptions / open issues**: anything the lead should double-check.`);
  L.push('Dense and factual. No greetings, no restating the task. Answer in the same language the task is written in.');
  return L.join('\n');
}

// ---------- 运行 codex exec ----------
const running = new Map(); // JSON-RPC id -> child
function runCodex(rpcId, { prompt, threadId, effort, write }, onProgress) {
  return new Promise((resolve) => {
    const [cmd, pre] = codexCmd();
    const outFile = path.join(os.tmpdir(), `codex-last-${process.pid}-${Date.now()}.txt`);
    const common = ['--json', '--skip-git-repo-check', '-m', MODEL,
      '-c', `model_reasoning_effort="${effort}"`, '-c', 'model_verbosity="medium"', '-o', outFile];
    const args = threadId
      ? [...pre, 'exec', 'resume', ...common, threadId, '-']
      : [...pre, 'exec', ...common, '-s', write ? 'workspace-write' : 'read-only', '-C', process.cwd(), '-'];
    let child;
    try { child = spawn(cmd, args, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return resolve({ error: '启动 codex 失败：' + e.message }); }
    running.set(rpcId, child);
    const st = { thread: threadId || '', messages: [], commands: [], files: new Set(), errors: [], usage: null };
    let buf = '', err = '';
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (e.type === 'thread.started' && e.thread_id) st.thread = e.thread_id;
        else if (e.type === 'turn.completed') st.usage = e.usage || null;
        else if (e.type === 'turn.failed' || e.type === 'error') st.errors.push((e.error && e.error.message) || e.message || JSON.stringify(e).slice(0, 300));
        const it = e.item;
        if (!it || e.type !== 'item.completed') {
          if (it && e.type === 'item.started' && it.type === 'command_execution') onProgress('运行命令：' + String(it.command || '').slice(0, 120));
          continue;
        }
        if (it.type === 'agent_message' && it.text) { st.messages.push(it.text); onProgress(it.text.slice(0, 160)); }
        else if (it.type === 'command_execution') st.commands.push({ cmd: String(it.command || ''), code: it.exit_code });
        else if (it.type === 'file_change' && Array.isArray(it.changes)) for (const c of it.changes) st.files.add(`${c.kind || 'update'} ${c.path}`);
        else if (it.type === 'error' && it.message) st.errors.push(it.message);
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { st.errors.push(String(e.message || e)); });
    child.on('close', (code) => {
      running.delete(rpcId);
      let last = '';
      try { last = fs.readFileSync(outFile, 'utf8').trim(); fs.rmSync(outFile, { force: true }); } catch {}
      if (!last) last = st.messages[st.messages.length - 1] || '';
      resolve({ code, last, st, stderr: err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function report(r, write) {
  if (r.error) return { text: r.error, isError: true };
  const { st } = r;
  const parts = [];
  parts.push(r.last || '(Codex 没有给出最终回复)');
  const meta = [];
  meta.push(`thread_id: ${st.thread || '(无)'}  ← 追问或让它接着改时，用 codex_continue 传这个 id`);
  meta.push(`model: ${MODEL} · mode: ${write ? 'write' : 'read-only'}`);
  if (st.files.size) meta.push('files changed (from Codex events):\n' + [...st.files].map((f) => '  - ' + f).join('\n'));
  if (st.commands.length) {
    const shown = st.commands.slice(-15).map((c) => `  - [${c.code == null ? '?' : c.code}] ${c.cmd.replace(/\s+/g, ' ').slice(0, 160)}`);
    meta.push(`commands run: ${st.commands.length}${st.commands.length > 15 ? '（只列最后 15 条）' : ''}\n` + shown.join('\n'));
  }
  if (st.usage) meta.push(`codex tokens: in ${st.usage.input_tokens || 0} (cached ${st.usage.cached_input_tokens || 0}) · out ${st.usage.output_tokens || 0}`);
  if (st.errors.length) meta.push('errors:\n' + st.errors.map((e) => '  - ' + e).join('\n'));
  if (r.code && !r.last) meta.push(`codex 退出码 ${r.code}。stderr 末尾：\n${r.stderr.trim().slice(-1500)}`);
  let text = parts.join('\n') + '\n\n---\n' + meta.join('\n');
  if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + `\n…（截断，原文 ${text.length} 字符）`;
  return { text, isError: !!(r.code && !r.last) };
}

// ---------- MCP ----------
const TOOLS = [
  {
    name: 'codex_task',
    description: `Delegate a self-contained sub-task to a Codex sub-agent (OpenAI ${MODEL}). It runs autonomously in the current working directory with its own tools (shell, file reading${WRITE_OK ? ', file editing' : ''}) and returns a final report. `
      + 'Use it instead of doing large amounts of exploration, implementation or verification yourself: codebase-wide searches, reading many files, implementing a well-specified change, running and debugging tests, independent review / second opinion. '
      + 'The sub-agent CANNOT see this conversation: put everything it needs into the arguments. It cannot ask you questions. '
      + 'Calls take from ~20 seconds to many minutes. Verify key claims in its report before relying on them.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, stated as a concrete goal. One task per call.' },
        context: { type: 'string', description: 'Background the sub-agent needs: what the user wants, relevant decisions, what you already know or tried, conventions to follow.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths of the most relevant files or directories to start from.' },
        done_criteria: { type: 'string', description: 'How to tell the task is finished (e.g. "tests in foo_test.py pass", "list every caller with file:line").' },
        mode: { type: 'string', enum: ['read', 'write'], description: '"read" = investigate only, no file changes (default). "write" = may edit files in the working directory.' },
        effort: { type: 'string', enum: EFFORTS, description: `Reasoning effort. Default ${DEF_EFFORT}. Use xhigh for hard debugging or design; low only for trivial lookups.` },
      },
      required: ['task'],
    },
  },
  {
    name: 'codex_continue',
    description: 'Send a follow-up message to an earlier Codex sub-agent thread (it keeps its own memory of that thread). Use for corrections, follow-up questions, or "now also do X". Pass the thread_id from a previous codex_task / codex_continue result.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'thread_id returned by a previous call.' },
        message: { type: 'string', description: 'The follow-up instruction or question. Be specific.' },
        effort: { type: 'string', enum: EFFORTS, description: `Reasoning effort. Default ${DEF_EFFORT}.` },
      },
      required: ['thread_id', 'message'],
    },
  },
];

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(id, params) {
  const a = params.arguments || {};
  const token = params._meta && params._meta.progressToken;
  let n = 0;
  const progress = (msg) => { if (token != null) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: msg } }); };
  const effort = EFFORTS.includes(a.effort) ? a.effort : DEF_EFFORT;
  let r, write;
  if (params.name === 'codex_task') {
    if (!a.task || !String(a.task).trim()) return reply(id, { content: [{ type: 'text', text: 'task 不能为空' }], isError: true });
    write = a.mode === 'write' && WRITE_OK;
    if (a.mode === 'write' && !WRITE_OK) progress('当前是只读模式（plan），Codex 不能改文件');
    r = await runCodex(id, { prompt: brief(a), effort, write }, progress);
    if (a.mode === 'write' && !WRITE_OK) r.last = '（注意：当前权限模式只读，Codex 以只读方式运行，没有修改文件）\n\n' + (r.last || '');
  } else if (params.name === 'codex_continue') {
    if (!/^[\w-]{8,}$/.test(a.thread_id || '')) return reply(id, { content: [{ type: 'text', text: 'thread_id 无效' }], isError: true });
    write = WRITE_OK;
    r = await runCodex(id, { prompt: String(a.message || ''), threadId: a.thread_id, effort, write }, progress);
  } else return fail(id, -32602, 'unknown tool: ' + params.name);
  const out = report(r, write);
  reply(id, { content: [{ type: 'text', text: out.text }], isError: out.isError });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.method === 'initialize') {
      reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-subagent', version: '1.0.0' } });
    } else if (m.method === 'tools/list') reply(m.id, { tools: TOOLS });
    else if (m.method === 'tools/call') callTool(m.id, m.params || {}).catch((e) => reply(m.id, { content: [{ type: 'text', text: '出错：' + e.message }], isError: true }));
    else if (m.method === 'ping') reply(m.id, {});
    else if (m.method === 'notifications/cancelled') { const c = running.get(m.params && m.params.requestId); if (c) killTree(c); }
    else if (m.id !== undefined && m.method) fail(m.id, -32601, 'method not found');
  }
});
function killTree(c) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  else try { c.kill('SIGTERM'); } catch {}
}
// Claude 退出（stdin 关闭）时把还在跑的 codex 一起结束
process.stdin.on('end', () => { for (const c of running.values()) killTree(c); setTimeout(() => process.exit(0), 500); });
