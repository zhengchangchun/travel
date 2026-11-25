/* 营业时间实时取 + 预约/时段（2026-11-25）
   ① 营业时间：**不缓存、不落库**（用户口径「每个人上来都能实时读取」）
   ② 额度用尽 ≠ 这个地点没营业时间（两个失败原因必须分开报）
   ③ 预约 / 时段：用户自己的安排 ⇒ 存库，并进分享包与行程单 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const AMAP = read('server/amap.js');
const POI_ROUTE = read('server/routes/poi.js');
const DETAIL = read('web/js/detail.js');
const ITIN = read('web/js/itinerary.js');
const DB = read('server/db.js');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' },
  defaultCity: '杭州',
};
const CATEGORIES = [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }];

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: opts.amap,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, db, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

const getJson = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
};

// ---------- ① 不缓存 ----------

test('营业时间接口故意不走 ctx.cache（与 /api/poi/detail 不同）', () => {
  const block = POI_ROUTE.match(/path: '\/api\/poi\/business'[\s\S]*?\n  \},/);
  assert.ok(block, '缺 /api/poi/business 路由');
  assert.ok(!/cached\(ctx/.test(block[0]), '营业时间不能走 cached()（会缓存 10 分钟）');
  assert.match(block[0], /ctx\.amap\.poiBusiness\(/, '要直接调 amap.poiBusiness');
  // 对照：detail 那条是走缓存的，说明两者口径确实不同
  assert.match(POI_ROUTE, /cached\(ctx, \(\) => ctx\.amap\.poiDetail/, 'detail 仍走缓存（它是不变的基本信息）');
});

test('pois 表已不落盘（营业时间更不可能存）', () => {
  // 2026-11-25：pois 整张表都不再建了（地点/评分/人均/电话/图片都是上游事实）
  assert.ok(!/CREATE TABLE IF NOT EXISTS pois \(/.test(DB), 'pois 不该再建表');
  assert.ok(!/opentime/i.test(DB), 'db.js 里不该出现 opentime（营业时间只实时取）');
  assert.ok(!/ensureColumn\(db, 'pois', 'opentime/.test(DB), '不该给 pois 前滚 opentime 列');
});

test('两次请求都真打高德（不缓存）', async () => {
  let calls = 0;
  const amap = {
    async poiBusiness(id) {
      calls += 1;
      return { id, name: '灵隐寺', opentimeToday: '07:30-18:00', opentimeWeek: '周一至周日 07:30-18:00', source: 'amap-v5' };
    },
  };
  const s = await start({ amap });
  try {
    const a = await getJson(s.base + '/api/poi/business?id=B1');
    const b = await getJson(s.base + '/api/poi/business?id=B1');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.data.available, true);
    assert.strictEqual(a.body.data.opentimeToday, '07:30-18:00');
    assert.strictEqual(b.body.data.opentimeToday, '07:30-18:00');
    assert.strictEqual(calls, 2, '两次请求应各打一次高德（calls=' + calls + '）');
  } finally {
    await s.close();
  }
});

// ---------- ② 额度用尽 ≠ 没营业时间 ----------

test('额度用尽：quota=true 且文案说「明天再看」，不说「这个地点没有营业时间」', async () => {
  const amap = {
    async poiBusiness() {
      const e = new Error('USER_DAILY_QUERY_OVER_LIMIT');
      e.code = 'AMAP_ERROR';
      throw e;
    },
  };
  const s = await start({ amap });
  try {
    const { status, body } = await getJson(s.base + '/api/poi/business?id=B1');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.available, false);
    assert.strictEqual(body.data.quota, true, '额度用尽要标 quota');
    assert.match(body.data.reason, /额度用完/, '要说清是额度问题');
    assert.match(body.data.reason, /明天/, '要给出什么时候能看');
    assert.ok(!/没有这个地点的营业时间/.test(body.data.reason), '不能误报成「这个地点没营业时间」');
  } finally {
    await s.close();
  }
});

test('这个地点确实没营业时间：quota=false，文案说「没有」', async () => {
  const amap = { async poiBusiness() { return null; } };
  const s = await start({ amap });
  try {
    const { body } = await getJson(s.base + '/api/poi/business?id=B1');
    assert.strictEqual(body.data.available, false);
    assert.strictEqual(body.data.quota, false);
    assert.match(body.data.reason, /没有这个地点的营业时间/);
  } finally {
    await s.close();
  }
});

test('amap.poiBusiness：v5 拿不到时退回 v3 的 biz_ext.opentime2', () => {
  const fn = AMAP.match(/async function poiBusiness\(id\)[\s\S]*?\n\}/);
  assert.ok(fn, '缺 poiBusiness');
  assert.match(fn[0], /\/v5\/place\/detail/, '先试 v5');
  assert.match(fn[0], /show_fields: 'business'/, 'v5 要带 show_fields=business');
  assert.match(fn[0], /\/v3\/place\/detail/, 'v5 不行要退回 v3');
  assert.match(fn[0], /biz\.opentime2/, 'v3 读 biz_ext.opentime2');
  assert.match(fn[0], /throw lastErr/, '两边都失败要把原因抛出去（不能吞成「没有」）');
});

// ---------- ③ 预约 / 时段 ----------

test('pins 表有 booking / slot 两列，且老库会前滚', () => {
  const schema = DB.match(/CREATE TABLE IF NOT EXISTS pins \([\s\S]*?\n\);/);
  assert.ok(schema, '缺 pins 建表语句');
  assert.match(schema[0], /booking\s+TEXT NOT NULL DEFAULT 'none'/, 'pins 要有 booking 列');
  assert.match(schema[0], /slot\s+TEXT/, 'pins 要有 slot 列');
  assert.match(DB, /ensureColumn\(db, 'pins', 'booking'/, '老库要前滚 booking');
  assert.match(DB, /ensureColumn\(db, 'pins', 'slot'/, '老库要前滚 slot');
});

test('PATCH /api/pins/:id 认 booking 与 slot，非法值 400', async () => {
  const s = await start();
  try {
    const trip = await (await fetch(s.base + '/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州', title: '预约测试' }),
    })).json();
    const pin = await (await fetch(s.base + '/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip_id: trip.data.id, name: '陕历博', lng: 108.9, lat: 34.2, category: 'sight' }),
    })).json();
    const pinId = pin.data.id;
    assert.strictEqual(pin.data.booking, 'none', '默认不用预约');
    assert.strictEqual(pin.data.slot, null, '默认不排时段');

    const patch = (body) =>
      fetch(s.base + '/api/pins/' + pinId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const r1 = await (await patch({ booking: 'required' })).json();
    assert.strictEqual(r1.data.booking, 'required');
    const r2 = await (await patch({ slot: 'morning' })).json();
    assert.strictEqual(r2.data.slot, 'morning');
    assert.strictEqual(r2.data.booking, 'required', '改时段不该把预约冲掉');

    // 清掉时段
    const r3 = await (await patch({ slot: '' })).json();
    assert.strictEqual(r3.data.slot, null, '空串 = 不排时段');

    // 非法值
    const bad1 = await patch({ booking: 'maybe' });
    assert.strictEqual(bad1.status, 400);
    assert.match((await bad1.json()).error.msg, /none \/ needed \/ required/);
    const bad2 = await patch({ slot: 'noon' });
    assert.strictEqual(bad2.status, 400);
    assert.match((await bad2.json()).error.msg, /morning \/ afternoon \/ evening \/ night/);
  } finally {
    await s.close();
  }
});

test('分享包与行程单都带上时段与预约（同行的人要知道什么时候去、要不要先约）', () => {
  const payload = share.buildPayload({
    trip: { id: 1, title: '西安三日', city: '西安' },
    city: '西安',
    stops: [
      { id: 1, name: '陕历博', lng: 108.9, lat: 34.2, category: 'sight', booking: 'required', slot: 'morning' },
      { id: 2, name: '城墙', lng: 108.9, lat: 34.3, category: 'sight', booking: 'none', slot: 'evening' },
    ],
    labels: { sight: { label: '景点' } },
    when: '2026-11-25T10:00:00.000Z',
  });
  assert.strictEqual(payload.stops[0].booking, 'required');
  assert.strictEqual(payload.stops[0].slot, 'morning');

  const text = share.buildText(payload);
  assert.match(text, /时段：上午/, '文本要写时段');
  assert.match(text, /预约：必须提前预约/, '文本要写预约');
  assert.match(text, /时段：傍晚/);
  // 不用预约的不写（省得每行都挂一句「不用预约」）
  assert.strictEqual((text.match(/预约：/g) || []).length, 1, '只有要预约的那条才写');

  const html = share.buildHtml(payload);
  assert.match(html, /上午/, '分享页要显示时段');
  assert.match(html, /必须提前预约/, '分享页要显示预约');
});

test('行程单（.md 导出）也带时段与预约', () => {
  const db = createDb(':memory:');
  const trip = db.getOrCreateCityTrip('西安', 1);
  const pin = db.addPin({
    trip_id: trip.id, name: '陕历博', lng: 108.9, lat: 34.2, category: 'sight',
  });
  db.updatePinBooking(pin.id, 'required');
  db.updatePinSlot(pin.id, 'morning');
  const md = db.buildTripMarkdown(trip.id);
  assert.match(md, /上午/, '行程单要写时段');
  assert.match(md, /必须提前预约/, '行程单要写预约');
  db.close();
});

// ---------- ④ 页面 ----------

test('详情卡：营业时间实时取，拿不到不显示空壳，额度用尽要说清', () => {
  assert.match(DETAIL, /function loadHours\(card, data\)/, '缺 loadHours');
  assert.match(DETAIL, /API\.poiBusiness\(/, '要调 poiBusiness');
  assert.match(DETAIL, /id="poi-hours"/, '详情卡要有营业时间容器');
  const fn = DETAIL.match(/function loadHours\(card, data\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 loadHours 实现');
  assert.match(fn[0], /res\.quota/, '额度用尽要单独处理');
  assert.match(fn[0], /hours-quota/, '额度用尽要有自己的样式');
  assert.match(fn[0], /实时/, '要标明这是实时取的');
});

test('行程里每行有「时段 / 预约」两个下拉，选完就存', () => {
  assert.match(ITIN, /function slotBookingHtml\(pin, handlers\)/, '缺 slotBookingHtml');
  assert.match(ITIN, /class="pin-slot"/, '缺时段下拉');
  assert.match(ITIN, /class="pin-booking"/, '缺预约下拉');
  assert.match(ITIN, /onPinSlot/, '时段要接回调');
  assert.match(ITIN, /onPinBooking/, '预约要接回调');
  assert.match(ITIN, /itin-book-warn/, '必须预约的要有醒目小标');
});
