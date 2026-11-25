/* 不落盘（2026-11-25）
   用户口径：「不要所有的数据都存在本地，可以做缓存 但是不能持久化到我这，
   要不然数据更新了 我们就都是错的」。

   分界线：
     · 上游事实（地点/评分/人均/电话/图片/行政区划/采集覆盖账本）⇒ 只放内存，带 TTL，重启即清
     · 我们自己的数据（账号/行程/点位/笔记/分享/搭子/留言/采集运行日志）⇒ 照旧落盘
*/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDb } = require('../server/db');
const { createPoiStore, DEFAULT_TTL_MS } = require('../server/poi-store');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DB = read('server/db.js');
const STORE = read('server/poi-store.js');

const POI = {
  poi_id: 'P1',
  city: '杭州',
  category: 'sight',
  name: '西湖',
  address: '西湖区',
  lng: 120.15,
  lat: 30.25,
  typecode: '110202',
  rating: '4.8',
  cost: '',
  tel: '',
  photos: ['u1'],
  tags: ['5A'],
};

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-nopersist-'));
  return { dir, file: path.join(dir, 'travel.db') };
}

// ---------- 表结构 ----------

test('三张上游事实表不再建：pois / poi_coverage / city_boundaries', () => {
  assert.ok(!/CREATE TABLE IF NOT EXISTS pois \(/.test(DB), 'pois 不该再建表');
  assert.ok(!/CREATE TABLE IF NOT EXISTS poi_coverage \(/.test(DB), 'poi_coverage 不该再建表');
  assert.ok(!/CREATE TABLE IF NOT EXISTS city_boundaries \(/.test(DB), 'city_boundaries 不该再建表');
  // 采集运行日志仍落盘（那是「我们做过什么」，不是上游事实）
  assert.match(DB, /CREATE TABLE IF NOT EXISTS poi_collect_runs/, '采集运行日志仍要落盘');
});

test('用户自己的数据照旧落盘（账号/行程/点位/笔记/分享/搭子/留言）', () => {
  ['users', 'sessions', 'trips', 'pins', 'notes', 'shares', 'buddies', 'trip_comments'].forEach((t) => {
    assert.match(DB, new RegExp('CREATE TABLE IF NOT EXISTS ' + t + ' \\('), t + ' 应仍落盘');
  });
});

test('db.js 里不再有读写 pois / poi_coverage / city_boundaries 的 SQL', () => {
  assert.ok(!/FROM pois\b/.test(DB), 'db.js 不该再 SELECT FROM pois');
  assert.ok(!/INTO pois\b/.test(DB), 'db.js 不该再 INSERT INTO pois');
  assert.ok(!/FROM poi_coverage\b/.test(DB), 'db.js 不该再读 poi_coverage');
  assert.ok(!/FROM city_boundaries\b/.test(DB), 'db.js 不该再读 city_boundaries');
});

// ---------- 行为：重启即清 ----------

test('POI 写进内存后，重开同一个库文件就没了（不持久化）', () => {
  const { dir, file } = tmpFile();
  try {
    const d1 = createDb(file);
    d1.upsertPoi(POI);
    assert.strictEqual(d1.getPoi('P1').name, '西湖');
    assert.strictEqual(d1.countPois('杭州'), 1);
    d1.close();

    const d2 = createDb(file);
    assert.strictEqual(d2.getPoi('P1'), null, '重启后不该还有旧 POI');
    assert.strictEqual(d2.countPois('杭州'), 0);
    assert.deepStrictEqual(d2.listPois({ city: '杭州' }).items, []);
    d2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('覆盖账本与城市轮廓同样不持久化（POI 没了账本留着就会「以为采过其实没有」）', () => {
  const { dir, file } = tmpFile();
  try {
    const d1 = createDb(file);
    d1.markCovered('杭州', 'food', 1, 1, 5);
    d1.saveCityBoundary('杭州', { name: '杭州', rings: [[[120, 30], [121, 30], [121, 31]]] });
    assert.strictEqual(d1.isCovered('杭州', 'food', 1, 1), true);
    assert.ok(d1.getCityBoundary('杭州'));
    d1.close();

    const d2 = createDb(file);
    assert.strictEqual(d2.isCovered('杭州', 'food', 1, 1), false, '重启后账本应清空');
    assert.strictEqual(d2.getCityBoundary('杭州'), null, '重启后轮廓应清空');
    d2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('用户数据不受影响：行程与点位重启后还在', () => {
  const { dir, file } = tmpFile();
  try {
    const d1 = createDb(file);
    const trip = d1.createTrip({ city: '杭州', title: '我的行程', userId: 1 });
    d1.addPin({ trip_id: trip.id, name: '西湖', lng: 120.15, lat: 30.25, category: 'sight' });
    d1.close();

    const d2 = createDb(file);
    const trips = d2.listTrips(1);
    assert.strictEqual(trips.length, 1, '行程要还在');
    assert.strictEqual(d2.getPinsByTrip(trips[0].id).length, 1, '点位要还在');
    d2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- TTL ----------

test('TTL 到期后读不到（默认 30 分钟，可注入）', () => {
  let clock = 1000;
  const store = createPoiStore({ ttlMs: 60_000, now: () => clock });
  store.upsertPoi(POI);
  assert.ok(store.getPoi('P1'), '刚写进去应读得到');
  clock += 59_000;
  assert.ok(store.getPoi('P1'), 'TTL 内应还在');
  clock += 2_000;
  assert.strictEqual(store.getPoi('P1'), null, 'TTL 过了应读不到');
  assert.strictEqual(store.stats().pois, 0, '过期项应被清掉');
});

test('默认 TTL 是 30 分钟；POI_CACHE_TTL_MINUTES 可覆盖', () => {
  assert.strictEqual(DEFAULT_TTL_MS, 30 * 60 * 1000);
  const old = process.env.POI_CACHE_TTL_MINUTES;
  try {
    process.env.POI_CACHE_TTL_MINUTES = '5';
    // 重新 require 拿新 env（模块级常量在函数里读，这里直接验函数）
    const { ttlFromEnv } = require('../server/poi-store');
    assert.strictEqual(ttlFromEnv(), 5 * 60 * 1000);
  } finally {
    if (old === undefined) delete process.env.POI_CACHE_TTL_MINUTES;
    else process.env.POI_CACHE_TTL_MINUTES = old;
  }
});

test('覆盖账本与 POI 同寿命：POI 过期后账本也过期', () => {
  let clock = 1000;
  const store = createPoiStore({ ttlMs: 60_000, now: () => clock });
  store.upsertPoi(POI);
  store.markCovered('杭州', 'sight', 1, 1, 1);
  assert.strictEqual(store.isCovered('杭州', 'sight', 1, 1), true);
  clock += 61_000;
  assert.strictEqual(store.isCovered('杭州', 'sight', 1, 1), false, '账本应与 POI 一起过期');
});

// ---------- 查询语义不变 ----------

test('内存版查询与原来的 SQL 语义一致：分类/评分/bbox/排序/分页', () => {
  const store = createPoiStore({ ttlMs: 60_000 });
  store.upsertPoi({ ...POI, poi_id: 'A', name: 'A店', rating: '4.9', category: 'food', lng: 120.10, lat: 30.20 });
  store.upsertPoi({ ...POI, poi_id: 'B', name: 'B店', rating: '3.2', category: 'food', lng: 120.20, lat: 30.30 });
  store.upsertPoi({ ...POI, poi_id: 'C', name: 'C点', rating: '', category: 'sight', lng: 120.15, lat: 30.25 });

  // 分类
  assert.strictEqual(store.listPois({ city: '杭州', category: 'food' }).total, 2);
  // 评分下限（空评分不算命中）
  assert.strictEqual(store.listPois({ city: '杭州', minRating: 4 }).total, 1);
  // bbox
  assert.strictEqual(
    store.listPois({ city: '杭州', bbox: { minLng: 120.05, maxLng: 120.16, minLat: 30.15, maxLat: 30.26 } }).total,
    2
  );
  // 按评分降序：有评分的在前，空评分垫底
  const byRating = store.listPois({ city: '杭州', sort: 'rating' }).rows.map((r) => r.poi_id);
  assert.deepStrictEqual(byRating, ['A', 'B', 'C']);
  // 分页
  const page = store.listPois({ city: '杭州', sort: 'rating', limit: 1, offset: 1 });
  assert.strictEqual(page.total, 3);
  assert.deepStrictEqual(page.rows.map((r) => r.poi_id), ['B']);
});

test('本地关键词搜索：多词 AND、名字命中优先于只有地址命中', () => {
  const store = createPoiStore({ ttlMs: 60_000 });
  store.upsertPoi({ ...POI, poi_id: 'X', name: '西湖风景名胜区', address: '西湖区', rating: '4.9' });
  store.upsertPoi({ ...POI, poi_id: 'Y', name: '某民宿', address: '西湖湖滨商圈', rating: '5.0' });
  const hits = store.searchPoisLocal({ city: '杭州', keywords: '西湖' });
  assert.strictEqual(hits[0].poi_id, 'X', '名字里有的要排在只有地址里有的前面');
  assert.strictEqual(hits.length, 2);
  // 多词 AND
  assert.strictEqual(store.searchPoisLocal({ city: '杭州', keywords: '西湖 民宿' }).length, 1);
});

test('点地图就近：按距离排序、超出方框的不返回', () => {
  const store = createPoiStore({ ttlMs: 60_000 });
  store.upsertPoi({ ...POI, poi_id: 'NEAR', lng: 120.1501, lat: 30.2501 });
  store.upsertPoi({ ...POI, poi_id: 'FAR', lng: 120.16, lat: 30.26 });
  const hits = store.poisNearPoint({ lng: 120.15, lat: 30.25, deg: 0.0015 });
  assert.deepStrictEqual(hits.map((r) => r.poi_id), ['NEAR']);
});

test('poi-store 里没有任何落盘调用（不 require sqlite / fs）', () => {
  assert.ok(!/node:sqlite/.test(STORE), 'poi-store 不该碰 sqlite');
  assert.ok(!/require\('node:fs'\)/.test(STORE), 'poi-store 不该碰文件系统');
  assert.match(STORE, /new Map\(\)/, '应该用内存 Map');
});
