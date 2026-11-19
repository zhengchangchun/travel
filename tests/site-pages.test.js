/* 站点层（2026-11-19）：真登录（账号密码）、推荐地区/路程、当前地区、分享列表
   ① 账号密码：注册/登录/退出/改设置；库里不存明文（scrypt + 每用户盐）
   ② 会话：HttpOnly Cookie 里放随机 token，库里只存它的 sha256；改一个字就认不出
   ③ 推荐：精选库 config/featured.json 是真源；当前城市排第一，并带真实「已收录点数」
   ④ 分享列表：每次分享落一条，网页版地址 /share/<base>.html 同一个服务里能直接打开
   ⑤ 一城多趟：trips 带 theme，同一城市可以建多条 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const TEST_CONFIG = { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' };

// 假高德：只回答「反向地理编码」与「IP 定位」这两件首页要用的事
function fakeAmap() {
  const calls = [];
  return {
    calls,
    async amapGet(pathname) {
      calls.push(pathname);
      if (pathname.includes('geocode/regeo')) {
        return { status: '1', regeocode: { formatted_address: '浙江省杭州市萧山区蜀山街道', addressComponent: { province: '浙江省', city: '杭州市', district: '萧山区', adcode: '330109' } } };
      }
      if (pathname.includes('/v3/ip')) {
        return { status: '1', province: '浙江省', city: '杭州市', adcode: '330100' };
      }
      return { status: '1' };
    },
  };
}

async function start(opts) {
  const db = createDb(':memory:');
  const amap = (opts && opts.amap) || fakeAmap();
  const app = createApp({
    config: TEST_CONFIG,
    categories: [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }],
    db,
    amap,
    routeIntervalMs: 0,
    collectIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    db,
    amap,
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
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') || '' };
}

test('注册：落库是 scrypt 哈希（不存明文）+ 下发 HttpOnly 会话 Cookie', async () => {
  const s = await start();
  try {
    const r = await call(s.base, 'POST', '/api/auth/register', { username: 'zhangcc', password: 'secret-pass-8', nickname: '长春' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.user.username, 'zhangcc');
    assert.equal(r.body.data.user.nickname, '长春');
    assert.match(r.setCookie, /travel_session=/);
    assert.match(r.setCookie, /HttpOnly/);

    const row = s.db.getUserByName('zhangcc');
    assert.ok(row.salt && row.salt.length >= 16, '每人一个盐');
    assert.notEqual(row.password_hash, 'secret-pass-8');
    assert.ok(!String(row.password_hash).includes('secret'), '不要出现明文片段');
    assert.equal(row.password_hash.length, 128, 'scrypt 64 字节 = 128 个 hex');
  } finally {
    await s.close();
  }
});

test('登录：密码错 401；对了两边同一句文案都没有（防枚举）', async () => {
  const s = await start();
  try {
    await call(s.base, 'POST', '/api/auth/register', { username: 'zhangcc', password: 'secret-pass-8' });
    const bad = await call(s.base, 'POST', '/api/auth/login', { username: 'zhangcc', password: 'wrong-pass-8' });
    assert.equal(bad.status, 401);
    const nobody = await call(s.base, 'POST', '/api/auth/login', { username: 'nobody', password: 'wrong-pass-8' });
    assert.equal(nobody.status, 401);
    assert.equal(bad.body.error.msg, nobody.body.error.msg, '账号不存在与密码错要同一句');

    const ok = await call(s.base, 'POST', '/api/auth/login', { username: 'zhangcc', password: 'secret-pass-8' });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie, /travel_session=/);
  } finally {
    await s.close();
  }
});

test('会话：带 Cookie 能认出人；令牌改一个字符就认不出；退出后失效', async () => {
  const s = await start();
  try {
    const reg = await call(s.base, 'POST', '/api/auth/register', { username: 'zhangcc', password: 'secret-pass-8' });
    const cookie = reg.setCookie.split(';')[0];
    const me = await call(s.base, 'GET', '/api/auth/me', null, cookie);
    assert.equal(me.body.data.user.username, 'zhangcc');

    const tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
    const fake = await call(s.base, 'GET', '/api/auth/me', null, tampered);
    assert.equal(fake.body.data.user, null, '改过的令牌不该认出人');

    const out = await call(s.base, 'POST', '/api/auth/logout', {}, cookie);
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    const after = await call(s.base, 'GET', '/api/auth/me', null, cookie);
    assert.equal(after.body.data.user, null, '退出后会话要失效');
  } finally {
    await s.close();
  }
});

test('改个人设置：没登录 401；登录后能改昵称/默认城市/默认方式，非法方式被拒', async () => {
  const s = await start();
  try {
    const anon = await call(s.base, 'PATCH', '/api/auth/me', { nickname: 'x' });
    assert.equal(anon.status, 401);

    const reg = await call(s.base, 'POST', '/api/auth/register', { username: 'zhangcc', password: 'secret-pass-8' });
    const cookie = reg.setCookie.split(';')[0];
    const ok = await call(s.base, 'PATCH', '/api/auth/me', { nickname: '长春', defaultCity: '三亚', defaultMode: 'driving' }, cookie);
    assert.equal(ok.status, 200);
    assert.deepEqual(
      [ok.body.data.user.nickname, ok.body.data.user.defaultCity, ok.body.data.user.defaultMode],
      ['长春', '三亚', 'driving']
    );

    const bad = await call(s.base, 'PATCH', '/api/auth/me', { defaultMode: 'teleport' }, cookie);
    assert.equal(bad.status, 400);
    const avatar = await call(s.base, 'PATCH', '/api/auth/me', { avatar: 'javascript:alert(1)' }, cookie);
    assert.equal(avatar.body.data.user.avatar, '', '头像只收 http(s) 或 data:image');
  } finally {
    await s.close();
  }
});

test('账号/密码基本校验：太短、非法字符、重复注册都拒', async () => {
  const s = await start();
  try {
    const short = await call(s.base, 'POST', '/api/auth/register', { username: 'ab', password: 'secret-pass-8' });
    assert.equal(short.status, 400);
    const weak = await call(s.base, 'POST', '/api/auth/register', { username: 'zhangcc', password: '1234567' });
    assert.equal(weak.status, 400);
    const chinese = await call(s.base, 'POST', '/api/auth/register', { username: '长春', password: 'secret-pass-8' });
    assert.equal(chinese.status, 400);
    const dup = await call(s.base, 'POST', '/api/auth/register', { username: 'ZhangCC', password: 'secret-pass-8' });
    assert.equal(dup.status, 200, '大小写不同视为同一账号？—— 先建');
    const dup2 = await call(s.base, 'POST', '/api/auth/register', { username: 'zhangcc', password: 'secret-pass-8' });
    assert.equal(dup2.status, 400, '同名（忽略大小写）不许重复注册');
  } finally {
    await s.close();
  }
});

test('当前地区：给了坐标走高德反查（杭州市 → 杭州）；没坐标退 IP 定位', async () => {
  const s = await start();
  try {
    const byCoord = await call(s.base, 'GET', '/api/whereami?lng=120.16&lat=30.25');
    assert.equal(byCoord.body.data.city, '杭州', '「杭州市」要收敛成「杭州」');
    assert.equal(byCoord.body.data.district, '萧山区');
    assert.equal(byCoord.body.data.source, 'browser');
    const byIp = await call(s.base, 'GET', '/api/whereami');
    assert.equal(byIp.body.data.city, '杭州');
    assert.equal(byIp.body.data.source, 'ip');
  } finally {
    await s.close();
  }
});

test('当前地区：高德两条都挂了也不报错，回退默认城市', async () => {
  const boom = {
    async amapGet() {
      throw new Error('quota');
    },
  };
  const s = await start({ amap: boom });
  try {
    const r = await call(s.base, 'GET', '/api/whereami?lng=1&lat=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.city, '');
    assert.equal(r.body.data.fallback, true);
    assert.equal(r.body.data.used, '杭州');
  } finally {
    await s.close();
  }
});

test('推荐：精选库是真源，当前城市排第一，地区带真实已收录点数', async () => {
  const s = await start();
  try {
    s.db.upsertPoi({ poi_id: 'p1', city: '杭州', category: 'sight', name: '西湖', lng: 120.1, lat: 30.2, fetchedAt: new Date().toISOString() });
    const r = await call(s.base, 'GET', '/api/featured?city=三亚');
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.current.city, '三亚');
    assert.equal(d.regions[0].city, '三亚', '当前城市要排第一');
    assert.equal(d.regions[0].current, true);
    assert.equal(d.routes[0].city, '三亚', '该城的推荐路线也要排在前面');
    const hz = d.regions.find((x) => x.city === '杭州');
    assert.equal(hz.collected, 1, '已收录点数读真实库');
    const bj = d.regions.find((x) => x.city === '成都');
    assert.equal(bj.collected, 0);
    assert.ok(d.routes.every((x) => Array.isArray(x.stops) && x.stops.length), '每条路线都要有点');
  } finally {
    await s.close();
  }
});

test('推荐路程：公开形状里不带坐标（详情只给名字和高德搜索链接）', async () => {
  const s = await start();
  try {
    const r = await call(s.base, 'GET', '/api/featured');
    const json = JSON.stringify(r.body.data.routes);
    assert.ok(!/"lng"|"lat"/.test(json), '推荐路线不应含坐标');
  } finally {
    await s.close();
  }
});

test('一城多趟：trips 带主题，同城能建多条并各自改名/改主题', async () => {
  const s = await start();
  try {
    const a = await call(s.base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 西线＋东线', theme: '经典首刷' });
    const b = await call(s.base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 亲子慢玩', theme: '亲子' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.data.city, '三亚');
    assert.equal(a.body.data.theme, '经典首刷');

    const patched = await call(s.base, 'PATCH', `/api/trips/${a.body.data.id}`, { theme: '改过的主题' });
    assert.equal(patched.body.data.theme, '改过的主题');

    const list = await call(s.base, 'GET', '/api/trips?city=三亚');
    assert.equal(list.body.data.length, 2, '同城两条都要在');
    assert.equal(patched.body.data.note, null, '只改主题不该动别的字段');
  } finally {
    await s.close();
  }
});

test('分享列表：分享落一条记录，网页版地址能直接在同一个服务里打开；删除连文件一起清', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-share-'));
  process.env.TRAVEL_SHARE_DIR = dir;
  const s = await start();
  try {
    const trip = await call(s.base, 'POST', '/api/trips', { city: '三亚', title: '三亚 · 我的行程' });
    const tripId = trip.body.data.id;
    await call(s.base, 'POST', '/api/pins', {
      trip_id: tripId, name: '天涯海角', lng: 109.345, lat: 18.2926, category: 'sight',
    });
    const shared = await call(s.base, 'POST', `/api/trips/${tripId}/share/export`, { stops: [] });
    assert.equal(shared.status, 200);
    const base = shared.body.data.base;
    assert.ok(fs.existsSync(path.join(dir, base + '.html')), '网页版要真落盘');

    const list = await call(s.base, 'GET', '/api/shares');
    assert.equal(list.body.data.length, 1);
    const row = list.body.data[0];
    assert.equal(row.url, '/share/' + encodeURIComponent(base + '.html'));
    assert.equal(row.city, '三亚');
    assert.ok(row.text && row.text.length > 0, '列表里要带纯文本，能直接复制');

    // 网页版地址真能打开（同一个服务里）
    const page = await fetch(s.base + row.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);

    const del = await call(s.base, 'DELETE', `/api/shares/${row.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.data.removedFiles.length, 3, 'html/txt/json 三个都删掉');
    assert.ok(!fs.existsSync(path.join(dir, base + '.html')));
    const after = await call(s.base, 'GET', '/api/shares');
    assert.equal(after.body.data.length, 0);
  } finally {
    await s.close();
    delete process.env.TRAVEL_SHARE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('页面路由：首页占 /，规划页在 /app，各子页都能开', async () => {
  const s = await start();
  try {
    const pages = [
      ['/', '旅迹'],
      ['/home', '旅迹'],
      ['/app', 'id="app"'],
      ['/trips', '我的行程'],
      ['/shares', '分享列表'],
      ['/settings', '个人设置'],
      ['/login', '登录'],
    ];
    for (const [url, needle] of pages) {
      const res = await fetch(s.base + url);
      assert.equal(res.status, 200, url + ' 应能打开');
      const text = await res.text();
      assert.match(text, /<html/i, url + ' 应返回页面');
      assert.ok(text.includes(needle), url + ' 内容里应有 ' + needle);
    }
    const missing = await fetch(s.base + '/nope');
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('前端接线：头部共用、首页只浏览推荐、分享列表给的是网页版链接', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const home = read('web/home.html');
  const app = read('web/index.html');
  assert.match(home, /id="headbar"/);
  assert.match(app, /id="headbar"/, '规划页也要挂同一条头部');
  assert.match(app, /body class="has-headbar"/);
  const head = read('web/js/headbar.js');
  assert.match(head, /我的行程/);
  assert.match(head, /分享列表/);
  assert.match(head, /个人设置/);
  assert.match(head, /登录 \/ 注册/);
  assert.match(head, /当前地区/);
  const homeJs = read('web/js/home.js');
  assert.match(homeJs, /api\.featured\(/);
  assert.match(homeJs, /旅行|收录|collect/i);
  assert.match(homeJs, /只会浏览|只浏览|不会动你的行程/);
  const shares = read('web/js/shares.js');
  assert.match(shares, /打开网页版/);
  assert.match(shares, /loginGate/);
  const login = read('web/js/login.js');
  assert.match(login, /api\.register|api\.login/);
});

test('分享列表：share/ 里当年生成的老包会被补进列表（不用手抄）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-share-old-'));
  process.env.TRAVEL_SHARE_DIR = dir;
  // 造一个「老年代」的分享包：只有三个文件、没有数据库记录
  fs.writeFileSync(path.join(dir, '杭州-我的行程-2026-11-10.html'), '<html><body>老包</body></html>', 'utf8');
  fs.writeFileSync(path.join(dir, '杭州-我的行程-2026-11-10.txt'), '第一天 西湖\n第二天 灵隐', 'utf8');
  fs.writeFileSync(path.join(dir, '杭州-我的行程-2026-11-10.json'), JSON.stringify({ stops: [{ name: '西湖' }, { name: '灵隐' }] }), 'utf8');
  const s = await start();
  try {
    const list = await call(s.base, 'GET', '/api/shares');
    assert.equal(list.body.data.length, 1);
    const row = list.body.data[0];
    assert.equal(row.city, '杭州');
    assert.equal(row.title, '我的行程');
    assert.equal(row.stops, 2, '点数从 json 里读');
    assert.match(row.text, /西湖/);
    assert.match(row.url, /%E6%9D%AD%E5%B7%9E|杭州/);
    // 第二次请求不该重复插入
    const again = await call(s.base, 'GET', '/api/shares');
    assert.equal(again.body.data.length, 1, '补账是幂等的');
  } finally {
    await s.close();
    delete process.env.TRAVEL_SHARE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('首页配图：静态地图缩略图（地区俯瞰 / 路线图）会生成并缓存，地图不可用时给 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-home-img-'));
  process.env.TRAVEL_HOME_IMG_DIR = dir;
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // 只要是个二进制就行
  const params = [];
  const amap = {
    async amapGet() {
      return { status: '1' };
    },
    async staticMap(p) {
      params.push(p);
      return { buffer: PNG, contentType: 'image/png' };
    },
  };
  const s = await start({ amap });
  try {
    // ① 地区俯瞰图
    const region = await fetch(s.base + '/home-img/region-%E6%9D%AD%E5%B7%9E.png');
    assert.equal(region.status, 200);
    assert.equal(region.headers.get('content-type'), 'image/png');
    assert.equal((await region.arrayBuffer()).byteLength, PNG.length);
    assert.ok(params.some((p) => p.zoom && p.location), '地区图要指定中心与缩放');
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('region-')), '图要落盘缓存');

    // ② 路线图：带 marker 与折线，且不带 zoom（让高德自己取景）
    const route = await fetch(s.base + '/home-img/route-sy-4d.png');
    assert.equal(route.status, 200);
    const routeParams = params[params.length - 1];
    assert.ok(routeParams.markers && routeParams.paths, '路线图要有 marker 和折线');
    assert.ok(!routeParams.zoom, '路线图不要写死缩放，交给高德取景');

    // ③ 第二次请求走缓存：不再打地图服务
    const before = params.length;
    await fetch(s.base + '/home-img/region-%E6%9D%AD%E5%B7%9E.png');
    assert.equal(params.length, before, '第二次应该直接读文件');

    // ④ 没有坐标的 key / 地图服务挂了 ⇒ 404（页面自己退化成渐变底）
    const none = await fetch(s.base + '/home-img/route-nope.png');
    assert.equal(none.status, 404);
    const boom = await start({
      amap: {
        async amapGet() {
          return { status: '1' };
        },
        async staticMap() {
          throw new Error('quota');
        },
      },
    });
    try {
      fs.rmSync(path.join(dir, 'region-三亚.png'), { force: true });
      const failed = await fetch(boom.base + '/home-img/region-%E4%B8%89%E4%BA%9A.png');
      assert.equal(failed.status, 404, '生成不了就 404，不要 500');
    } finally {
      await boom.close();
    }
  } finally {
    await s.close();
    delete process.env.TRAVEL_HOME_IMG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('推荐载荷带封面地址；坐标底稿只在服务端（接口里仍然没有坐标）', async () => {
  const s = await start();
  try {
    const r = await call(s.base, 'GET', '/api/featured?city=三亚');
    const d = r.body.data;
    assert.match(d.regions[0].cover, /^\/home-img\/region-/);
    assert.match(d.routes[0].cover, /^\/home-img\/route-/);
    assert.ok(!/"lng"|"lat"/.test(JSON.stringify(d)), '推荐载荷里不该出现坐标');
    const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/featured-geo.json'), 'utf8'));
    assert.ok(Object.keys(geo.cities || {}).length >= 5, '坐标底稿要有城市中心');
    assert.ok(Object.keys(geo.routes || {}).length >= 4, '坐标底稿要有路线站点');
  } finally {
    await s.close();
  }
});

test('首页配图：坐标缺失（null）不能当成 0,0 —— 那会把取景拉到整张世界地图', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-home-img-null-'));
  process.env.TRAVEL_HOME_IMG_DIR = dir;
  const params = [];
  const amap = {
    async amapGet() {
      return { status: '1' };
    },
    async staticMap(p) {
      params.push(p);
      return { buffer: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png' };
    },
  };
  const s = await start({ amap });
  try {
    // hz-2d 里「九溪十八涧」查不到坐标（null）—— 它不该出现在 marker / 折线里
    const res = await fetch(s.base + '/home-img/route-hz-2d.png');
    assert.equal(res.status, 200);
    const p = params[params.length - 1];
    assert.ok(!/0\.00000,0\.00000/.test(p.markers), 'marker 里不能出现 0,0：' + p.markers);
    assert.ok(!/0\.00000,0\.00000/.test(p.paths), '折线里不能出现 0,0');
    assert.equal((p.markers.match(/\|/g) || []).length + 1, 7, '8 个站点里那个没坐标的要被跳过');
  } finally {
    await s.close();
    delete process.env.TRAVEL_HOME_IMG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('实景图：推荐路程每站带图与出处，/photo/ 能取到图，/api/photos 给规划页用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-photos-'));
  process.env.TRAVEL_FEATURED_PHOTO_DIR = dir;
  const files = fs.readdirSync(path.join(ROOT, 'config'));
  assert.ok(files.includes('featured-photos.json'), '实景图索引要在仓里');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/featured-photos.json'), 'utf8'));
  assert.ok(idx.entries.length >= 20, '索引里应有一批实景图（现在 ' + idx.entries.length + ' 张）');
  assert.ok(idx.entries.every((e) => e.author !== undefined && e.license), '每张都要有许可');

  // 把其中一张拷进临时目录，验证 /photo/ 能发出来
  const one = idx.entries[0];
  const srcFile = path.join(ROOT, 'data/featured-photos', one.file);
  assert.ok(fs.existsSync(srcFile), '图片文件应该在 data/featured-photos 下');
  fs.copyFileSync(srcFile, path.join(dir, one.file));

  const s = await start();
  try {
    const r = await call(s.base, 'GET', '/api/featured?city=' + encodeURIComponent(one.city));
    const route = r.body.data.routes.find((x) => x.stops.some((st) => st.name === one.name));
    const stop = route.stops.find((st) => st.name === one.name);
    assert.match(stop.photo, /^\/photo\//, '有图的站要带 photo 地址');
    assert.ok(stop.photoCredit, '要带摄影者/许可');
    assert.ok(route.photoCount >= 1, '整条路线要统计有图几站');
    assert.ok(r.body.data.photoCredits, '要带整体出处说明');
    assert.ok(!/"lng"|"lat"/.test(JSON.stringify(r.body.data)), '还是不能漏坐标');

    const img = await fetch(s.base + stop.photo);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\//);

    const photos = await call(s.base, 'GET', '/api/photos?city=' + encodeURIComponent(one.city));
    assert.ok(photos.body.data.photos[one.name], '规划页按点位名查得到图');
    assert.match(photos.body.data.photos[one.name].url, /^\/photo\//);

    // 文件不在就别硬给（页面会自动不显示）
    fs.rmSync(path.join(dir, one.file));
    const gone = await fetch(s.base + stop.photo);
    assert.equal(gone.status, 404);
  } finally {
    await s.close();
    delete process.env.TRAVEL_FEATURED_PHOTO_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('实景图接线：首页卡与详情、行程清单都要用上（且带出处）', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const homeJs = read('web/js/home.js');
  assert.match(homeJs, /class="shots"/, '路程卡上要有一排实景小图');
  assert.match(homeJs, /stop-shot/, '路程详情每站要有实景图');
  assert.match(homeJs, /Wikimedia Commons/, '要标出处');
  const itinerary = read('web/js/itinerary.js');
  assert.match(itinerary, /itin-shot/, '行程清单要有缩略图');
  const app = read('web/js/app.js');
  assert.match(app, /getCityPhotos/, '规划页要按城市拉实景图索引');
  assert.match(app, /function photoOfPin/, '要点自己的图优先、其次按名字查');
  const css = read('web/css/style.css');
  assert.match(css, /\.itin-shot/, '缩略图要样式');
});
