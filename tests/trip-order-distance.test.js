/* 点的顺序与「路线就在一张清单里」（2026-11-18）
   用户原话：「我觉得路线的话 尽量要看下都放在一起 算下每个点的距离，默认顺序先按照地点的距离计算」
   ① 默认顺序＝按地点之间的距离（最近邻，从住宿出发；没定就从第一个点），库里那份原样留着
   ② 切「手动顺序」＝看库里那份；拖拽/↑↓ 才落库，并自动切成手动顺序
   ③ 路线不再另开一张段清单：每个点上方一条「从上一站过来多远/多久/累计」
   ④ 页面上的点序（默认按距离那份）必须随请求带给服务端：逐段规划 / 分享 / 导出 / 复制都按它走 */
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
const ITIN = read('web/js/itinerary.js');
const PLANNER = read('web/js/planner.js');

const TEST_CONFIG = { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' };

// 只认坐标的假高德：每段回一个固定耗时，顺便记下「这一段是从谁到谁」
function fakeAmap() {
  const calls = [];
  const leg = async (o, d) => {
    calls.push({ o, d });
    return {
      mode: 'driving',
      distance: 1000,
      duration: 600,
      polyline: [[120.1, 30.2], [120.2, 30.3]],
      steps: [{ instruction: '直行', distance: 1000, duration: 600 }],
      transit: null,
      degraded: false,
    };
  };
  return { calls, planDriving: leg, planWalking: leg, planRiding: leg, planTransit: leg };
}

async function start(amap) {
  const db = createDb(':memory:');
  const app = createApp({ authFallbackUser: true, config: TEST_CONFIG, categories: [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }], db, amap, routeIntervalMs: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, db, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

const json = async (res) => {
  let body = null;
  try { body = await res.json(); } catch (err) { body = null; }
  return { status: res.status, body };
};
const getJson = (url) => fetch(url).then(json);

async function post(base, p, body) {
  return json(await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}
async function put(base, p, body) {
  return json(await fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// 三个点：A(120.10) B(120.11) C(120.12)，注意落库顺序 A→B→C 与「按距离」不一样时才有意义
async function seed(base) {
  const trip = (await post(base, '/api/trips', { city: '杭州', title: '杭州行程' })).body.data;
  const pins = [];
  for (const name of ['A', 'B', 'C']) {
    const r = await post(base, '/api/pins', {
      trip_id: trip.id,
      name,
      lng: 120.1 + pins.length / 100,
      lat: 30.2 + pins.length / 100,
      category: 'sight',
    });
    pins.push(r.body.data);
  }
  return { trip, pins };
}

const names = (pins) => pins.map((p) => p.name).join('');

// ---------- 服务端：显式点序随请求带过来 ----------

test('逐段规划认 order：服务端按页面上的点序排段，不再按库里的 sort_order', async () => {
  const s = await start(fakeAmap());
  try {
    const { pins } = await seed(s.base);
    // 库里是 A→B→C；页面上（按距离）实际要 C→A→B
    const order = [pins[2], pins[0], pins[1]];
    const keys = order.map((p) => 'pin:' + p.id); // /api/pins 造的点没有 poi_id ⇒ 客户端 key 是 pin:<行号>
    const r = await getJson(
      s.base + '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving&order=' + keys.join(',')
    );
    assert.equal(r.status, 200);
    const legs = r.body.data.legs;
    assert.equal(legs.length, 2);
    assert.equal(legs[0].from.name, 'C');
    assert.equal(legs[0].to.name, 'A');
    assert.equal(legs[1].from.name, 'A');
    assert.equal(legs[1].to.name, 'B');
  } finally {
    await s.close();
  }
});

test('逐段规划：order 里认不出的 key 一律忽略，点一个不丢（回落到库里那份）', async () => {
  const s = await start(fakeAmap());
  try {
    const { pins } = await seed(s.base);
    const r = await getJson(
      s.base + '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving&order=pin:' + pins[2].id + ',不存在,'
    );
    assert.equal(r.status, 200);
    const legs = r.body.data.legs;
    assert.equal(legs.length, 2, '3 个点仍然是 2 段');
    const all = [legs[0].from.name].concat(legs.map((l) => l.to.name));
    assert.deepEqual(all.slice().sort(), ['A', 'B', 'C'], '三个点都要在');
    assert.equal(all[0], 'C', '认得出的那个放最前');
  } finally {
    await s.close();
  }
});

test('行程单导出认 order：复制/下载按页面上的点序编号', async () => {
  const s = await start(fakeAmap());
  try {
    const { pins } = await seed(s.base);
    const keys = [pins[2], pins[0], pins[1]].map((p) => 'pin:' + p.id);
    const res = await fetch(
      s.base + '/api/selection/export?city=' + encodeURIComponent('杭州') + '&format=md&order=' + keys.join(',')
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => /^\d+\./.test(l));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^1\. C\b/);
    assert.match(lines[1], /^2\. A\b/);
    assert.match(lines[2], /^3\. B\b/);
    assert.ok(!/^## /m.test(text), '不再按类别分组');
  } finally {
    await s.close();
  }
});

test('分享包认 order：分享里的点序 = 页面上看到的点序', async () => {
  const s = await start(fakeAmap());
  try {
    const { trip, pins } = await seed(s.base);
    const keys = [pins[2], pins[0], pins[1]].map((p) => 'pin:' + p.id);
    const r = await post(s.base, '/api/trips/' + trip.id + '/share', { order: keys });
    assert.equal(r.status, 200);
    assert.equal(names(r.body.data.payload.stops), 'CAB');
    assert.match(r.body.data.text, /1\. C/);
  } finally {
    await s.close();
  }
});

test('库里的点序也能按 pin:<行号> 重排（geocode 出来的点没有 poi_id）', async () => {
  const s = await start(fakeAmap());
  try {
    const { pins } = await seed(s.base);
    const r = await put(s.base, '/api/selection/order', {
      city: '杭州',
      poi_ids: [pins[1].id, pins[2].id, pins[0].id].map((id) => 'pin:' + id),
    });
    assert.equal(r.status, 200);
    const after = await getJson(s.base + '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.equal(names(after.body.data.pins), 'BCA', '按行号也要能排（原来只按 poi_id，会静默漏掉）');
  } finally {
    await s.close();
  }
});

// ---------- 前端：默认按距离 + 一条清单 ----------

test('顺序默认「按距离」，切「手动顺序」＝看库里那份（切模式不动库）', () => {
  assert.match(APP, /const ORDER_KEY = 'travel\.orderMode'/, '顺序偏好要落 localStorage');
  assert.match(APP, /return window\.localStorage\.getItem\(ORDER_KEY\) === 'manual' \? 'manual' : 'distance'/, '没选过就是按距离');
  assert.match(APP, /orderMode: 'distance'/, 'state 默认按距离');
  assert.match(APP, /state\.orderMode = readOrderMode\(\)/, '启动时读回上次的选择');
  const set = APP.match(/function setOrderMode\(mode, opts\)[\s\S]*?\n  \}/);
  assert.ok(set, '缺 setOrderMode');
  assert.ok(!/Selection\.reorder/.test(set[0]), '切模式只是换个看法，不能偷偷改库里的顺序');
  // 按距离＝最近邻（从住宿出发；没定就从第一个点）
  const ordered = APP.match(/function orderedPins\(\)[\s\S]*?\n  \}/);
  assert.ok(ordered, '缺 orderedPins');
  assert.match(ordered[0], /Planner\.orderStops\(pins, start \? \{ start \} : undefined\)/, '按距离要真算（最近邻）');
  assert.match(ordered[0], /pins\.length >= 3/, '1~2 个点别重排（顺序没意义，列表还会自己跳）');
  // 2026-11-19 按天分段：算完再按「第几天」分组，组内保留原顺序
  assert.match(ordered[0], /groupByDay\(ordered\)/, '要按天分组');
  assert.match(PLANNER, /function orderStops\(stops, opts\)/, 'planner 得提供最近邻排序');
});

test('拖拽/↑↓ 才落库，并自动切成「手动顺序」（否则下次刷新又被按距离重排）', () => {
  const apply = APP.match(/async function applyManualOrder\(ids\)[\s\S]*?\n  \}/);
  assert.ok(apply, '缺 applyManualOrder');
  assert.match(apply[0], /state\.orderMode = 'manual'/, '落库前先切成手动顺序');
  assert.match(apply[0], /saveOrderMode\('manual'\)/, '偏好也要记住');
  assert.match(apply[0], /Selection\.reorder\(ids\)/, '一次落库');
  assert.match(APP, /onMove: \(index, delta\) => onMoveDisplayed\(list, index, delta\)/, '行程列表的 ↑↓ 走眼前顺序');
  assert.match(APP, /onMove: \(index, delta\) => onMoveDisplayed\(panelPins, index, delta\)/, '挑点列表的 ↑↓ 也走眼前顺序');
  const mover = APP.match(/async function onMoveDisplayed\(pins, index, delta\)[\s\S]*?\n  \}/);
  assert.ok(mover, '缺 onMoveDisplayed');
  assert.match(mover[0], /applyManualOrder\(ids\)/, '最终都汇到 applyManualOrder');
});

test('两张清单、连线、分享、导出用的是同一份顺序', () => {
  const itin = APP.match(/function renderItinerary\(\)[\s\S]*?\n  \}/);
  assert.ok(itin, '缺 renderItinerary');
  assert.match(itin[0], /const list = orderedPins\(\)/, '行程视图按这份顺序');
  assert.match(itin[0], /syncRoute\(\)/, '段数据回填后重画（一条路线只规划一次）');
  assert.match(APP, /const panelPins = orderedPins\(\)/, '挑点清单同一份顺序');
  assert.match(APP, /order: orderKeys\(orderedPins\(\)\)/, '分享带上这份顺序');
  assert.match(APP, /API\.exportSelection\(state\.city, orderKeys\(orderedPins\(\)\), state\.tripId\)/, '复制/下载带上这份顺序（以及哪一趟）');
  assert.match(API, /order: o\.order && o\.order\.length \? o\.order\.join\(','\) : undefined/, 'api 层要能带 order');
  // 实时耗时不再自己规划一遍：它读的就是 route.js 那条线（点序由 route.js 随请求带给服务端）
  assert.ok(!/API\.itineraryRoute/.test(APP), 'app.js 不得再各自发一遍逐段规划');
  assert.match(ROUTE, /order: orderKeys\(lastPins\)/, '点序由 route.js 带给服务端');
  assert.match(APP, /function orderKeys\(pins\)/, '要有统一的 key 口径');
});

test('路线就在行程这张清单里：每个点上方一条「从上一站过来」，不再另开 #route-legs', () => {
  assert.ok(!/route-legs/.test(HTML), 'index.html 不该再有 #route-legs');
  assert.ok(!/route-legs/.test(CSS), 'CSS 里也该清掉');
  const line = ROUTE.match(/function legLineHtml\(leg, opts\)[\s\S]*?\n  \}/);
  assert.ok(line, '缺 legLineHtml');
  assert.match(line[0], /起点/, '第一个点是「起点」');
  assert.match(line[0], /累计 /, '每个点要知道从起点走到这里的累计距离');
  assert.match(line[0], /fmtDuration\(leg\.duration\)/, '耗时');
  assert.match(line[0], /fmtDistance\(leg\.distance\)/, '距离');
  assert.match(line[0], /这一段没规划出来/, '拿不到要说清楚');
  assert.match(line[0], /legModeBadge\(leg\)/, '这一段是什么方式要看得出来');
  assert.match(line[0], /detailHtml\(leg\)/, '展开是路书 + 换这一段的方式');
  // 每个点只有一条到达行，第 1 个点是起点行
  assert.match(ITIN, /R\.legLineHtml\(leg, \{/, '清单里插到达行');
  assert.match(ITIN, /const leg = index > 0 \? legs\[index - 1\] : null/, '第 i 个点用第 i-1 段');
  assert.match(ITIN, /cum: cums\[index\]/, '累计距离按点序累加');
  assert.match(ITIN, /function cumulative\(legs, pinCount\)/, '缺累计距离计算');
  assert.match(ITIN, /base: handlers\.base \|\| null/, '定了住宿就说从哪儿出发');
  assert.match(APP, /base: baseForPlan\(\),/, '行程视图要把住宿锚点交给清单');
});

test('段数据回来才画：变了才重画（否则拉着一张没距离的清单）', () => {
  const hook = APP.match(/function onRouteLegs\(legs\)[\s\S]*?\n  \}/);
  assert.ok(hook, '缺 onRouteLegs');
  assert.match(hook[0], /state\.routeLegSig/, '要有签名去重');
  assert.match(hook[0], /state\.routeLegs = next/, '存下来给清单用');
  assert.match(hook[0], /renderItinerary\(\)/, '行程视图变了就重画');
  assert.match(hook[0], /else renderSelection\(\)/, '挑点视图也要把估算换成实测');
  assert.match(ROUTE, /function notifyLegs\(\)[\s\S]*?\n  \}/, 'route.js 要主动通知');
  assert.match(ROUTE, /handlers\.onLegs\(\(lastData && lastData\.legs\) \|\| \[\]\)/, '把段数据交出去');
});

test('同一条路线只规划一次：在飞的不重复打，换了身份就重规划', () => {
  const draw = ROUTE.match(/async function draw\(city, pins, opts\)[\s\S]*?\n  \}/);
  assert.ok(draw, '缺 draw');
  assert.match(draw[0], /if \(key === pendingKey\) return/, '同一条路线还在规划中时不得再发一遍（挑点视图 refresh 很频繁）');
  assert.match(draw[0], /pendingKey = key/, '记下在飞的那条');
  assert.match(draw[0], /if \(pendingKey === key\) pendingKey = null/, '收工要清掉');
  assert.match(ROUTE, /const fit = handlers\.fit !== false && key !== lastFitKey/, '取景要听调用方（挑点视图不抢镜头）');
});

