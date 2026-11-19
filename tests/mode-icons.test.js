/* 出行方式各给一个小图标，并且「地图上那条线」要看得出区别（2026-11-17）
   用户原话：「车 骑车 步行 都给我整成单独的小图标 能看到路线上的区别」
   本文件盯四件事：
     ① 图标模块（mode-icons.js）四套图标齐全、用 currentColor 便于按方式上色；
     ② 颜色/线型三处一致：右栏芯片（route.js）、估算（quickroute.js）、地图线（map.js）；
     ③ 骑行这条腿真的接通了：接口收 riding、amap 走 v5 bicycling、静态图也支持；
     ④ 分享包认得出骑行。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const amap = require('../server/amap');
const routemap = require('../server/routemap');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const ROUTE = read('web/js/route.js');
const QUICK = read('web/js/quickroute.js');
const MAP = read('web/js/map.js');
const ICONS = read('web/js/mode-icons.js');

// ---------- ① 图标 ----------

test('mode-icons.js：驾车/骑行/步行/公交各有自己的图标，色由外面给（currentColor）', () => {
  const win = {};
  new Function('window', ICONS)(win);
  const M = win.TravelModeIcons;
  assert.ok(M, '缺 window.TravelModeIcons');
  assert.deepStrictEqual(M.keys.sort(), ['auto', 'driving', 'riding', 'transit', 'walking']);
  const svgs = M.keys.map((k) => M.svg(k, 14));
  svgs.forEach((s) => {
    assert.match(s, /^<svg /);
    assert.match(s, /stroke="currentColor"/, '颜色要跟着外面走');
    assert.match(s, /width="14"/);
  });
  // 五个图标不能长一样（各自 path 不同）
  assert.equal(new Set(svgs).size, 5, '五个图标必须彼此不同');
  // 认不出的 key 别炸，退回一个默认图标
  assert.match(M.svg('nope', 12), /^<svg /);
});

test('mode-icons.js 在 route.js / app.js 之前加载', () => {
  const at = (f) => HTML.indexOf('/js/' + f);
  assert.ok(at('mode-icons.js') > 0);
  assert.ok(at('mode-icons.js') < at('route.js'), 'icon 要先于 route.js');
  assert.ok(at('mode-icons.js') < at('app.js'), 'icon 要先于 app.js');
});

// ---------- ② 颜色/线型三处一致 ----------

test('右栏芯片：图标 + 名称 + 一小段「线型样例」，颜色即地图线颜色', () => {
  assert.match(ROUTE, /const ModeIcons = window\.TravelModeIcons/);
  assert.match(ROUTE, /ModeIcons\.svg\(m\.key, 14\)/, '芯片里要有该方式的图标');
  assert.match(ROUTE, /route-chip-line ' \+ m\.line/, '芯片里要有线型样例');
  assert.match(ROUTE, /--mode-color/, '颜色通过 --mode-color 传给 CSS');
  assert.match(ROUTE, /aria-pressed/, '选中态要能读出来');
  assert.match(CSS, /\.route-chip-line\.solid/);
  assert.match(CSS, /\.route-chip-line\.dash-long/);
  assert.match(CSS, /\.route-chip-line\.dash-mid/);
  assert.match(CSS, /\.route-chip-line\.dot/);
  assert.match(CSS, /repeating-linear-gradient/, '虚线要用重复渐变画出来');
});

test('颜色/线型在 route.js / quickroute.js / map.js 三处对得上（改一处不许漏另两处）', () => {
  const pick = (src, re) => {
    const out = {};
    let m;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(src))) out[m[1]] = m[2].toLowerCase();
    return out;
  };
  const routeColors = pick(ROUTE, /key: '(driving|riding|walking|transit)'[^}]*color: '(#[0-9a-fA-F]{6})'/);
  const quickColors = pick(QUICK, /key: '(driving|riding|walking|transit)'[^}]*color: '(#[0-9a-fA-F]{6})'/);
  const mapColors = pick(MAP, /(driving|riding|walking|transit): \{ strokeColor: '(#[0-9a-fA-F]{6})'/);
  assert.deepStrictEqual(Object.keys(routeColors).sort(), ['driving', 'riding', 'transit', 'walking']);
  assert.deepStrictEqual(quickColors, routeColors, '估算那套颜色要和芯片一致');
  assert.deepStrictEqual(mapColors, routeColors, '地图线颜色要和芯片一致');
  // 四种线型彼此不同
  assert.match(MAP, /riding: \{[^}]*strokeDasharray: \[7, 5\]/);
  assert.match(MAP, /walking: \{[^}]*strokeDasharray: \[2, 6\]/);
  assert.match(MAP, /driving: \{[^}]*strokeStyle: 'solid'/);
});

test('骑行进了估算表（不然实时耗时会按驾车算），速度比步行快、比驾车慢', () => {
  const win = {};
  new Function('window', QUICK)(win);
  const Q = win.TravelQuickRoute;
  const riding = Q.modeMeta('riding');
  assert.equal(riding.label, '骑行');
  assert.ok(riding.kmh > Q.modeMeta('walking').kmh, '骑行要比步行快');
  assert.ok(riding.kmh < Q.modeMeta('driving').kmh, '骑行要比驾车慢');
});

// ---------- ③ 骑行这条腿接通了 ----------

test('amap.planRiding 走 v5 bicycling（v3 那个接口对个人 key 不可用），v5 的字段也要认得', async () => {
  const payload = {
    status: '1',
    info: 'OK',
    infocode: '10000',
    count: '1',
    route: {
      origin: '120.1,30.2',
      destination: '120.2,30.3',
      paths: [
        {
          distance: '7434',
          duration: '2504',
          steps: [
            {
              instruction: '沿武林路向西北骑行133米左转',
              step_distance: '133',
              cost: { duration: '45' },
              polyline: '120.1,30.2;120.12,30.21;120.2,30.3',
            },
          ],
        },
      ],
    },
  };
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => payload };
  };
  amap.setConfig({ amap: { webServiceKey: 'TESTKEY' } });
  try {
    const r = await amap.planRiding('120.1,30.2', '120.2,30.3');
    assert.match(calls[0], /\/v5\/direction\/bicycling/);
    assert.ok(!/\/v3\/direction\/bicycling/.test(calls[0]), 'v3 那个接口打不通，别回去用');
    assert.equal(r.mode, 'riding');
    assert.equal(r.distance, 7434);
    assert.equal(r.duration, 2504);
    assert.deepStrictEqual(r.polyline, [
      [120.1, 30.2],
      [120.12, 30.21],
      [120.2, 30.3],
    ]);
    // v5 用 step_distance / cost.duration，也要读出来
    assert.equal(r.steps[0].distance, 133);
    assert.equal(r.steps[0].duration, 45);
  } finally {
    globalThis.fetch = orig;
  }
});

function fakeAmap() {
  const calls = [];
  const legs = (mode, distance, duration) => ({
    mode,
    distance,
    duration,
    polyline: [[120.1, 30.2], [120.2, 30.3]],
    steps: [],
    transit: null,
    degraded: false,
  });
  return {
    calls,
    async planWalking() { calls.push({ mode: 'walking' }); return legs('walking', 800, 600); },
    async planRiding() { calls.push({ mode: 'riding' }); return legs('riding', 2400, 600); },
    async planDriving() { calls.push({ mode: 'driving' }); return legs('driving', 3200, 720); },
    async planTransit() { calls.push({ mode: 'transit' }); return legs('transit', 8000, 1800); },
  };
}

async function start(amapImpl) {
  const db = createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' },
    categories: [],
    db,
    amap: amapImpl,
    routeIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

test('GET /api/itinerary/route?mode=riding 真的会走骑行规划', async () => {
  const impl = fakeAmap();
  const s = await start(impl);
  try {
    const trip = (await (await fetch(s.base + '/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州', title: '杭州行程' }),
    })).json()).data;
    for (const p of [{ name: 'A', lng: 120.1, lat: 30.2 }, { name: 'B', lng: 120.2, lat: 30.3 }]) {
      await fetch(s.base + '/api/pins', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_id: trip.id, ...p, category: 'sight' }),
      });
    }
    const res = await fetch(s.base + '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=riding');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.mode, 'riding');
    assert.deepStrictEqual(impl.calls.map((c) => c.mode), ['riding']);
  } finally {
    await s.close();
  }
});

test('mode 非法时的提示里有骑行这一项', async () => {
  const s = await start(fakeAmap());
  try {
    const res = await fetch(s.base + '/api/route?mode=fly&origin=120.1,30.2&destination=120.2,30.3');
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(body.error.msg, /riding/);
  } finally {
    await s.close();
  }
});

// ---------- ④ 静态图与分享 ----------

test('分享包的静态路线图四种都支持（骑行与公交别再被当成不可用）', () => {
  ['driving', 'riding', 'walking', 'transit'].forEach((m) => {
    assert.ok(routemap.SUPPORTED_MODES.includes(m), '静态图要支持 ' + m);
  });
  assert.equal(routemap.MODE_LABEL.riding, '骑行');
  assert.equal(routemap.MODE_LABEL.transit, '公交');
  const src = read('server/routemap.js');
  // 现在是「每段自己的方式」（legMode）：全局方式与逐段方式走的是同一个分支
  assert.match(src, /legMode === 'riding'.*amap\.planRiding/s, '静态图要调骑行规划');
  assert.match(src, /legMode === 'transit'.*planTransit/s, '静态图要调公交规划');
});

test('分享页里骑行的名字是「骑行」（某一路线图没生成时点名也是中文）', () => {
  const payload = share.buildPayload({
    trip: { id: 1, title: 'T' },
    city: '杭州',
    stops: [{ name: 'A', lng: 120.1, lat: 30.2, category: 'sight' }],
    labels: { sight: { label: '景点' } },
  });
  payload.maps = {
    riding: { modeLabel: '骑行', image: 'data:image/png;base64,AA', distance: 2400, duration: 600 },
  };
  payload.mapErrors = { walking: '高德没返回路线' };
  const html = share.buildHtml(payload);
  assert.match(html, /骑行/, '骑行那一屏要出现');
  assert.match(html, /步行路线图没生成/, '出错文案也要用中文名');
});
