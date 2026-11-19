/* 按用户隔离（2026-11-19）：行程 / 点位 / 选中 / 分享，各看各的
   这里故意**不开** authFallbackUser：全部用真注册真登录拿 cookie，
   因为要钉的就是「没登录 401、别人的数据当不存在」。 */
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
});

async function start() {
  const db = createDb(':memory:');
  const amap = fakeAmap();
  // 注意：不给 authFallbackUser —— 要真登录
  const app = createApp({
    config: TEST_CONFIG,
    categories: [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }],
    db,
    amap,
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
  return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function signup(base, username) {
  const r = await call(base, 'POST', '/api/auth/register', { username, password: 'pass-' + username + '-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: r.cookie, user: r.body.data.user };
}

// 造一趟行程 + 一个点
async function seedTrip(base, cookie, city, title) {
  const trip = await call(base, 'POST', '/api/trips', { city, title }, cookie);
  assert.equal(trip.status, 200, JSON.stringify(trip.body));
  const pin = await call(
    base,
    'POST',
    '/api/pins',
    { trip_id: trip.body.data.id, name: title + '的点', lng: 120.1, lat: 30.2, category: 'sight' },
    cookie
  );
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  return { trip: trip.body.data, pin: pin.body.data };
}

test('没登录：行程 / 选中 / 分享 全 401（地图工具也进不去）', async () => {
  const s = await start();
  try {
    const urls = [
      ['GET', '/api/trips'],
      ['POST', '/api/trips'],
      ['GET', '/api/selection?city=' + encodeURIComponent('杭州')],
      ['PUT', '/api/selection/order'],
      ['GET', '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving'],
      ['GET', '/api/shares'],
      ['GET', '/api/legacy/pending'],
    ];
    for (const [method, url] of urls) {
      const r = await call(s.base, method, url, method === 'GET' ? null : {});
      assert.equal(r.status, 401, method + ' ' + url + ' 应 401，实际 ' + r.status);
      assert.equal(r.body.error.code, 'AUTH_REQUIRED');
    }
  } finally {
    await s.close();
  }
});

test('两个人的行程互相看不见（列表 / 详情 / 点 / 改 / 删 / 分享全挡住）', async () => {
  const s = await start();
  try {
    const alice = await signup(s.base, 'alice');
    const bob = await signup(s.base, 'bob');
    const a = await seedTrip(s.base, alice.cookie, '三亚', '爱丽丝的三亚');
    const b = await seedTrip(s.base, bob.cookie, '三亚', '鲍勃的三亚');

    const aList = await call(s.base, 'GET', '/api/trips?city=' + encodeURIComponent('三亚'), null, alice.cookie);
    assert.deepEqual(aList.body.data.map((t) => t.title), ['爱丽丝的三亚'], '只看得到自己那趟');
    const bList = await call(s.base, 'GET', '/api/trips', null, bob.cookie);
    assert.deepEqual(bList.body.data.map((t) => t.title), ['鲍勃的三亚']);

    // 选中视图：同城，各自只看到自己的点
    const aSel = await call(s.base, 'GET', '/api/selection?city=' + encodeURIComponent('三亚'), null, alice.cookie);
    assert.deepEqual(aSel.body.data.pins.map((p) => p.name), ['爱丽丝的三亚的点']);
    assert.equal(aSel.body.data.tripId, a.trip.id);

    // 越权访问：一律 404（当不存在，不泄露「有这条」）
    for (const [method, url, body] of [
      ['GET', '/api/trips/' + b.trip.id + '/pins'],
      ['PATCH', '/api/trips/' + b.trip.id, { title: '改名试试' }],
      ['DELETE', '/api/trips/' + b.trip.id, null],
      ['PATCH', '/api/pins/' + b.pin.id, { note: '写点字' }],
      ['DELETE', '/api/pins/' + b.pin.id, null],
      ['POST', '/api/trips/' + b.trip.id + '/share/export', {}],
    ]) {
      const r = await call(s.base, method, url, body, alice.cookie);
      assert.equal(r.status, 404, method + ' ' + url + ' 应 404，实际 ' + r.status);
    }
    // 鲍勃的数据没被改动
    const bPins = await call(s.base, 'GET', '/api/trips/' + b.trip.id + '/pins', null, bob.cookie);
    assert.equal(bPins.body.data.length, 1);
    const bTrip = await call(s.base, 'GET', '/api/trips', null, bob.cookie);
    assert.equal(bTrip.body.data[0].title, '鲍勃的三亚');

    // 同一个 poi 两个人各自加：各留一条，互不覆盖
    const poi = { id: 'poi-x', name: '同一家店', lng: 109.5, lat: 18.25, category: 'sight' };
    const aAdd = await call(s.base, 'POST', '/api/selection', { city: '三亚', poi }, alice.cookie);
    const bAdd = await call(s.base, 'POST', '/api/selection', { city: '三亚', poi }, bob.cookie);
    assert.equal(aAdd.status, 200);
    assert.equal(bAdd.status, 200);
    assert.notEqual(aAdd.body.data.pin.id, bAdd.body.data.pin.id, '同一个点在不同人名下是两条');
  } finally {
    await s.close();
  }
});

test('分享列表各看各的；删别人的 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-iso-share-'));
  process.env.TRAVEL_SHARE_DIR = dir;
  const s = await start();
  try {
    const alice = await signup(s.base, 'alice2');
    const bob = await signup(s.base, 'bob2');
    const a = await seedTrip(s.base, alice.cookie, '三亚', '爱丽丝的分享');
    const shared = await call(s.base, 'POST', '/api/trips/' + a.trip.id + '/share/export', {}, alice.cookie);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));

    const aShares = await call(s.base, 'GET', '/api/shares', null, alice.cookie);
    assert.equal(aShares.body.data.length, 1);
    const bShares = await call(s.base, 'GET', '/api/shares', null, bob.cookie);
    assert.equal(bShares.body.data.length, 0, '别人的分享不出现在我的列表里');

    const del = await call(s.base, 'DELETE', '/api/shares/' + aShares.body.data[0].id, null, bob.cookie);
    assert.equal(del.status, 404);
    const stillThere = await call(s.base, 'GET', '/api/shares', null, alice.cookie);
    assert.equal(stillThere.body.data.length, 1, '别人删不掉');
  } finally {
    await s.close();
    delete process.env.TRAVEL_SHARE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧数据认领：没归属的行程 / 分享归给认领人，认领完别人也拿不到', async () => {
  // 分享目录指到空目录：否则读列表时会把仓里 share/ 下的真实老包也补进来
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-iso-legacy-'));
  process.env.TRAVEL_SHARE_DIR = dir;
  const s = await start();
  try {
    // 模拟账号上线前就存在的两条行程（user_id 为空）
    const legacyTrip = s.db.createTrip({ city: '三亚', title: '老的：三亚四天' });
    s.db.addPin({ trip_id: legacyTrip.id, name: '天涯海角', lng: 109.3, lat: 18.29, category: 'sight' });
    const legacyShare = s.db.addShare({ city: '杭州', title: '老的分享', base: 'old-base', stops: 3 });

    const alice = await signup(s.base, 'alice3');
    const bob = await signup(s.base, 'bob3');

    const before = await call(s.base, 'GET', '/api/trips', null, alice.cookie);
    assert.equal(before.body.data.length, 0, '没认领前谁都看不到');

    const pending = await call(s.base, 'GET', '/api/legacy/pending', null, alice.cookie);
    assert.deepEqual(pending.body.data, { trips: 1, shares: 1 });

    const claim = await call(s.base, 'POST', '/api/legacy/claim', {}, alice.cookie);
    assert.deepEqual(claim.body.data.trips, 1);
    assert.deepEqual(claim.body.data.shares, 1);

    const aliceTrips = await call(s.base, 'GET', '/api/trips', null, alice.cookie);
    assert.deepEqual(aliceTrips.body.data.map((t) => t.title), ['老的：三亚四天']);
    const aliceShares = await call(s.base, 'GET', '/api/shares', null, alice.cookie);
    assert.equal(aliceShares.body.data.length, 1);

    const bobTrips = await call(s.base, 'GET', '/api/trips', null, bob.cookie);
    assert.equal(bobTrips.body.data.length, 0, '认领是先到先得，晚来的看不到');
    const bobClaim = await call(s.base, 'POST', '/api/legacy/claim', {}, bob.cookie);
    assert.deepEqual({ trips: bobClaim.body.data.trips, shares: bobClaim.body.data.shares }, { trips: 0, shares: 0 });

    // 认领后的行程是真的能用（点还在）
    const pins = await call(s.base, 'GET', '/api/trips/' + aliceTrips.body.data[0].id + '/pins', null, alice.cookie);
    assert.equal(pins.body.data.length, 1);
    assert.equal(s.db.getShare(legacyShare.id).user_id, alice.user.id);
  } finally {
    await s.close();
    delete process.env.TRAVEL_SHARE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('退出登录后立刻看不到自己的数据', async () => {
  const s = await start();
  try {
    const alice = await signup(s.base, 'alice4');
    await seedTrip(s.base, alice.cookie, '杭州', '我的一趟');
    const before = await call(s.base, 'GET', '/api/trips', null, alice.cookie);
    assert.equal(before.body.data.length, 1);
    const out = await call(s.base, 'POST', '/api/auth/logout', {}, alice.cookie);
    assert.equal(out.status, 200);
    const after = await call(s.base, 'GET', '/api/trips', null, alice.cookie);
    assert.equal(after.status, 401, '退出后旧 cookie 不认了');
  } finally {
    await s.close();
  }
});
