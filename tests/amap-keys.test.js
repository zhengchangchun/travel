/* 多 key 轮换（2026-11-25）
   高德配额是**按 key 按月**算的（个人开发者基础搜索 5000 次/月）。
   一个 key 用尽就换下一个，不用重启、不用改代码。

   口径：
     · 只有「配额类」错误才换 key；参数错 / key 无效换也没用，直接抛
     · 换过的 key 记下来，下次直接从下一个开始，不每次都撞一遍
     · 全部用尽 ⇒ 抛原来的配额错误（调用方照旧能识别）
     · 进程重启后清空（配额是按月的，重启后重试一次是合理的）
*/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const AMAP = read('server/amap.js');
const CONFIG = read('server/config.js');

// ---------- 配置解析 ----------

test('config：单 key 写法照旧能用，自动包成数组', () => {
  const { loadConfig } = require('../server/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config', 'local.json'),
      JSON.stringify({ amap: { webServiceKey: 'only-one' } })
    );
    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.amap.webServiceKey, 'only-one', '老字段仍要有');
    assert.deepStrictEqual(cfg.amap.webServiceKeys, ['only-one'], '要包成数组');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config：多 key 写法（webServiceKeys 数组）', () => {
  const { loadConfig } = require('../server/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config', 'local.json'),
      JSON.stringify({ amap: { webServiceKeys: ['k1', 'k2', 'k3'] } })
    );
    const cfg = loadConfig(dir);
    assert.deepStrictEqual(cfg.amap.webServiceKeys, ['k1', 'k2', 'k3']);
    assert.strictEqual(cfg.amap.webServiceKey, 'k1', '第一个 key 仍叫 webServiceKey（兼容老调用点）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config：两种写法混用时数组优先，单 key 只在不在数组里时补到最前', () => {
  const { loadConfig } = require('../server/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    // 单 key 已在数组里 ⇒ 不重复、顺序按数组
    fs.writeFileSync(
      path.join(dir, 'config', 'local.json'),
      JSON.stringify({ amap: { webServiceKey: 'k2', webServiceKeys: ['k1', 'k2'] } })
    );
    assert.deepStrictEqual(loadConfig(dir).amap.webServiceKeys, ['k1', 'k2'], '数组优先、不重复');

    // 单 key 不在数组里 ⇒ 补到最前（它是老配置，不能丢）
    fs.writeFileSync(
      path.join(dir, 'config', 'local.json'),
      JSON.stringify({ amap: { webServiceKey: 'k0', webServiceKeys: ['k1', 'k2'] } })
    );
    assert.deepStrictEqual(loadConfig(dir).amap.webServiceKeys, ['k0', 'k1', 'k2'], '单 key 补到最前');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config：空 key 被过滤掉（不会拿空串去请求）', () => {
  const { loadConfig } = require('../server/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config', 'local.json'),
      JSON.stringify({ amap: { webServiceKeys: ['k1', '', '  ', 'k2'] } })
    );
    const cfg = loadConfig(dir);
    assert.deepStrictEqual(cfg.amap.webServiceKeys, ['k1', 'k2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 轮换逻辑 ----------

test('isQuotaInfo：只认配额类错误', () => {
  const amap = require('../server/amap');
  ['USER_DAILY_QUERY_OVER_LIMIT', 'DAILY_QUERY_OVER_LIMIT', 'CALL_LIMIT', 'QPS_HAS_EXCEEDED_THE_LIMIT'].forEach(
    (info) => assert.strictEqual(amap.isQuotaInfo(info), true, info + ' 应算配额错误')
  );
  ['INVALID_USER_KEY', 'INVALID_USER_SCODE', 'SERVICE_NOT_AVAILABLE', 'INVALID_PARAMS', ''].forEach((info) =>
    assert.strictEqual(amap.isQuotaInfo(info), false, info + ' 不该算配额错误')
  );
});

test('keyStatus：只给尾号，不泄露完整 key', () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['abcdef123456', 'zzzz99998888'] } });
  const st = amap.keyStatus();
  assert.strictEqual(st.total, 2);
  assert.strictEqual(st.available, 2);
  assert.strictEqual(st.keys[0].tail, '3456');
  assert.ok(!JSON.stringify(st).includes('abcdef123456'), '不能把完整 key 吐出去');
  amap.resetKeyStatus();
});

