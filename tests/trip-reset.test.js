const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('web/js/app.js');
const API = read('web/js/api.js');
const SEL = read('web/js/selection.js');

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

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: { async searchPoiAround() { return []; }, async searchPoiInArea() { return []; } },
    collectIntervalMs: 0,
    ...opts,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    db,
    base,
    close: () =>
      new Promise((resolve) =>
        app.server.close(() => {
          if (!opts.db) db.close();
          resolve();
        })
      ),
  };
}

const req = async (base, p, opts) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, body };
};

const postJson = (base, p, payload) =>
  req(base, p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

// ---------- 服务端：按城市删干净 ----------

test('DELETE /api/trips?city= 删掉该城市全部行程与地点，选中态随之清空（不再有幽灵星标）', async () => {
  const h = await start();
  try {
    // 造两条同城行程 + 各自一个点（模拟历史遗留的多行程），再给别的城市留一条做对照
    const t1 = await postJson(h.base, '/api/trips', { city: '杭州', title: '杭州 · 第一次' });
    const t2 = await postJson(h.base, '/api/trips', { city: '杭州', title: '杭州 · 第二次' });
    const other = await postJson(h.base, '/api/trips', { city: '上海', title: '上海 · 行程' });
    assert.equal(t1.status, 200);
    assert.equal(t2.status, 200);
    for (const [t, id] of [[t1, 'P1'], [t2, 'P2']]) {
      const r = await postJson(h.base, '/api/pins', {
        trip_id: t.body.data.id,
        poi_id: id,
        name: '点' + id,
        lng: 120.1,
        lat: 30.1,
        category: 'food',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const before = await req(h.base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.equal(before.body.data.count, 2, '按城市看：两个点都在（跨行程并集）');

    const del = await req(h.base, '/api/trips?city=' + encodeURIComponent('杭州'), {
      method: 'DELETE',
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.data.deleted, true);
    assert.equal(del.body.data.trips, 2, '两条同城行程都要删');
    assert.equal(del.body.data.pins, 2, '两条行程下的点都要删');

    const after = await req(h.base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.equal(after.body.data.count, 0, '删完后该城市不应还有任何选中点');
    const tripsAfter = await req(h.base, '/api/trips?city=' + encodeURIComponent('杭州'));
    assert.deepEqual(tripsAfter.body.data, [], '该城市不应再有行程');

    // 别的城市不受影响
    const sh = await req(h.base, '/api/selection?city=' + encodeURIComponent('上海'));
    const shTrips = await req(h.base, '/api/trips?city=' + encodeURIComponent('上海'));
    assert.equal(Array.isArray(shTrips.body.data) && shTrips.body.data.length, 1);
    assert.ok(sh, '上海查询不应报错');
    assert.equal(other.status, 200);
  } finally {
    await h.close();
  }
});

test('DELETE /api/trips?city= 缺 city → 400', async () => {
  const h = await start();
  try {
    const r = await req(h.base, '/api/trips', { method: 'DELETE' });
    assert.equal(r.status, 400);
  } finally {
    await h.close();
  }
});

test('db.deleteCityTrips：只删本城市，且返回删了几条行程/几个点', () => {
  const db = createDb(':memory:');
  const a = db.createTrip({ city: '杭州', title: 'A', userId: 1});
  const b = db.createTrip({ city: '杭州', title: 'B', userId: 1});
  const c = db.createTrip({ city: '上海', title: 'C', userId: 1});
  db.addPin({ trip_id: a.id, poi_id: 'X1', name: 'x1', lng: 1, lat: 1, category: 'food' });
  db.addPin({ trip_id: b.id, poi_id: 'X2', name: 'x2', lng: 2, lat: 2, category: 'food' });
  db.addPin({ trip_id: c.id, poi_id: 'Y1', name: 'y1', lng: 3, lat: 3, category: 'food' });
  const res = db.deleteCityTrips('杭州', 1);
  assert.deepEqual({ trips: res.trips, pins: res.pins }, { trips: 2, pins: 2 });
  assert.equal(db.listTrips(1, '杭州').length, 0);
  assert.equal(db.listTrips(1, '上海').length, 1);
  assert.equal(db.getPinsByTrip(c.id).length, 1, '别的城市的点不能动');
  // 幂等：再删一次不报错
  assert.deepEqual(db.deleteCityTrips('杭州', 1), { city: '杭州', trips: 0, pins: 0 });
  db.close();
});

// ---------- 前端：删除后必须清星 ----------

test('删除行程走「按城市删」+ 本地清选中 + 刷列表（幽灵星标的修复点）', () => {
  assert.match(API, /clearCityTrips:/, 'api.js 缺 clearCityTrips');
  assert.match(API, /'\/api\/trips\?'/, 'clearCityTrips 应打 /api/trips?city=');
  assert.match(SEL, /function\s+reset\(\)/, 'selection.js 缺 reset');
  assert.match(SEL, /\n    reset,/, 'reset 未导出');

  const m = APP.match(/async function onDeleteTrip[\s\S]*?\n  \}/);
  assert.ok(m, '缺 onDeleteTrip');
  assert.match(m[0], /API\.clearCityTrips\(state\.city\)/, '应整城删，而不是只删一条行程');
  assert.match(m[0], /Selection\.reset\(\)/, '删完必须清本地选中（否则会留星标）');
  assert.match(m[0], /await reloadSelection\(\)/, '删完要与后端对齐');
  assert.match(m[0], /refresh\(\)/, '删完要重画列表与地图');
  // 先清本地再对齐：顺序上 reset 必须在 reloadSelection 之前
  assert.ok(
    m[0].indexOf('Selection.reset()') < m[0].indexOf('await reloadSelection()'),
    '应先本地清星再与后端对齐'
  );
});

test('读选中失败时清空兜底；同城不多建第二条行程', () => {
  const r = APP.match(/async function reloadSelection[\s\S]*?\n  \}/);
  assert.ok(r, '缺 reloadSelection');
  assert.match(r[0], /Selection\.reset\(\)/, '读取失败应清空（否则旧星标留着）');
  const nb = APP.match(/trip-new-btn'\)\.onclick = async[\s\S]*?\n    \};/);
  assert.ok(nb, '缺「新建行程」绑定');
  assert.match(nb[0], /if \(state\.trip\)/, '已有行程时不应再造第二个');
  assert.match(nb[0], /同城只保留一个/, '应提示同城只保留一个行程');
});
