const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const { liveRect, bboxPolygon, inBbox, LIVE_MAX_PAGES, diffAgainstCache, storableOnly } = require('../server/collect');
const { contentHash, setDigest, canonicalPoi, shortHash, HASH_FIELDS } = require('../server/poi-hash');
const HASH_FIELDS_COUNT = HASH_FIELDS.length;

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
    authFallbackUser: true,
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

// ---------- 缓存一致性对拍 ----------

function seed(db, p) {
  db.upsertPoi({
    poi_id: p.id,
    city: '杭州',
    adcode: '330102',
    category: p.category || 'stay',
    name: p.name,
    address: p.address || '',
    lng: p.lng,
    lat: p.lat,
    typecode: p.typecode || '100000',
    rating: p.rating || null,
    cost: p.cost || null,
    tel: p.tel || null,
    photos: p.photos || [],
    tags: p.tags || [],
  });
}

test('diffAgainstCache：新增 / 字段变化 / 一致 三分类，逐字段点名', () => {
  const db = createDb(':memory:');
  const base = mkPoi('D1', '100000', { name: '老名字', rating: '4.6' });
  seed(db, base);
  seed(db, mkPoi('D3', '100000', { name: '同名店' }));

  const diff = diffAgainstCache(db, [
    mkPoi('D1', '100000', { name: '新名字', rating: '4.6' }), // name 变了
    mkPoi('D3', '100000', { name: '同名店' }), // 完全一致
    mkPoi('D9', '100000', { name: '新店' }), // 库里没有
  ]);

  assert.equal(diff.checked, 3);
  assert.equal(diff.added, 1, 'D9 应算新增');
  assert.equal(diff.changed, 1, 'D1 应算有变化');
  assert.equal(diff.same, 1, 'D3 应算一致');
  assert.deepEqual(diff.changed_fields, { name: 1 });
  assert.equal(diff.samples[0].poi_id, 'D1');
  assert.deepEqual(diff.samples[0].fields, ['name']);
  db.close();
});

test('diffAgainstCache：null/空串/缺省视为同值；坐标容差到 6 位；photos/tags 按数组比', () => {
  const db = createDb(':memory:');
  const seedFields = {
    name: 'X',
    address: 'addr',
    lng: 120.16,
    lat: 30.25,
    rating: '4.5',
    cost: '',
    tel: '',
    photos: ['u1', 'u2'],
    tags: ['a'],
  };
  seed(db, { ...seedFields, id: 'E1' });

  const incoming = (extra = {}) =>
    mkPoi('E1', '100000', { ...seedFields, tel: null, cost: '', ...extra });

  const same = diffAgainstCache(db, [incoming()]);
  assert.equal(same.same, 1, 'null 与空串应视为同值');
  assert.equal(same.changed, 0);

  const changed = diffAgainstCache(db, [incoming({ rating: '4.9' })]);
  assert.equal(changed.changed_fields.rating, 1, 'rating 变化应被认出');
  assert.deepEqual(changed.changed_fields, { rating: 1 }, '其他字段不应误报');

  const tol = diffAgainstCache(db, [incoming({ lng: 120.1600004 })]);
  assert.equal(tol.same, 1, '坐标第 7 位以后不算变化（容差 6 位）');

  const photos = diffAgainstCache(db, [incoming({ photos: ['u2', 'u1'] })]);
  assert.equal(photos.changed_fields.photos, 1, 'photos 顺序变了应算变化');
  db.close();
});

test('storableOnly：按归类规则先滤掉不会入库的点（否则对拍数字会虚高）', () => {
  const list = [mkPoi('S1', '100000'), mkPoi('S2', '050100'), mkPoi('S3', '200000')];
  assert.equal(storableOnly(list, 'stay').length, 1, 'stay 只应留 100000');
  assert.equal(storableOnly(list, 'all').length, 2, 'all 应丢非四类');
});

test('liveRect：返回与缓存的对拍（0 额外调用）', async () => {
  const db = createDb(':memory:');
  seed(db, mkPoi('K1', '100000', { name: '老名字' }));
  const amap = {
    async searchPoiInArea() {
      return [
        mkPoi('K1', '100000', { name: '新名字' }), // 有变化
        mkPoi('K2', '100000', { name: '新店' }), // 新增
      ];
    },
  };
  const res = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(res.diff.checked, 2);
  assert.equal(res.diff.added, 1);
  assert.equal(res.diff.changed, 1);
  assert.equal(res.diff.same, 0);
  assert.equal(res.diff.changed_fields.name, 1);
  assert.equal(res.fetched, 2);
  db.close();
});

