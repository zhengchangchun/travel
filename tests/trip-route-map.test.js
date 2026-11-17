/* P14 真实路线图：
   ① 抽稀 / paths / markers 参数格式（静态地图那条 5 字段的硬规矩，少一个字段就 20003）
   ② 逐段规划聚合（缓存、失败降级、全失败才抛）
   ③ 分享包里的路线图：base64 内嵌、分享页 tab 可切换、JSON 不带图
   全部离线（假 amap），不消耗真配额 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const routemap = require('../server/routemap');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const APP = read('web/js/app.js');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [{ key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' }];

const STOPS = [
  { name: 'A', lng: 120.1, lat: 30.2 },
  { name: 'B', lng: 120.2, lat: 30.3 },
  { name: 'C', lng: 120.3, lat: 30.4 },
];

// 假高德：逐段返回「起点→终点」的直线折线 + 固定里程/耗时；staticMap 返回假 PNG
function fakeAmap(opts = {}) {
  const calls = { walking: 0, driving: 0, riding: 0, transit: 0, staticMap: 0 };
  const mk = (o, d, dist, dur) => {
    const [olng, olat] = String(o).split(',').map(Number);
    const [dlng, dlat] = String(d).split(',').map(Number);
    return { polyline: [[olng, olat], [dlng, dlat]], distance: dist, duration: dur };
  };
  const failLeg = (name, n) => {
    if (opts[name] === true) return true;
    if (Number.isInteger(opts[name + 'Leg'])) return opts[name + 'Leg'] === n;
    return false;
  };
  return {
    calls,
    async planWalking(o, d) {
      calls.walking += 1;
      if (failLeg('failWalk', calls.walking - 1)) throw new Error('步行第' + calls.walking + '段失败');
      return mk(o, d, 1000, 700);
    },
    async planRiding(o, d) {
      calls.riding += 1;
      if (failLeg('failRide', calls.riding - 1)) throw new Error('骑行第' + calls.riding + '段失败');
      return mk(o, d, 1500, 600);
    },
    async planTransit(o, d, city) {
      if (!city) throw new Error('公交需要城市名');
      calls.transit += 1;
      return Object.assign(mk(o, d, 2500, 900), { transit: { segments: [] } });
    },
    async planDriving(o, d) {
      calls.driving += 1;
      if (failLeg('failDrive', calls.driving - 1)) throw new Error('驾车第' + calls.driving + '段失败');
      return mk(o, d, 2000, 500);
    },
    async staticMap(params) {
      calls.staticMap += 1;
      if (opts.failMap) throw new Error('CUQPS_HAS_EXCEEDED_THE_LIMIT');
      // 记下最后一次参数，供断言
      calls.lastParams = params;
      return { buffer: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png;charset=UTF-8' };
    },
  };
}

// ---------- ① 参数格式 ----------

test('thinPoints：等距抽稀保留首尾；不足上限原样返回；非法点剔除', () => {
  const many = Array.from({ length: 1000 }, (_, i) => [120 + i / 10000, 30 + i / 10000]);
  const thinned = routemap.thinPoints(many, 200);
  assert.equal(thinned.length, 200);
  assert.deepEqual(thinned[0], many[0]);
  assert.deepEqual(thinned[thinned.length - 1], many[many.length - 1]);
  assert.equal(routemap.thinPoints(many.slice(0, 10), 200).length, 10);
  assert.deepEqual(routemap.thinPoints([[120, 30], [NaN, 30], null, [120.1, 30.1]]), [[120, 30], [120.1, 30.1]]);
});

test('静态地图 paths 必须写满 5 个字段（少一个就是 20003）', () => {
  const p = routemap.buildPathsParam([[120.1, 30.2], [120.2, 30.3]]);
  const [style, line] = p.split(':');
  assert.equal(style.split(',').length, 5, 'paths 的样式段必须是 线宽,线色,线透明度,填充色,填充透明度');
  assert.match(style, /^\d+,0x[0-9a-f]{6},[\d.]+,0x[0-9a-f]{6},[\d.]+$/i);
  assert.equal(line, '120.10000,30.20000;120.20000,30.30000');
  assert.equal(routemap.buildPathsParam([[120.1, 30.2]]), '', '少于 2 个点不该给 paths');
});

test('markers：起点绿 / 终点红 / 中间蓝，标签 1..9 再 A..Z', () => {
  const two = routemap.buildMarkersParam(STOPS.slice(0, 2)).split('|');
  assert.equal(two.length, 2);
  assert.match(two[0], /^mid,0x22aa66,1:/);
  assert.match(two[1], /^mid,0xe0503a,2:/, '两个点时第二个就是终点（红）');
  const three = routemap.buildMarkersParam(STOPS).split('|');
  assert.match(three[0], /,1:/);
  assert.match(three[1], /,2:/);
  assert.match(three[2], /^mid,0xe0503a,3:/);
  const twelve = routemap.buildMarkersParam(
    Array.from({ length: 12 }, (_, i) => ({ name: 'p' + i, lng: 120 + i / 100, lat: 30 + i / 100 }))
  ).split('|');
  assert.match(twelve[9], /,A:/, '第 10 个点用字母 A');
  assert.match(twelve[11], /,C:/);
});

test('staticMapParams：默认 760*430 / scale=1（手机上正好 2 倍像素），zoom 可不传', () => {
  const p = routemap.staticMapParams({ stops: STOPS, points: [[120.1, 30.2], [120.2, 30.3]] });
  assert.equal(p.size, '760*430');
  assert.equal(p.scale, 1);
  assert.equal(p.zoom, undefined);
  assert.ok(p.paths && p.markers);
});

// ---------- ② 逐段规划聚合 ----------

function withCache() {
  const store = new Map();
  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    size: () => store.size,
  };
}

test('routeForStops：逐段拼接成一条折线、里程/耗时求和、命中缓存不重复调用', async () => {
  const amap = fakeAmap();
  const cache = withCache();
  const r = await routemap.routeForStops({ amap, cache, intervalMs: 0, mode: 'driving', stops: STOPS });
  assert.equal(amap.calls.driving, 2, '3 个点 = 2 段');
  assert.equal(r.distance, 4000);
  assert.equal(r.duration, 1000);
  assert.equal(r.legs.length, 2);
  assert.deepEqual(r.points, [[120.1, 30.2], [120.2, 30.3], [120.3, 30.4]], '逐段拼成一条完整折线');
  assert.equal(r.failed.length, 0);
  // 再跑一次：全走缓存
  const again = await routemap.routeForStops({ amap, cache, intervalMs: 0, mode: 'driving', stops: STOPS });
  assert.equal(amap.calls.driving, 2, '缓存命中不该再打高德');
  assert.equal(again.distance, 4000);
});

test('routeForStops：某段失败只记 failed 不炸；全失败才抛', async () => {
  const partial = fakeAmap({ failWalkLeg: 0 });
  const r = await routemap.routeForStops({ amap: partial, cache: withCache(), intervalMs: 0, mode: 'walking', stops: STOPS });
  assert.equal(r.failed.length, 1, '只失败了一段');
  assert.equal(r.distance, 1000, '剩下那段照算');
  assert.equal(r.legs[0].ok, false);
  assert.equal(r.legs[1].ok, true);

  const amap = fakeAmap({ failWalk: true });
  await assert.rejects(
    () => routemap.routeForStops({ amap, cache: withCache(), intervalMs: 0, mode: 'walking', stops: STOPS }),
    /所有路段均规划失败/
  );
  await assert.rejects(
    () => routemap.routeForStops({ amap, cache: withCache(), intervalMs: 0, mode: 'walking', stops: [STOPS[0]] }),
    /点数不足 2/
  );
});

test('buildShareMaps：两种方式各一张图（data URI），某方式失败只进 errors，不影响另一种', async () => {
  const ok = await routemap.buildShareMaps({
    amap: fakeAmap(),
    cache: withCache(),
    intervalMs: 0,
    stops: STOPS,
    modes: ['driving', 'walking'],
    mapGapMs: 0,
  });
  assert.deepEqual(Object.keys(ok.maps).sort(), ['driving', 'walking']);
  assert.match(ok.maps.driving.image, /^data:image\/png;charset=UTF-8;base64,/);
  assert.equal(ok.maps.driving.modeLabel, '驾车');
  assert.deepEqual(ok.errors, {});

  const half = await routemap.buildShareMaps({
    amap: fakeAmap({ failWalk: true }),
    cache: withCache(),
    intervalMs: 0,
    stops: STOPS,
    modes: ['driving', 'walking'],
    mapGapMs: 0,
  });
  assert.deepEqual(Object.keys(half.maps), ['driving']);
  assert.match(half.errors.walking, /步行.*失败/);

  const badMap = await routemap.buildShareMaps({
    amap: fakeAmap({ failMap: true }),
    cache: withCache(),
    intervalMs: 0,
    stops: STOPS,
    modes: ['driving'],
    mapGapMs: 0,
  });
  assert.deepEqual(badMap.maps, {});
  assert.match(badMap.errors.driving, /CUQPS/);

  // 只认这四种方式；认不出的名字直接滤掉（不报错、也不假装支持）
  const filtered = await routemap.buildShareMaps({
    amap: fakeAmap(),
    cache: withCache(),
    intervalMs: 0,
    stops: STOPS,
    modes: ['bicycling', 'helicopter'],
    city: '杭州',
    mapGapMs: 0,
  });
  assert.deepEqual(filtered.maps, {});
  assert.deepEqual(filtered.errors, {});

  // 骑行与公交都进静态图（骑行走 v5；公交必须带城市名）
  const all = await routemap.buildShareMaps({
    amap: fakeAmap(),
    cache: withCache(),
    intervalMs: 0,
    stops: STOPS,
    modes: ['riding', 'transit'],
    city: '杭州',
    mapGapMs: 0,
  });
  assert.deepEqual(Object.keys(all.maps).sort(), ['riding', 'transit']);
  assert.equal(all.maps.riding.modeLabel, '骑行');
  assert.equal(all.maps.transit.modeLabel, '公交');
  assert.match(all.maps.riding.image, /^data:image\/png;charset=UTF-8;base64,/);

  // 公交没给城市名：只进 errors，不把整包弄挂
  const noCity = await routemap.buildShareMaps({
    amap: fakeAmap(),
    cache: withCache(),
    intervalMs: 0,
    stops: STOPS,
    modes: ['transit'],
    mapGapMs: 0,
  });
  assert.deepEqual(noCity.maps, {});
  assert.match(noCity.errors.transit, /城市名/);
});

// ---------- ③ 分享包 ----------

const MAPS = {
  driving: { mode: 'driving', modeLabel: '驾车', distance: 4000, duration: 1000, image: 'data:image/png;base64,AAA', legs: [] },
  walking: { mode: 'walking', modeLabel: '步行', distance: 3000, duration: 2000, image: 'data:image/png;base64,BBB', legs: [] },
};


test('分享页：有路线图就用可切换的 tab ＋ 真实里程/耗时，没有图才退回自绘示意图', () => {
  const withMaps = share.buildHtml(
    share.buildPayload({ trip: { id: 1, title: '杭州行程' }, city: '杭州', stops: STOPS, labels: {}, maps: MAPS, when: '2026-11-11T10:00:00+08:00' })
  );
  assert.match(withMaps, /class="tab on" data-mode="driving"/);
  assert.match(withMaps, /class="tab" data-mode="walking"/);
  assert.match(withMaps, /31\.4 km|4\.0 km/, '要有里程');
  assert.match(withMaps, /src="data:image\/png;base64,AAA"/);
  assert.match(withMaps, /querySelectorAll\('\.tab'\)/, '要有切换脚本');
  assert.ok(!/key=/.test(withMaps), '分享页不许出现 key');
  assert.ok(!/aria-label="行程点顺序示意图"/.test(withMaps), '有真实路线图就不该再画示意图');

  const noMaps = share.buildHtml(
    share.buildPayload({ trip: { id: 1, title: '杭州行程' }, city: '杭州', stops: STOPS, labels: {}, when: '2026-11-11T10:00:00+08:00' })
  );
  assert.match(noMaps, /aria-label="行程点顺序示意图"/, '没有路线图时退回自绘示意图');
});

test('纯文本里带上各出行方式的全程里程/耗时', () => {
  const text = share.buildText(
    share.buildPayload({ trip: { id: 1, title: '杭州行程' }, city: '杭州', stops: STOPS, labels: {}, maps: MAPS, when: '2026-11-11T10:00:00+08:00' })
  );
  assert.match(text, /驾车全程：4\.0 km · 17 min/);
  assert.match(text, /步行全程：3\.0 km · 33 min/);
});

test('JSON 留档不带图片（否则几百 KB 的 base64 会撑爆它）', () => {
  const p = share.buildPayload({ trip: { id: 1, title: '杭州行程' }, city: '杭州', stops: STOPS, labels: {}, maps: MAPS });
  const json = share.payloadForJson(p);
  assert.equal(json.maps.driving.image, undefined);
  assert.equal(json.maps.driving.distance, 4000, '元信息要留着');
  assert.equal(p.maps.driving.image, 'data:image/png;base64,AAA', '原载荷不动（HTML 还要用）');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-share-p14-'));
  const out = share.writePackage(dir, p);
  const jsonFile = out.files.find((f) => f.kind === 'json');
  assert.ok(jsonFile.bytes < 20000, 'JSON 不应被图片撑大，实际 ' + jsonFile.bytes);
  const htmlFile = out.files.find((f) => f.kind === 'html');
  assert.ok(htmlFile.bytes > jsonFile.bytes, 'HTML 才带图');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 接口层 ----------

async function withTmpShareDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-sharedir14-'));
  const old = process.env.TRAVEL_SHARE_DIR;
  process.env.TRAVEL_SHARE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.TRAVEL_SHARE_DIR;
    else process.env.TRAVEL_SHARE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const req = async (base, p, opts) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, body };
};

async function start(amap) {
  const db = createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap,
    collectIntervalMs: 0,
    routeIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) =>
        app.server.close(() => {
          db.close();
          resolve();
        })
      ),
  };
}

async function seedTrip(base, n) {
  const trip = (
    await req(base, '/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州', title: '杭州行程' }),
    })
  ).body.data;
  for (let i = 0; i < n; i += 1) {
    await req(base, '/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip_id: trip.id, name: 'P' + i, lng: 120.1 + i / 100, lat: 30.2 + i / 100, category: 'food' }),
    });
  }
  return trip;
}

test('导出接口：不指定 modes 就把支持的四种都出一张；指定一个时就只出一张', async () => {
  await withTmpShareDir(async (dir) => {
    const amap = fakeAmap();
    const s = await start(amap);
    try {
      const trip = await seedTrip(s.base, 3);
      const both = await req(s.base, `/api/trips/${trip.id}/share/export`, { method: 'POST' });
      assert.equal(both.status, 200);
      const data = both.body.data;
      assert.deepEqual(
        data.maps.map((m) => m.mode).sort(),
        ['driving', 'riding', 'transit', 'walking']
      );
      assert.ok(data.maps.every((m) => m.bytes > 0));
      const html = fs.readFileSync(path.join(dir, data.files.find((f) => f.kind === 'html').name), 'utf8');
      assert.match(html, /data:image\/png;charset=UTF-8;base64,/);
      assert.ok(!/key=/.test(html));

      const onlyCar = await req(s.base, `/api/trips/${trip.id}/share/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modes: ['driving'] }),
      });
      assert.deepEqual(
        onlyCar.body.data.maps.map((m) => m.mode),
        ['driving']
      );

      // 只有 1 个点时没有路线可规划，但仍要能出分享包（退回自绘示意图）
      const one = await seedTrip(s.base, 1);
      const single = await req(s.base, `/api/trips/${one.id}/share/export`, { method: 'POST' });
      assert.equal(single.status, 200);
      assert.deepEqual(single.body.data.maps, []);
    } finally {
      await s.close();
    }
  });
});

test('路线图生成失败不阻断分享：mapErrors 如实回报，文件照出', async () => {
  await withTmpShareDir(async () => {
    const amap = fakeAmap({ failMap: true });
    const s = await start(amap);
    try {
      const trip = await seedTrip(s.base, 3);
      const res = await req(s.base, `/api/trips/${trip.id}/share/export`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.maps, []);
      assert.ok(Object.keys(res.body.data.mapErrors).length >= 1);
      assert.equal(res.body.data.files.length, 3, '三件套照出');
      const html = fs.readFileSync(path.join(process.env.TRAVEL_SHARE_DIR, res.body.data.files[0].name), 'utf8');
      assert.match(html, /check.svg|x|aria-label="行程点顺序示意图"/, '失败时退回自绘示意图');
    } finally {
      await s.close();
    }
  });
});

test('前端：分享结果块里有出行方式选择，两个入口都带上', () => {
  assert.match(APP, /const SHARE_MODES = \[/, '缺出行方式列表');
  assert.match(APP, /onShareTrip\(opt\.modes\)/, '点出行方式要能重新生成');
  assert.match(APP, /modes: lastShareModes/, '导出时要带上选择');
  assert.match(HTML, /id="share-result"/);
  assert.match(read('web/css/style.css'), /\.share-result \.share-modes\s*\{/);
});
