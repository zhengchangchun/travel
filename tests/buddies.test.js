/* 旅游搭子（2026-11-20）：一个人的小名单（名字/关系/标签/联系方式/备注）
   ① 一律要登录：未登录 401；别人的搭子一律当不存在（404）
   ② 校验：名字必填、同名不许建、标签最多 8 个、超长直接拒（不偷偷截断）
   ③ 挂到行程上：PATCH /api/trips/:id { buddyIds } 整组替换；不是自己的搭子 400
   ④ 计数与清理：「一起走过 N 趟」读真实关联；删搭子 / 删行程都要把关联清掉 */
const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

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
    headers: Object.assign(
      body ? { 'Content-Type': 'application/json' } : {},
      cookie ? { Cookie: cookie } : {}
    ),
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
  assert.equal(r.status, 200, '注册要成功');
  return r.cookie;
}

test('搭子：未登录一律 401（列/建/改/删都不行）', async () => {
  const s = await start();
  try {
    for (const [m, url] of [['GET', '/api/buddies'], ['POST', '/api/buddies'], ['PATCH', '/api/buddies/1'], ['DELETE', '/api/buddies/1']]) {
      const r = await call(s.base, m, url, m === 'GET' || m === 'DELETE' ? null : { name: 'x' });
      assert.equal(r.status, 401, m + ' ' + url + ' 应要求登录');
    }
  } finally {
    await s.close();
  }
});

test('搭子：建 → 列 → 改 → 删；标签存成数组、字符串去掉首尾空格', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const made = await call(s.base, 'POST', '/api/buddies', {
      name: '  老王  ',
      relation: ' 同事 ',
      tags: ['早起', '能吃辣', '早起'],
      contact: '13800000000',
      note: '怕晒',
    }, cookie);
    assert.equal(made.status, 200);
    const b = made.body.data;
    assert.equal(b.name, '老王', '首尾空格要去掉');
    assert.equal(b.relation, '同事');
    assert.deepEqual(b.tags, ['早起', '能吃辣'], '重复标签只留一个');
    assert.equal(b.contact, '13800000000');
    assert.equal(b.tripCount, 0, '还没挂过行程');

    const list = await call(s.base, 'GET', '/api/buddies', null, cookie);
    assert.equal(list.body.data.buddies.length, 1);
    assert.deepEqual(list.body.data.buddies[0].tags, ['早起', '能吃辣'], '读回来还是数组');

    const patched = await call(s.base, 'PATCH', `/api/buddies/${b.id}`, { note: '爱爬山', tags: ['会开车'] }, cookie);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.name, '老王', '没传的字段保持原样');
    assert.equal(patched.body.data.note, '爱爬山');
    assert.deepEqual(patched.body.data.tags, ['会开车']);

    // 清空备注：传空串等于清掉
    const cleared = await call(s.base, 'PATCH', `/api/buddies/${b.id}`, { note: '' }, cookie);
    assert.equal(cleared.body.data.note, null);

    const del = await call(s.base, 'DELETE', `/api/buddies/${b.id}`, null, cookie);
    assert.equal(del.status, 200);
    const after = await call(s.base, 'GET', '/api/buddies', null, cookie);
    assert.equal(after.body.data.buddies.length, 0);
    const again = await call(s.base, 'DELETE', `/api/buddies/${b.id}`, null, cookie);
    assert.equal(again.status, 404, '删过的再删＝不存在');
  } finally {
    await s.close();
  }
});