test('配额用尽时自动换下一个 key（不抛错）', async () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = new URL(url).searchParams.get('key');
    seen.push(key);
    if (key === 'key-A') {
      return { json: async () => ({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10044' }) };
    }
    return { json: async () => ({ status: '1', infocode: '10000', ok: true }) };
  };
  try {
    const json = await amap.amapGet('/v3/place/text', { keywords: '西湖' });
    assert.strictEqual(json.ok, true, '应拿到第二个 key 的结果');
    assert.deepStrictEqual(seen, ['key-A', 'key-B'], '先试 A，用尽后换 B');
    // A 被标记用尽
    const st = amap.keyStatus();
    assert.strictEqual(st.available, 1);
    assert.strictEqual(st.keys.find((k) => k.tail === 'ey-A').exhausted, true);
  } finally {
    globalThis.fetch = realFetch;
    amap.resetKeyStatus();
  }
});

test('换过的 key 下次直接从下一个开始（不每次都撞一遍）', async () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = new URL(url).searchParams.get('key');
    seen.push(key);
    if (key === 'key-A') {
      return { json: async () => ({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10044' }) };
    }
    return { json: async () => ({ status: '1', infocode: '10000', ok: true }) };
  };
  try {
    await amap.amapGet('/v3/place/text', { keywords: 'a' });
    seen.length = 0;
    await amap.amapGet('/v3/place/text', { keywords: 'b' });
    assert.deepStrictEqual(seen, ['key-B'], '第二次应直接用 B，不再撞 A');
  } finally {
    globalThis.fetch = realFetch;
    amap.resetKeyStatus();
  }
});

test('非配额错误不换 key（参数错换 key 也没用）', async () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(new URL(url).searchParams.get('key'));
    return { json: async () => ({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }) };
  };
  try {
    await assert.rejects(() => amap.amapGet('/v3/place/text', { keywords: 'x' }), /INVALID_USER_KEY/);
    assert.deepStrictEqual(seen, ['key-A'], '只该试一次，不该换 key');
  } finally {
    globalThis.fetch = realFetch;
    amap.resetKeyStatus();
  }
});

test('全部 key 用尽 ⇒ 抛配额错误（调用方照旧能识别）', async () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10044' }),
  });
  try {
    await assert.rejects(() => amap.amapGet('/v3/place/text', { keywords: 'x' }), /USER_DAILY_QUERY_OVER_LIMIT/);
    const st = amap.keyStatus();
    assert.strictEqual(st.available, 0, '两个都该标用尽');
  } finally {
    globalThis.fetch = realFetch;
    amap.resetKeyStatus();
  }
});

test('单 key 时配额用尽直接抛（没有可换的）', async () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['only'] } });
  amap.resetKeyStatus();

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10044' }),
  });
  try {
    await assert.rejects(() => amap.amapGet('/v3/place/text', {}), /USER_DAILY_QUERY_OVER_LIMIT/);
  } finally {
    globalThis.fetch = realFetch;
    amap.resetKeyStatus();
  }
});

test('resetKeyStatus：配额恢复后不用重启', async () => {
  const amap = require('../server/amap');
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  const realFetch = globalThis.fetch;
  let quota = true;
  globalThis.fetch = async (url) => {
    const key = new URL(url).searchParams.get('key');
    if (quota && key === 'key-A') {
      return { json: async () => ({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10044' }) };
    }
    return { json: async () => ({ status: '1', infocode: '10000', ok: true }) };
  };
  try {
    await amap.amapGet('/v3/place/text', {});
    assert.strictEqual(amap.keyStatus().available, 1);
    // 配额恢复
    quota = false;
    amap.resetKeyStatus();
    assert.strictEqual(amap.keyStatus().available, 2, 'reset 后两个都算可用');
  } finally {
    globalThis.fetch = realFetch;
    amap.resetKeyStatus();
  }
});

// ---------- 接线 ----------

test('/api/health 暴露 key 状态（只给尾号）', () => {
  const INDEX = read('server/index.js');
  assert.match(INDEX, /amapKeys:/, 'health 要带 amapKeys');
  assert.match(INDEX, /keyStatus\(\)/, '要调 keyStatus');
});

test('amap.js 里没有把 key 的值写进日志或错误消息', () => {
  const fn = AMAP.match(/async function amapGet\(pathname, params = \{\}\)[\s\S]*?\n\}/);
  assert.ok(fn, '缺 amapGet');
  // 允许出现「key」这个词（拼 URL、说明文字都要用），但不允许把 key 的**值**拼进去：
  // 即不能出现 ${key} / + key + 这类插值
  assert.ok(!/\$\{\s*key\s*\}/.test(fn[0]), '错误消息里不该插值 key');
  assert.ok(!/\+\s*key\s*\+/.test(fn[0]), '错误消息里不该拼 key');
  assert.ok(!/console\.(log|error|warn)\([^)]*\$\{\s*key\s*\}/.test(fn[0]), '日志里不该插值 key');
});
