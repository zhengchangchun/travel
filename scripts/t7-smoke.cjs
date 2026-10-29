#!/usr/bin/env node
/*
 * T7 自测（mock 高德，不烧配额）：/api/pois bbox 过滤与校验 + 视野加载前端资产 + 工程约束。
 * 逐条打印 PASS/FAIL，全绿 exit 0；供 scripts/smoke.sh 调用。
 * 判据 T7-P68 起（T5 已占用 P58–P67，此处顺延；见 docs/tasks/2026-10-30-T7-切城市视角与视野加载.md §5）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');

const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: '' },
  defaultCity: '杭州',
  usingExample: false,
};

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function seedPoi(db, { id, lng = 120.1, lat = 30.1, category = 'food' }) {
  db.upsertPoi({
    poi_id: id,
    city: '杭州',
    adcode: '330102',
    category,
    name: '点' + id,
    address: 'addr',
    lng,
    lat,
    typecode: '050000',
    rating: '4.5',
    cost: null,
    tel: null,
    photos: [],
    tags: [],
    fetched_at: '2026-10-30T00:00:00Z',
  });
}

async function withApp(db, fn) {
  const calls = { amap: 0 };
  const amap = {
    async searchPoi() {
      calls.amap += 1;
      return [];
    },
    async searchPoiByDistrict() {
      calls.amap += 1;
      return [];
    },
    async districts() {
      calls.amap += 1;
      return [];
    },
    async poiDetail() {
      calls.amap += 1;
      return null;
    },
  };
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap,
    collectIntervalMs: 0,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = {
    calls,
    get: async (p) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json() };
    },
  };
  try {
    await fn(api);
  } finally {
    await new Promise((r) => app.server.close(r));
    db.close();
  }
}

const CITY = encodeURIComponent('杭州');
const CHECKS = [];
function check(id, desc, fn) {
  CHECKS.push({ id, desc, fn });
}

// ---------- 接口（mock 高德） ----------

check('T7-P68', 'GET /api/pois?bbox= 返回的点全部落在框内', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'IN1', lng: 120.15, lat: 30.25 });
  seedPoi(db, { id: 'IN2', lng: 120.18, lat: 30.28 });
  seedPoi(db, { id: 'OUT1', lng: 121.0, lat: 30.25 });
  seedPoi(db, { id: 'OUT2', lng: 120.15, lat: 31.0 });
  await withApp(db, async (api) => {
    const { status, body } = await api.get(
      '/api/pois?city=' + CITY + '&bbox=120.1,30.2,120.2,30.3'
    );
    assert.strictEqual(status, 200);
    const ids = body.data.items.map((i) => i.id).sort();
    assert.deepStrictEqual(ids, ['IN1', 'IN2']);
    body.data.items.forEach((i) => {
      assert.ok(i.lng >= 120.1 && i.lng <= 120.2, 'lng 越界 ' + i.lng);
      assert.ok(i.lat >= 30.2 && i.lat <= 30.3, 'lat 越界 ' + i.lat);
    });
  });
});

check('T7-P69', 'bbox 缺段 / 非数字 / min>=max → 400', async () => {
  const db = createDb(':memory:');
  await withApp(db, async (api) => {
    const bads = [
      '120.1,30.2,120.2',
      '120.1,30.2,120.2,x',
      '120.2,30.2,120.1,30.3',
      '120.1,30.3,120.2,30.2',
    ];
    for (const bad of bads) {
      const { status } = await api.get('/api/pois?city=' + CITY + '&bbox=' + encodeURIComponent(bad));
      assert.strictEqual(status, 400, '应 400: ' + bad);
    }
  });
});

check('T7-P70', '无 bbox 时行为不变：不给 limit 仍封顶 200', async () => {
  const db = createDb(':memory:');
  for (let i = 0; i < 205; i += 1) seedPoi(db, { id: 'C' + i });
  await withApp(db, async (api) => {
    const { body } = await api.get('/api/pois?city=' + CITY);
    assert.strictEqual(body.data.items.length, 200);
    assert.strictEqual(body.data.total, 205);
  });
});

check('T7-P71', '有 bbox 且不给 limit → 框内全量返回（不封顶、不抽稀）', async () => {
  const db = createDb(':memory:');
  for (let i = 0; i < 250; i += 1) seedPoi(db, { id: 'D' + i, lng: 120.15, lat: 30.25 });
  await withApp(db, async (api) => {
    const { body } = await api.get('/api/pois?city=' + CITY + '&bbox=120,30,121,31');
    assert.strictEqual(body.data.items.length, 250);
  });
});

check('T7-P72', '配额保护：带 bbox 的 /api/pois 只读缓存，不产生高德调用', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { id: 'Q1', lng: 120.15, lat: 30.25 });
  await withApp(db, async (api) => {
    await api.get('/api/pois?city=' + CITY + '&bbox=120,30,121,31');
    await api.get('/api/pois?city=' + CITY + '&bbox=120,30,121,31');
    assert.strictEqual(api.calls.amap, 0);
  });
});

// ---------- 前端资产 ----------

check('T7-P73', 'app.js：倍率阈值唯一门控 + 先定位后加载 + 竞态 + 无数量限制', () => {
  const app = readFile('web/js/app.js');
  assert.match(app, /const\s+CITY_ZOOM\s*=\s*13/, '缺 CITY_ZOOM=13');
  assert.match(app, /const\s+MIN_MARKER_ZOOM\s*=\s*13/, '缺 MIN_MARKER_ZOOM=13');
  assert.match(app, /zoom\s*<\s*MIN_MARKER_ZOOM/, '缺倍率阈值判断');
  assert.match(app, /放大地图以加载本区域地点/, '缺阈值提示文案');
  assert.match(app, /await\s+MapCtl\.setZoomAndCenter/, '未等相机落定（moveend）');
  assert.match(app, /onMoveEnd/, '未注册 onMoveEnd');
  assert.match(app, /bbox/, '请求未带 bbox');
  assert.match(app, /state\.viewSeq\s*\+=\s*1/, '缺递增请求序号');
  assert.match(app, /seq\s*!==\s*state\.viewSeq/, '未用序号丢弃过期响应');
  assert.ok(!/5000/.test(app), 'app.js 不应再出现 5000 封顶');
  assert.ok(!/抽稀/.test(app), 'app.js 不应做抽稀');
});

check('T7-P74', 'map.js 暴露 getBounds/getZoom/setZoomAndCenter/onMoveEnd（防抖）', () => {
  const map = readFile('web/js/map.js');
  ['getBounds', 'getZoom', 'setZoomAndCenter', 'onMoveEnd', 'MOVE_DEBOUNCE_MS', 'moveend', 'zoomend'].forEach(
    (k) => assert.ok(map.includes(k), 'map.js 缺 ' + k)
  );
});

check('T7-P75', '双口径计数资产：app 用 setViewCount/poisStats；ui 有「当前视野/全城已收录」；index 有 #view-count', () => {
  const app = readFile('web/js/app.js');
  const ui = readFile('web/js/ui.js');
  const idx = readFile('web/index.html');
  const css = readFile('web/css/style.css');
  assert.ok(app.includes('setViewCount'), 'app 未调用 setViewCount');
  assert.ok(app.includes('poisStats'), 'app 未取全城已收录数（poisStats）');
  assert.ok(ui.includes('setViewCount'), 'ui.js 缺 setViewCount');
  assert.ok(ui.includes('当前视野'), 'ui.js 缺「当前视野」');
  assert.ok(ui.includes('全城已收录'), 'ui.js 缺「全城已收录」');
  assert.ok(idx.includes('id="view-count"'), 'index 缺 #view-count 容器');
  assert.ok(css.includes('.view-count'), 'css 缺 .view-count 样式');
});

async function main() {
  for (const c of CHECKS) {
    try {
      await c.fn();
      process.stdout.write(`PASS  ${c.id} ${c.desc}\n`);
    } catch (err) {
      process.stdout.write(`FAIL  ${c.id} ${c.desc} :: ${err.message}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`T7 mock 检查通过：${CHECKS.length} 项\n`);
}

main().catch((err) => {
  process.stdout.write('FAIL  T7 mock 运行异常 :: ' + (err && err.message) + '\n');
  process.exit(1);
});
