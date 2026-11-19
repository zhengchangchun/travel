// P2 账本补采：调用由「格是否新鲜（30 天）」决定，不再由「地图动了」决定。
// 覆盖：planFill 三态判定 / fillByGrids 三条路径（cache·around·rect）/ 截断只标有数据的格 /
//       失败不标覆盖 / 同视野第二次 0 调用 / force 强制重查 / 路由 /api/poi/inview 端到端。
const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const {
  planFill,
  fillByGrids,
  fillAroundGrids,
  COVERAGE_TTL_MS,
  FILL_AROUND_MAX_GRIDS,
  bboxToGrids,
  LIVE_MAX_PAGES,
} = require('../server/collect');

const CITY = '杭州';
const CAT = 'stay';
const DAY = 24 * 60 * 60 * 1000;

// 6 格（3 列 × 2 行）≥ FILL_AROUND_MAX_GRIDS ⇒ 走整框查
const BIG = { minLng: 120.15, minLat: 30.24, maxLng: 120.17, maxLat: 30.252 };
// 1 格 ⇒ 走按格查
const TINY = { minLng: 120.1501, minLat: 30.2401, maxLng: 120.1509, maxLat: 30.2409 };
// 2 格（2 列 × 1 行）
const TWO = { minLng: 120.1501, minLat: 30.2401, maxLng: 120.1659, maxLat: 30.2409 };

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

function poiAt(id, lng, lat, typecode = '100000') {
  return {
    id,
    name: 'P' + id,
    address: 'addr',
    lng,
    lat,
    typecode,
    category: 'stay',
    rating: '4.6',
    cost: '88',
    tel: '123',
    photos: [],
    tags: [],
  };
}

function pageOf(n, prefix, typecode = '100000') {
  return Array.from({ length: n }, (_, k) => poiAt(`${prefix}-${k}`, 120.16, 30.25, typecode));
}

// 假高德：分别记 place/polygon 与 place/around 的调用次数
function mkAmap({ area = [], around = [], failArea = false, failAround = false } = {}) {
  const calls = { area: 0, around: 0 };
  return {
    calls,
    async searchPoiInArea() {
      calls.area += 1;
      if (failArea) throw new Error('DAILY_QUERY_OVER_LIMIT');
      return area;
    },
    async searchPoiAround() {
      calls.around += 1;
      if (failAround) throw new Error('DAILY_QUERY_OVER_LIMIT');
      return around;
    },
  };
}

// ---------- planFill：三态判定 ----------

test('planFill：空库 ⇒ 全是 blank，要补 = 全部格', () => {
  const db = createDb(':memory:');
  const plan = planFill({ db, city: CITY, category: CAT, bbox: BIG });
  assert.strictEqual(plan.grids.length, 6, 'BIG 应为 6 格');
  assert.strictEqual(plan.fresh_count, 0);
  assert.strictEqual(plan.blank_count, 6);
  assert.strictEqual(plan.stale_count, 0);
  assert.strictEqual(plan.todo.length, 6);
  db.raw.close();
});

test('planFill：TTL 内已采 ⇒ fresh；超过 30 天 ⇒ stale', () => {
  const db = createDb(':memory:');
  bboxToGrids(TINY).forEach((g) => db.markCovered(CITY, CAT, g.gx, g.gy, 3));
  const fresh = planFill({ db, city: CITY, category: CAT, bbox: TINY });
  assert.strictEqual(fresh.fresh_count, 1, '刚采过 ⇒ fresh');
  assert.strictEqual(fresh.todo.length, 0);
  // 把「现在」挪到 31 天后 ⇒ 同一行变成 stale
  const later = planFill({
    db,
    city: CITY,
    category: CAT,
    bbox: TINY,
    now: () => Date.now() + 31 * DAY,
  });
  assert.strictEqual(later.fresh_count, 0);
  assert.strictEqual(later.stale_count, 1, '超 30 天 ⇒ stale');
  assert.strictEqual(later.blank_count, 0);
  db.raw.close();
});

test('planFill：force ⇒ 即使新鲜也算要补', () => {
  const db = createDb(':memory:');
  bboxToGrids(TINY).forEach((g) => db.markCovered(CITY, CAT, g.gx, g.gy, 3));
  const plan = planFill({ db, city: CITY, category: CAT, bbox: TINY, force: true });
  assert.strictEqual(plan.fresh_count, 0);
  assert.strictEqual(plan.todo.length, 1);
  assert.strictEqual(plan.todo[0].kind, 'stale', 'force 下已采过的格按 stale 记（会重查）');
  db.raw.close();
});

test('planFill：分类隔离 —— 别的分类采过不算新鲜', () => {
  const db = createDb(':memory:');
  bboxToGrids(TINY).forEach((g) => db.markCovered(CITY, 'food', g.gx, g.gy, 3));
  const plan = planFill({ db, city: CITY, category: CAT, bbox: TINY });
  assert.strictEqual(plan.fresh_count, 0, 'stay 没采过 ⇒ 不算新鲜');
  assert.strictEqual(plan.blank_count, 1);
  db.raw.close();
});

