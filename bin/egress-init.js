#!/usr/bin/env node
// 出口锁初始化：从 v2rayN 当前用的配置里取出代理节点，生成一份 claude 专用的 xray 配置。
// 这个 xray 只监听 127.0.0.1，只有一个出站（你的节点），没有 direct：节点不通时请求直接失败，不会走本机网络。
//
// 用法: node bin/egress-init.js [--from v2rayN的config.json] [--tag proxy] [--xray xray.exe路径]
//                               [--port 10900] [--expect-ip 1.2.3.4[,5.6.7.8]] [--country US]
// 不给 --expect-ip 时：启动一次 xray，测出当前出口 IP，打印出来让你确认，并写进允许列表。
//
// 生成（都在 ~/.claude-web 或 CLAUDE_WEB_DATA 下，含节点密钥，不进仓库）：
//   egress/xray.exe     复制一份 xray 内核，v2rayN 升级内核时不受影响
//   egress/xray.json    xray 配置
//   egress.json         claude-web 读取的出口锁配置
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const tls = require('tls');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const V2N = 'F:\\v2rayN-windows-64';
const from = arg('from', path.join(V2N, 'binConfigs', 'config.json'));
const tag = arg('tag', 'proxy');
const xraySrc = arg('xray', path.join(V2N, 'bin', 'xray', process.platform === 'win32' ? 'xray.exe' : 'xray'));
const port = parseInt(arg('port', '10900'), 10);
const DATA_DIR = path.resolve(process.env.CLAUDE_WEB_DATA || path.join(os.homedir(), '.claude-web'));
const OUT_DIR = path.join(DATA_DIR, 'egress');
const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

let src;
try { src = JSON.parse(fs.readFileSync(from, 'utf8')); } catch (e) { die(`读不了 ${from}：${e.message}\n    用 --from 指定 v2rayN 正在用的 config.json（v2rayN 目录下 binConfigs\\config.json）`); }
const ob = (src.outbounds || []).find((o) => o.tag === tag);
if (!ob) die(`${from} 里没有 tag 为 "${tag}" 的出站。现有的：${(src.outbounds || []).map((o) => o.tag).join(', ')}`);
if (['freedom', 'blackhole', 'dns'].includes(ob.protocol)) die(`出站 "${tag}" 是 ${ob.protocol}，不是代理节点`);
if (ob.streamSettings && ob.streamSettings.sockopt && ob.streamSettings.sockopt.dialerProxy) {
  die(`出站 "${tag}" 用了 dialerProxy（链式代理），这个脚本暂不处理，请手动编写 xray 配置`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const xrayBin = path.join(OUT_DIR, path.basename(xraySrc));
try { fs.copyFileSync(xraySrc, xrayBin); } catch (e) {
  if (!fs.existsSync(xrayBin)) die(`复制 xray 失败：${e.message}\n    用 --xray 指定 xray 可执行文件`);
  console.log('  ! 复制 xray 失败（可能正在运行），沿用已有的 ' + xrayBin);
}

const cfg = {
  log: { loglevel: 'warning' },
  inbounds: [{
    tag: 'in', listen: '127.0.0.1', port, protocol: 'mixed',
    settings: { auth: 'noauth', udp: false },
  }],
  // 只有节点和黑洞两个出站，没有 direct：节点挂了就是连不上，不会退回本机网络
  outbounds: [{ ...ob, tag: 'proxy' }, { tag: 'block', protocol: 'blackhole' }],
  routing: {
    domainStrategy: 'AsIs', // 域名原样交给节点解析，本机不做 DNS
    rules: [{ type: 'field', network: 'udp', outboundTag: 'block' }, { type: 'field', network: 'tcp', outboundTag: 'proxy' }],
  },
};
const cfgFile = path.join(OUT_DIR, 'xray.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
const proxy = `http://127.0.0.1:${port}`;

// 经代理请求 cloudflare trace，返回 { ip, loc }
function trace() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('超时')), 15000);
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'www.cloudflare.com:443', agent: false });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) { clearTimeout(t); sock.destroy(); return reject(new Error('代理返回 ' + res.statusCode)); }
      const s = tls.connect({ socket: sock, servername: 'www.cloudflare.com' }, () => {
        s.write('GET /cdn-cgi/trace HTTP/1.1\r\nHost: www.cloudflare.com\r\nConnection: close\r\nUser-Agent: curl/8\r\n\r\n');
      });
      let b = ''; s.on('data', (d) => { b += d; });
      s.on('close', () => { clearTimeout(t); resolve({ ip: (b.match(/^ip=(.+)$/m) || [])[1] || '', loc: (b.match(/^loc=(.+)$/m) || [])[1] || '' }); });
      s.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(t); reject(e); });
    req.end();
  });
}

(async () => {
  let expect = (arg('expect-ip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 用一个临时 xray 验证配置能用（端口被占用时直接测已在跑的那个）
  const x = spawn(xrayBin, ['run', '-c', cfgFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let xo = ''; x.stdout.on('data', (d) => { xo += d; }); x.stderr.on('data', (d) => { xo += d; });
  await new Promise((r) => setTimeout(r, 1500));
  let got;
  try { got = await trace(); } catch (e) { x.kill(); die(`经新配置访问失败：${e.message}\n${xo.slice(-1500)}`); }
  x.kill();
  console.log(`\n  经新配置测到的出口：${got.ip}（${got.loc}）`);
  if (!expect.length) {
    expect = [got.ip];
    console.log('  没有给 --expect-ip，已把这个 IP 写进允许列表。请确认它确实是你的家宽 IP！');
  } else if (!expect.includes(got.ip)) {
    console.log(`  ⚠ 和你给的 --expect-ip（${expect.join(', ')}）不一致，网页会拦住所有消息，直到出口对上`);
  }
  const egress = {
    proxy,
    expectIp: expect,
    expectCountry: arg('country', '') ? arg('country').split(',') : [],
    interval: 60,
    disableNonessential: true,
    xray: { bin: xrayBin, config: cfgFile },
  };
  const ef = path.join(DATA_DIR, 'egress.json');
  fs.writeFileSync(ef, JSON.stringify(egress, null, 2) + '\n');
  console.log(`\n  ✓ 已生成\n    ${cfgFile}\n    ${ef}\n\n  重启 claude-web 生效；它会自动拉起这个 xray（代理端口 ${proxy}）并定时检查出口。`);
  console.log('  下一步（可选但强烈建议）：以管理员身份运行 bin\\egress-firewall.bat，让 claude.exe 除了本机代理哪儿都连不了。\n');
})();
