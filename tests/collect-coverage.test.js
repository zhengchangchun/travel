const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const {
  GRID_DEG,
  MAX_VIEWPORT_GRIDS,
  gridOf,
  gridCenter,
  bboxToGrids,
  createRateLimiter,
  collectViewport,
  DEFAULT_VIEWPORT_RATE_PER_MIN,
  CATEGORY_ROTATION,
  nextCategory,
  createViewportRunRegistry,
} = require('../server/collect');

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

function mkPoi(id, typecode, lng = 120.1, lat = 30.1) {
  return {
    id,
    name: 'P' + id,
    address: 'addr',
    lng,
    lat,
    typecode,
    rating: '4.5',
    photos: [],
    tags: [],
  };
}

function makeAmap(overrides = {}) {
  const calls = { around: 0, pages: [] };
  return {
    calls,
    async searchPoiAround({ page }) {
      calls.around += 1;
      calls.pages.push(page);
      return [];
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
    authFallbackUser: true,
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
    base,
    amap,
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

// ---------- 网格几何 ----------

test('gridOf：floor(lng/GRID) 与 floor(lat/GRID)', () => {
  assert.strictEqual(GRID_DEG, 0.01);
  const g = gridOf(120.15507, 30.27415);
  assert.strictEqual(g.gx, Math.floor(120.15507 / 0.01));
  assert.strictEqual(g.gy, Math.floor(30.27415 / 0.01));
});

test('bboxToGrids：含边界', () => {
  const grids = bboxToGrids({ minLng: 120.1, minLat: 30.2, maxLng: 120.12, maxLat: 30.21 });
  const gxs = [...new Set(grids.map((x) => x.gx))].sort((a, b) => a - b);
  const gys = [...new Set(grids.map((x) => x.gy))].sort((a, b) => a - b);
  assert.deepStrictEqual(gxs, [12010, 12011, 12012]);
  assert.deepStrictEqual(gys, [3020, 3021]);
  assert.strictEqual(grids.length, 6);
});

test('bboxToGrids：超大 bbox 格数巨大（用于上限校验）', () => {
  const grids = bboxToGrids({ minLng: 120, minLat: 30, maxLng: 121, maxLat: 31 });
  assert.strictEqual(grids.length, 101 * 101); // 含边界
  assert.ok(grids.length > MAX_VIEWPORT_GRIDS);
});

test('gridCenter：格中心落在格内', () => {
  const c = gridCenter(12010, 3020);
  assert.deepStrictEqual(gridOf(c.lng, c.lat), { gx: 12010, gy: 3020 });
});

// ---------- 覆盖表 ----------

test('poi_coverage：幂等迁移 + markCovered/isCovered', () => {
  const db = createDb(':memory:');
  assert.strictEqual(db.isCovered('杭州', 'all', 1, 2), false);
  db.markCovered('杭州', 'all', 1, 2, 3);
  db.markCovered('杭州', 'all', 1, 2, 9);
  assert.strictEqual(db.isCovered('杭州', 'all', 1, 2), true);
  assert.strictEqual(db.isCovered('杭州', 'all', 2, 2), false);
  const rows = db.listCoverage('杭州', 'all');
  assert.strictEqual(rows.length, 1);
  db.close();
});

test('poi_coverage：旧库自动补表（幂等）', () => {
  const db = createDb(':memory:');
  db.markCovered('杭州', 'all', 5, 5);
  const cols = db.raw.prepare('PRAGMA table_info(poi_coverage)').all().map((c) => c.name);
  ['city', 'category', 'gx', 'gy', 'collected_at', 'n_inserted'].forEach((c) =>
    assert.ok(cols.includes(c), '缺列 ' + c)
  );
  db.close();
});

// ---------- 按视野采集 ----------

test('collectViewport：只采未覆盖格 + 采后标覆盖', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async searchPoiAround() {
      amap.calls.around += 1;
      return [mkPoi('A' + amap.calls.around, '050000')];
    },
  });
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.11, maxLat: 30.21 }; // 2x2=4 格
  const first = await collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(first.collected.length, 4);
  assert.strictEqual(amap.calls.around, 4);
  assert.strictEqual(first.n_inserted, 4);
  // 二次：全部已覆盖 → 0 调用
  const second = await collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(second.collected.length, 0);
  assert.strictEqual(second.skipped.length, 4);
  assert.strictEqual(amap.calls.around, 4, '二次进入不得再打高德');
  db.close();
});

