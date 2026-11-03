const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const { liveRect, bboxPolygon, inBbox, LIVE_MAX_PAGES } = require('../server/collect');

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
const BBOX_STR = `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;

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

function pageOf(n, prefix, typecode = '100000', extra = {}) {
  return Array.from({ length: n }, (_, k) => mkPoi(`${prefix}-${k}`, typecode, extra));
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

// ---------- bboxPolygon / inBbox ----------

test('bboxPolygon：四角闭合顺序 + lng,lat| 格式（首尾不闭合）', () => {
  const s = bboxPolygon(BBOX);
  const parts = s.split('|');
  assert.equal(parts.length, 4, '应是 4 个顶点');
  assert.equal(parts[0], '120.15,30.24');
  assert.equal(parts[1], '120.17,30.24');
  assert.equal(parts[2], '120.17,30.252');
  assert.equal(parts[3], '120.15,30.252');
  assert.ok(!/,120\.15,30\.24$/.test(s), '首尾不应重复闭合');
});

test('inBbox：框内 true、框外 false、边界算框内', () => {
  assert.ok(inBbox({ lng: 120.16, lat: 30.25 }, BBOX), '框内应 true');
  assert.ok(inBbox({ lng: BBOX.minLng, lat: BBOX.minLat }, BBOX), '左下角应算框内');
  assert.ok(inBbox({ lng: BBOX.maxLng, lat: BBOX.maxLat }, BBOX), '右上角应算框内');
  assert.ok(!inBbox({ lng: 120.1499, lat: 30.25 }, BBOX), '左越界应 false');
  assert.ok(!inBbox({ lng: 120.16, lat: 30.253 }, BBOX), '上越界应 false');
  assert.ok(!inBbox({ lng: null, lat: 30.25 }, BBOX), '缺坐标应 false');
  assert.ok(!inBbox(null, BBOX), '空点应 false');
});

// ---------- liveRect：按矩形查 + 框外不落库 ----------

test('liveRect：只把框内的点落库，框外的一律丢弃', async () => {
  const db = createDb(':memory:');
  const calls = [];
  const amap = {
    async searchPoiInArea({ polygon, page }) {
      calls.push({ polygon, page });
      return [
        mkPoi('IN-1', '100000', { lng: 120.16, lat: 30.25 }),
        mkPoi('IN-2', '100000', { lng: 120.165, lat: 30.245 }),
        mkPoi('OUT-1', '100000', { lng: 120.19, lat: 30.25 }), // 框右外
        mkPoi('OUT-2', '100000', { lng: 120.16, lat: 30.26 }), // 框上外
      ];
    },
  };
  const res = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(res.calls, 1, '不满一页 ⇒ 只查 1 次');
  assert.equal(res.inserted, 2, '只有框内 2 条入库');
  assert.deepEqual(res.errors, []);
  assert.equal(res.mode, 'rect');
  assert.equal(calls[0].polygon, bboxPolygon(BBOX), '应按当前地图矩形查');
  const rows = db.listPois({ city: '杭州', bbox: BBOX });
  assert.equal(rows.total, 2, '框内可查出 2 条');
  assert.ok(
    db.listPois({ city: '杭州' }).items.every((p) => inBbox(p, BBOX)),
    '库里不允许出现框外的点'
  );
  db.close();
});

test('liveRect：满页继续翻页，最多 LIVE_MAX_PAGES 次；不满页即停', async () => {
  const db = createDb(':memory:');
  const pages = [];
  const full = {
    async searchPoiInArea({ page }) {
      pages.push(page);
      return pageOf(25, 'F' + page);
    },
  };
  const res = await liveRect({ amap: full, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(res.calls, LIVE_MAX_PAGES, '一直满页 ⇒ 翻到上限停');
  assert.deepEqual(pages, [1, 2, 3, 4], '页码应按 1..N 递增');

  const db2 = createDb(':memory:');
  const half = { async searchPoiInArea() { return pageOf(3, 'H'); } };
  const res2 = await liveRect({ amap: half, db: db2, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(res2.calls, 1, '不满一页即停');
  assert.equal(res2.inserted, 3);
  db.close();
  db2.close();
});

test('liveRect：失败立刻停并如实回报（配额用尽场景）', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiInArea() {
      calls += 1;
      throw new Error('USER_DAILY_QUERY_OVER_LIMIT');
    },
  };
  const res = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(calls, 1, '失败后不应继续翻页');
  assert.equal(res.calls, 1);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /USER_DAILY_QUERY_OVER_LIMIT/);
  assert.equal(res.inserted, 0);
  db.close();
});

test('liveRect：category=all 时按 typecode 归类，非四类丢弃', async () => {
  const db = createDb(':memory:');
  const amap = {
    async searchPoiInArea() {
      return [
        mkPoi('A-stay', '100000'),
        mkPoi('A-food', '050100'),
        mkPoi('A-other', '200000'),
      ];
    },
  };
  const res = await liveRect({ amap, db, city: '杭州', category: 'all', bbox: BBOX });
  assert.equal(res.inserted, 2, '非四类 typecode 应被丢弃');
  assert.equal(db.listPois({ city: '杭州', category: 'stay' }).total, 1);
  assert.equal(db.listPois({ city: '杭州', category: 'food' }).total, 1);
  db.close();
});

// ---------- 路由：/api/poi/inview ----------

test('GET /api/poi/inview：返回当前地图范围内的结果 + live 计数', async () => {
  const calls = [];
  const amap = {
    async searchPoiInArea({ polygon, page }) {
      calls.push({ polygon, page });
      return [
        mkPoi('R1', '100000'),
        mkPoi('R2', '100000'),
        mkPoi('R3', '050100'),
        mkPoi('R-out', '100000', { lng: 120.9, lat: 30.9 }), // 框外，必须被过滤
      ];
    },
  };
  const h = await start({ amap });
  try {
    const { status, body } = await getJson(
      h.base,
      `/api/poi/inview?city=${encodeURIComponent('杭州')}&category=stay&bbox=${BBOX_STR}`
    );
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.category, 'stay');
    assert.equal(d.live.mode, 'rect');
    assert.equal(d.live.calls, 1);
    assert.equal(d.total, 2, '框内 stay 2 条（food 那条与框外那条都不算）');
    assert.ok(d.items.every((p) => p.category === 'stay' && inBbox(p, BBOX)));
    assert.equal(calls[0].polygon, bboxPolygon(BBOX), '请求应带当前地图矩形');
  } finally {
    await h.close();
  }
});

test('GET /api/poi/inview：缺 bbox → 400；bbox 非法 → 400', async () => {
  const h = await start({ amap: { async searchPoiInArea() { return []; } } });
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

test('GET /api/poi/inview：高德失败仍 200，live.errors 回报且 items 走缓存', async () => {
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
      async searchPoiInArea() {
        throw new Error('USER_DAILY_QUERY_OVER_LIMIT');
      },
    },
  });
  try {
    const { status, body } = await getJson(
      h.base,
      `/api/poi/inview?city=${encodeURIComponent('杭州')}&category=stay&bbox=${BBOX_STR}`
    );
    assert.equal(status, 200, '实时失败不应 500，前端还要显示缓存');
    assert.ok(body.data.live.errors.length > 0, '应回报失败原因');
    assert.equal(body.data.total, 1, '缓存里的点仍要返回');
    assert.equal(body.data.items[0].name, '缓存里的住宿');
  } finally {
    await h.close();
  }
});
