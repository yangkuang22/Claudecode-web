'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
for (const file of ['server.js', 'codex-client.js', 'codex-backend.js', 'presets.js']) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit', windowsHide: true });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
new Function(html.split('<script>')[1].split('</script>')[0]);
console.log('服务端、Codex 接入层和网页脚本语法检查通过。');
