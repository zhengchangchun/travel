const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const { liveViewport, liveGrids, LIVE_MAX_CELLS } = require('../server/collect');

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

// 一个视野 bbox（杭州湖滨，约 0.02° × 0.012° ≈ 2km × 1.3km）
const BBOX = { minLng: 120.15, minLat: 30.24, maxLng: 120.17, maxLat: 30.252 };

function mkPoi(id, typecode, extra = {}) {
  return {
    id,
    name: 'P' + id,
    address: 'addr',
    lng: 120.16,
    lat: 30.25,
    typecode,
    category: 'stay',
    rating: '4.6',
    cost: '88',
    tel: '123',
    photos: ['u1'],
    tags: ['招牌'],
    ...extra,
  };
}

function aroundFixture(pois, calls) {
  return async ({ lng, lat, radius, page }) => {
    calls.push({ lng, lat, radius, page });
    return pois;
  };
}

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: opts.amap,
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

// ---------- liveGrids：粗格切分 ----------

test('liveGrids 小视野 1 格、大视野 ≤ 9 格、半径夹在 [300, 50000]', () => {
  const small = liveGrids({ minLng: 120.15, minLat: 30.24, maxLng: 120.155, maxLat: 30.244 });
  assert.equal(small.length, 1, '约 0.5km 视野应只切 1 格');
  const big = liveGrids({ minLng: 120.0, minLat: 30.0, maxLng: 120.5, maxLat: 30.5 });
  assert.ok(big.length <= LIVE_MAX_CELLS, `每轴最多 3 格（实际 ${big.length}）`);
  assert.equal(big.length, LIVE_MAX_CELLS, '50km 视野应切满 9 格');
  [...small, ...big].forEach((c) => {
    assert.ok(c.radius >= 300 && c.radius <= 50000, `半径越界：${c.radius}`);
  });
  assert.ok(
    big.every((c) => c.lng > 120.0 && c.lng < 120.5 && c.lat > 30.0 && c.lat < 30.5),
    '格中心必须落在 bbox 内'
  );
});

// ---------- liveViewport：一次视野 ≤ 9 次调用 + 落库 ----------

test('liveViewport：每格 1 次调用（不翻页）、结果落库、计数正确', async () => {
  const db = createDb(':memory:');
  const calls = [];
  const pois = [mkPoi('L1', '100000'), mkPoi('L2', '100000')];
  const res = await liveViewport({
    amap: { searchPoiAround: aroundFixture(pois, calls) },
    db,
    city: '杭州',
    category: 'stay',
    bbox: BBOX,
  });
  const cells = liveGrids(BBOX).length;
  assert.equal(res.calls, cells, '调用次数应等于格数');
  assert.equal(calls.length, cells, '每格只打 1 次');
  assert.ok(calls.every((c) => c.page === 1), '实时搜索不翻页（只取第 1 页）');
  assert.equal(res.inserted, 2, '两条新 POI 应入库');
  assert.deepEqual(res.errors, []);
  const rows = db.listPois({ city: '杭州', bbox: BBOX });
  assert.equal(rows.total, 2, '结果应落库并在缓存里可查');
  assert.equal(rows.items[0].category, 'stay');
  db.close();
});

test('liveViewport：单格失败不阻断，errors 如实回报（配额用尽场景）', async () => {
  const db = createDb(':memory:');
  const calls = [];
  const amap = {
    async searchPoiAround(args) {
      calls.push(args);
      if (calls.length === 1) throw new Error('USER_DAILY_QUERY_OVER_LIMIT');
      return [mkPoi('OK1', '100000')];
    },
  };
  const res = await liveViewport({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.ok(res.calls >= 2, '应继续尝试其余格');
  assert.equal(res.errors.length, 1, '失败次数应记录');
  assert.match(res.errors[0], /USER_DAILY_QUERY_OVER_LIMIT/);
  assert.equal(res.inserted, res.calls - 1, '失败那格没有入库');
  db.close();
});

test('liveViewport：category=all 时按 typecode 归类，非四类丢弃', async () => {
  const db = createDb(':memory:');
  const amap = {
    async searchPoiAround() {
      return [
        mkPoi('A-stay', '100000'),
        mkPoi('A-food', '050100'),
        mkPoi('A-other', '200000'),
      ];
    },
  };
  const res = await liveViewport({ amap, db, city: '杭州', category: 'all', bbox: BBOX });
  assert.equal(res.inserted, 2, '非四类 typecode 应被丢弃');
  const stay = db.listPois({ city: '杭州', category: 'stay' });
  const food = db.listPois({ city: '杭州', category: 'food' });
  assert.equal(stay.total, 1);
  assert.equal(food.total, 1);
  db.close();
});

// ---------- 路由：/api/poi/inview ----------

test('GET /api/poi/inview：返回本视野结果 + live 计数，且打高德不超过 9 次', async () => {
  const calls = [];
  const pois = [mkPoi('R1', '100000'), mkPoi('R2', '100000'), mkPoi('R3', '050100')];
  const h = await start({ amap: { searchPoiAround: aroundFixture(pois, calls) } });
  try {
    const q = `city=${encodeURIComponent('杭州')}&category=stay&bbox=${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;
    const { status, body } = await getJson(h.base, '/api/poi/inview?' + q);
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.city, '杭州');
    assert.equal(d.category, 'stay');
    assert.ok(d.live.calls <= 9, `实时调用应 ≤ 9 次（实际 ${d.live.calls}）`);
    assert.equal(d.total, 2, 'stay 分类 2 条（food 那条不算）');
    assert.equal(d.items.length, 2);
    assert.ok(d.items.every((p) => p.category === 'stay'));
  } finally {
    await h.close();
  }
});

test('GET /api/poi/inview：缺 bbox → 400；bbox 非法 → 400', async () => {
  const h = await start({ amap: { async searchPoiAround() { return []; } } });
  try {
    const bad1 = await getJson(h.base, '/api/poi/inview?city=' + encodeURIComponent('杭州'));
    assert.equal(bad1.status, 400);
    const bad2 = await getJson(
      h.base,
      '/api/poi/inview?city=' + encodeURIComponent('杭州') + '&bbox=1,2,3'
    );
    assert.equal(bad2.status, 400);
  } finally {
    await h.close();
  }
});

test('GET /api/poi/inview：高德全失败时仍 200，live.errors 回报且 items 走缓存', async () => {
  const db = createDb(':memory:');
  db.upsertPoi({
    poi_id: 'CACHE1',
    city: '杭州',
    adcode: '330102',
    category: 'stay',
    name: '缓存里的住宿',
    address: 'a',
    lng: 120.16,
    lat: 30.25,
    typecode: '100000',
    rating: '4.8',
    cost: '120',
    tel: null,
    photos: [],
    tags: [],
  });
  const h = await start({
    db,
    amap: {
      async searchPoiAround() {
        throw new Error('USER_DAILY_QUERY_OVER_LIMIT');
      },
    },
  });
  try {
    const q = `city=${encodeURIComponent('杭州')}&category=stay&bbox=${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;
    const { status, body } = await getJson(h.base, '/api/poi/inview?' + q);
    assert.equal(status, 200, '实时失败不应 500，前端还要显示缓存');
    assert.ok(body.data.live.errors.length > 0, '应回报失败原因');
    assert.equal(body.data.total, 1, '缓存里的点仍要返回');
    assert.equal(body.data.items[0].name, '缓存里的住宿');
  } finally {
    await h.close();
  }
});
