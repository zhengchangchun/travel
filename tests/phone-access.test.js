/* 手机访问（2026-11-24 用户「手机也能用」）
   ① 服务默认管理局域网：只听 127.0.0.1 的手机永远打不开，所以默认值是 0.0.0.0，
      并且启动日志里要把地址打出来（这里只钉源码意图与默认值，不真起服务）
   ② GET /api/phone：把私网 IPv4 挑出来给页面用；回环/公网不算，虚拟网卡排在真网卡后面
   ③ web/js/qr.js：页面现画的二维码。Node 里没解码器，所以用「矩阵哈希」当金标 ——
      这两个哈希是拿 opencv 的 QRCodeDetector 解过、确认能解出原文之后冻下来的，
      一旦编码器被改坏（掩码/格式信息/纠错码），哈希立刻对不上。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
const PHONE = fs.readFileSync(path.join(ROOT, 'server/routes/phone.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'web/settings.html'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'web/js/settings.js'), 'utf8');

const phoneRoutes = require('../server/routes/phone');
const QR = require('../web/js/qr.js');

const hash = (rows) => crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);

test('服务默认管理局域网，启动日志给出手机能开的地址', () => {
  assert.match(INDEX, /const host = process\.env\.HOST \|\| '0\.0\.0\.0'/, '默认值应是 0.0.0.0');
  assert.match(INDEX, /HOST=127\.0\.0\.1/, '要告诉用户怎么关掉（只想本机用）');
  assert.match(INDEX, /手机也能开/, '启动日志里要有手机能开的提示');
  assert.match(INDEX, /lanAddresses\(port\)/, '启动日志地址要与 /api/phone 同源');
});

test('/api/phone：挑私网 IPv4，回环与公网不算', () => {
  assert.equal(phoneRoutes.length, 1);
  assert.equal(phoneRoutes[0].path, '/api/phone');
  const list = phoneRoutes.lanAddresses(8787);
  assert.ok(Array.isArray(list));
  list.forEach((row) => {
    assert.match(row.ip, /^(\d{1,3}\.){3}\d{1,3}$/, '只能是 IPv4');
    assert.ok(
      row.ip.startsWith('192.168.') || row.ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(row.ip),
      '只能是私网地址，免得把公网/回环地址发给用户：' + row.ip
    );
    assert.equal(row.url, `http://${row.ip}:8787`);
  });
  // 真网卡要排在 VPN/虚拟网卡前面
  const ranks = list.map((r) => (/^(en|eth)\d+$/i.test(r.iface) ? 0 : /^(bridge|vmnet|docker|utun|tun)/i.test(r.iface) ? 2 : 1));
  const sorted = ranks.slice().sort((a, b) => a - b);
  assert.deepEqual(ranks, sorted, '网卡顺序应先真后虚');
});

test('/api/phone：只听本机时照实说，不假装手机能连', () => {
  assert.match(PHONE, /lanOpen/, '要有 lanOpen 这个字段');
  assert.match(PHONE, /host !== '127\.0\.0\.1' && host !== 'localhost'/, 'lanOpen 的判据');
  assert.match(SETTINGS_JS, /只本机/, '页面上要有「只本机模式」的说法');
});

test('设置页有「手机也能用」卡：地址 + 现画的二维码 + 复制', () => {
  assert.match(SETTINGS, /id="phone-card"/);
  assert.match(SETTINGS, /id="phone-url"/);
  assert.match(SETTINGS, /id="phone-qr"/);
  assert.match(SETTINGS, /id="phone-copy"/);
  assert.match(SETTINGS, /\/js\/qr\.js/, '要引本地的二维码编码器（不连外部服务）');
  assert.match(SETTINGS_JS, /\/api\/phone/, '页面要自己去取地址');
  assert.match(SETTINGS_JS, /window\.TravelQR\.toSvg/, '用本地二维码画出来');
  assert.match(SETTINGS_JS, /navigator\.clipboard\.writeText/, '要能一键复制地址');
});

test('二维码编码器：金标矩阵（已用 opencv 解过）', () => {
  const cases = [
    { text: 'http://192.168.31.213:8787', version: 2, mask: 2, size: 25, hash: '1b92449d2e743aa4' },
    { text: 'A', version: 1, mask: 2, size: 21, hash: '1df28de52a4a3bd0' },
  ];
  cases.forEach((c) => {
    const qr = QR.encode(c.text);
    assert.ok(qr, c.text + ' 应该编得出来');
    assert.equal(qr.version, c.version);
    assert.equal(qr.mask, c.mask);
    assert.equal(qr.size, c.size);
    assert.equal(hash(qr.modules.map((r) => r.join(''))), c.hash, '矩阵变了 —— 掩码/格式信息/纠错码被改坏了？');
  });
});

test('二维码编码器：够用就行，超了就说编不出来', () => {
  assert.ok(QR.encode('x'.repeat(106)), '106 字节要能编（版本 6 的上限）');
  assert.equal(QR.encode('x'.repeat(107)), null, '107 字节应返回 null，让页面退化成「手动输」');
  const svg = QR.toSvg(QR.encode('http://127.0.0.1:8787'), { quiet: 4 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /shape-rendering="crispEdges"/, '得是硬边，不然扫码会糊');
  assert.match(svg, /viewBox="0 0 33 33"/, '25 + 4×2 的静区');
});
