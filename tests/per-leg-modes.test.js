/* 「先按时间最短规划」+「分路段不同交通方式」（2026-11-17）
   用户原话：「可以分路段不同的交通方式 先以时间最短的方式进行规划」
   服务端：mode=auto（每段各取最快）/ modes=a,b,c（每段指定）/ mode=key（全段一个）
   前端：芯片多了「最快」且是默认、每段能单独换方式、地图按段上色。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const API = read('web/js/api.js');
const ROUTE = read('web/js/route.js');
const MAP = read('web/js/map.js');

// 每种方式给的耗时不同：骑行最快、驾车次之、公交再次、步行最慢
const DURATION = { riding: 900, driving: 1000, transit: 2000, walking: 3000 };
const DISTANCE = { riding: 2500, driving: 2600, transit: 4000, walking: 2400 };

function fakeAmap(opts = {}) {
  const calls = [];
  const leg = (mode) => ({
    mode,
    distance: DISTANCE[mode],
    duration: DURATION[mode],
    polyline: [[120.1, 30.2], [120.2, 30.3]],
    steps: [{ instruction: mode + ' 一步', distance: DISTANCE[mode], duration: DURATION[mode], polyline: [[120.1, 30.2], [120.2, 30.3]] }],
    transit: mode === 'transit' ? { segments: [{ type: 'bus', name: '28路', distance: 4000, duration: 2000 }] } : null,
    degraded: false,
  });
  const wrap = (mode) => async (o, d) => {
    calls.push({ mode, o, d });
    if (opts.fail && opts.fail.includes(mode)) throw new Error(mode + ' 不可用');
    return leg(mode);
  };
  return {
    calls,
    planWalking: wrap('walking'),
    planRiding: wrap('riding'),
    planDriving: wrap('driving'),
    planTransit: wrap('transit'),
  };
}

async function start(amap) {
  const db = createDb(':memory:');
  const app = createApp({
    config: { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' },
    categories: [],
    db,
    amap,
    routeIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    db,
    close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })),
  };
}

const getJson = async (url) => {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch (err) { body = null; }
  return { status: res.status, body };
};

async function seed(base, n) {
  const trip = (await (await fetch(base + '/api/trips', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city: '杭州', title: '杭州行程' }),
  })).json()).data;
  for (let i = 0; i < n; i += 1) {
    await fetch(base + '/api/pins', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip_id: trip.id, name: 'P' + i, lng: 120.1 + i / 100, lat: 30.2 + i / 100, category: 'sight' }),
    });
  }
  return trip;
}

const itin = (base, q) => getJson(base + '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&' + q);

// ---------- 服务端 ----------

test('mode=auto：每段各自挑用时最短的那种方式，并把四种的耗时都带回来', async () => {
  const amap = fakeAmap();
  const s = await start(amap);
  try {
    await seed(s.base, 3); // 2 段
    const r = await itin(s.base, 'mode=auto');
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.mode, 'auto');
    assert.equal(d.auto, true);
    assert.equal(d.legs.length, 2);
    d.legs.forEach((l) => {
      assert.equal(l.mode, 'riding', '骑行 900s 最短，应被选中');
      assert.equal(l.modeLabel, '骑行');
      assert.equal(l.duration, 900);
      assert.deepEqual(
        l.modeOptions.map((o) => o.mode).sort(),
        ['driving', 'riding', 'transit', 'walking'],
        '四种方式的耗时都要给前端（每段的选择器要用）'
      );
      const fastest = l.modeOptions.reduce((a, b) => (b.duration < a.duration ? b : a));
      assert.equal(fastest.mode, 'riding');
    });
    assert.equal(d.totalDuration, 1800);
    assert.equal(d.totalDistance, 5000);
    // 每段四种方式各打一次
    assert.equal(amap.calls.length, 8);
  } finally {
    await s.close();
  }
});

test('auto：某种方式规划失败就跳过它，不影响这一段与整条行程', async () => {
  const amap = fakeAmap({ fail: ['riding'] });
  const s = await start(amap);
  try {
    await seed(s.base, 2);
    const r = await itin(s.base, 'mode=auto');
    assert.equal(r.status, 200);
    const leg = r.body.data.legs[0];
    assert.equal(leg.mode, 'driving', '骑行挂了就退到次快的驾车');
    const bad = leg.modeOptions.find((o) => o.mode === 'riding');
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /不可用/);
  } finally {
    await s.close();
  }
});

test('modes=a,b,c：每段指定方式，混着也照办（mode 返回 mixed）', async () => {
  const amap = fakeAmap();
  const s = await start(amap);
  try {
    await seed(s.base, 3);
    const r = await itin(s.base, 'modes=walking,driving');
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.deepEqual(d.legs.map((l) => l.mode), ['walking', 'driving']);
    assert.deepEqual(d.legs.map((l) => l.modeLabel), ['步行', '驾车']);
    assert.equal(d.mode, 'mixed');
    assert.equal(d.mixed, true);
    assert.equal(d.totalDuration, 3000 + 1000);
    assert.equal(d.totalDistance, 2400 + 2600);
    assert.deepEqual(amap.calls.map((c) => c.mode), ['walking', 'driving'], '指定了就别乱试别的');
  } finally {
    await s.close();
  }
});

test('modes 全一样时不算混合（mode 直接给那一种）', async () => {
  const s = await start(fakeAmap());
  try {
    await seed(s.base, 3);
    const d = (await itin(s.base, 'modes=driving,driving')).body.data;
    assert.equal(d.mode, 'driving');
    assert.equal(d.mixed, false);
  } finally {
    await s.close();
  }
});

test('modes 的边界：个数对不上 400、名字认不出 400', async () => {
  const s = await start(fakeAmap());
  try {
    await seed(s.base, 3); // 2 段
    const few = await itin(s.base, 'modes=walking');
    assert.equal(few.status, 400);
    assert.match(few.body.error.msg, /要给 2 个/);

    const bad = await itin(s.base, 'modes=walking,teleport');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.msg, /认不出/);
  } finally {
    await s.close();
  }
});

test('换了每段方式后，modeOptions 从缓存里带出四种耗时（切方式不用再打高德）', async () => {
  const amap = fakeAmap();
  const s = await start(amap);
  try {
    await seed(s.base, 2);
    await itin(s.base, 'mode=auto'); // 先把四种方式都算一遍（进缓存）
    const before = amap.calls.length;
    const r = await itin(s.base, 'modes=walking');
    assert.equal(r.status, 200);
    const opts = r.body.data.legs[0].modeOptions;
    assert.equal(opts.length, 4, '缓存里有四种就都列出来');
    assert.equal(amap.calls.length, before, '全走缓存，切方式不该再打高德');
  } finally {
    await s.close();
  }
});

test('单段接口也认 auto（mode 非法提示里带上 auto）', async () => {
  const s = await start(fakeAmap());
  try {
    const ok = await getJson(s.base + '/api/route?mode=auto&origin=120.1,30.2&destination=120.2,30.3&city=' + encodeURIComponent('杭州'));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.mode, 'riding');
    assert.equal(ok.body.data.modeOptions.length, 4);

    const bad = await getJson(s.base + '/api/route?mode=fly&origin=120.1,30.2&destination=120.2,30.3');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.msg, /auto/);
  } finally {
    await s.close();
  }
});

// ---------- 前端 ----------

test('前端：芯片里多了「最快」且是默认；选它会清掉每段的自选方式', () => {
  assert.match(ROUTE, /key: 'auto', label: '最快'/);
  assert.match(ROUTE, /const DEFAULT_MODE = 'auto'/);
  assert.match(ROUTE, /const CHIPS = \[AUTO_MODE\]\.concat\(MODES\)/);
  const chips = ROUTE.match(/function renderChips\(\)[\s\S]*?\n  \}/);
  assert.ok(chips, '缺 renderChips');
  assert.match(chips[0], /perLeg = null;/, '点芯片要回到「全段一种方式」');
  assert.match(chips[0], /renderModesNote\(\)/);
});

test('前端：每段能单独换方式，换了之后只重规划那一段的组合', () => {
  const fn = ROUTE.match(/function setLegMode\(index, key\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 setLegMode');
  assert.match(fn[0], /current\[index\] = key/);
  assert.match(fn[0], /perLeg = current/, '混着就是每段各自');
  assert.match(fn[0], /draw\(lastCity, lastPins\)/);
  // 段行上要有方式小标 + 「这一段怎么走」四选一
  assert.match(ROUTE, /route-leg-mode/, '缺段方式小标');
  assert.match(ROUTE, /leg-mode-btn/, '缺每段方式按钮');
  assert.match(ROUTE, /function legModePicker/);
  assert.match(HTML, /id="route-modes-note"/, '缺「每段各自的方式」那行说明');
  assert.match(CSS, /\.leg-mode-btn/, '缺每段方式按钮样式');
  assert.match(CSS, /\.route-leg-mode/, '缺段方式小标样式');
});

test('前端：地图按「这一段自己的方式」上色，不再全用当前芯片那一种', () => {
  const fn = MAP.match(/function drawRoute\(legs, mode, handlers\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 drawRoute');
  assert.match(fn[0], /const legMode = leg\.mode \|\| mode/, '每段优先用自己的方式');
  assert.match(fn[0], /routeStyle\(legMode\)/);
});

test('前端：最快规划时请求 mode=auto，混合时请求 modes=…', () => {
  const fn = ROUTE.match(/async function draw\(city, pins\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 draw');
  assert.match(fn[0], /API\.itineraryRoute\(lastCity, \{ modes: perLeg \}\)/);
  assert.match(fn[0], /API\.itineraryRoute\(lastCity, mode\)/);
  assert.match(API, /modes: o\.modes && o\.modes\.length \? o\.modes\.join\(','\) : undefined/);
  assert.match(API, /mode: o\.modes && o\.modes\.length \? undefined : o\.mode/, '给 modes 时别再带上 mode');
  // 进度条要说人话
  assert.match(fn[0], /按最快的方式逐段规划/);
});
