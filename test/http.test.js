const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
test('HTTP：页面、跨站拦截、附件、目录、记忆与预设校验', { timeout: 20000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-web-http-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--cwd', temp, '--port', '0', '--no-open'], { windowsHide: true, env: { ...process.env, CODEX_WEB_DATA: path.join(temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('启动超时 ' + log)), 5000);
    app.stdout.on('data', d => { log += d; const m = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
    app.once('error', reject);
  });
  const query = '?' + new URLSearchParams({ cwd: temp });
  try {
    const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /想一起做点什么/);
    assert.equal((await fetch(url + '/api/info', { headers: { Origin: 'http://untrusted.example' } })).status, 403);
    const info = await (await fetch(url + '/api/info' + query)).json(); assert.equal(info.app, 'codex-web');
    const upload = await (await fetch(url + '/api/upload?name=test.txt', { method: 'POST', body: '附件测试' })).json();
    assert.equal(await (await fetch(url + '/api/file?path=' + encodeURIComponent(upload.path))).text(), '附件测试');
    assert.equal((await fetch(url + '/api/file?path=' + encodeURIComponent(path.join(temp, 'secret.txt')))).status, 403);
    const memory = await (await fetch(url + '/api/memory' + query)).json();
    assert.ok(memory.codex.some(c => c.path.endsWith('AGENTS.md')));
    const memPath = path.join(memory.dir, 'note.md');
    const save = await fetch(url + '/api/memfile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: temp, path: memPath, content: '项目记忆', index: '测试说明' }) });
    assert.equal(save.status, 200); assert.match(fs.readFileSync(path.join(memory.dir, 'MEMORY.md'), 'utf8'), /note.md/);
    const bad = await fetch(url + '/api/preset', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'invalid.json', data: {} }) });
    assert.equal(bad.status, 400);
    const prefs = await fetch(url + '/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: '', effort: 'ultra', perm: 'readOnly', preset: 'example.json' }) });
    assert.equal((await prefs.json()).preset, 'example.json');
  } finally {
    app.kill(); await new Promise(resolve => app.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
  }
});