test('搭子：名字必填、同名不许建、标签最多 8 个、超长直接拒', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const empty = await call(s.base, 'POST', '/api/buddies', { name: '   ' }, cookie);
    assert.equal(empty.status, 400);
    const long = await call(s.base, 'POST', '/api/buddies', { name: 'x'.repeat(25) }, cookie);
    assert.equal(long.status, 400);
    const ok = await call(s.base, 'POST', '/api/buddies', { name: '老王' }, cookie);
    assert.equal(ok.status, 200);
    const dup = await call(s.base, 'POST', '/api/buddies', { name: '老王' }, cookie);
    assert.equal(dup.status, 400, '同名拒绝（免得名单里两条一样的）');
    const many = await call(s.base, 'POST', '/api/buddies', {
      name: '小李',
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    }, cookie);
    assert.equal(many.status, 400);
    const bigTag = await call(s.base, 'POST', '/api/buddies', { name: '小张', tags: ['很长的标签'.repeat(3)] }, cookie);
    assert.equal(bigTag.status, 400);
    const longNote = await call(s.base, 'POST', '/api/buddies', { name: '小张', note: '备'.repeat(301) }, cookie);
    assert.equal(longNote.status, 400);
    // 改名撞别人也要拒
    await call(s.base, 'POST', '/api/buddies', { name: '小张' }, cookie);
    const two = (await call(s.base, 'GET', '/api/buddies', null, cookie)).body.data.buddies;
    const xiaozhang = two.find((x) => x.name === '小张');
    const clash = await call(s.base, 'PATCH', `/api/buddies/${xiaozhang.id}`, { name: '老王' }, cookie);
    assert.equal(clash.status, 400);
  } finally {
    await s.close();
  }
});

test('搭子：只看得到自己的；改/删别人的当不存在（404）', async () => {
  const s = await start();
  try {
    const a = await signUp(s.base, 'zhangcc');
    const b = await signUp(s.base, 'someone');
    const mine = await call(s.base, 'POST', '/api/buddies', { name: '老王' }, a);
    const id = mine.body.data.id;

    const bList = await call(s.base, 'GET', '/api/buddies', null, b);
    assert.equal(bList.body.data.buddies.length, 0, '别人的名单看不到');
    const bPatch = await call(s.base, 'PATCH', `/api/buddies/${id}`, { name: '我改了' }, b);
    assert.equal(bPatch.status, 404);
    const bDel = await call(s.base, 'DELETE', `/api/buddies/${id}`, null, b);
    assert.equal(bDel.status, 404);
    const stillThere = await call(s.base, 'GET', '/api/buddies', null, a);
    assert.equal(stillThere.body.data.buddies.length, 1, 'A 的搭子没被 B 动到');
    assert.equal(stillThere.body.data.buddies[0].name, '老王');
  } finally {
    await s.close();
  }
});

test('挂到行程上：整组替换、只认自己的搭子、删搭子/删行程都要清关联', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const other = await signUp(s.base, 'someone');
    const wang = (await call(s.base, 'POST', '/api/buddies', { name: '老王' }, cookie)).body.data;
    const li = (await call(s.base, 'POST', '/api/buddies', { name: '小李' }, cookie)).body.data;
    const stranger = (await call(s.base, 'POST', '/api/buddies', { name: '别人的搭子' }, other)).body.data;

    const trip = (await call(s.base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 西线＋东线' }, cookie)).body.data;
    assert.deepEqual(trip.buddyIds || [], [], '新行程默认没有搭子');

    const set = await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [wang.id, li.id] }, cookie);
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.data.buddyIds, [wang.id, li.id].sort((x, y) => x - y));

    const list = (await call(s.base, 'GET', '/api/trips', null, cookie)).body.data;
    const row = list.find((t) => Number(t.id) === Number(trip.id));
    assert.equal(row.buddyIds.length, 2, '列表里要带上搭子');

    // 别人的搭子 id：400（不静默丢弃）
    const bad = await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [stranger.id] }, cookie);
    assert.equal(bad.status, 400);
    const notArray = await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: wang.id }, cookie);
    assert.equal(notArray.status, 400);
    const stillTwo = (await call(s.base, 'GET', '/api/trips', null, cookie)).body.data
      .find((t) => Number(t.id) === Number(trip.id));
    assert.equal(stillTwo.buddyIds.length, 2, '被拒的那次不能把原来的改掉');

    // 「一起走过 N 趟」
    const buddies = (await call(s.base, 'GET', '/api/buddies', null, cookie)).body.data.buddies;
    assert.equal(buddies.find((x) => x.name === '老王').tripCount, 1);
    assert.equal(buddies.find((x) => x.name === '小李').tripCount, 1);

    // 整组替换成一个人
    await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [li.id] }, cookie);
    const afterSwap = (await call(s.base, 'GET', '/api/buddies', null, cookie)).body.data.buddies;
    assert.equal(afterSwap.find((x) => x.name === '老王').tripCount, 0, '被换掉的不再算一起走过');

    // 清空
    const clear = await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [] }, cookie);
    assert.deepEqual(clear.body.data.buddyIds, []);

    // 删搭子 ⇒ 关联一起没
    await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [li.id] }, cookie);
    await call(s.base, 'DELETE', `/api/buddies/${li.id}`, null, cookie);
    const afterDel = (await call(s.base, 'GET', '/api/trips', null, cookie)).body.data
      .find((t) => Number(t.id) === Number(trip.id));
    assert.deepEqual(afterDel.buddyIds, [], '删人的时候要把行程里的引用也清掉');

    // 删行程 ⇒ 关联一起没（tripCount 回落到 0）
    await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [wang.id] }, cookie);
    assert.equal((await call(s.base, 'GET', '/api/buddies', null, cookie)).body.data.buddies
      .find((x) => x.name === '老王').tripCount, 1);
    const delTrip = await call(s.base, 'DELETE', `/api/trips/${trip.id}`, null, cookie);
    assert.equal(delTrip.status, 200);
    assert.equal((await call(s.base, 'GET', '/api/buddies', null, cookie)).body.data.buddies
      .find((x) => x.name === '老王').tripCount, 0, '行程没了，一起走过也该归零');
  } finally {
    await s.close();
  }
});

