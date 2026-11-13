'use strict';
function pickOrder(d) {
  const po = (d && Array.isArray(d.prompt_order)) ? d.prompt_order : [];
  const o = po.find((x) => x && x.character_id === 100001) || po[0];
  return (o && Array.isArray(o.order)) ? o.order : [];
}
function assembleFromST(d) {
  const byId = Object.create(null); for (const p of (d.prompts || [])) byId[p.identifier] = p;
  const order = pickOrder(d);
  const sys = [], turns = [];
  let buf = '', leading = true;
  const pushAssistant = (c) => {
    if (buf.trim()) { turns.push({ role: 'user', content: buf.trim() }); buf = ''; turns.push({ role: 'assistant', content: c }); }
    else if (turns.length && turns[turns.length - 1].role === 'assistant') turns[turns.length - 1].content += '\n\n' + c; // 连续 assistant 合并成一条
    else turns.push({ role: 'assistant', content: c }); // Codex 支持直接注入 assistant，不补造 user。
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
  // 保持原项目的装配语义，不在每轮用户消息后重复附加预设。
  return { systemField: sys.join('\n\n'), seedTurns: turns, historyHead: buf.trim() };
}
function validatePreset(data) {
  if (!data || !Array.isArray(data.prompts) || !Array.isArray(data.prompt_order)) throw new Error('需要 ST 格式的 prompts 和 prompt_order 数组');
  for (const p of data.prompts) {
    if (!p || typeof p.identifier !== 'string' || (p.content != null && typeof p.content !== 'string') || (p.role && !['system', 'user', 'assistant'].includes(p.role))) throw new Error('预设条目格式无效');
  }
  for (const p of data.prompt_order) if (!p || !Array.isArray(p.order) || p.order.some(x => !x || typeof x.identifier !== 'string')) throw new Error('预设排序格式无效');
}
module.exports = { assembleFromST, validatePreset };
