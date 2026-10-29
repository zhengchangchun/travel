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