test('搭子不泄露到分享包里：只带名字与关系，联系方式/备注不外发', async () => {
  const s = await start();
  try {
    const cookie = await signUp(s.base, 'zhangcc');
    const wang = (await call(s.base, 'POST', '/api/buddies', {
      name: '老王', relation: '同事', contact: '13800000000', note: '怕晒', tags: ['早起'],
    }, cookie)).body.data;
    const trip = (await call(s.base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 海边' }, cookie)).body.data;
    await call(s.base, 'PATCH', `/api/trips/${trip.id}`, { buddyIds: [wang.id] }, cookie);

    const shared = await call(s.base, 'POST', `/api/trips/${trip.id}/share`, {}, cookie);
    assert.equal(shared.status, 200);
    const payload = shared.body.data.payload;
    assert.deepEqual(payload.buddies, [{ name: '老王', relation: '同事' }], '分享载荷里带同行（名字＋关系）');
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('13800000000'), '联系方式不出去');
    assert.ok(!json.includes('怕晒'), '备注不出去');
    assert.ok(!json.includes('早起'), '标签不出去');
    assert.match(shared.body.data.text, /同行：老王（同事）/, '文本里也写一行同行');

    // 没搭子的行程：payload.buddies 是空数组，文本不出现「同行：」
    const t2 = (await call(s.base, 'POST', '/api/trips', { city: '杭州', title: '杭州 · 一个人' }, cookie)).body.data;
    const plain = await call(s.base, 'POST', `/api/trips/${t2.id}/share`, {}, cookie);
    assert.deepEqual(plain.body.data.payload.buddies, []);
    assert.ok(!/同行：/.test(plain.body.data.text));
  } finally {
    await s.close();
  }
});

test('搭子接线：页面在 /buddies，头部有入口，行程页能挑人', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('web/buddies.html'), /id="headbar"/);
  assert.match(read('web/js/buddies.js'), /api\.buddies\(\)/);
  assert.match(read('web/js/buddies.js'), /loginGate/);
  const head = read('web/js/headbar.js');
  assert.match(head, /'\/buddies', '旅游搭子'/);
  const trips = read('web/js/trips.js');
  assert.match(trips, /bulkBuddy|buddyIds/);
  assert.match(trips, /pickBuddies/);
  assert.match(read('server/routes/trips.js'), /buddyIds/);
  // 分享包里也带同行（名字＋关系），规划页右栏只读显示
  assert.match(read('server/share.js'), /buddies/);
  const app = read('web/js/app.js');
  assert.match(app, /renderTripBuddies/);
  assert.match(read('web/index.html'), /id="trip-buddies"/);
});
