#!/usr/bin/env node
/*
 * T8 自测（mock 高德，不烧配额）：覆盖格 / 按视野采集 / 配额保护 / 渐进补旗前端资产 / N20。
 * 逐条打印 PASS/FAIL，全绿 exit 0；供 scripts/smoke.sh 调用。
 * 判据 T8-P77 起（T7 已占用 P68–P76，此处顺延；见 docs/tasks/2026-10-30-T8-按视野自动采集.md §5）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const {
  createRateLimiter,
  collectViewport,
  gridOf,
  bboxToGrids,
  MAX_VIEWPORT_GRIDS,
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

function makeAmap(overrides = {}) {
  const calls = { around: 0 };
  return {
    calls,
    async searchPoiAround() {
      calls.around += 1;
      return [mkPoi('X' + calls.around, '050000')];
    },
    async districts() {
      return [];
    },
    ...overrides,
  };
}

async function withApp(deps, fn) {
  const db = deps.db || createDb(':memory:');
  const amap = deps.amap || makeAmap();
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap,
    collectIntervalMs: 0,
    viewportRateLimiter: createRateLimiter({ maxPerMin: 0 }),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = {
    amap,
    db,
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

async function waitDone(api, runId, tries = 100) {
  let data = null;
  for (let i = 0; i < tries; i += 1) {
    const res = await api.get('/api/collect/status?runId=' + runId);
    data = res.body.data;
    if (data && data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 10));
  }
  return data;
}

const CITY = encodeURIComponent('杭州');
const BBOX = '120.1,30.2,120.11,30.21'; // 4 格

const CHECKS = [];
const check = (id, desc, fn) => CHECKS.push({ id, desc, fn });

// ---------- 网格几何 / 迁移 ----------

check('T8-P77', '网格几何：gridOf 与 bboxToGrids 含边界', () => {
  assert.deepStrictEqual(gridOf(120.155, 30.274), { gx: 12015, gy: 3027 });
  const grids = bboxToGrids({ minLng: 120.1, minLat: 30.2, maxLng: 120.12, maxLat: 30.21 });
  assert.strictEqual(grids.length, 3 * 2);
});

check('T8-P78', 'poi_coverage 幂等迁移 + isCovered/markCovered', () => {
  const db = createDb(':memory:');
  const cols = db.raw.prepare('PRAGMA table_info(poi_coverage)').all().map((c) => c.name);
  ['city', 'category', 'gx', 'gy', 'collected_at', 'n_inserted'].forEach((c) =>
    assert.ok(cols.includes(c), '缺列 ' + c)
  );
  assert.strictEqual(db.isCovered('杭州', 'all', 1, 1), false);
  db.markCovered('杭州', 'all', 1, 1, 2);
  db.markCovered('杭州', 'all', 1, 1, 5);
  assert.strictEqual(db.isCovered('杭州', 'all', 1, 1), true);
  assert.strictEqual(db.listCoverage('杭州', 'all').length, 1);
  db.close();
});

// ---------- 接口（mock 高德） ----------

check('T8-P79', 'GET /api/coverage：返回 grids/covered/uncovered', async () => {
  const db = createDb(':memory:');
  db.markCovered('杭州', 'all', 12010, 3020);
  await withApp({ db }, async (api) => {
    const { status, body } = await api.get(`/api/coverage?city=${CITY}&category=all&bbox=${BBOX}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.grids.length, 4);
    assert.strictEqual(body.data.uncovered.length, 3);
    assert.ok(body.data.covered.some((g) => g.gx === 12010 && g.gy === 3020));
  });
});

check('T8-P80', 'GET /api/coverage：缺 bbox / 超上限 → 400', async () => {
  await withApp({}, async (api) => {
    assert.strictEqual((await api.get('/api/coverage?city=' + CITY)).status, 400);
    const big = await api.get('/api/coverage?city=' + CITY + '&bbox=120,30,121,31');
    assert.strictEqual(big.status, 400);
    assert.ok(101 * 101 > MAX_VIEWPORT_GRIDS);
  });
});

check('T8-P81', 'POST /api/collect/viewport：只采未覆盖格，done 后 n_inserted 正确', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap();
  await withApp({ db, amap }, async (api) => {
    const post = await api.post('/api/collect/viewport', { city: '杭州', category: 'all', bbox: BBOX });
    assert.strictEqual(post.status, 200);
    assert.ok(post.body.data.runId > 0);
    assert.strictEqual(post.body.data.grids.length, 4);
    const done = await waitDone(api, post.body.data.runId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.n_inserted, 4);
    assert.strictEqual(amap.calls.around, 4);
  });
});

check('T8-P82', 'L15 同一格二次进入不重复采（0 高德调用）', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap();
  await withApp({ db, amap }, async (api) => {
    await api.post('/api/collect/viewport', { city: '杭州', category: 'all', bbox: BBOX });
    const before = amap.calls.around;
    const second = await api.post('/api/collect/viewport', { city: '杭州', category: 'all', bbox: BBOX });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.data.grids.length, 0);
    assert.strictEqual(second.body.data.runId, null);
    assert.strictEqual(amap.calls.around, before, '二次进入不得再打高德');
  });
});

check('T8-P83', 'L17 同格并发合并：仅采一次', async () => {
  const db = createDb(':memory:');
  let around = 0;
  const amap = {
    async searchPoiAround() {
      around += 1;
      await new Promise((r) => setTimeout(r, 40));
      return [];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.11, maxLat: 30.21 };
  await Promise.all([
    collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 }),
    collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 }),
  ]);
  assert.strictEqual(around, 4, '同格应只采一次，实际 ' + around);
  db.close();
});

check('T8-P84', 'L17 速率限制：超过 maxPerMin 需等待窗口', async () => {
  let clock = 0;
  const sleeps = [];
  const limiter = createRateLimiter({
    maxPerMin: 2,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.strictEqual(sleeps.length, 1);
  assert.ok(sleeps[0] >= 59000);
});

// ---------- 前端资产 ----------

check('T8-P85', 'L13/L14/L16 前端：门控 + 自动采集 + 渐进补旗资产就绪', () => {
  const app = readFile('web/js/app.js');
  const map = readFile('web/js/map.js');
  assert.match(app, /const\s+MIN_COLLECT_ZOOM\s*=\s*13/);
  assert.match(app, /zoom\s*<\s*MIN_COLLECT_ZOOM/);
  assert.match(app, /放大地图以加载本区域地点/);
  assert.match(app, /本区域加载中/);
  assert.match(app, /autoCollectViewport/);
  assert.match(app, /API\.coverage/);
  assert.match(app, /API\.collectViewport/);
  assert.match(app, /MapCtl\.addMarkers/);
  assert.match(map, /function\s+addMarkers/);
  const idx = readFile('web/index.html');
  assert.ok(idx.includes('id="view-hint"'), 'index 缺 #view-hint');
});

check('T8-P86', 'L19 采集模块下线 + N20 切城市重置行程', () => {
  const idx = readFile('web/index.html');
  assert.ok(!/id="collect-btn"/.test(idx), 'index 不应再有采集按钮');
  const app = readFile('web/js/app.js');
  const m = app.match(/function\s+setCity[\s\S]*?\n  \}/);
  assert.ok(m && /state\.trip\s*=\s*null/.test(m[0]), 'setCity 未重置 state.trip');
  assert.match(m[0], /API\.listTrips\(state\.city\)/, 'setCity 未重取行程');
});

// ---------- T8b：格内翻页取全 / 超额细分 / truncated ----------

function fullPageOf(prefix, typecode) {
  return Array.from({ length: 25 }, (_, k) => mkPoi(`${prefix}-${k}`, typecode));
}

check('T8b-P87', 'P1 格内翻页到不满 25（3 满 + 1 半 → 4 次调用、85 条、非 truncated）', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround({ page }) {
      calls += 1;
      if (page <= 3) return fullPageOf(`F${page}`, '050000');
      if (page === 4) return fullPageOf('F4', '050000').slice(0, 10);
      return [];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 };
  const res = await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(calls, 4, '应翻到第 4 页，实际 ' + calls);
  assert.strictEqual(res.n_inserted, 85);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 0);
  db.close();
});

check('T8b-P88', 'P2 格内取满 200 ⇒ 细分；子格取完则 truncated=0', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround({ radius }) {
      calls += 1;
      if (radius >= 500) return fullPageOf(`T${calls}`, '050000');
      return [];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(calls, 12, '顶格 8 页 + 4 子格各 1 页，实际 ' + calls);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 0);
  db.close();
});

check('T8b-P89', 'P3 细分到底仍满 ⇒ 仍标覆盖但 truncated=1', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround() {
      calls += 1;
      return fullPageOf(`S${calls}`, '050000');
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0, maxDepth: 1 });
  assert.strictEqual(calls, 8 + 4 * 8, '实际 ' + calls);
  assert.strictEqual(db.isCovered('杭州', 'food', 12010, 3020), true);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 1);
  db.close();
});

check('T8b-P90', 'poi_coverage 含 truncated 列（幂等迁移 + 默认 0）', () => {
  const db = createDb(':memory:');
  const cols = db.raw.prepare('PRAGMA table_info(poi_coverage)').all().map((c) => c.name);
  assert.ok(cols.includes('truncated'), '缺 truncated 列');
  db.markCovered('杭州', 'food', 1, 1);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 0);
  db.close();
});

check('T8b-P92', '格内高德持续报错 ⇒ 不误标覆盖（可重试）且不中断其它格', async () => {
  const db = createDb(':memory:');
  let n = 0;
  const amap = {
    async searchPoiAround() {
      n += 1;
      if (n <= 3) {
        const e = new Error('CUQPS_HAS_EXCEEDED_THE_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      }
      return [mkPoi('OK', '050000')];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.11, maxLat: 30.2 };
  const res = await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  const covered = db.listCoverage('杭州', 'food').map((r) => r.gx + ',' + r.gy);
  assert.ok(!covered.includes('12010,3020'), '报错格不应标覆盖');
  assert.ok(covered.includes('12011,3020'), '后续格仍应采到');
  assert.ok(res.errored >= 1, '应记录 errored');
  db.close();
});

check('T8b-P91', 'P4 配额节流仍在：collectCell 每次高德调用前 acquire', () => {
  const src = readFile('server/collect.js');
  assert.ok(src.includes('rateLimiter.acquire'), 'collectCell 未接入 rateLimiter');
  assert.ok(!/VIEWPORT_MAX_PAGE\s*=\s*1/.test(src), '仍残留每格 1 页限制');
  assert.match(src, /for\s*\(\s*let\s+page\s*=\s*1;\s*page\s*<=\s*MAX_PAGE/, '格内未沿用 MAX_PAGE');
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
  process.stdout.write(`T8 mock 检查通过：${CHECKS.length} 项\n`);
}

main().catch((err) => {
  process.stdout.write('FAIL  T8 mock 运行异常 :: ' + (err && err.message) + '\n');
  process.exit(1);
});