test('db.listCoverageRange 带 collected_at（补采决策要用它判新鲜度）', () => {
  const db = createDb(':memory:');
  db.markCovered(CITY, CAT, 12015, 3024, 7);
  const rows = db.listCoverageRange(CITY, CAT, 12015, 12015, 3024, 3024);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].collected_at, '应带 collected_at');
  assert.ok(!Number.isNaN(Date.parse(rows[0].collected_at)), 'collected_at 应是可解析时间');
  assert.strictEqual(rows[0].n_inserted, 7);
  db.raw.close();
});

test('COVERAGE_TTL_MS 是 30 天；按格查的格数上限是 2', () => {
  assert.strictEqual(COVERAGE_TTL_MS, 30 * DAY);
  assert.strictEqual(FILL_AROUND_MAX_GRIDS, 2);
});

// ---------- fillByGrids：三条路径 ----------

test('fillByGrids：本区域全新鲜 ⇒ mode=cache、0 次调用、不打高德', async () => {
  const db = createDb(':memory:');
  bboxToGrids(BIG).forEach((g) => db.markCovered(CITY, CAT, g.gx, g.gy, 5));
  const amap = mkAmap({ area: pageOf(3, 'a') });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: BIG });
  assert.strictEqual(res.mode, 'cache');
  assert.strictEqual(res.calls, 0);
  assert.strictEqual(res.filled, 0);
  assert.strictEqual(res.grids, 6);
  assert.strictEqual(res.fresh, 6);
  assert.strictEqual(amap.calls.area + amap.calls.around, 0, '走缓存就不该打高德');
  db.raw.close();
});

test('fillByGrids：需补 1 格 ⇒ mode=around、1 次 place/around、采完标格', async () => {
  const db = createDb(':memory:');
  const amap = mkAmap({ around: pageOf(4, 'r') });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: TINY });
  assert.strictEqual(res.mode, 'around');
  assert.strictEqual(res.calls, 1);
  assert.strictEqual(amap.calls.around, 1);
  assert.strictEqual(amap.calls.area, 0, '少量新格不该走整框查');
  assert.strictEqual(res.filled, 1);
  assert.strictEqual(res.inserted, 4);
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 1, '采完应标格');
  db.raw.close();
});

test('fillByGrids：需补 2 格 ⇒ around、2 次调用', async () => {
  const db = createDb(':memory:');
  const amap = mkAmap({ around: pageOf(2, 'r') });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: TWO });
  assert.strictEqual(res.mode, 'around');
  assert.strictEqual(res.calls, 2);
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 2);
  db.raw.close();
});

test('fillByGrids：需补 ≥3 格 ⇒ mode=rect、走 place/polygon、取全后框内所有格都标新鲜', async () => {
  const db = createDb(':memory:');
  const amap = mkAmap({ area: pageOf(3, 'a') }); // 不满一页 ⇒ 一次取全
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: BIG });
  assert.strictEqual(res.mode, 'rect');
  assert.strictEqual(res.calls, 1);
  assert.strictEqual(amap.calls.area, 1);
  assert.strictEqual(amap.calls.around, 0, '格数多时走整框查，不逐格打');
  assert.strictEqual(res.filled, 6, '取全 ⇒ 整框 6 格都标新鲜');
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 6);
  // 再来看同一片 ⇒ 0 调用
  const again = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: BIG });
  assert.strictEqual(again.mode, 'cache');
  assert.strictEqual(again.calls, 0);
  assert.strictEqual(amap.calls.area, 1, '第二次不该再打高德');
  db.raw.close();
});

test('fillByGrids：整框查被截断（翻满页）⇒ 只标真有数据的格，不留永久空洞', async () => {
  const db = createDb(':memory:');
  const grids = bboxToGrids(BIG);
  // 两个格里有数据（坐标取格中心、且在视野框内 —— liveRect 会再按 inBbox 复筛一次）
  const hit = grids.filter((g) => g.gy === 3024).slice(0, 2); // (12015,3024) 与 (12016,3024)
  assert.strictEqual(hit.length, 2, '取两个在框内的格');
  const area = [];
  for (let p = 1; p <= LIVE_MAX_PAGES; p += 1) {
    for (let k = 0; k < 25; k += 1) {
      const g = hit[k % hit.length];
      area.push(poiAt(`t-${p}-${k}`, (g.gx + 0.5) * 0.01, (g.gy + 0.5) * 0.01));
    }
  }
  const amap = mkAmap({ area });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: BIG });
  assert.strictEqual(res.mode, 'rect');
  assert.strictEqual(res.calls, LIVE_MAX_PAGES, '满页一路翻到上限');
  assert.strictEqual(res.filled, 2, '截断时只标真有数据的 2 格');
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 2);
  db.raw.close();
});

test('fillByGrids：按格查失败 ⇒ 不标覆盖（下次会重试），其余格不受影响', async () => {
  const db = createDb(':memory:');
  const amap = mkAmap({ failAround: true });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: TWO });
  assert.strictEqual(res.mode, 'around');
  assert.strictEqual(res.calls, 2);
  assert.strictEqual(res.errors.length, 2, '两次调用都失败应如实回报');
  assert.strictEqual(res.filled, 0);
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 0, '失败不标覆盖');
  db.raw.close();
});

