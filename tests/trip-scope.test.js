/* 一城多趟：规划页一次只改「某一趟」（2026-11-19）
   以前的毛病：选中/排序/导出按「城市」算，同城两趟的点会并集混在一起。
   现在每个请求都可以带 tripId，服务端按那一趟办事；不带才回退到该城第一趟。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const TEST_CONFIG = { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' };

const fakeAmap = () => ({
  async amapGet() {
    return { status: '1' };
  },
  async planDriving() {
    return { mode: 'driving', distance: 1000, duration: 600, polyline: [[120.1, 30.2], [120.2, 30.3]], steps: [], degraded: false };
  },
});

async function start() {
  const db = createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }],
    db,
    amap: fakeAmap(),
    routeIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, db, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

async function call(base, method, url, body, cookie) {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    json = null;
  }
  return { status: res.status, body: json };
}

async function signup(base, username) {
  const r = await call(base, 'POST', '/api/auth/register', { username, password: 'pass-' + username + '-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: r.body.data.user ? null : null };
}

async function userCookie(base, username) {
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'pass-' + username + '-1' }),
  });
  return (reg.headers.get('set-cookie') || '').split(';')[0];
}

const poi = (id, name, lng, lat) => ({ id, name, lng, lat, category: 'sight' });

async function seedTwoTrips(base, cookie) {
  const a = await call(base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 西线', theme: '西线' }, cookie);
  const b = await call(base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 东线', theme: '东线' }, cookie);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const tA = a.body.data;
  const tB = b.body.data;
  // A 趟：天涯海角、南山；B 趟：大东海、亚龙湾；另外两个趟里都放「三亚湾」（同名不同趟）
  for (const [tripId, p] of [
    [tA.id, poi('p-th', '天涯海角', 109.35, 18.29)],
    [tA.id, poi('p-ns', '南山', 109.2, 18.3)],
    [tA.id, poi('p-bay', '三亚湾', 109.46, 18.28)],
    [tB.id, poi('p-ddh', '大东海', 109.52, 18.22)],
    [tB.id, poi('p-ylb', '亚龙湾', 109.65, 18.24)],
    [tB.id, poi('p-bay', '三亚湾', 109.46, 18.28)],
  ]) {
    const r = await call(base, 'POST', '/api/selection', { city: '三亚', tripId, poi: p }, cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.tripId, tripId, '加点要落在指定那一趟');
  }
  return { tA, tB };
}

test('按 tripId 看/改：两趟的点不再并集', async () => {
  const s = await start();
  try {
    const cookie = await userCookie(s.base, 'scope-a');
    const { tA, tB } = await seedTwoTrips(s.base, cookie);

    const byA = await call(s.base, 'GET', `/api/selection?tripId=${tA.id}`, null, cookie);
    assert.deepEqual(byA.body.data.pins.map((p) => p.name).sort(), ['三亚湾', '南山', '天涯海角'].sort());
    assert.equal(byA.body.data.tripId, tA.id);

    const byB = await call(s.base, 'GET', `/api/selection?tripId=${tB.id}`, null, cookie);
    assert.deepEqual(byB.body.data.pins.map((p) => p.name).sort(), ['亚龙湾', '三亚湾', '大东海'].sort());

    // 不带 tripId：回退到该城第一趟（A）
    const fallback = await call(s.base, 'GET', '/api/selection?city=' + encodeURIComponent('三亚'), null, cookie);
    assert.equal(fallback.body.data.tripId, tA.id, '不带就回退第一趟');
    assert.equal(fallback.body.data.count, 3);
  } finally {
    await s.close();
  }
});

test('排序 / 删除都只动指定那一趟（同一个点在两趟里互不影响）', async () => {
  const s = await start();
  try {
    const cookie = await userCookie(s.base, 'scope-b');
    const { tA, tB } = await seedTwoTrips(s.base, cookie);

    // A 趟倒着排
    const order = await call(
      s.base,
      'PUT',
      '/api/selection/order',
      { tripId: tA.id, poi_ids: ['p-bay', 'p-ns', 'p-th'] },
      cookie
    );
    assert.equal(order.status, 200);
    assert.deepEqual(order.body.data.pins.map((p) => p.name), ['三亚湾', '南山', '天涯海角']);
    const bStill = await call(s.base, 'GET', `/api/selection?tripId=${tB.id}`, null, cookie);
    assert.deepEqual(bStill.body.data.pins.map((p) => p.name), ['大东海', '亚龙湾', '三亚湾'], 'B 趟顺序没被动');

    // 从 A 删掉「三亚湾」：B 趟里的那个还在
    const del = await call(s.base, 'DELETE', `/api/selection?poi_id=p-bay&tripId=${tA.id}`, null, cookie);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.data.pins.map((p) => p.name), ['南山', '天涯海角']);
    const bAfter = await call(s.base, 'GET', `/api/selection?tripId=${tB.id}`, null, cookie);
    assert.ok(bAfter.body.data.pins.some((p) => p.name === '三亚湾'), 'B 趟的三亚湾不该被删');
  } finally {
    await s.close();
  }
});

test('导出 / 逐段规划都认 tripId（标题与点都是那一趟的）', async () => {
  const s = await start();
  try {
    const cookie = await userCookie(s.base, 'scope-c');
    const { tB } = await seedTwoTrips(s.base, cookie);

    const md = await fetch(s.base + `/api/selection/export?tripId=${tB.id}`, { headers: { Cookie: cookie } });
    assert.equal(md.status, 200);
    const text = await md.text();
    assert.match(text, /^# 三亚 · 东线（3 个地点）/m);

    const route = await call(s.base, 'GET', `/api/itinerary/route?tripId=${tB.id}&mode=driving`, null, cookie);
    assert.equal(route.status, 200, JSON.stringify(route.body));
    assert.equal(route.body.data.legs.length, 2, '3 个点 = 2 段');
  } finally {
    await s.close();
  }
});

test('别人的 tripId 一律 404（看 / 加 / 排 / 删 / 导出）', async () => {
  const s = await start();
  try {
    const alice = await userCookie(s.base, 'scope-alice');
    const bob = await userCookie(s.base, 'scope-bob');
    const { tA } = await seedTwoTrips(s.base, alice);

    for (const [method, url, body] of [
      ['GET', `/api/selection?tripId=${tA.id}`, null],
      ['POST', '/api/selection', { tripId: tA.id, poi: poi('x', '插队', 109.1, 18.1) }],
      ['PUT', '/api/selection/order', { tripId: tA.id, poi_ids: ['p-th'] }],
      ['DELETE', `/api/selection?poi_id=p-th&tripId=${tA.id}`, null],
      ['GET', `/api/itinerary/route?tripId=${tA.id}&mode=driving`, null],
    ]) {
      const r = await call(s.base, method, url, body, bob);
      assert.equal(r.status, 404, method + ' ' + url + ' 应 404，实际 ' + r.status);
    }
    const md = await fetch(s.base + `/api/selection/export?tripId=${tA.id}`, { headers: { Cookie: bob } });
    assert.equal(md.status, 404);
  } finally {
    await s.close();
  }
});

test('前端接线：切换器 + 请求都带 tripId；链接能直接打开某一趟', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const html = read('web/index.html');
  assert.match(html, /id="trip-switch"/, '行程卡要有「当前一趟」切换器');
  const app = read('web/js/app.js');
  assert.match(app, /async function switchTrip\(/, '缺 switchTrip');
  assert.match(app, /params\.get\('trip'\)/, '要支持 /app?trip=<id> 直接打开某一趟');
  assert.match(app, /tripId: state\.tripId/, '画路线时要带 tripId');
  const api = read('web/js/api.js');
  assert.match(api, /getSelection: \(city, tripId\)/, '拉选中要能带 tripId');
  assert.match(api, /tripId: o\.tripId/, '逐段规划要能带 tripId');
  const route = read('web/js/route.js');
  assert.match(route, /lastTripId/, 'route.js 要记住这次画的是哪一趟');
  const sel = read('web/js/selection.js');
  assert.match(sel, /async function load\(nextCity, nextTripId\)/, 'selection.load 要收 tripId');
});

test('我的行程页「去规划」点到具体那一趟', () => {
  const ROOT = path.join(__dirname, '..');
  const trips = fs.readFileSync(path.join(ROOT, 'web/js/trips.js'), 'utf8');
  assert.match(trips, /\/app\?trip=/, '行程卡的「去规划」应带上 trip=<id>');
});