test('collectViewport：分类纯净，非目标分类丢弃', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async searchPoiAround() {
      return [mkPoi('F', '050000'), mkPoi('X', '071300'), mkPoi('S', '110000')];
    },
  });
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 }; // 1 格
  const res = await collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(res.n_inserted, 2, '仅 food/sight 入库');
  const { items } = db.listPois({ city: '杭州', limit: 100 });
  const cats = items.map((p) => p.category).sort();
  assert.deepStrictEqual(cats, ['food', 'sight']);
  db.close();
});

test('collectViewport：同格并发合并，不重复起', async () => {
  const db = createDb(':memory:');
  let around = 0;
  const amap = {
    async searchPoiAround() {
      around += 1;
      await new Promise((r) => setTimeout(r, 40));
      return [];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.11, maxLat: 30.21 }; // 4 格
  await Promise.all([
    collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 }),
    collectViewport({ city: '杭州', category: 'all', bbox, amap, db, intervalMs: 0 }),
  ]);
  assert.strictEqual(around, 4, '同格只应采一次，实际 ' + around);
  db.close();
});

// ---------- T8b：格内翻页到没有 + 超额细分 + 覆盖时机 ----------

function fullPageOf(prefix, typecode) {
  return Array.from({ length: 25 }, (_, k) => mkPoi(`${prefix}-${k}`, typecode));
}

test('T8b-P1 格内翻页到不满 25：3 满页 + 1 半页 → 4 次调用、85 条、真取完覆盖', async () => {
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
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 }; // 1 格
  const res = await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(calls, 4, '应翻到第 4 页（不满 25 才停），实际 ' + calls);
  assert.strictEqual(res.n_inserted, 85);
  assert.strictEqual(db.isCovered('杭州', 'food', 12010, 3020), true);
  const row = db.listCoverage('杭州', 'food')[0];
  assert.strictEqual(row.truncated, 0);
  db.close();
});

test('T8b-P2 格内取满 200 ⇒ 细分；子格取完则 truncated=0', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround({ radius, page }) {
      calls += 1;
      if (radius >= 500) return fullPageOf(`T${calls}`, '050000'); // 顶格永远满 200
      return []; // 子格空 → 取完
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  // 顶格 8 页 + 4 个子格各 1 页（空）= 12
  assert.strictEqual(calls, 12, '应细分 4 个子格，实际调用 ' + calls);
  const row = db.listCoverage('杭州', 'food')[0];
  assert.strictEqual(row.truncated, 0, '子格取完 → 非 truncated');
  db.close();
});

test('T8b-P3 细分到底仍满 ⇒ 仍标覆盖但 truncated=1（防无限重采）', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround() {
      calls += 1;
      return fullPageOf(`S${calls}`, '050000'); // 永远满 200
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0, maxDepth: 1 });
  assert.strictEqual(calls, 8 + 4 * 8, '顶格 8 页 + 4 子格各 8 页，实际 ' + calls);
  assert.strictEqual(db.isCovered('杭州', 'food', 12010, 3020), true);
  const row = db.listCoverage('杭州', 'food')[0];
  assert.strictEqual(row.truncated, 1);
  db.close();
});

test('T8b 细分合并：父格取满后子格数据并入同一 (city,category)', async () => {
  const db = createDb(':memory:');
  let c = 0;
  const amap = {
    async searchPoiAround({ radius, page }) {
      if (radius >= 500 && page <= 8) return fullPageOf(`P${radius}-${page}`, '050000');
      if (radius < 500 && page === 1) return [mkPoi(`SUB-${(c += 1)}`, '050000')];
      return [];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  const { total } = db.listPois({ city: '杭州', category: 'food', limit: 1 });
  assert.strictEqual(total, 200 + 4, '顶格 200 + 4 子格各 1，实际 ' + total);
  db.close();
});

test('T8b 单格预算用尽 ⇒ truncated=1 且仍标覆盖（防 QPS 打爆）', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  const amap = {
    async searchPoiAround() {
      calls += 1;
      return fullPageOf('B' + calls, '050000'); // 永远满 200
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 }; // 1 格
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0, maxGridCalls: 10 });
  assert.strictEqual(calls, 10, '预算应封顶 10，实际 ' + calls);
  assert.strictEqual(db.isCovered('杭州', 'food', 12010, 3020), true);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 1);
  db.close();
});