test('fillByGrids：一次失败一次成功 ⇒ 只标成功那格', async () => {
  const db = createDb(':memory:');
  let n = 0;
  const amap = {
    calls: { around: 0 },
    async searchPoiAround() {
      n += 1;
      if (n === 1) throw new Error('DAILY_QUERY_OVER_LIMIT');
      return pageOf(3, 'ok');
    },
  };
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: TWO });
  assert.strictEqual(res.calls, 2);
  assert.strictEqual(res.errors.length, 1);
  assert.strictEqual(res.filled, 1);
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 1);
  db.raw.close();
});

test('fillByGrids：force 跳过账本 ⇒ 即使新鲜也重查', async () => {
  const db = createDb(':memory:');
  bboxToGrids(BIG).forEach((g) => db.markCovered(CITY, CAT, g.gx, g.gy, 5));
  const amap = mkAmap({ area: pageOf(3, 'a') });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: BIG, force: true });
  assert.strictEqual(res.mode, 'rect');
  assert.strictEqual(res.calls, 1, 'force 下应真的打一次');
  assert.strictEqual(amap.calls.area, 1);
  db.raw.close();
});

test('fillByGrids：整框查失败 ⇒ 不标任何格（否则会误判 30 天新鲜）', async () => {
  const db = createDb(':memory:');
  const amap = mkAmap({ failArea: true });
  const res = await fillByGrids({ amap, db, city: CITY, category: CAT, bbox: BIG });
  assert.strictEqual(res.mode, 'rect');
  assert.strictEqual(res.errors.length, 1);
  assert.strictEqual(res.filled, 0);
  assert.strictEqual(db.listCoverage(CITY, CAT).length, 0);
  db.raw.close();
});

test('fillAroundGrids：只取第 1 页（浏览级，不翻页不细分）', async () => {
  const db = createDb(':memory:');
  const seen = [];
  const amap = {
    async searchPoiAround({ page, lng, lat }) {
      seen.push(page);
      return pageOf(25, 'full');
    },
  };
  const grids = bboxToGrids(TINY);
  const res = await fillAroundGrids({ amap, db, city: CITY, category: CAT, grids });
  assert.deepStrictEqual(seen, [1], '只应请求第 1 页');
  assert.strictEqual(res.calls, 1);
  db.raw.close();
});

// ---------- 路由：/api/poi/inview 端到端 ----------

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: opts.amap,
    collectIntervalMs: 0,
    ...opts,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return { base, db, app, close: () => new Promise((r) => app.server.close(r)) };
}

async function getJson(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

const BIG_STR = `${BIG.minLng},${BIG.minLat},${BIG.maxLng},${BIG.maxLat}`;

test('GET /api/poi/inview：首次补采 ⇒ 第二次同框 0 次调用（30 天账本生效）', async () => {
  const amap = mkAmap({ area: pageOf(3, 'a') });
  const h = await start({ amap });
  try {
    const url = `/api/poi/inview?city=${encodeURIComponent(CITY)}&category=stay&bbox=${BIG_STR}`;
    const first = await getJson(h.base, url);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.data.live.mode, 'rect', '第一次要真的补采');
    assert.strictEqual(first.body.data.live.calls, 1);
    assert.strictEqual(amap.calls.area, 1);

    const second = await getJson(h.base, url);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.data.live.mode, 'cache', '第二次应走账本');
    assert.strictEqual(second.body.data.live.calls, 0);
    assert.strictEqual(amap.calls.area, 1, '第二次绝不该再打高德');
    assert.ok(second.body.data.items.length > 0, '缓存里应还有第一次采到的点');
  } finally {
    await h.close();
  }
});

test('GET /api/poi/inview：force=1 强制重查（跳过 30 天账本）', async () => {
  const amap = mkAmap({ area: pageOf(3, 'a') });
  const h = await start({ amap });
  try {
    const base = `/api/poi/inview?city=${encodeURIComponent(CITY)}&category=stay&bbox=${BIG_STR}`;
    await getJson(h.base, base);
    assert.strictEqual(amap.calls.area, 1);
    const forced = await getJson(h.base, base + '&force=1');
    assert.strictEqual(forced.body.data.live.mode, 'rect', 'force 应强制重查');
    assert.strictEqual(amap.calls.area, 2, 'force 下应再打一次');
  } finally {
    await h.close();
  }
});

test('GET /api/poi/inview：少量新格走按格查（around），不烧整框', async () => {
  const amap = mkAmap({ around: pageOf(4, 'r') });
  const h = await start({ amap });
  try {
    const tiny = `${TINY.minLng},${TINY.minLat},${TINY.maxLng},${TINY.maxLat}`;
    const res = await getJson(
      h.base,
      `/api/poi/inview?city=${encodeURIComponent(CITY)}&category=stay&bbox=${tiny}`
    );
    assert.strictEqual(res.body.data.live.mode, 'around');
    assert.strictEqual(res.body.data.live.calls, 1);
    assert.strictEqual(amap.calls.area, 0, '不该打整框查');
  } finally {
    await h.close();
  }
});