test('选中某一段：行高亮 + 展开路书，地图那一段同时高亮', () => {
  const paint = ITIN.match(/function paintSelection\(container, selectedLeg\)[\s\S]*?\n  \}/);
  assert.ok(paint, '缺 paintSelection');
  assert.match(paint[0], /classList\.toggle\('sel', on\)/, '高亮类');
  assert.match(paint[0], /if \(on\) el\.classList\.add\('open'\)/, '选中的那段顺便展开（要看路书）');
  assert.match(paint[0], /scrollIntoView/, '选中的段要滚进视野');
  assert.match(ITIN, /handlers\.onLegSelect\(index\)/, '点到达行=选中');
  assert.match(ITIN, /handlers\.onLegMode\(index, btn\.dataset\.mode\)/, '换这一段的方式');
  assert.match(APP, /onLegSelect: \(index\) => \{ if \(Route\) Route\.selectLeg\(index\); \}/, '接上 route.selectLeg');
  assert.match(APP, /function paintLegSel\(selectedLeg\)/, 'route 回调回来刷新行');
  assert.match(ROUTE, /if \(handlers\.onSelectLeg\) handlers\.onSelectLeg\(selectedLeg\)/, 'route 要回调出去');
  assert.match(CSS, /\.itin-item \.itin-leg/, '缺清单里的到达行样式');
});
