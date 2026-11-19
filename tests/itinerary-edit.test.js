/* 行程可编辑（2026-11-17）：① 每条地点能写备注（pins.note）② 整条行程能写备注（trips.note）
   ③ 备注进分享包（网页/文案/JSON）④ 行程视图能拖拽 + ↑↓ 做「细微调整」
   覆盖：db 前滚与读写（含老库）、HTTP 接口、分享载荷、前端结构 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const API = read('web/js/api.js');
const SEL = read('web/js/selection.js');
const ITIN = read('web/js/itinerary.js');
const UI = read('web/js/ui.js');
const NOTEBOX = read('web/js/notebox.js');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [{ key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35' }];

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

const jsonReq = async (base, p, method, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let b = null;
  try { b = await res.json(); } catch (err) { b = null; }
  return { status: res.status, body: b };
};

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'travel-itin-')), 'x.db');

// ---------- ① trips.note 落库与前滚 ----------

test('trips 有 note 列；老库（没有这列）打开时自动补上，已有行照旧可读', () => {
  const file = tmpFile();
  // 造一个「老库」：trips 表没有 note 列
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  old.exec("INSERT INTO trips (city, title) VALUES ('杭州', '老行程')");
  old.close();

  const db = createDb(file);
  // 老库里没有归属：认领给账号 1（账号上线前的数据都走这条）
  db.claimUnowned(1);
  const rows = db.listTrips(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '老行程');
  assert.ok('note' in rows[0], '老库也要有 note 列');
  assert.equal(rows[0].note, null);

  // 再开一次（幂等）：列不会重复加，写下的话还在
  db.updateTripNote(rows[0].id, '周三下午到，先吃饭再逛');
  db.close();
  const db2 = createDb(file);
  const again = db2.listTrips(1)[0];
  assert.equal(again.note, '周三下午到，先吃饭再逛');
  const cols = db2.raw.prepare('PRAGMA table_info(trips)').all().filter((c) => c.name === 'note');
  assert.equal(cols.length, 1, 'note 列只能有一个');
  db2.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('updateTripNote：空串存 NULL（写了个空的＝没有备注）', () => {
  const db = createDb(':memory:');
  const trip = db.createTrip({ city: '杭州', title: '杭州行程', userId: 1});
  assert.equal(db.updateTripNote(trip.id, '   ').trip.note, null);
  assert.equal(db.updateTripNote(trip.id, '有内容').trip.note, '有内容');
  assert.equal(db.updateTripNote(trip.id, '').trip.note, null);
  db.close();
});

// ---------- ② HTTP：PATCH /api/trips/:id ----------

test('PATCH /api/trips/:id 改备注（也支持改标题）；不存在的行程 404、空标题 400', async () => {
  const s = await start();
  try {
    const trip = (await jsonReq(s.base, '/api/trips', 'POST', { city: '杭州', title: '杭州行程' })).body.data;
    const one = await jsonReq(s.base, `/api/trips/${trip.id}`, 'PATCH', { note: '周一闭馆，别安排博物馆' });
    assert.equal(one.status, 200);
    assert.equal(one.body.data.note, '周一闭馆，别安排博物馆');
    assert.equal(one.body.data.title, '杭州行程', '只改备注时标题不动');

    const two = await jsonReq(s.base, `/api/trips/${trip.id}`, 'PATCH', { title: '杭州两日' });
    assert.equal(two.body.data.title, '杭州两日');
    assert.equal(two.body.data.note, '周一闭馆，别安排博物馆', '只改标题时备注不动');

    const empty = await jsonReq(s.base, `/api/trips/${trip.id}`, 'PATCH', { title: '   ' });
    assert.equal(empty.status, 400);

    const missing = await jsonReq(s.base, '/api/trips/99999', 'PATCH', { note: 'x' });
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('每条地点的备注走 PATCH /api/pins/:id，落库到 pins.note', async () => {
  const s = await start();
  try {
    const trip = (await jsonReq(s.base, '/api/trips', 'POST', { city: '杭州', title: '杭州行程' })).body.data;
    const pin = (await jsonReq(s.base, '/api/pins', 'POST', {
      trip_id: trip.id, name: '楼外楼', lng: 120.13, lat: 30.25, category: 'food',
    })).body.data;
    const r = await jsonReq(s.base, `/api/pins/${pin.id}`, 'PATCH', { note: '提前订位，点东坡肉' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.note, '提前订位，点东坡肉');
    assert.equal(s.db.getPin(pin.id).note, '提前订位，点东坡肉');
  } finally {
    await s.close();
  }
});

// ---------- ③ 备注进分享包 ----------

test('备注进分享包：网页上有「行程备注」块、文案里有这行、JSON 里也带着', () => {
  const payload = share.buildPayload({
    trip: { id: 7, title: '杭州行程', note: '周三下午到，先吃饭再逛' },
    city: '杭州',
    stops: [
      { name: '西湖', lng: 120.14, lat: 30.24, category: 'food', note: '日落前去' },
    ],
    labels: { food: { label: '美食' } },
    when: '2026-11-17T20:00:00+08:00',
  });
  assert.equal(payload.tripNote, '周三下午到，先吃饭再逛');
  assert.equal(payload.stops[0].note, '日落前去');

  const text = share.buildText(payload);
  assert.match(text, /行程备注：周三下午到，先吃饭再逛/);
  assert.match(text, /备注：日落前去/);

  const html = share.buildHtml(payload);
  assert.match(html, /class="tripnote"/);
  assert.match(html, /周三下午到，先吃饭再逛/);
  assert.match(html, /日落前去/);
  assert.match(html, /\.tripnote \{/, '分享页要有 tripnote 样式');

  const json = JSON.stringify(share.payloadForJson(payload));
  assert.match(json, /周三下午到，先吃饭再逛/);

  // 没写备注时不留空壳（样式表里始终写着 .tripnote 规则，这里只看正文里有没有那个块）
  const bare = share.buildPayload({ trip: { id: 8, title: 'T' }, city: '杭州', stops: [] });
  assert.equal(bare.tripNote, '');
  assert.ok(!/<div class="tripnote"/.test(share.buildHtml(bare)));
  assert.ok(!/行程备注/.test(share.buildText(bare)));
});

test('分享接口把 trips.note 带出来（行程备注不是前端自己拼的）', async () => {
  const s = await start();
  try {
    const trip = (await jsonReq(s.base, '/api/trips', 'POST', { city: '杭州', title: '杭州行程' })).body.data;
    await jsonReq(s.base, `/api/trips/${trip.id}`, 'PATCH', { note: '自驾来，找有车位的' });
    await jsonReq(s.base, '/api/pins', 'POST', { trip_id: trip.id, name: '西湖', lng: 120.14, lat: 30.24, category: 'food' });
    const r = await jsonReq(s.base, `/api/trips/${trip.id}/share`, 'POST', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.payload.tripNote, '自驾来，找有车位的');
    assert.match(r.body.data.text, /行程备注：自驾来，找有车位的/);
  } finally {
    await s.close();
  }
});

// ---------- ④ 前端：备注入口 + 拖拽调序 ----------

test('api.js：updateTrip 走 PATCH /api/trips/:id；updatePinNote 也统一走 patch()', () => {
  assert.match(API, /updateTrip:\s*\(tripId, payload\)[\s\S]{0,60}\/api\/trips\/' \+ tripId, patch\(/);
  assert.match(API, /updatePinNote:\s*\(id, note\) => request\('\/api\/pins\/' \+ id, patch\(\{ note \}\)\)/);
});

test('selection.js：列表项带 note，能写备注（乐观更新 + 落库行号缺失时先刷新）', () => {
  assert.match(SEL, /note: pin\.note \|\| ''/, 'mapPin 要带出 note');
  assert.match(SEL, /async function setNote\(key, note\)/, '缺 setNote');
  assert.match(SEL, /API\.updatePinNote\(rowId, text\)/, 'setNote 要打到 PATCH /api/pins/:id');
  assert.match(SEL, /pins = backup;/, '失败要回滚');
  assert.match(SEL, /setNote,/, '要导出 setNote');
});

test('行程视图：每行有备注入口，整条行程有备注输入框，顺序可拖拽也能 ↑↓', () => {
  assert.match(HTML, /id="trip-note"/, '缺行程备注输入框');
  assert.match(HTML, /id="trip-note"[\s\S]{0,400}行程备注/, '输入框要说明是行程备注');
  assert.match(ITIN, /NoteBox\.html\(note\)/, '每行要挂备注位');
  assert.match(ITIN, /NoteBox\.wire\(li,/, '备注位要能就地编辑');
  assert.match(ITIN, /itin-handle/, '缺拖拽把手');
  assert.match(ITIN, /dragstart[\s\S]*?drop[\s\S]*?onReorder/, '缺拖拽落位');
  assert.match(ITIN, /handlers\.onReorder\(from, index\)/, '放下时要回调新顺序');
  assert.match(ITIN, /class="del"/, '删除按钮不能丢');
  assert.match(ITIN, /onMove\(index, -1\)/, '↑↓ 调序不能丢');
  // 分组标题与顺序冲突（按分类分组会把人挪过的顺序又切碎）⇒ 已改成每行带分类标签
  assert.ok(!/itin-group/.test(ITIN), '行程视图不再插分类分组标题');
});

test('备注位（notebox.js）：两处共用，自由输入、回车存、Esc 撤、点空位也能进', () => {
  assert.match(NOTEBOX, /'<div class="note-row'/, '要渲染 note-row');
  assert.match(NOTEBOX, /note-add/, '空备注时要有「＋ 备注」');
  assert.match(NOTEBOX, /note-input/, '要能就地写');
  assert.match(NOTEBOX, /e\.key === 'Enter'/, '回车保存');
  assert.match(NOTEBOX, /e\.key === 'Escape'/, 'Esc 取消');
  assert.match(NOTEBOX, /blur/, '失焦也要保存');
  assert.match(NOTEBOX, /maxLength = 200/, '备注限长，不让一整页文字进库');
  assert.match(NOTEBOX, /e\.stopPropagation/, '点备注不要冒泡到行（否则一点就跳地图）');
  // 加载顺序：notebox 要在 ui.js / itinerary.js 之前
  const at = (f) => HTML.indexOf('/js/' + f);
  assert.ok(at('notebox.js') > 0 && at('notebox.js') < at('ui.js'), 'notebox.js 必须先于 ui.js');
  assert.ok(at('notebox.js') < at('itinerary.js'), 'notebox.js 必须先于 itinerary.js');
});

test('挑点阶段（我的选择）也能写备注：同一份数据，同一套入口', () => {
  assert.match(UI, /window\.TravelNoteBox\.html\(pin\.note\)/, '我的选择每行也要有备注位');
  assert.match(UI, /window\.TravelNoteBox\.wire\(li,/, '我的选择也能就地编辑');
  const sel = APP.match(/UI\.renderSelectionPanel\(\$\('selection-list'\), panelPins, \{[\s\S]*?\n    \}\);/);
  assert.ok(sel, '缺 renderSelectionPanel 调用');
  assert.match(sel[0], /onNote: onEditPinNote/, '挑点列表要接上备注');
  assert.match(sel[0], /onCancel: renderSelection/, '收尾要重画列表');
  const note = APP.match(/async function onEditPinNote\(pin, text\)[\s\S]*?\n  \}/);
  assert.ok(note, '缺 onEditPinNote');
  assert.match(note[0], /renderSelection\(\)/, '写完备注我的选择要重画');
  assert.match(note[0], /renderItinerary\(\)/, '行程视图开着时也要重画');
});

test('app.js：备注 / 拖拽 / 行程备注三条线都接上了', () => {
  const itin = APP.match(/function renderItinerary\(\)[\s\S]*?\n  \}/);
  assert.ok(itin, '缺 renderItinerary');
  assert.match(itin[0], /onNote: onEditPinNote/);
  assert.match(itin[0], /onReorder: onReorderItinerary/);
  assert.match(itin[0], /syncTripNoteInput\(\)/);
  const note = APP.match(/async function onEditPinNote\(pin, text\)[\s\S]*?\n  \}/);
  assert.ok(note, '缺 onEditPinNote');
  assert.match(note[0], /Selection\.setNote\(pin\.id, text\)/);
  const reorder = APP.match(/async function onReorderItinerary\(from, to\)[\s\S]*?\n  \}/);
  assert.ok(reorder, '缺 onReorderItinerary');
  assert.match(reorder[0], /ids\.splice\(from, 1\)\[0\]/, '要把源行摘出来');
  assert.match(reorder[0], /ids\.splice\(to, 0, moved\)/, '要插到目标行的位置');
  assert.match(reorder[0], /applyManualOrder\(ids\)/, '落库走 applyManualOrder（拖一下就切成「手动顺序」）');
  const apply = APP.match(/async function applyManualOrder\(ids\)[\s\S]*?\n  \}/);
  assert.ok(apply, '缺 applyManualOrder');
  assert.match(apply[0], /Selection\.reorder\(ids\)/, '要一次落库');
  const tripNote = APP.match(/async function onTripNoteChange\(\)[\s\S]*?\n  \}/);
  assert.ok(tripNote, '缺 onTripNoteChange');
  assert.match(tripNote[0], /API\.updateTrip\(trip\.id, \{ note: text \}\)/);
  assert.match(APP, /tripNote\.onchange = onTripNoteChange/);
  assert.match(APP, /tripNote\.onkeydown/, '回车要能直接存');
});

test('备注/拖拽的样式都在（深色主题下也要看得见）', () => {
  assert.match(CSS, /\.trip-note-input\s*\{/, '缺行程备注输入框样式');
  assert.match(CSS, /\.note-row\s*\{/, '缺每条备注样式');
  assert.match(CSS, /\.itin-item\.drop-on/, '缺拖拽落点提示样式');
  assert.match(CSS, /\.itin-handle\s*\{/, '缺拖拽把手样式');
  assert.match(CSS, /\.note-row \.note-input/, '缺就地编辑输入框样式');
  // 深色主题里不能只有浅色的那套
  assert.match(CSS, /\.note-row \.note-input, \.trip-note-input/, '深色主题缺这两处样式');
  assert.ok(!/\.itin-note/.test(CSS), '旧类名 .itin-note 已改名 .note-row，别留死样式');
});
