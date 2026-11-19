/* P21：城市轮廓（用户 2026-11-12「刚选一个城市，先看下整个城市的轮廓和范围，城市边缘最好加个边框」）。
   覆盖：① amap.js 轮廓解析/抽稀 ② GET /api/city/boundary 契约与缓存（行政区查询有日配额）
   ③ 拿不到时必须如实报错（前端才能退回主城区路径），而不是静默画一张空图。 */
const test = require('node:test');
const assert = require('node:assert');

const amap = require('../server/amap');
const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};

const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
];

const RING = [
  [118.34, 29.19],
  [120.72, 29.19],
  [120.72, 30.56],
  [118.34, 29.19],
];

function boundary(overrides = {}) {
  return {
    name: '杭州市',
    adcode: '330100',
    center: [120.209903, 30.246566],
    bbox: [118.344933, 29.188757, 120.721945, 30.563114],
    rings: [RING],
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: opts.amap || { async cityBoundary() { return boundary(); } },
    collectIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    db,
    close: () =>
      new Promise((resolve) =>
        app.server.close(() => {
          if (!opts.db) db.close();
          resolve();
        })
      ),
  };
}

async function getJson(base, p) {
  const res = await fetch(base + p);
  const body = await res.json();
  return { status: res.status, body, data: body.data };
}

// ---------- ① 轮廓解析与抽稀 ----------

test('parseDistrictRings：多段（岛屿/飞地）用 | 分隔，坏点和不足三点的段丢掉', () => {
  const svg =
    '120.0,30.0;120.1,30.0;120.1,30.1;120.0,30.0|121.0,31.0;121.1,31.0;121.1,31.1|bad;120.2,30.2';
  const rings = amap.parseDistrictRings(svg);
  assert.strictEqual(rings.length, 2, '坏点组成的第三段应被丢弃');
  assert.strictEqual(rings[0].length, 4);
  assert.deepStrictEqual(amap.parseDistrictRings(''), []);
});

test('thinRing：密点变疏点，且首尾闭合、保留点之间的步长不退回密点', () => {
  const dense = [];
  for (let i = 0; i < 200; i += 1) dense.push([120 + i * 0.001, 30 + i * 0.001]);
  const thin = amap.thinRing(dense);
  assert.ok(thin.length <= dense.length / 2 + 2, '抽稀要真的变少：' + dense.length + ' → ' + thin.length);
  assert.deepStrictEqual(thin[0], dense[0], '起点要保留');
  assert.deepStrictEqual(thin[thin.length - 1], dense[0], '轮廓要闭合');
  for (let i = 1; i < thin.length - 1; i += 1) {
    const step = Math.max(Math.abs(thin[i][0] - thin[i - 1][0]), Math.abs(thin[i][1] - thin[i - 1][1]));
    assert.ok(step >= 0.0015, '保留的点之间步长要合并到抽稀粒度以上，实际 ' + step);
  }
  assert.strictEqual(amap.thinRing([[1, 1], [2, 2], [3, 3]]).length, 3, '刚好 3 点不动它');
});

test('capRing：超过上限就等距取点，末尾一定保留', () => {
  const ring = [];
  for (let i = 0; i < 5000; i += 1) ring.push([120 + i * 0.0001, 30]);
  const capped = amap.capRing(ring, 1200);
  assert.ok(capped.length <= 1201, '取点后不超过上限（可能 +1 个末尾点），实际 ' + capped.length);
  assert.deepStrictEqual(capped[capped.length - 1], ring[ring.length - 1], '末尾点要保留');
  assert.strictEqual(amap.capRing(ring, 9000), ring, '没超上限原样返回');
});

// ---------- ② 接口契约与缓存 ----------

test('GET /api/city/boundary：返回轮廓与外接矩形，第二次走缓存不再打高德', async () => {
  const calls = { n: 0 };
  const ctx = await start({
    amap: {
      async cityBoundary(city) {
        calls.n += 1;
        return boundary({ name: city + '市' });
      },
    },
  });
  const first = await getJson(ctx.base, '/api/city/boundary?city=' + encodeURIComponent('杭州'));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.data.name, '杭州市');
  assert.deepStrictEqual(first.data.bbox, [118.344933, 29.188757, 120.721945, 30.563114]);
  assert.strictEqual(first.data.rings.length, 1);
  assert.deepStrictEqual(first.data.rings[0].slice(0, 2), RING.slice(0, 2));
  assert.strictEqual(calls.n, 1);

  const second = await getJson(ctx.base, '/api/city/boundary?city=' + encodeURIComponent('杭州'));
  assert.strictEqual(calls.n, 1, '半年内只拉一次（高德行政区查询有日配额）');
  assert.strictEqual(second.data.cached, true, '缓存回执要标明 cached');

  // 库里真的落了一行
  assert.ok(ctx.db.getCityBoundary('杭州'), '应写入 city_boundaries');
  await ctx.close();
});

test('GET /api/city/boundary：缺 city 参数 → 400', async () => {
  const ctx = await start();
  const r = await getJson(ctx.base, '/api/city/boundary');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error.code, 'BAD_REQUEST');
  await ctx.close();
});

test('GET /api/city/boundary：高德挂掉但有旧缓存 ⇒ 用旧的降级返回', async () => {
  const db = createDb(':memory:');
  db.saveCityBoundary('辽阳', { ...boundary({ name: '辽阳市' }), fetchedAt: '2025-01-01T00:00:00.000Z' });
  const ctx = await start({
    db,
    amap: {
      async cityBoundary() {
        throw new Error('高德错误：DAILY_QUERY_OVER_LIMIT');
      },
    },
  });
  const r = await getJson(ctx.base, '/api/city/boundary?city=' + encodeURIComponent('辽阳'));
  assert.strictEqual(r.status, 200, '过期缓存 + 上游失败 ⇒ 降级返回旧轮廓');
  assert.strictEqual(r.data.name, '辽阳市');
  await ctx.close();
});

test('GET /api/city/boundary：没有缓存且高德失败 ⇒ 502 BOUNDARY_UNAVAILABLE（前端据此退回主城区）', async () => {
  const ctx = await start({
    amap: {
      async cityBoundary() {
        throw new Error('高德错误：DAILY_QUERY_OVER_LIMIT');
      },
    },
  });
  const r = await getJson(ctx.base, '/api/city/boundary?city=' + encodeURIComponent('杭州'));
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.error.code, 'BOUNDARY_UNAVAILABLE');
  await ctx.close();
});

test('db：rings 为空的缓存行当作没缓存（宁可重拉，也不画一张空图）', async () => {
  const db = createDb(':memory:');
  db.saveCityBoundary('杭州', { name: '杭州市', bbox: [1, 2, 3, 4], rings: [], fetchedAt: new Date().toISOString() });
  assert.strictEqual(db.getCityBoundary('杭州'), null);
  db.close();
});
