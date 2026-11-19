/* 按天分段（2026-11-19）：一趟行程里的点可以分到第 N 天
   - pins.day（默认 1），清单/导出/分享包都按「天 → 顺序」排
   - 单天时不插任何标题（输出与以前一模一样，老行为不破） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const TEST_CONFIG = { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' };

const fakeAmap = () => ({
  async amapGet() {
    return { status: '1' };
  },
});

async function start() {
  const db = createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
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

const call = async (base, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    json = null;
  }
  return { status: res.status, body: json };
};

const poi = (id, name) => ({ id, name, lng: 109.4 + Math.random() * 0.01, lat: 18.25, category: 'sight' });

async function seedTrip(base, stops) {
  const trip = (await call(base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 四天' })).body.data;
  const ids = [];
  for (const s of stops) {
    const r = await call(base, 'POST', '/api/selection', { tripId: trip.id, poi: s });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids.push(r.body.data.pin.id);
  }
  return { trip, ids };
}

test('挪天：PATCH /api/pins/:id 收 day，夹在 1–30，落库后按「天 → 顺序」排', async () => {
  const s = await start();
  try {
    const { trip, ids } = await seedTrip(s.base, [poi('a', '天涯海角'), poi('b', '南山'), poi('c', '大东海')]);
    const before = await call(s.base, 'GET', `/api/selection?tripId=${trip.id}`);
    assert.deepEqual(before.body.data.pins.map((p) => p.day), [1, 1, 1], '默认都是第 1 天');

    const moved = await call(s.base, 'PATCH', `/api/pins/${ids[2]}`, { day: 2 });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.day, 2);

    const after = await call(s.base, 'GET', `/api/selection?tripId=${trip.id}`);
    assert.deepEqual(
      after.body.data.pins.map((p) => p.name),
      ['天涯海角', '南山', '大东海'],
      '第 1 天在前、第 2 天在后'
    );
    assert.deepEqual(after.body.data.pins.map((p) => p.day), [1, 1, 2]);

    // 越界夹紧：0 → 1，99 → 30
    const low = await call(s.base, 'PATCH', `/api/pins/${ids[0]}`, { day: 0 });
    assert.equal(low.body.data.day, 1);
    const high = await call(s.base, 'PATCH', `/api/pins/${ids[0]}`, { day: 99 });
    assert.equal(high.body.data.day, 30);
  } finally {
    await s.close();
  }
});

test('单天时不插标题；多天时导出按天分段、序号仍然连续', async () => {
  const s = await start();
  try {
    const { trip, ids } = await seedTrip(s.base, [poi('a', '天涯海角'), poi('b', '南山'), poi('c', '大东海')]);
    const one = await fetch(s.base + `/api/selection/export?tripId=${trip.id}`);
    const oneText = await one.text();
    assert.ok(!/^## /m.test(oneText), '只有一天就不该出现天标题');

    await call(s.base, 'PATCH', `/api/pins/${ids[1]}`, { day: 2 });
    await call(s.base, 'PATCH', `/api/pins/${ids[2]}`, { day: 2 });
    const multi = await fetch(s.base + `/api/selection/export?tripId=${trip.id}`);
    const text = await multi.text();
    assert.match(text, /^## 第 1 天$/m);
    assert.match(text, /^## 第 2 天$/m);
    assert.match(text, /^1\. 天涯海角/m);
    assert.match(text, /^2\. 南山/m, '跨天之后序号要连续，不能每天从 1 开始');
    assert.match(text, /^3\. 大东海/m);
  } finally {
    await s.close();
  }
});

test('分享包：文案与网页版都按天分段（多天才有）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-days-share-'));
  process.env.TRAVEL_SHARE_DIR = dir;
  const s = await start();
  try {
    const { trip, ids } = await seedTrip(s.base, [poi('a', '天涯海角'), poi('b', '南山'), poi('c', '大东海')]);
    await call(s.base, 'PATCH', `/api/pins/${ids[2]}`, { day: 3 });

    const out = await call(s.base, 'POST', `/api/trips/${trip.id}/share/export`, {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    // 文案：第 1 天 / 第 3 天 两段（第 2 天没人就不出现）
    assert.match(out.body.data.text, /【第 1 天】/);
    assert.match(out.body.data.text, /【第 3 天】/);
    // 网页版：有 day-head 块
    const html = fs.readFileSync(path.join(dir, out.body.data.base + '.html'), 'utf8');
    assert.match(html, /class="day-head"/);
    assert.match(html, /第 3 天/);
    // payload 里每站带 day
    const payload = JSON.parse(fs.readFileSync(path.join(dir, out.body.data.base + '.json'), 'utf8'));
    assert.deepEqual(payload.stops.map((x) => x.day), [1, 1, 3]);
  } finally {
    await s.close();
    delete process.env.TRAVEL_SHARE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('前端接线：清单按天分组 + 行内 D-/D+ + 接口 PATCH day', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const itin = read('web/js/itinerary.js');
  assert.match(itin, /itin-day/, '要有「第 N 天」分隔行');
  assert.match(itin, /day-prev/, '行内要有 D-');
  assert.match(itin, /day-next/, '行内要有 D+');
  assert.match(itin, /onPinDay\(pin, Math\.max\(1, dayNo - 1\)\)/, 'D- 的算法');
  const app = read('web/js/app.js');
  assert.match(app, /async function onPinDay\(/, 'app.js 要有 onPinDay');
  assert.match(app, /API\.updatePinDay\(pinId, next\)/, '要走 PATCH day');
  assert.match(app, /onPinDay: onPinDay/, '两处清单都要传下去');
  const api = read('web/js/api.js');
  assert.match(api, /updatePinDay: \(id, day\)/, 'api.js 缺 updatePinDay');
  const css = read('web/css/style.css');
  assert.match(css, /\.itin-day\b/, '天标题要有样式');
});

test('迁移：老库（pins 没有 day 列）打开时自动补上，旧行默认第 1 天', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-days-migrate-'));
  const file = path.join(dir, 'old.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  old.exec("CREATE TABLE pins (id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL, poi_id TEXT, name TEXT NOT NULL, address TEXT, lng REAL NOT NULL, lat REAL NOT NULL, category TEXT NOT NULL, rating TEXT, cost TEXT, tel TEXT, photo TEXT, note TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  old.exec("INSERT INTO trips (city, title) VALUES ('三亚', '老行程')");
  old.exec("INSERT INTO pins (trip_id, poi_id, name, lng, lat, category) VALUES (1, 'x', '老点', 109.4, 18.2, 'sight')");
  old.close();

  const db = createDb(file);
  try {
    const col = db.raw.prepare("PRAGMA table_info(pins)").all().filter((c) => c.name === 'day');
    assert.equal(col.length, 1, 'day 列要补上');
    const pins = db.getPinsByTrip(1);
    assert.equal(pins[0].day, 1, '老点默认第 1 天');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
