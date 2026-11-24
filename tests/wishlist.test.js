/* 待规划（2026-11-24，对标圆周旅迹的「待规划地点」）
   先收着、还没排进日程的点：不参与连线/耗时/分享，只是「想去但还没定哪天」的池子。

   ① 数据：pins.status（planned 默认 / wish），老库靠 ensureColumn 前滚
   ② 接口：PATCH /api/pins/:id { status } —— 只认这两个值，别的 400
   ③ 前端：orderedPins 只取 planned；「我的选择」计数也只算 planned；待规划单独一块
   ④ 两个动作：挑点行「待规划」→ 收进池子；池子里「排进日程」→ 转回 planned */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { createDb } = require('../server/db');
const tripsRoutes = require('../server/routes/trips');

const DB_SRC = read('server/db.js');
const TRIPS_SRC = read('server/routes/trips.js');
const APP = read('web/js/app.js');
const UI = read('web/js/ui.js');
const SEL = read('web/js/selection.js');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

test('数据：pins.status 默认 planned，老库靠 ensureColumn 前滚', () => {
  assert.match(DB_SRC, /ensureColumn\(db, 'pins', 'status'/, '缺 status 列的前滚');
  assert.match(DB_SRC, /status TEXT NOT NULL DEFAULT 'planned'/, '默认值应是 planned');
  const db = createDb(':memory:');
  const u = db.createUser({ username: 'w1', passwordHash: 'x', salt: 's' });
  const t = db.createTrip({ city: '杭州', title: '待规划测试', theme: null, userId: u.id });
  const p = db.addPin({ trip_id: t.id, poi_id: 'A1', name: '西湖', lng: 120.1, lat: 30.2, category: 'sight' });
  assert.equal(db.getPin(p.id).status, 'planned', '新加的点默认已排进日程');
  assert.equal(db.updatePinStatus(p.id, 'wish').pin.status, 'wish');
  assert.equal(db.updatePinStatus(p.id, 'planned').pin.status, 'planned');
  // 认不出的值一律当 planned（不写脏数据）
  assert.equal(db.updatePinStatus(p.id, 'whatever').pin.status, 'planned');
});

test('接口：PATCH /api/pins/:id 认 status，别的值 400', () => {
  const db = createDb(':memory:');
  const u = db.createUser({ username: 'w2', passwordHash: 'x', salt: 's' });
  const t = db.createTrip({ city: '三亚', title: 't', theme: null, userId: u.id });
  const p = db.addPin({ trip_id: t.id, poi_id: 'B1', name: '大东海', lng: 109.5, lat: 18.2, category: 'sight' });
  const route = tripsRoutes.find((r) => r.method === 'PATCH' && r.path === '/api/pins/:id');
  assert.ok(route, '缺 PATCH /api/pins/:id');
  const ctx = { db, HttpError, params: { id: String(p.id) }, body: { status: 'wish' }, req: { headers: {} }, fallbackUser: u };
  assert.equal(route.handler(ctx).status, 'wish');
  ctx.body = { status: 'nope' };
  assert.throws(() => route.handler(ctx), (e) => e.status === 400);
});

test('前端：连线/耗时/分享只认已排进日程的点', () => {
  assert.match(APP, /function plannedPins\(\)/, '缺 plannedPins');
  assert.match(APP, /function wishPins\(\)/, '缺 wishPins');
  const ordered = APP.match(/function orderedPins\(\)[\s\S]*?\n  \}/);
  assert.ok(ordered, '缺 orderedPins');
  assert.match(ordered[0], /const pins = plannedPins\(\);/, 'orderedPins 必须只取 planned');
  // 「我的选择」计数也只算 planned（否则「0 个点」和列表里有点会打架）
  const render = APP.match(/function renderSelection\(\)[\s\S]*?\n  \}/);
  assert.ok(render, '缺 renderSelection');
  assert.match(render[0], /const count = plannedPins\(\)\.length;/, '计数只算 planned');
  assert.match(render[0], /renderWishBox\(\)/, '要渲染待规划清单');
});

test('前端：两个动作都在（收进待规划 / 排进日程）', () => {
  assert.match(UI, /class="wish-btn"/, '挑点行要有「待规划」按钮');
  assert.match(UI, /function renderWishList\(/, '缺待规划清单渲染');
  assert.match(UI, /class="plan-in"/, '池子里要有「排进日程」');
  assert.match(APP, /async function onMarkWish\(pin\)/, '缺 onMarkWish');
  assert.match(APP, /async function onMarkPlanned\(pin\)/, '缺 onMarkPlanned');
  assert.match(SEL, /async function setStatus\(poiOrKey, status\)/, '缺 Selection.setStatus');
  assert.match(SEL, /status: pin\.status === 'wish' \? 'wish' : 'planned'/, 'mapPin 要带 status');
});

test('页面：待规划块默认隐藏，有点才出现', () => {
  assert.match(HTML, /id="wish-box"[^>]*class="wish-box hidden"/, '待规划块默认隐藏');
  assert.match(HTML, /id="wish-list"/, '缺待规划清单容器');
  assert.match(HTML, /id="wish-count"/, '缺待规划计数');
  assert.match(CSS, /\.wish-box\.hidden \{ display: none; \}/, '缺隐藏规则');
  assert.match(CSS, /\.wish-list \.poi-item \{[^}]*border-style: dashed/, '池子里的行用虚线区分');
});
