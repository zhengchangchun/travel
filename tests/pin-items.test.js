/* 每个点下面的小清单（2026-11-20）：到了这地方「必须去/要做的事」＋随手记事
   ① 一律要登录，且只能碰自己行程里的点（别人的当不存在 ⇒ 404）
   ② 校验：文字 1–80 字、一个点最多 30 条；重入拿不到别人的
   ③ 勾「去过了」= PATCH done，会记 done_at；再取消则清空
   ④ 清理：删点、删行程、删整城都要把清单一起带走
   ⑤ 分享包带上（文本里一行「要去的：· 楼外楼，✓ 断桥」、网页版一个 .items 列表）*/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const TEST_CONFIG = { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' };

async function start() {
  const db = createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }],
    db,
    amap: { async amapGet() { return { status: '1' }; } },
    routeIntervalMs: 0,
    collectIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${app.server.address().port}`,
    db,
    close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })),
  };
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
  return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function signUp(base, username) {
  const r = await call(base, 'POST', '/api/auth/register', { username, password: 'secret-pass-8', nickname: username });
  assert.equal(r.status, 200);
  return r.cookie;
}

// 建一趟 + 一个点，返回 {tripId, pinId}
async function seed(base, cookie, city = '杭州', name = '西湖') {
  const trip = (await call(base, 'POST', '/api/trips', { city, title: city + ' · 我的行程' }, cookie)).body.data;
  const pin = (await call(base, 'POST', '/api/pins', {
    trip_id: trip.id, name, lng: 120.15, lat: 30.25, category: 'sight',
  }, cookie)).body.data;
  return { tripId: trip.id, pinId: pin.id };
}

test('小清单：未登录一律 401', async () => {
  const s = await start();
  try {
    for (const [m, url, body] of [
      ['GET', '/api/trips/1/items', null],
      ['POST', '/api/pins/1/items', { text: 'x' }],
      ['PATCH', '/api/items/1', { done: true }],
      ['DELETE', '/api/items/1', null],
    ]) {
      const r = await call(s.base, m, url, body);
      assert.equal(r.status, 401, m + ' ' + url);
    }
  } finally {
    await s.close();
  }
});

test('小清单：加 → 列 → 改文字 → 勾去过 → 删；按点分组返回', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const { tripId, pinId } = await seed(s.base, cookie);

    const a = await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '  楼外楼吃饭  ' }, cookie);
    assert.equal(a.status, 200);
    assert.equal(a.body.data.text, '楼外楼吃饭', '首尾空格去掉');
    assert.equal(a.body.data.done, false);
    const b = await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '断桥拍日出' }, cookie);
    assert.equal(b.body.data.sort_order > a.body.data.sort_order, true, '后加的排后面');

    const list = await call(s.base, 'GET', `/api/trips/${tripId}/items`, null, cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 2);
    assert.equal(list.body.data.byPin[pinId].length, 2, '按点分组也给了（前端一次拿完）');
    assert.deepEqual(list.body.data.items.map((i) => i.text), ['楼外楼吃饭', '断桥拍日出']);

    const patched = await call(s.base, 'PATCH', `/api/items/${a.body.data.id}`, { text: '楼外楼（提前订）', done: true }, cookie);
    assert.equal(patched.body.data.text, '楼外楼（提前订）');
    assert.equal(patched.body.data.done, true);
    assert.ok(patched.body.data.done_at, '勾上要记时间');
    const un = await call(s.base, 'PATCH', `/api/items/${a.body.data.id}`, { done: false }, cookie);
    assert.equal(un.body.data.done, false);
    assert.equal(un.body.data.done_at, null, '取消勾选要把时间清掉');

    const del = await call(s.base, 'DELETE', `/api/items/${a.body.data.id}`, null, cookie);
    assert.equal(del.status, 200);
    const after = await call(s.base, 'GET', `/api/trips/${tripId}/items`, null, cookie);
    assert.equal(after.body.data.items.length, 1);
    const again = await call(s.base, 'DELETE', `/api/items/${a.body.data.id}`, null, cookie);
    assert.equal(again.status, 404);
  } finally {
    await s.close();
  }
});

test('小清单：文字必填、≤80 字、一个点最多 30 条', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const { pinId } = await seed(s.base, cookie);
    assert.equal((await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '   ' }, cookie)).status, 400);
    assert.equal((await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: 'x'.repeat(81) }, cookie)).status, 400);
    for (let i = 1; i <= 30; i++) {
      const r = await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '第 ' + i + ' 条' }, cookie);
      assert.equal(r.status, 200, '第 ' + i + ' 条该成功');
    }
    const over = await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '第 31 条' }, cookie);
    assert.equal(over.status, 400, '超过 30 条要拒');
    const empty = await call(s.base, 'PATCH', `/api/items/1`, {}, cookie);
    assert.equal([400, 404].includes(empty.status), true, '空 PATCH 不该静默成功');
  } finally {
    await s.close();
  }
});

test('小清单：只看得到自己行程里的（别人的点/条一律 404）', async () => {
  const s = await start();
  try {
    const a = await signUp(s.base, 'zhangcc');
    const b = await signUp(s.base, 'someone');
    const { tripId, pinId } = await seed(s.base, a);
    const mine = (await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '我的记事' }, a)).body.data;

    assert.equal((await call(s.base, 'GET', `/api/trips/${tripId}/items`, null, b)).status, 404, '别人的行程看不到');
    assert.equal((await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '插一条' }, b)).status, 404, '别人的点加不了');
    assert.equal((await call(s.base, 'PATCH', `/api/items/${mine.id}`, { done: true }, b)).status, 404, '别人的条改不了');
    assert.equal((await call(s.base, 'DELETE', `/api/items/${mine.id}`, null, b)).status, 404, '别人的条删不了');
    const still = (await call(s.base, 'GET', `/api/trips/${tripId}/items`, null, a)).body.data.items;
    assert.equal(still.length, 1);
    assert.equal(still[0].text, '我的记事');
  } finally {
    await s.close();
  }
});

test('小清单：删点 / 删行程 / 删整城都要把清单一起带走', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const { tripId, pinId } = await seed(s.base, cookie);
    await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '要带走' }, cookie);
    assert.equal(s.db.listTripItems(tripId).length, 1);

    await call(s.base, 'DELETE', `/api/pins/${pinId}`, null, cookie);
    assert.equal(s.db.listTripItems(tripId).length, 0, '删点连清单一起删');

    // 再建一趟，验删行程 / 删整城
    const one = await seed(s.base, cookie, '杭州', '灵隐寺');
    await call(s.base, 'POST', `/api/pins/${one.pinId}/items`, { text: 'x' }, cookie);
    await call(s.base, 'DELETE', `/api/trips/${one.tripId}`, null, cookie);
    assert.equal(s.db.listTripItems(one.tripId).length, 0, '删行程连清单一起删');

    const two = await seed(s.base, cookie, '成都', '宽窄巷子');
    await call(s.base, 'POST', `/api/pins/${two.pinId}/items`, { text: 'y' }, cookie);
    const byCity = await call(s.base, 'DELETE', '/api/trips?city=成都', null, cookie);
    assert.equal(byCity.status, 200);
    assert.equal(s.db.listTripItems(two.tripId).length, 0, '删整城连清单一起删');
  } finally {
    await s.close();
  }
});

test('小清单：分享包里带上（文本一行 + 网页版列表）', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const { tripId, pinId } = await seed(s.base, cookie);
    await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '楼外楼吃饭' }, cookie);
    const done = (await call(s.base, 'POST', `/api/pins/${pinId}/items`, { text: '断桥拍日出' }, cookie)).body.data;
    await call(s.base, 'PATCH', `/api/items/${done.id}`, { done: true }, cookie);

    const shared = await call(s.base, 'POST', `/api/trips/${tripId}/share`, {}, cookie);
    assert.equal(shared.status, 200);
    const stop = shared.body.data.payload.stops[0];
    assert.deepEqual(stop.items, [{ text: '楼外楼吃饭', done: false }, { text: '断桥拍日出', done: true }]);
    assert.match(shared.body.data.text, /要去的：· 楼外楼吃饭，✓ 断桥拍日出/);
    // 网页版分享页里也要有（模板里是一个 .items 列表）
    const html = require('../server/share').buildHtml(shared.body.data.payload);
    assert.match(html, /class="items"/);
    assert.match(html, /楼外楼吃饭/);
    assert.equal(html.split('class="items"').length - 1, 1, '一个点就一个列表，没写的点不要凭空多一个');
  } finally {
    await s.close();
  }
});

test('小清单接线：规划页有权跟清单（源码钉住）', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('web/js/app.js'), /decoratePinItems/);
  assert.match(read('web/js/app.js'), /addPinItem/);
  assert.match(read('web/js/api.js'), /listTripItems/);
  assert.match(read('web/js/ui.js'), /dataset\.pinId/);
  assert.match(read('web/css/style.css'), /\.poi-items/);
  assert.match(read('server/routes/items.js'), /\/api\/pins\/:id\/items/);
  assert.match(read('server/share.js'), /要去的：/);
});
