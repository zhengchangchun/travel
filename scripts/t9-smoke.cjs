#!/usr/bin/env node
/*
 * T9 自测（mock 高德，不烧配额）：R1 轮转分类 / R2 单飞+superseded / R3 速率 180 /
 * R4 进度可见 / R5 中心优先。逐条打印 PASS/FAIL，全绿 exit 0；供 scripts/smoke.sh 调用。
 * 判据 T9-P93 起（T8 已占用 P77–P92）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const {
  collectViewport,
  createViewportRunRegistry,
  DEFAULT_VIEWPORT_RATE_PER_MIN,
  CATEGORY_ROTATION,
  nextCategory,
} = require('../server/collect');

const ROOT = path.join(__dirname, '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

function mkPoi(id, typecode) {
  return { id, name: 'P' + id, address: 'addr', lng: 120.1, lat: 30.2, typecode, photos: [], tags: [] };
}

async function withApp(deps, fn) {
  const db = deps.db || createDb(':memory:');
  const amap = deps.amap || { async searchPoiAround() { return []; } };
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap,
    collectIntervalMs: 0,
    viewportRateLimiter: { acquire: async () => 0, maxPerMin: 0, reset() {} },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = {
    get: async (p) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json() };
    },
    post: async (p, payload) => {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
  };
  try {
    await fn(api);
  } finally {
    await new Promise((r) => app.server.close(r));
    if (!deps.db) db.close();
  }
}

async function waitDone(api, runId, tries = 200) {
  let data = null;
  for (let i = 0; i < tries; i += 1) {
    const res = await api.get('/api/collect/status?runId=' + runId);
    data = res.body.data;
    if (data && data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 10));
  }
  return data;
}

const CHECKS = [];
const check = (id, desc, fn) => CHECKS.push({ id, desc, fn });

check('T9-P93', 'R1 轮转顺序 food→stay→sight→play + 未知回退 food', () => {
  assert.deepStrictEqual(CATEGORY_ROTATION, ['food', 'stay', 'sight', 'play']);
  assert.strictEqual(nextCategory('food'), 'stay');
  assert.strictEqual(nextCategory('play'), 'food');
  assert.strictEqual(nextCategory(undefined), 'food');
});

check('T9-P94', 'R1 /api/config 暴露 categoryRotation（前端据此每次只采一类）', async () => {
  await withApp({}, async (api) => {
    const { body } = await api.get('/api/config');
    assert.deepStrictEqual(body.data.categoryRotation, ['food', 'stay', 'sight', 'play']);
  });
});

check('T9-P95', 'R2 单飞注册表：新 run 顶替旧 run 并立即作废', () => {
  const reg = createViewportRunRegistry();
  assert.strictEqual(reg.start('杭州', 'food', 1), null);
  assert.strictEqual(reg.start('杭州', 'food', 2), 1);
  assert.strictEqual(reg.isCancelled('杭州', 'food', 1), true);
  assert.strictEqual(reg.isCancelled('杭州', 'food', 2), false);
});

check('T9-P96', 'R2 新视野顶替旧 run：旧标 superseded，新 done', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround() {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return [mkPoi('S' + calls, '050000')];
    },
  };
  await withApp({ db, amap }, async (api) => {
    const bbox = '120.1,30.2,120.11,30.21';
    const r1 = await api.post('/api/collect/viewport', { city: '杭州', category: 'food', bbox });
    const r2 = await api.post('/api/collect/viewport', { city: '杭州', category: 'food', bbox });
    assert.ok(r1.body.data.runId > 0 && r2.body.data.runId > 0);
    const s1 = await waitDone(api, r1.body.data.runId);
    const s2 = await waitDone(api, r2.body.data.runId);
    assert.strictEqual(s1.status, 'superseded');
    assert.strictEqual(s2.status, 'done');
  });
});

check('T9-P97', 'R3 默认速率 = 180/分钟（仍保留限流）', () => {
  assert.strictEqual(DEFAULT_VIEWPORT_RATE_PER_MIN, 180);
  const src = readFile('server/index.js');
  assert.ok(src.includes('DEFAULT_VIEWPORT_RATE_PER_MIN'), 'index.js 未引用速率常量');
});

check('T9-P98', 'R4 状态返回 done_grids/total_grids（本区域已采 x/y 格）', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = { async searchPoiAround() { calls += 1; return [mkPoi('G' + calls, '050000')]; } };
  await withApp({ db, amap }, async (api) => {
    const post = await api.post('/api/collect/viewport', {
      city: '杭州',
      category: 'food',
      bbox: '120.1,30.2,120.11,30.21',
    });
    const done = await waitDone(api, post.body.data.runId);
    assert.strictEqual(done.total_grids, 4);
    assert.strictEqual(done.done_grids, 4);
  });
});

check('T9-P99', 'R5 中心格优先：先采离 bbox 中心最近的格', async () => {
  const db = createDb(':memory:');
  const order = [];
  const amap = { async searchPoiAround({ lng }) { order.push(lng); return []; } };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.125, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(order.length, 3);
  assert.ok(Math.abs(order[0] - (12011 + 0.5) * 0.01) < 1e-9, '首采应为中心格 12011');
  db.close();
});

check('T9-P100', 'R1/R4 前端资产：单分类轮转 + 已采进度 + 停旧轮询', () => {
  const app = readFile('web/js/app.js');
  const ui = readFile('web/js/ui.js');
  const idx = readFile('web/index.html');
  assert.match(app, /CATEGORY_ROTATION/);
  assert.match(app, /pickCollectCategory/);
  assert.match(app, /stopViewportPoll/);
  assert.match(app, /UI\.setViewProgress/);
  assert.match(ui, /本区域已采/);
  assert.ok(idx.includes('id="view-progress"'), 'index 缺 #view-progress');
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
  process.stdout.write(`T9 mock 检查通过：${CHECKS.length} 项\n`);
}

main().catch((err) => {
  process.stdout.write('FAIL  T9 mock 运行异常 :: ' + (err && err.message) + '\n');
  process.exit(1);
});
