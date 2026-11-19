/* 分享给别人的东西里也要有「我这条线」（2026-11-18 用户：「分享给别人的时候也有线」）
   ① 分享页第一屏＝按我的安排（每段自己的方式），后面才是各方式全程
   ② 分享出去的文案里，每个点上面也写清「从上一站过来多远/多久/什么方式」
   全部离线（假高德），不消耗真配额 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const routemap = require('../server/routemap');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('web/js/app.js');
const SHARE = read('server/share.js');
const TRIPS = read('server/routes/trips.js');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }];

// 假高德：每段返回直线折线 + 按方式区分的里程/耗时；staticMap 返回假 PNG
function fakeAmap() {
  const calls = { driving: 0, riding: 0, walking: 0, transit: 0, staticMap: 0 };
  const mk = (o, d, dist, dur) => {
    const [olng, olat] = String(o).split(',').map(Number);
    const [dlng, dlat] = String(d).split(',').map(Number);
    return { polyline: [[olng, olat], [dlng, dlat]], distance: dist, duration: dur };
  };
  return {
    calls,
    async planDriving(o, d) { calls.driving += 1; return mk(o, d, 2000, 500); },
    async planRiding(o, d) { calls.riding += 1; return mk(o, d, 1500, 600); },
    async planWalking(o, d) { calls.walking += 1; return mk(o, d, 1000, 700); },
    async planTransit(o, d, city) {
      if (!city) throw new Error('公交需要城市名');
      calls.transit += 1;
      return Object.assign(mk(o, d, 2500, 900), { transit: { segments: [] } });
    },
    async staticMap() {
      calls.staticMap += 1;
      return { buffer: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png;charset=UTF-8' };
    },
  };
}

async function start(amap) {
  const db = createDb(':memory:');
  const app = createApp({ authFallbackUser: true, config: TEST_CONFIG, categories: CATEGORIES, db, amap, routeIntervalMs: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, db, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

async function post(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

// 三个点（A→B→C），都落库在同一趟行程里
async function seed(base) {
  const trip = (await post(base, '/api/trips', { city: '杭州', title: '杭州行程' })).body.data;
  const pins = [];
  const coords = [[120.1, 30.2], [120.2, 30.3], [120.3, 30.4]];
  for (let i = 0; i < 3; i += 1) {
    const r = await post(base, '/api/pins', {
      trip_id: trip.id,
      name: 'P' + i,
      lng: coords[i][0],
      lat: coords[i][1],
      category: 'sight',
    });
    pins.push(r.body.data);
  }
  return { trip, pins };
}

const keys = (pins) => pins.map((p) => 'pin:' + p.id);

// ---------- 服务端 ----------

test('buildPlanMap：一条线、每段自己的方式，标题是「按我的安排」', async () => {
  const amap = fakeAmap();
  const map = await routemap.buildPlanMap({
    amap,
    cache: null,
    intervalMs: 0,
    stops: [
      { name: 'A', lng: 120.1, lat: 30.2 },
      { name: 'B', lng: 120.2, lat: 30.3 },
      { name: 'C', lng: 120.3, lat: 30.4 },
    ],
    perLegModes: ['driving', 'riding'],
    city: '杭州',
  });
  assert.equal(map.mode, 'plan');
  assert.equal(map.modeLabel, '按我的安排');
  assert.deepEqual(map.legs.map((l) => l.mode), ['driving', 'riding']);
  assert.deepEqual(map.legs.map((l) => l.modeLabel), ['驾车', '骑行']);
  assert.deepEqual(map.legs.map((l) => l.distance), [2000, 1500]);
  assert.equal(map.distance, 3500);
  assert.equal(map.duration, 1100);
  assert.equal(map.legs[0].fromSeq, 1);
  assert.equal(map.legs[1].toSeq, 3);
  assert.match(map.image, /^data:image\/png;charset=UTF-8;base64,/);
  assert.equal(amap.calls.driving, 1, '第一段走驾车');
  assert.equal(amap.calls.riding, 1, '第二段走骑行');
  assert.equal(amap.calls.staticMap, 1, '一条线只出一张图');
  assert.equal(map.pins.length, 3, '序号热区照旧');
});

test('buildPlanMap：段方式全一样时标题就用那个方式', async () => {
  const amap = fakeAmap();
  const map = await routemap.buildPlanMap({
    amap,
    cache: null,
    intervalMs: 0,
    stops: [{ name: 'A', lng: 120.1, lat: 30.2 }, { name: 'B', lng: 120.2, lat: 30.3 }],
    perLegModes: ['walking'],
    city: '杭州',
  });
  assert.equal(map.modeLabel, '步行');
});

test('分享导出：planModes 给对了 ⇒ 第一屏就是「按我的安排」，各方式全程照旧都在', async () => {
  const amap = fakeAmap();
  const s = await start(amap);
  try {
    const { trip, pins } = await seed(s.base);
    const r = await post(s.base, '/api/trips/' + trip.id + '/share/export', {
      order: keys(pins),
      modes: ['driving', 'walking'],
      planModes: ['driving', 'riding'],
    });
    assert.equal(r.status, 200);
    const out = r.body.data;
    assert.equal(out.maps[0].mode, 'plan', '按我的安排排在第一屏');
    assert.equal(out.maps[0].label, '按我的安排');
    assert.equal(out.maps[0].distance, 3500);
    assert.equal(out.maps[0].bytes > 0, true);
    assert.deepEqual(out.maps.slice(1).map((m) => m.mode).sort(), ['driving', 'walking']);
    assert.equal(Object.keys(out.mapErrors || {}).length, 0);
    assert.equal(amap.calls.staticMap, 3, '按我的安排 + 驾车 + 步行 = 3 张图');

    // 分享页：plan 的那一屏在最前，分段行写清这一段的方式
    const payload = share.buildPayload({
      trip: { id: trip.id, title: '杭州行程' },
      city: '杭州',
      stops: pins.map((p, i) => ({ seq: i + 1, name: p.name, lng: p.lng, lat: p.lat })),
      labels: { sight: { label: '景点' } },
    });
    payload.maps = {
      plan: await routemap.buildPlanMap({
        amap,
        cache: null,
        intervalMs: 0,
        stops: pins,
        perLegModes: ['driving', 'riding'],
        city: '杭州',
      }),
    };
    const html = share.buildHtml(payload);
    const planAt = html.indexOf('data-mode="plan"');
    assert.ok(planAt > 0, '缺按我的安排这一屏');
    assert.match(html, /按我的安排/);
    assert.match(html, /class="leg-mode">骑行</);
    assert.match(html, /class="leg-mode">驾车</);
  } finally {
    await s.close();
  }
});

test('分享导出：planModes 长度/名字对不上 ⇒ 宁可不画，也不画错', async () => {
  const amap = fakeAmap();
  const s = await start(amap);
  try {
    const { trip, pins } = await seed(s.base);
    for (const bad of [['driving'], ['driving', 'riding', 'walking'], ['driving', 'flying'], []]) {
      const r = await post(s.base, '/api/trips/' + trip.id + '/share/export', {
        order: keys(pins),
        modes: ['driving'],
        planModes: bad,
      });
      assert.equal(r.status, 200, '坏 planModes 不能把分享打挂');
      const out = r.body.data;
      assert.ok(!out.maps.some((m) => m.mode === 'plan'), '不该出现按我的安排：' + JSON.stringify(bad));
      assert.ok(out.maps.some((m) => m.mode === 'driving'), '各方式全程照旧');
    }
  } finally {
    await s.close();
  }
});

test('分享文案（复制到微信那份）也有线：每个点上面写清从上一站怎么过来', async () => {
  const amap = fakeAmap();
  const s = await start(amap);
  try {
    const { trip, pins } = await seed(s.base);
    const r = await post(s.base, '/api/trips/' + trip.id + '/share/export', {
      order: keys(pins),
      modes: ['driving'],
      planModes: ['driving', 'riding'],
    });
    const text = r.body.data.text;
    assert.match(text, /按我的安排全程：3\.5 km · 18 min/, '文案里要说清这条线全程多少');
    assert.match(text, /1\. P0/);
    assert.match(text, /↑ 从第 1 站：驾车 2\.0 km · 8 min/, '第二站要写清从第一站怎么过来');
    assert.match(text, /↑ 从第 2 站：骑行 1\.5 km · 10 min/, '第三站写清方式');
    assert.match(text, /驾车全程：4\.0 km/, '各方式全程照旧');
    // 序号要对：↑ 写在对应那个点的上面
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /^2\. P1/.test(l));
    assert.ok(/↑ 从第 1 站/.test(lines[at - 1] || ''), '↑ 要写在那个点的上一行');
  } finally {
    await s.close();
  }
});

// ---------- 前端 ----------

test('app.js：分享时把页面上那条线的每段方式带上（长度对不上就不带）', () => {
  const fn = APP.match(/function planModesForShare\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 planModesForShare');
  assert.match(fn[0], /Route\.getLegs\(\)/, '拿页面上的那条线');
  assert.match(fn[0], /legs\.length !== pins\.length - 1/, '段数对不上就不带');
  assert.match(fn[0], /return modes\.length === legs\.length \? modes : undefined/, '每段都要有方式才带');
  assert.match(APP, /planModes: planModesForShare\(\)/, '分享请求里要带上它');
  assert.match(TRIPS, /function parsePlanModes\(raw, legCount\)/, '服务端要把关');
  assert.match(TRIPS, /MODE_KEYS\.includes\(m\)/, '认不出的方式要挡住');
  assert.match(TRIPS, /built\.maps\.plan = await routemap\.buildPlanMap/, '先画按我的安排');
  assert.match(SHARE, /leg-mode/, '分享页的分段行要能显示这一段的方式');
});
