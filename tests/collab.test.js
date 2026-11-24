/* 一起改（2026-11-24，对标圆周旅迹的多人协作）：邀请 / 成员 / 留言
   这一层是「分享页只读」的补丁 —— 被邀请的人登录后能真的改这趟行程。

   ① 数据：trip_members / trip_invites / trip_comments 三张表（append-only 的只有留言）
   ② 权限：getTripForMember 收口「owner 或成员」；碰不到一律 404（不泄露存在性）
   ③ 邀请：24 字节随机 token、默认 30 天、可撤销；接受要登录
   ④ 留言：成员与 owner 都能写，作者名取当时昵称 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { createDb } = require('../server/db');
const collab = require('../server/routes/collab');
const tripsRoutes = require('../server/routes/trips');

const DB_SRC = read('server/db.js');
const COLLAB_SRC = read('server/routes/collab.js');
const TRIPS_SRC = read('server/routes/trips.js');
const INDEX_SRC = read('server/index.js');
const COLLAB_JS = read('web/js/collab.js');
const TRIPS_JS = read('web/js/trips.js');

function route(list, method, p) {
  return list.find((r) => r.method === method && r.path === p);
}

// 最小 ctx：HttpError + 假登录用户
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
// auth.requireUser 读的是会话 Cookie；测试里用 fallbackUser 直接指定「当前登录的人」
function ctxFor(db, user) {
  return {
    db,
    HttpError,
    params: {},
    query: {},
    body: {},
    req: { headers: {} },
    user,
    fallbackUser: user || undefined,
  };
}

test('三张表都在 schema 里（成员 / 邀请 / 留言）', () => {
  ['trip_members', 'trip_invites', 'trip_comments'].forEach((t) => {
    assert.match(DB_SRC, new RegExp('CREATE TABLE IF NOT EXISTS ' + t), '缺表 ' + t);
  });
  assert.match(DB_SRC, /CREATE INDEX IF NOT EXISTS idx_trip_comments_trip/, '留言要按行程建索引');
});

test('权限收口：owner 或成员都能碰，别人一律 404', () => {
  const db = createDb(':memory:');
  const owner = db.createUser({ username: 'owner1', passwordHash: 'x', salt: 's' });
  const mate = db.createUser({ username: 'mate1', passwordHash: 'x', salt: 's' });
  const other = db.createUser({ username: 'other1', passwordHash: 'x', salt: 's' });
  const trip = db.createTrip({ city: '杭州', title: '一起改测试', theme: null, userId: owner.id });

  assert.equal(db.getTripForMember(trip.id, owner.id).role, 'owner');
  assert.equal(db.getTripForMember(trip.id, mate.id), null, '还没邀请就不该能碰');
  db.addMember(trip.id, mate.id);
  assert.equal(db.getTripForMember(trip.id, mate.id).role, 'editor');
  assert.equal(db.getTripForMember(trip.id, other.id), null);

  // 列表：自己的 + 别人分享给我的
  const mine = db.listTrips(owner.id).map((t) => Number(t.id));
  const shared = db.listTripsSharedWith(mate.id).map((t) => Number(t.id));
  assert.ok(mine.includes(Number(trip.id)));
  assert.ok(shared.includes(Number(trip.id)), '被邀请的行程要出现在他的列表里');
  assert.ok(!db.listTripsSharedWith(other.id).some((t) => Number(t.id) === Number(trip.id)));
});

test('邀请：建 → 看 → 接受 → 撤销；过期与撤销都拒', () => {
  const db = createDb(':memory:');
  const owner = db.createUser({ username: 'o2', passwordHash: 'x', salt: 's' });
  const mate = db.createUser({ username: 'm2', passwordHash: 'x', salt: 's' });
  const trip = db.createTrip({ city: '三亚', title: '邀请测试', theme: null, userId: owner.id });

  const create = route(collab, 'POST', '/api/trips/:id/invite');
  const accept = route(collab, 'POST', '/api/invite/:token/accept');
  const info = route(collab, 'GET', '/api/invite/:token');
  const revoke = route(collab, 'DELETE', '/api/trips/:id/invite');

  const ctx = ctxFor(db, owner);
  ctx.params = { id: String(trip.id) };
  const made = create.handler(ctx);
  assert.ok(made.token && made.token.length >= 20, 'token 要够长');
  assert.equal(made.tripId, trip.id);
  assert.match(made.url, /^\/invite\//);

  // 未登录也能看「这是哪趟」
  const peek = ctxFor(db, null);
  peek.params = { token: made.token };
  const seen = info.handler(peek);
  assert.equal(seen.tripId, trip.id);
  assert.equal(seen.needLogin, true);

  // 接受 → 成为 editor
  const mateCtx = ctxFor(db, mate);
  mateCtx.params = { token: made.token };
  const joined = accept.handler(mateCtx);
  assert.equal(joined.role, 'editor');
  assert.equal(joined.already, false);
  assert.equal(db.getTripForMember(trip.id, mate.id).role, 'editor');
  // 再点一次：already
  assert.equal(accept.handler(mateCtx).already, true);

  // 撤销后旧链接失效
  const ownerCtx = ctxFor(db, owner);
  ownerCtx.params = { id: String(trip.id) };
  revoke.handler(ownerCtx);
  const dead = ctxFor(db, null);
  dead.params = { token: made.token };
  assert.throws(() => info.handler(dead), (e) => e.status === 404);
});

test('留言：成员能写能看，空/超长拒；作者名取当时昵称', () => {
  const db = createDb(':memory:');
  const owner = db.createUser({ username: 'o3', passwordHash: 'x', salt: 's', nickname: '长春' });
  const mate = db.createUser({ username: 'm3', passwordHash: 'x', salt: 's', nickname: '小王' });
  const trip = db.createTrip({ city: '成都', title: '留言测试', theme: null, userId: owner.id });
  db.addMember(trip.id, mate.id);

  const post = route(collab, 'POST', '/api/trips/:id/comments');
  const list = route(collab, 'GET', '/api/trips/:id/comments');

  const c = ctxFor(db, mate);
  c.params = { id: String(trip.id) };
  c.body = { text: '第三天想加个地方' };
  const out = post.handler(c);
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].author, '小王', '作者名取昵称');

  const readCtx = ctxFor(db, owner);
  readCtx.params = { id: String(trip.id) };
  assert.equal(list.handler(readCtx).comments.length, 1);

  // 空 / 超长
  const bad = ctxFor(db, mate);
  bad.params = { id: String(trip.id) };
  bad.body = { text: '   ' };
  assert.throws(() => post.handler(bad), (e) => e.status === 400);
  bad.body = { text: 'x'.repeat(501) };
  assert.throws(() => post.handler(bad), (e) => e.status === 400);

  // 不是成员的人写不了（404，不泄露存在性）
  const stranger = db.createUser({ username: 's3', passwordHash: 'x', salt: 's' });
  const sc = ctxFor(db, stranger);
  sc.params = { id: String(trip.id) };
  sc.body = { text: '我也想说' };
  assert.throws(() => post.handler(sc), (e) => e.status === 404);
});

test('移除成员：owner 能踢人、成员能自己退、owner 不能被踢', () => {
  const db = createDb(':memory:');
  const owner = db.createUser({ username: 'o4', passwordHash: 'x', salt: 's' });
  const mate = db.createUser({ username: 'm4', passwordHash: 'x', salt: 's' });
  const mate2 = db.createUser({ username: 'm4b', passwordHash: 'x', salt: 's' });
  const trip = db.createTrip({ city: '厦门', title: '移除测试', theme: null, userId: owner.id });
  db.addMember(trip.id, mate.id);
  db.addMember(trip.id, mate2.id);

  const del = route(collab, 'DELETE', '/api/trips/:id/members/:uid');
  // 成员踢别人：403
  const mc = ctxFor(db, mate);
  mc.params = { id: String(trip.id), uid: String(mate2.id) };
  assert.throws(() => del.handler(mc), (e) => e.status === 403);
  // 成员自己退：可以
  mc.params = { id: String(trip.id), uid: String(mate.id) };
  del.handler(mc);
  assert.equal(db.getTripForMember(trip.id, mate.id), null);
  // owner 踢人：可以
  const oc = ctxFor(db, owner);
  oc.params = { id: String(trip.id), uid: String(mate2.id) };
  del.handler(oc);
  assert.equal(db.getTripForMember(trip.id, mate2.id), null);
  // owner 不能被踢
  oc.params = { id: String(trip.id), uid: String(owner.id) };
  assert.throws(() => del.handler(oc), (e) => e.status === 400);
});

test('行程接口改成「我能碰的」：成员也能读点、改标题', () => {
  assert.match(TRIPS_SRC, /const \{ tripFor \} = require\('\.\.\/trip-access'\)/, 'trips 路由要接 trip-access');
  assert.match(TRIPS_SRC, /function tripOfUser\(ctx, id\) \{\s*\n\s*const \{ user, trip, role \} = tripFor\(ctx, id\);/, 'tripOfUser 要走成员判定');
  assert.match(TRIPS_SRC, /ctx\.db\.getTripForMember\(pin\.trip_id, user\.id\)/, 'pinOfUser 也要走成员判定');
  assert.match(TRIPS_SRC, /listTripsSharedWith\(user\.id\)/, '列表要带上别人分享给我的');
  assert.match(TRIPS_SRC, /role: Number\(t\.user_id\) === Number\(user\.id\) \? 'owner' : 'editor'/, '列表要标 role');
});

test('页面与路由：/invite/<token> 与 /collab 都能打开', () => {
  assert.match(INDEX_SRC, /'\/collab': 'collab\.html'/, '缺 /collab 页面路由');
  assert.match(INDEX_SRC, /pathname\.startsWith\('\/invite\/'\)/, '缺 /invite/<token> 落地');
  assert.match(COLLAB_JS, /function tokenFromPath\(\)/, '缺 token 解析');
  assert.match(COLLAB_JS, /acceptInvite\(token\)/, '要能接受邀请');
  assert.match(COLLAB_JS, /createTripInvite\(state\.tripId\)/, '要能生成邀请链接');
  assert.match(COLLAB_JS, /addTripComment\(state\.tripId, text\)/, '要能留言');
  // 我的行程页：编辑者不给删除、并标「一起改」
  assert.match(TRIPS_JS, /t\.role === 'editor'/, '行程卡要认 role');
  assert.match(TRIPS_JS, /href="\/collab\?trip=/, '行程卡要有「一起改」入口');
});
