/* 别把 key 提交进仓（2026-11-20 加）：
   推送 GitHub 前实测发现 docs/evidence/diagnostics/amap-click-poi.cjs 里写死了真 key ⇒ 已清掉。
   这条测试守住它：仓里任何「会被提交的文件」都不许出现 config/local.json 里的那几个 key 值。
   config/local.json 本身在 .gitignore 里（不进仓），没有它时这条跳过。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, 'config', 'local.json');

function trackedFiles() {
  const out = execFileSync('/usr/bin/git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'buffer' });
  return out.toString('utf8').split('\0').filter(Boolean);
}

test('仓里不许出现 config/local.json 里的任何 key（写死的 key 一律挡在提交之前）', (t) => {
  if (!fs.existsSync(LOCAL)) {
    t.skip('没有 config/local.json（换机器/CI 正常）');
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  const secrets = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node.length >= 12) secrets.push(node);
      return;
    }
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(cfg.amap || {});
  assert.ok(secrets.length >= 2, 'local.json 里至少该有 webServiceKey / jsApiKey');

  const hits = [];
  trackedFiles().forEach((rel) => {
    const full = path.join(ROOT, rel);
    let text = '';
    try {
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) return; // 二进制跳过
      text = buf.toString('utf8');
    } catch (err) {
      return;
    }
    secrets.forEach((s) => {
      if (text.includes(s)) hits.push(rel + ' 含一个 key（' + s.slice(0, 6) + '…）');
    });
  });
  assert.deepEqual(hits, [], '这些文件里写死了 key，改成从 config/local.json 读：\n' + hits.join('\n'));
});

test('本地配置与数据不进仓（.gitignore 兜底）', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /config\/local\.json/, 'key 文件要忽略');
  assert.match(ignore, /data\/\*\.db/, '真库要忽略');
  assert.match(ignore, /^share\/$/m, '分享包要忽略');
  const tracked = trackedFiles();
  assert.ok(!tracked.includes('config/local.json'), 'config/local.json 不该被追踪');
  assert.ok(!tracked.some((f) => /^data\/.*\.db$/.test(f)), '真库不该被追踪');
  assert.ok(!tracked.some((f) => /^share\//.test(f)), '分享包不该被追踪');
});