test('liveRect：库里与远端逐字段相同 ⇒ diff.same 全中（缓存就是最新的）', async () => {
  const db = createDb(':memory:');
  const p = mkPoi('SAME1', '100000', { name: '一模一样', rating: '4.6' });
  seed(db, { ...p, id: 'SAME1' });
  const amap = { async searchPoiInArea() { return [p]; } };
  const res = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(res.diff.same, 1, '应判「与缓存一致」');
  assert.equal(res.diff.changed, 0);
  assert.equal(res.diff.added, 0);
  db.close();
});

// ---------- 内容指纹 / 集合指纹 ----------

test('contentHash：字段顺序无关、null 与空串同值、坐标 6 位容差、photos 顺序敏感', () => {
  const a = { name: 'X', address: 'a', lng: 120.16, lat: 30.25, typecode: '100000', category: 'stay', rating: '4.5', cost: '', tel: null, photos: ['u1'], tags: ['t'] };
  const b = { tags: ['t'], photos: ['u1'], cost: null, tel: '', rating: '4.5', category: 'stay', typecode: '100000', lat: 30.25, lng: 120.16, address: 'a', name: 'X' };
  assert.equal(contentHash(a), contentHash(b), '同内容（键顺序不同）指纹应相同');
  assert.equal(contentHash({ ...a, lng: 120.1600004 }), contentHash(a), '坐标 6 位以内不算变化');
  assert.notEqual(contentHash({ ...a, rating: '4.9' }), contentHash(a), '字段变化 ⇒ 指纹变');
  assert.notEqual(contentHash({ ...a, photos: ['u2'] }), contentHash(a), 'photos 变化 ⇒ 指纹变');
  assert.match(contentHash(a), /^[0-9a-f]{64}$/, '应是 sha256 hex');
});

test('canonicalPoi：字段顺序固定，便于两库对比与排错', () => {
  const s = canonicalPoi({ name: 'X', lng: 1, lat: 2 });
  assert.ok(s.startsWith('X\u0001'), '首字段应是 name：' + JSON.stringify(s.slice(0, 6)));
  assert.equal(s.split('\u0001').length, HASH_FIELDS_COUNT, '字段个数应固定');
});

test('setDigest：与顺序无关；内容变则指纹变；空集合稳定', () => {
  const A = { poi_id: 'A', hash: 'h1' };
  const B = { poi_id: 'B', hash: 'h2' };
  assert.equal(setDigest([A, B]), setDigest([B, A]), '集合指纹应与顺序无关');
  assert.notEqual(setDigest([A, B]), setDigest([A, { poi_id: 'B', hash: 'h3' }]), '内容变 ⇒ 指纹变');
  assert.equal(setDigest([]), setDigest([]), '空集合应稳定');
  assert.match(shortHash('0123456789abcdef'), /^0123456789ab$/, '短显示取前 12 位');
});

test('liveRect：集合指纹 —— 同批两次 digest_match=true，改了一个字段就 false', async () => {
  const db = createDb(':memory:');
  let rating = '4.6';
  const amap = {
    async searchPoiInArea() {
      return [mkPoi('G1', '100000', { rating }), mkPoi('G2', '100000', { rating })];
    },
  };
  const first = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.match(first.digest, /^[0-9a-f]{64}$/, '应给集合指纹');
  assert.equal(first.digest_match, false, '第一次入库前缓存里没有 ⇒ 指纹不等');

  const again = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(again.digest_match, true, '同内容再取一次 ⇒ 指纹一致（缓存就是最新的）');
  assert.equal(again.diff.same, 2);
  assert.equal(again.diff.changed, 0);

  rating = '4.9';
  const changed = await liveRect({ amap, db, city: '杭州', category: 'stay', bbox: BBOX });
  assert.equal(changed.digest_match, false, '远端变了 ⇒ 指纹不等');
  assert.equal(changed.diff.changed, 2);
  assert.equal(changed.diff.changed_fields.rating, 2);
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
