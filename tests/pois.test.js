const test = require('node:test');
const assert = require('node:assert');

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
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

function amapFixture(overrides = {}) {
  const calls = { districts: 0, byDistrict: 0, poiSearch: 0 };
  const amap = {
    calls,
    async districts() {
      calls.districts += 1;
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      calls.byDistrict += 1;
      if (page > 1) return [];
      return [
        { id: 'A1', name: '甲', address: 'a', lng: 120.1, lat: 30.1, typecode: '100000', category: 'stay', rating: '4.6', photos: ['u1'], tags: ['x'] },
        { id: 'A2', name: '乙', address: 'b', lng: 120.2, lat: 30.2, typecode: '100000', category: 'stay', rating: '4.9', photos: ['u2'], tags: [] },
      ];
    },
    async searchPoi() {
      calls.poiSearch += 1;
      return [];
    },
    ...overrides,
  };
  return amap;
}

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: opts.amap || amapFixture(),
    collectIntervalMs: 0,
    ...opts,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
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
  return { status: res.status, body: await res.json() };
}

async function postJson(base, p, payload) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function seedPoi(db, { id, city = '杭州', category = 'stay', rating = null, typecode = '100000', lng = 120.1, lat = 30.1 }) {
  db.upsertPoi({
    poi_id: id,
    city,
    adcode: '330102',
    category,
    name: '店' + id,
    address: 'addr',
    lng,
    lat,
    typecode,
    rating,
    cost: null,
    tel: null,
    photos: ['u'],
    tags: [],
    fetched_at: '2026-10-29T00:00:00Z',
  });
}

// ---------- db 层 ----------

test('db.upsertPoi 增量：首次 inserted，二次 updated', () => {
  const db = createDb(':memory:');
  const poi = { poi_id: 'X1', city: '杭州', adcode: '330102', category: 'stay', name: '店', lng: 1, lat: 2, typecode: '100000', photos: [], tags: [] };
  assert.strictEqual(db.upsertPoi(poi).status, 'inserted');
  assert.strictEqual(db.upsertPoi(poi).status, 'updated');
  db.close();
});

test('db.listPois sort=rating 按评分降序且空评分排最后', () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'L1', rating: '4.2' });
  seedPoi(db, { id: 'L2', rating: '4.8' });
  seedPoi(db, { id: 'L3', rating: null });
  const { items } = db.listPois({ city: '杭州', category: 'stay', sort: 'rating', limit: 10 });
  assert.deepStrictEqual(items.map((i) => i.id), ['L2', 'L1', 'L3']);
  db.close();
});

test('db.listPois minRating 过滤：无评分的点不计入', () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'M1', rating: '4.0' });
  seedPoi(db, { id: 'M2', rating: '3.9' });
  seedPoi(db, { id: 'M3', rating: null });
  const { total, items } = db.listPois({ city: '杭州', category: 'stay', minRating: 4.0, limit: 10 });
  assert.strictEqual(total, 1);
  assert.deepStrictEqual(items.map((i) => i.id), ['M1']);
  db.close();
});

test('db.poisStats 返回分类条数与评分分桶', () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'P1', category: 'stay', rating: '4.6' });
  seedPoi(db, { id: 'P2', category: 'stay', rating: '3.2' });
  seedPoi(db, { id: 'P3', category: 'food', rating: '4.8', typecode: '050000' });
  const stats = db.poisStats('杭州');
  assert.strictEqual(stats.total, 3);
  const stay = stats.categories.find((c) => c.key === 'stay');
  assert.strictEqual(stay.count, 2);
  assert.ok(Array.isArray(stats.ratingBuckets));
  db.close();
});

test('db 采集元数据：createRun / updateRun / getRun / findRunningRun', () => {
  const db = createDb(':memory:');
  const run = db.createRun({ city: '杭州', category: 'stay' });
  assert.ok(run.id > 0);
  assert.strictEqual(run.status, 'running');
  assert.ok(db.findRunningRun('杭州', 'stay'));
  db.updateRun(run.id, { status: 'done', n_inserted: 5 });
  assert.strictEqual(db.getRun(run.id).status, 'done');
  assert.strictEqual(db.findRunningRun('杭州', 'stay'), null);
  db.close();
});

// ---------- HTTP 层 ----------

