const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, loadCategories } = require('../server/config');

function tmpConfigDir(localJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cfg-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'config', 'example.json'),
    path.join(dir, 'config', 'example.json')
  );
  if (localJson) {
    fs.writeFileSync(
      path.join(dir, 'config', 'local.json'),
      JSON.stringify(localJson)
    );
  }
  return dir;
}

test('loadConfig 优先读取 config/local.json', () => {
  const dir = tmpConfigDir({
    port: 9999,
    amap: { webServiceKey: 'WKEY', jsApiKey: 'JKEY', jsApiSecurityCode: 'SEC' },
    defaultCity: '上海',
  });
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.port, 9999);
  assert.strictEqual(cfg.amap.webServiceKey, 'WKEY');
  assert.strictEqual(cfg.amap.jsApiKey, 'JKEY');
  assert.strictEqual(cfg.amap.jsApiSecurityCode, 'SEC');
  assert.strictEqual(cfg.defaultCity, '上海');
  assert.strictEqual(cfg.usingExample, false);
});

test('loadConfig 无 local.json 时回退 example.json 并标记 usingExample', () => {
  const dir = tmpConfigDir(null);
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.usingExample, true);
  assert.strictEqual(cfg.defaultCity, '杭州');
});

test('loadConfig 两者都不存在时抛出明确错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cfg-'));
  assert.throws(() => loadConfig(dir), /local\.json/);
});

test('loadConfig 缺 port 时默认 8787', () => {
  const dir = tmpConfigDir({ amap: {}, defaultCity: '杭州' });
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.port, 8787);
});

test('loadCategories 返回 4 条分类且字段完整', () => {
  const cats = loadCategories(path.join(__dirname, '..'));
  assert.strictEqual(cats.length, 4);
  const food = cats.find((c) => c.key === 'food');
  assert.ok(food);
  assert.strictEqual(food.label, '美食');
  assert.strictEqual(food.amapCode, '050000');
  assert.ok(food.color);
  assert.ok(food.icon);
});
