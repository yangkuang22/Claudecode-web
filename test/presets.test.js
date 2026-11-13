const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleFromST, validatePreset } = require('../presets');
test('ST 顺序、禁用条目、Chat History、角色和尾部文本兼容', () => {
  const data = {
    prompts: [
      { identifier: 'system', role: 'system', content: '系统指令' },
      { identifier: 'disabled', role: 'system', content: '不应出现' },
      { identifier: 'answer', role: 'assistant', content: '示例回答' },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'after', role: 'system', content: '尾部说明' },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'disabled', enabled: true }] },
      { character_id: 100001, order: [
        { identifier: 'system', enabled: true }, { identifier: 'disabled', enabled: false },
        { identifier: 'answer', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'after', enabled: true },
      ] },
    ],
  };
  validatePreset(data);
  assert.deepEqual(assembleFromST(data), { systemField: '系统指令', seedTurns: [{ role: 'assistant', content: '示例回答' }], historyHead: '尾部说明' });
});
test('非法角色及错误预设结构给出错误', () => {
  assert.throws(() => validatePreset({}));
  assert.throws(() => validatePreset({ prompts: [{ identifier: 'bad', role: 'tool' }], prompt_order: [] }));
});