test('P39 GET /api/pois/stats?city= 返回各分类条数', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'S1', category: 'stay', rating: '4.5' });
  const { base, close } = await start({ db });
  try {
    const { status, body } = await getJson(base, '/api/pois/stats?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(status, 200);
    assert.ok(body.data.categories.length >= 4);
    const stay = body.data.categories.find((c) => c.key === 'stay');
    assert.strictEqual(stay.count, 1);
  } finally {
    await close();
  }
});

test('P40 POST /api/collect 返回 runId；status 可查进度至 done', async () => {
  const { base, close } = await start();
  try {
    const post = await postJson(base, '/api/collect', { city: '杭州', category: 'stay' });
    assert.strictEqual(post.status, 200);
    assert.ok(post.body.data.runId > 0);

    let data;
    for (let i = 0; i < 50; i += 1) {
      const res = await getJson(base, '/api/collect/status?runId=' + post.body.data.runId);
      assert.strictEqual(res.status, 200);
      data = res.body.data;
      if (data.status === 'done' || data.status === 'partial') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(data.status, 'done');
    assert.strictEqual(data.n_inserted, 2);
    assert.strictEqual(data.total_districts, 1);
    assert.strictEqual(data.percent, 100);
  } finally {
    await close();
  }
});

test('P41 同一 (城市,分类) 采集进行中再次 POST → 409', async () => {
  const slow = amapFixture({
    async searchPoiByDistrict({ page }) {
      await new Promise((r) => setTimeout(r, 120));
      if (page > 1) return [];
      return [{ id: 'B1', name: '慢点', lng: 120.1, lat: 30.1, typecode: '100000', category: 'stay', photos: [], tags: [] }];
    },
  });
  const { base, close } = await start({ amap: slow });
  try {
    const first = await postJson(base, '/api/collect', { city: '杭州', category: 'stay' });
    assert.strictEqual(first.status, 200);
    const second = await postJson(base, '/api/collect', { city: '杭州', category: 'stay' });
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.error.code, 'CONFLICT');
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    await close();
  }
});

test('P47 GET /api/pois sort=rating 按评分降序（空评分排最后）', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'V1', rating: '4.1' });
  seedPoi(db, { id: 'V2', rating: '4.9' });
  seedPoi(db, { id: 'V3', rating: null });
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(
      base,
      '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay&sort=rating'
    );
    assert.deepStrictEqual(body.data.items.map((i) => i.id), ['V2', 'V1', 'V3']);
  } finally {
    await close();
  }
});

test('P52 配额保护：/api/pois 只读缓存，连打 3 次不产生高德调用', async () => {
  const amap = amapFixture();
  const { base, close } = await start({ amap });
  try {
    await getJson(base, '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay');
    await getJson(base, '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay');
    await getJson(base, '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay');
    assert.strictEqual(amap.calls.poiSearch, 0);
    assert.strictEqual(amap.calls.byDistrict, 0);
    assert.strictEqual(amap.calls.districts, 0);
  } finally {
    await close();
  }
});

test('P56 GET /api/pois minRating=4.0 仅返回 rating>=4.0（无评分的点不计入）', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'N1', rating: '4.2' });
  seedPoi(db, { id: 'N2', rating: '4.6' });
  seedPoi(db, { id: 'N3', rating: '3.5' });
  seedPoi(db, { id: 'N4', rating: null });
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(
      base,
      '/api/pois?city=' + encodeURIComponent('杭州') + '&category=stay&minRating=4.0'
    );
    assert.strictEqual(body.data.total, 2);
    body.data.items.forEach((i) => assert.ok(Number(i.rating) >= 4.0));
  } finally {
    await close();
  }
});

test('GET /api/collect/status?runId=不存在 → 404', async () => {
  const { base, close } = await start();
  try {
    const { status } = await getJson(base, '/api/collect/status?runId=999999');
    assert.strictEqual(status, 404);
  } finally {
    await close();
  }
});

// ---------- T7 bbox 过滤与参数校验 ----------

test('T7 db.listPois bbox 只返回框内的点', () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'IN1', lng: 120.15, lat: 30.25 });
  seedPoi(db, { id: 'IN2', lng: 120.18, lat: 30.28 });
  seedPoi(db, { id: 'OUT1', lng: 121.0, lat: 30.25 });
  seedPoi(db, { id: 'OUT2', lng: 120.15, lat: 31.0 });
  const { items } = db.listPois({
    city: '杭州',
    bbox: { minLng: 120.1, minLat: 30.2, maxLng: 120.2, maxLat: 30.3 },
  });
  assert.deepStrictEqual(items.map((i) => i.id).sort(), ['IN1', 'IN2']);
  db.close();
});

