#!/usr/bin/env node
/*
 * T4 自测（mock 高德，不烧配额）：采集器 / 缓存接口 / 评分过滤 / 配额保护 / 二级分片。
 * 逐条打印 PASS/FAIL，全绿 exit 0；供 scripts/smoke.sh 调用。
 */
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const { collectCityCategory } = require('../server/collect');

const STAY = '100000';
const FOOD = '050000';

const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: '' },
  defaultCity: '杭州',
  usingExample: false,
};

function mkPoi(id, typecode, extra = {}) {
  return {
    id,
    name: 'P' + id,
    address: 'addr',
    lng: 120,
    lat: 30,
    typecode,
    category: String(typecode).startsWith('10') ? 'stay' : 'food',
    rating: '4.5',
    photos: ['https://img/1.jpg', 'https://img/2.jpg'],
    tags: ['招牌'],
    ...extra,
  };
}

function fullPage(prefix, typecode) {
  return Array.from({ length: 25 }, (_, k) => mkPoi(`${prefix}-${k}`, typecode));
}

function amapFixture(overrides = {}) {
  const calls = { districts: 0, byDistrict: 0, poiSearch: 0 };
  return {
    calls,
    async districts() {
      calls.districts += 1;
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      calls.byDistrict += 1;
      if (page > 1) return [];
      return [mkPoi('A1', STAY), mkPoi('A2', STAY, { rating: '4.9' })];
    },
    async searchPoi() {
      calls.poiSearch += 1;
      return [];
    },
    ...overrides,
  };
}

async function withApp(deps, fn) {
  const amap = deps.amap || amapFixture();
  const db = deps.db || createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap,
    collectIntervalMs: 0,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = {
    base,
    amap,
    db,
    get: async (p) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json() };
    },
    post: async (p, payload) => {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
  };
  try {
    await fn(api);
  } finally {
    await new Promise((r) => app.server.close(r));
    if (!deps.db) db.close();
  }
}

function seedPoi(db, { id, category = 'stay', rating = null, typecode = '100000', city = '杭州' }) {
  db.upsertPoi({
    poi_id: id,
    city,
    adcode: '330102',
    category,
    name: '店' + id,
    address: 'addr',
    lng: 120.1,
    lat: 30.1,
    typecode,
    rating,
    photos: ['u'],
    tags: [],
    fetched_at: '2026-10-29T00:00:00Z',
  });
}

const CHECKS = [];
function check(id, desc, fn) {
  CHECKS.push({ id, desc, fn });
}

// ---------- 采集器（mock，不烧配额） ----------

check('T4-P42', '分批突破 200：13 区各 200 条 → 该分类入库 > 200', async () => {
  const db = createDb(':memory:');
  const districts = Array.from({ length: 13 }, (_, i) => ({
    name: '区' + i,
    adcode: '3301' + String(i).padStart(2, '0'),
    lng: 120 + i * 0.01,
    lat: 30,
  }));
  const amap = {
    async districts() {
      return districts;
    },
    async searchPoiByDistrict({ adcode, page }) {
      if (page > 8) return [];
      return fullPage(`${adcode}-${page}`, STAY);
    },
    async searchPoiAround() {
      return [];
    },
  };
  const res = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(res.status, 'done');
  const { total } = db.listPois({ city: '杭州', category: 'stay', limit: 1 });
  assert.ok(total > 200, 'total=' + total);
  db.close();
});

check('T4-P43', '分类纯净：混入 050000 餐饮被丢弃，入库 100% 前缀 10', async () => {
  const db = createDb(':memory:');
  const amap = {
    async districts() {
      return [{ name: '西湖区', adcode: '330106', lng: 120.13, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('S1', STAY), mkPoi('F1', FOOD), mkPoi('S2', STAY)];
    },
  };
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const { items } = db.listPois({ city: '杭州', category: 'stay', limit: 100 });
  assert.strictEqual(items.length, 2);
  items.forEach((p) => assert.ok(String(p.typecode).startsWith('10')));
  db.close();
});

check('T4-P44', '去重：同一 poi_id 多区重复 → 只入库 1 条', async () => {
  const db = createDb(':memory:');
  const amap = {
    async districts() {
      return [
        { name: 'A区', adcode: '330101', lng: 120.1, lat: 30.1 },
        { name: 'B区', adcode: '330102', lng: 120.2, lat: 30.2 },
      ];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('DUP', STAY), mkPoi('ONLY-A', STAY)];
    },
  };
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const { items } = db.listPois({ city: '杭州', category: 'stay', limit: 100 });
  assert.strictEqual(items.filter((p) => p.id === 'DUP').length, 1);
  db.close();
});

check('T4-P45', '增量：二次采集同一数据 → n_inserted=0、n_updated>0', async () => {
  const db = createDb(':memory:');
  const amap = {
    async districts() {
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('I1', STAY), mkPoi('I2', STAY)];
    },
  };
  const first = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(first.n_inserted, 2);
  const second = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(second.n_inserted, 0);
  assert.ok(second.n_updated > 0);
  db.close();
});

