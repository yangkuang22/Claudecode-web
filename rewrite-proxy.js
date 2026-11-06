#!/usr/bin/env node
// 重写代理：拦截 Claude CLI → Anthropic API 的请求
// 精确移除身份行和非必要 system-reminders，保留全部工具能力
//
// 用法：
//   node rewrite-proxy.js &
//   ANTHROPIC_BASE_URL=http://127.0.0.1:9877 node server.js

const http = require('http');
const https = require('https');

const PROXY_PORT = parseInt(process.argv[2] || '9877', 10);
const REAL_API = 'api.anthropic.com';

// ===== 清理级别（从保守到激进，按需开关） =====
const STRIP_IDENTITY    = true;   // 移除 "You are Claude Code..." 身份行
const STRIP_AGENTS      = true;   // 移除 "Available agent types" reminder (3700+字)
const STRIP_SKILLS      = true;   // 移除 "skills are available" reminder (8000+字)
const STRIP_DEFERRED    = true;   // 移除 deferred tools 列表
const STRIP_MCP         = true;   // 移除 MCP server instructions
// 以下保留（功能相关）：
// - Environment（工作目录、平台）
// - 模型名称
// - 日期
// - 用户邮箱上下文
// - Git attribution
// - Token 计数

const LOG = true;

// ===== system prompt 清理 =====
function cleanSystem(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.filter(b => {
    if (!b || b.type !== 'text') return true;
    if (STRIP_IDENTITY && /^You are Claude Code/.test((b.text || '').trim())) return false;
    return true;
  });
}

// ===== user message 清理：移除指定类型的 system-reminder blocks =====
function shouldStripReminder(text) {
  if (STRIP_AGENTS && /Available agent types for the Agent tool/.test(text)) return true;
  if (STRIP_SKILLS && /following skills are available/.test(text)) return true;
  if (STRIP_DEFERRED && /deferred tools are now available/.test(text)) return true;
  if (STRIP_DEFERRED && /deferred tools are no longer available/.test(text)) return true;
  if (STRIP_MCP && /MCP Server Instructions/.test(text)) return true;
  if (STRIP_MCP && /MCP servers have disconnected/.test(text)) return true;
  // task reminder 也可以去掉（非必要）
  if (/task tools haven't been used recently/.test(text)) return true;
  return false;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (msg.role !== 'user') return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    const filtered = content.filter(block => {
      if (!block || block.type !== 'text') return true;
      const text = (block.text || '').trim();
      if (!text.startsWith('<system-reminder>')) return true;
      return !shouldStripReminder(text);
    });

    return { ...msg, content: filtered.length > 0 ? filtered : [{ type: 'text', text: '继续。' }] };
  });
}

function logRequest(body) {
  if (!LOG) return;
  const sys = body.system || [];
  const msgs = body.messages || [];
  const tools = body.tools || [];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`system: ${sys.length}块  tools: ${tools.length}个  messages: ${msgs.length}条`);
  if (Array.isArray(sys)) {
    sys.forEach((b, i) => {
      const t = (b.text || '').slice(0, 100).replace(/\n/g, '\\n');
      console.log(`  sys[${i}] (${(b.text||'').length}字) ${t}...`);
    });
  }
  msgs.forEach((m, i) => {
    const c = m.content;
    if (Array.isArray(c)) {
      const lens = c.map(b => (b.text||'').length);
      const total = lens.reduce((a,b)=>a+b, 0);
      console.log(`  msg[${i}] ${m.role} ${c.length}块 ${total}字`);
      c.forEach((b, j) => {
        const t = (b.text||'').slice(0, 80).replace(/\n/g, '\\n');
        console.log(`    [${j}] (${(b.text||'').length}字) ${t}...`);
      });
    } else {
      console.log(`  msg[${i}] ${m.role} ${(c||'').length}字`);
    }
  });
  console.log('='.repeat(60));
}

const server = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let bodyBuf = Buffer.concat(chunks);

    // 只重写 /v1/messages POST
    if (req.url === '/v1/messages' && req.method === 'POST') {
      try {
        const body = JSON.parse(bodyBuf.toString());
        body.system = cleanSystem(body.system);
        body.messages = cleanMessages(body.messages);
        logRequest(body);
        bodyBuf = Buffer.from(JSON.stringify(body));
      } catch (e) {
        console.error('解析失败:', e.message);
      }
    }

    // 透传到真实 API
    const headers = { ...req.headers };
    delete headers.host;
    headers['content-length'] = bodyBuf.length;

    const proxy = https.request({
      hostname: REAL_API,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxy.on('error', e => {
      console.error('代理错误:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    });

    proxy.end(bodyBuf);
  });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`\n🔧 重写代理: http://127.0.0.1:${PROXY_PORT} → https://${REAL_API}`);
  console.log(`   移除身份行: ${STRIP_IDENTITY}`);
  console.log(`   移除agents列表: ${STRIP_AGENTS}`);
  console.log(`   移除skills列表: ${STRIP_SKILLS}`);
  console.log(`   移除deferred tools: ${STRIP_DEFERRED}`);
  console.log(`   移除MCP instructions: ${STRIP_MCP}`);
  console.log(`   tools参数: 不动（全部工具保留）`);
  console.log(`\n用法: ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT} node server.js\n`);
});