test('T8b 高德瞬时报错 ⇒ 重试成功后仍标覆盖（errored=0）', async () => {
  const db = createDb(':memory:');
  let n = 0;
  const amap = {
    async searchPoiAround() {
      n += 1;
      if (n === 1) {
        const e = new Error('CUQPS_HAS_EXCEEDED_THE_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      }
      return [mkPoi('OK', '050000')];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.1, maxLat: 30.2 }; // 1 格
  const res = await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(res.errored, 0, '瞬时错误应被重试吸收');
  assert.strictEqual(db.isCovered('杭州', 'food', 12010, 3020), true);
  db.close();
});

test('T8b 格内高德持续报错 ⇒ 该格不标覆盖（可重试）且不中断其它格', async () => {
  const db = createDb(':memory:');
  let n = 0;
  const amap = {
    async searchPoiAround() {
      n += 1;
      if (n <= 3) {
        // 首格 3 次尝试全部报错（重试耗尽）
        const e = new Error('CUQPS_HAS_EXCEEDED_THE_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      }
      return [mkPoi('OK', '050000')];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.11, maxLat: 30.2 }; // 2 格
  const res = await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  const covered = db.listCoverage('杭州', 'food').map((r) => r.gx + ',' + r.gy);
  assert.ok(!covered.includes('12010,3020'), '报错格不应标覆盖（留待重试）');
  assert.ok(covered.includes('12011,3020'), '后续格仍应采到');
  assert.ok(res.errored >= 1, '应记录 errored，实际 ' + res.errored);
  db.close();
});

test('T8b poi_coverage 增列 truncated（幂等迁移 + 默认 0）', () => {
  const db = createDb(':memory:');
  const cols = db.raw.prepare('PRAGMA table_info(poi_coverage)').all().map((c) => c.name);
  assert.ok(cols.includes('truncated'), 'poi_coverage 缺 truncated 列');
  db.markCovered('杭州', 'food', 1, 1);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 0);
  db.markCovered('杭州', 'food', 1, 1, 0, true);
  assert.strictEqual(db.listCoverage('杭州', 'food')[0].truncated, 1);
  db.close();
});

test('T8b 旧库 poi_coverage 无 truncated → 自动补列且幂等', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-cov-'));
  const file = path.join(dir, 'travel.db');
  const raw = new DatabaseSync(file);
  raw.exec(
    `CREATE TABLE poi_coverage (city TEXT NOT NULL, category TEXT NOT NULL, gx INTEGER NOT NULL,
     gy INTEGER NOT NULL, collected_at TEXT NOT NULL, n_inserted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (city, category, gx, gy));`
  );
  raw.close();
  const d1 = createDb(file);
  const cols = d1.raw.prepare('PRAGMA table_info(poi_coverage)').all().map((c) => c.name);
  assert.ok(cols.includes('truncated'), '旧库未补 truncated');
  d1.close();
  const d2 = createDb(file); // 连跑两次不报错
  d2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 速率限制 ----------

test('createRateLimiter：超过 maxPerMin 需等待窗口释放', async () => {
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
  assert.strictEqual(sleeps.length, 1, '第三次应等待一次');
  assert.ok(sleeps[0] >= 59000, '等待应接近一个窗口，实际 ' + sleeps[0]);
});

test('createRateLimiter：maxPerMin<=0 不限速', async () => {
  let slept = 0;
  const limiter = createRateLimiter({
    maxPerMin: 0,
    now: () => 0,
    sleep: async () => {
      slept += 1;
    },
  });
  for (let i = 0; i < 10; i += 1) await limiter.acquire();
  assert.strictEqual(slept, 0);
});

// ---------- 接口 ----------

test('GET /api/coverage：返回 grids 与 uncovered', async () => {
  const db = createDb(':memory:');
  db.markCovered('杭州', 'all', 12010, 3020);
  await withApp({ db }, async (api) => {
    const bbox = '120.1,30.2,120.11,30.21';
    const { status, body } = await api.get(
      '/api/coverage?city=' + encodeURIComponent('杭州') + '&category=all&bbox=' + bbox
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.grids.length, 4);
    assert.strictEqual(body.data.uncovered.length, 3);
    const covered = body.data.covered.map((g) => g.gx + ',' + g.gy);
    assert.ok(covered.includes('12010,3020'));
  });
});

test('GET /api/coverage：缺 bbox → 400', async () => {
  await withApp({}, async (api) => {
    const { status } = await api.get('/api/coverage?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(status, 400);
  });
});

test('POST /api/collect/viewport：只采未覆盖格并返回 runId', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async searchPoiAround() {
      amap.calls.around += 1;
      return [mkPoi('B' + amap.calls.around, '100000')];
    },
  });
  await withApp({ db, amap }, async (api) => {
    const post = await api.post('/api/collect/viewport', {
      city: '杭州',
      category: 'all',
      bbox: '120.1,30.2,120.11,30.21',
    });
    assert.strictEqual(post.status, 200);
    assert.ok(post.body.data.runId > 0);
    assert.strictEqual(post.body.data.grids.length, 4);
    const done = await waitDone(api, post.body.data.runId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.n_inserted, 4);
    assert.strictEqual(amap.calls.around, 4);
  });
});

test('POST /api/collect/viewport：bbox 格数超上限 → 400', async () => {
  await withApp({}, async (api) => {
    const post = await api.post('/api/collect/viewport', {
      city: '杭州',
      category: 'all',
      bbox: '120,30,121,31',
    });
    assert.strictEqual(post.status, 400);
  });
});

test('POST /api/collect/viewport：已覆盖格直接跳过（不产生高德调用）', async () => {
  const db = createDb(':memory:');
  bboxToGrids({ minLng: 120.1, minLat: 30.2, maxLng: 120.11, maxLat: 30.21 }).forEach((g) =>
    db.markCovered('杭州', 'all', g.gx, g.gy)
  );
  const amap = makeAmap();
  await withApp({ db, amap }, async (api) => {
    const post = await api.post('/api/collect/viewport', {
      city: '杭州',
      category: 'all',
      bbox: '120.1,30.2,120.11,30.21',
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.body.data.grids.length, 0);
    assert.strictEqual(amap.calls.around, 0);
  });
});

// ---------- T9：实时加载优化（R1 轮转 / R2 单飞 / R3 速率 / R4 进度 / R5 中心优先） ----------

test('T9 R1 分类轮转顺序 food→stay→sight→play→food', () => {
  assert.deepStrictEqual(CATEGORY_ROTATION, ['food', 'stay', 'sight', 'play']);
  assert.strictEqual(nextCategory('food'), 'stay');
  assert.strictEqual(nextCategory('stay'), 'sight');
  assert.strictEqual(nextCategory('sight'), 'play');
  assert.strictEqual(nextCategory('play'), 'food');
  assert.strictEqual(nextCategory(undefined), 'food');
  assert.strictEqual(nextCategory('unknown'), 'food');
});

test('T9 R1 /api/config 暴露分类轮转顺序（前端据此轮转）', async () => {
  await withApp({}, async (api) => {
    const { status, body } = await api.get('/api/config');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.data.categoryRotation, ['food', 'stay', 'sight', 'play']);
  });
});

test('T9 R2 单飞注册表：同 (city,category) 新 run 顶替旧 run', () => {
  const reg = createViewportRunRegistry();
  assert.strictEqual(reg.start('杭州', 'food', 1), null);
  assert.strictEqual(reg.isCancelled('杭州', 'food', 1), false);
  assert.strictEqual(reg.start('杭州', 'food', 2), 1, '应返回被顶替的旧 runId');
  assert.strictEqual(reg.isCancelled('杭州', 'food', 1), true, '旧 run 应立即停止');
  assert.strictEqual(reg.isCancelled('杭州', 'food', 2), false);
  // 不同分类互不影响
  assert.strictEqual(reg.start('杭州', 'stay', 3), null);
  assert.strictEqual(reg.isCancelled('杭州', 'food', 2), false);
  reg.finish('杭州', 'food', 2);
  assert.strictEqual(reg.isCancelled('杭州', 'food', 2), true, 'finish 后视为已取消');
  assert.strictEqual(reg.start('杭州', 'food', 4), null, 'finish 后无旧 run 可顶替');
});

test('T9 R2 collectViewport 响应 isCancelled 立即停（不再采后续格、不误标覆盖）', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  let cancelled = false;
  const amap = {
    async searchPoiAround() {
      calls += 1;
      cancelled = true; // 首个请求后即被作废（模拟新视野到来）
      return [mkPoi('C' + calls, '050000')];
    },
  };
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.12, maxLat: 30.2 }; // 3 格
  const res = await collectViewport({
    city: '杭州',
    category: 'food',
    bbox,
    amap,
    db,
    intervalMs: 0,
    isCancelled: () => cancelled,
  });
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(calls, 1, '作废后不应再采后续格，实际 ' + calls);
  assert.strictEqual(db.listCoverage('杭州', 'food').length, 0, '被作废的格不应标覆盖');
  db.close();
});

test('T9 R2 HTTP：新视野顶替旧 run（旧 run 标 superseded，新 run done）', async () => {
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
    const bbox = '120.1,30.2,120.11,30.21'; // 4 格
    const r1 = await api.post('/api/collect/viewport', { city: '杭州', category: 'food', bbox });
    assert.ok(r1.body.data.runId > 0, '首次应起 run');
    const r2 = await api.post('/api/collect/viewport', { city: '杭州', category: 'food', bbox });
    assert.ok(r2.body.data.runId > 0, '新视野应起新 run');
    assert.notStrictEqual(r1.body.data.runId, r2.body.data.runId);
    const s1 = await waitDone(api, r1.body.data.runId);
    const s2 = await waitDone(api, r2.body.data.runId);
    assert.strictEqual(s1.status, 'superseded', '旧 run 应标 superseded');
    assert.strictEqual(s2.status, 'done', '新 run 应正常完成');
  });
});