check('T4-P46', '逐区容错：某区失败 → status=partial、其余区已入库', async () => {
  const db = createDb(':memory:');
  const amap = {
    async districts() {
      return [
        { name: 'A区', adcode: '330101', lng: 120.1, lat: 30.1 },
        { name: 'B区', adcode: '330102', lng: 120.2, lat: 30.2 },
        { name: 'C区', adcode: '330103', lng: 120.3, lat: 30.3 },
      ];
    },
    async searchPoiByDistrict({ adcode, page }) {
      if (adcode === '330102') {
        const e = new Error('DAILY_QUERY_OVER_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      }
      if (page > 1) return [];
      return [mkPoi('P-' + adcode, STAY)];
    },
  };
  const res = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(res.status, 'partial');
  assert.strictEqual(res.districts.filter((d) => d.ok === false).length, 1);
  const { total } = db.listPois({ city: '杭州', category: 'stay', limit: 100 });
  assert.strictEqual(total, 2);
  db.close();
});

check('T4-P53', '二级分片递归：某区永远 200 → 继续缩小半径，最终入库 > 200', async () => {
  const db = createDb(':memory:');
  const radii = [];
  const amap = {
    async districts() {
      return [{ name: '西湖区', adcode: '330106', lng: 120.13, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 8) return [];
      return fullPage(`text-${page}`, STAY);
    },
    async searchPoiAround({ radius, page }) {
      if (page === 1) radii.push(radius);
      if (page > 8) return [];
      return fullPage(`around-${radius}-${page}`, STAY);
    },
  };
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const { total } = db.listPois({ city: '杭州', category: 'stay', limit: 100000 });
  assert.ok(total > 200, 'total=' + total);
  assert.ok(radii.length >= 2, 'radii=' + JSON.stringify(radii));
  assert.ok(radii[0] > radii[radii.length - 1], '半径应递减 ' + JSON.stringify(radii));
  db.close();
});

check('T4-P57', '图片与标签落库：photos 为 JSON 数组且 tags 非空', async () => {
  const db = createDb(':memory:');
  const amap = {
    async districts() {
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('IMG1', STAY)];
    },
  };
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const row = db.getPoi('IMG1');
  assert.ok(JSON.parse(row.photos).length >= 1);
  assert.ok(JSON.parse(row.tags).length >= 1);
  db.close();
});

// ---------- 接口（mock app） ----------

check('T4-P39', 'GET /api/pois/stats 返回各分类条数', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'S1', rating: '4.5' });
  await withApp({ db }, async (api) => {
    const { status, body } = await api.get('/api/pois/stats?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(status, 200);
    assert.ok(body.data.categories.length >= 4);
    assert.strictEqual(body.data.categories.find((c) => c.key === 'stay').count, 1);
  });
});

check('T4-P40', 'POST /api/collect 返回 runId；status 可查到 done 与进度', async () => {
  await withApp({}, async (api) => {
    const post = await api.post('/api/collect', { city: '杭州', category: 'stay' });
    assert.strictEqual(post.status, 200);
    assert.ok(post.body.data.runId > 0);
    let data;
    for (let i = 0; i < 50; i += 1) {
      const res = await api.get('/api/collect/status?runId=' + post.body.data.runId);
      data = res.body.data;
      if (data.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(data.status, 'done');
    assert.strictEqual(data.n_inserted, 2);
    assert.strictEqual(data.percent, 100);
  });
});

check('T4-P41', '同一 (城市,分类) 采集进行中再次 POST → 409', async () => {
  const slow = amapFixture({
    async searchPoiByDistrict({ page }) {
      await new Promise((r) => setTimeout(r, 120));
      if (page > 1) return [];
      return [mkPoi('B1', STAY)];
    },
  });
  await withApp({ amap: slow }, async (api) => {
    const first = await api.post('/api/collect', { city: '杭州', category: 'stay' });
    assert.strictEqual(first.status, 200);
    const second = await api.post('/api/collect', { city: '杭州', category: 'stay' });
    assert.strictEqual(second.status, 409);
    await new Promise((r) => setTimeout(r, 250));
  });
});

check('T4-P47', 'GET /api/pois sort=rating 按评分降序（空评分排最后）', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'V1', rating: '4.1' });
  seedPoi(db, { id: 'V2', rating: '4.9' });
  seedPoi(db, { id: 'V3', rating: null });
  await withApp({ db }, async (api) => {
    const { body } = await api.get(
      '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay&sort=rating'
    );
    assert.deepStrictEqual(body.data.items.map((i) => i.id), ['V2', 'V1', 'V3']);
  });
});

check('T4-P52', '配额保护：/api/pois 连打 3 次不产生高德调用', async () => {
  await withApp({}, async (api) => {
    for (let i = 0; i < 3; i += 1) {
      await api.get('/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay');
    }
    assert.strictEqual(api.amap.calls.poiSearch, 0);
    assert.strictEqual(api.amap.calls.byDistrict, 0);
    assert.strictEqual(api.amap.calls.districts, 0);
  });
});

check('T4-P56', 'GET /api/pois minRating=4.0 仅返回 rating>=4.0（无评分不计入）', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'N1', rating: '4.2' });
  seedPoi(db, { id: 'N2', rating: '4.6' });
  seedPoi(db, { id: 'N3', rating: '3.5' });
  seedPoi(db, { id: 'N4', rating: null });
  await withApp({ db }, async (api) => {
    const { body } = await api.get(
      '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay&minRating=4.0'
    );
    assert.strictEqual(body.data.total, 2);
    body.data.items.forEach((i) => assert.ok(Number(i.rating) >= 4.0));
  });
});

async function main() {
  for (const c of CHECKS) {
    try {
      await c.fn();
      process.stdout.write(`PASS  ${c.id} ${c.desc}\n`);
    } catch (err) {
      process.stdout.write(`FAIL  ${c.id} ${c.desc} :: ${err.message}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`T4 mock 检查通过：${CHECKS.length} 项\n`);
}

main().catch((err) => {
  process.stdout.write('FAIL  T4 mock 运行异常 :: ' + (err && err.message) + '\n');
  process.exit(1);
});