test('T7 GET /api/pois bbox 返回的点全部落在框内', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'B1', lng: 120.15, lat: 30.25 });
  seedPoi(db, { id: 'B2', lng: 120.18, lat: 30.28 });
  seedPoi(db, { id: 'B3', lng: 121.0, lat: 30.25 });
  const { base, close } = await start({ db });
  try {
    const { status, body } = await getJson(
      base,
      '/api/pois?city=' + encodeURIComponent('杭州') + '&bbox=120.1,30.2,120.2,30.3'
    );
    assert.strictEqual(status, 200);
    assert.ok(body.data.items.length >= 2);
    body.data.items.forEach((i) => {
      assert.ok(i.lng >= 120.1 && i.lng <= 120.2, 'lng 越界 ' + i.lng);
      assert.ok(i.lat >= 30.2 && i.lat <= 30.3, 'lat 越界 ' + i.lat);
    });
    assert.ok(!body.data.items.some((i) => i.id === 'B3'), '框外点不应返回');
  } finally {
    await close();
  }
});

test('T7 bbox 缺段 / 非数字 / min>=max → 400', async () => {
  const { base, close } = await start({ db: createDb(':memory:') });
  try {
    const CITY = encodeURIComponent('杭州');
    const bads = ['120.1,30.2,120.2', '120.1,30.2,120.2,x', '120.2,30.2,120.1,30.3', '120.1,30.3,120.2,30.2'];
    for (const bad of bads) {
      const { status } = await getJson(base, '/api/pois?city=' + CITY + '&bbox=' + encodeURIComponent(bad));
      assert.strictEqual(status, 400, '应 400: ' + bad);
    }
  } finally {
    await close();
  }
});

test('T7 无 bbox 时行为不变：不给 limit 仍封顶 200', async () => {
  const db = createDb(':memory:');
  for (let i = 0; i < 205; i += 1) seedPoi(db, { id: 'C' + i });
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(base, '/api/pois?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(body.data.items.length, 200);
  } finally {
    await close();
  }
});

test('T7 有 bbox 且不给 limit → 框内全量返回（不封顶）', async () => {
  const db = createDb(':memory:');
  for (let i = 0; i < 300; i += 1) seedPoi(db, { id: 'D' + i, lng: 120.15, lat: 30.25 });
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(
      base,
      '/api/pois?city=' + encodeURIComponent('杭州') + '&bbox=120,30,121,31'
    );
    assert.strictEqual(body.data.items.length, 300);
  } finally {
    await close();
  }
});

test('GET /api/collect/runs?city= 返回各分类最近一次状态', async () => {
  const db = createDb(':memory:');
  const run = db.createRun({ city: '杭州', category: 'stay' });
  db.updateRun(run.id, { status: 'done', n_inserted: 7, n_fetched: 20 });
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(base, '/api/collect/runs?city=' + encodeURIComponent('杭州'));
    const stay = body.data.find((r) => r.category === 'stay');
    assert.ok(stay);
    assert.strictEqual(stay.n_inserted, 7);
    assert.strictEqual(stay.status, 'done');
  } finally {
    await close();
  }
});

test('GET /api/pois/digest：给出该城市缓存的集合指纹（可对账）', async () => {
  const db = createDb(':memory:');
  const h = await start({ db });
  try {
    seedPoi(db, { id: 'DG1', lng: 120.16, lat: 30.25, rating: '4.6' });
    seedPoi(db, { id: 'DG2', lng: 120.17, lat: 30.26, rating: '4.8' });
    const a = await getJson(h.base, '/api/pois/digest?city=' + encodeURIComponent('杭州'));
    assert.equal(a.status, 200);
    assert.equal(a.body.data.total, 2);
    assert.equal(a.body.data.hashed, 2, '写库时应已落指纹');
    assert.match(a.body.data.digest, /^[0-9a-f]{64}$/);

    // 内容没变 ⇒ 指纹不变；变一条 ⇒ 指纹变
    const b = await getJson(h.base, '/api/pois/digest?city=' + encodeURIComponent('杭州'));
    assert.equal(b.body.data.digest, a.body.data.digest, '内容未变指纹不应变');
    seedPoi(db, { id: 'DG2', lng: 120.17, lat: 30.26, rating: '3.9' });
    const c = await getJson(h.base, '/api/pois/digest?city=' + encodeURIComponent('杭州'));
    assert.notEqual(c.body.data.digest, a.body.data.digest, '内容变了指纹应变');
  } finally {
    await h.close();
  }
});