test('T9 R3 默认速率上调为 180/分钟（仍保留限流）', () => {
  assert.strictEqual(DEFAULT_VIEWPORT_RATE_PER_MIN, 180);
});

test('T9 R4 采集状态返回本区域已采格数 done_grids/total_grids', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async searchPoiAround() {
      amap.calls.around += 1;
      return [mkPoi('G' + amap.calls.around, '050000')];
    },
  });
  await withApp({ db, amap }, async (api) => {
    const post = await api.post('/api/collect/viewport', {
      city: '杭州',
      category: 'food',
      bbox: '120.1,30.2,120.11,30.21', // 4 格
    });
    const done = await waitDone(api, post.body.data.runId);
    assert.strictEqual(done.total_grids, 4);
    assert.strictEqual(done.done_grids, 4);
  });
});

test('T9 R5 视野中心格优先（按格中心到 bbox 中心距离排序）', async () => {
  const db = createDb(':memory:');
  const order = [];
  const amap = {
    async searchPoiAround({ lng }) {
      order.push(lng);
      return [];
    },
  };
  // gx=12010/12011/12012 三格，bbox 中心 120.1125 → 最近为中心格 12011
  const bbox = { minLng: 120.1, minLat: 30.2, maxLng: 120.125, maxLat: 30.2 };
  await collectViewport({ city: '杭州', category: 'food', bbox, amap, db, intervalMs: 0 });
  assert.strictEqual(order.length, 3);
  assert.ok(
    Math.abs(order[0] - (12011 + 0.5) * 0.01) < 1e-9,
    '应先采中心格 12011，实际首采 ' + order[0]
  );
  db.close();
});
