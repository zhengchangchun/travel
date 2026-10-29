const test = require('node:test');
const assert = require('node:assert');

const { createDb } = require('../server/db');
const { collectCityCategory } = require('../server/collect');

const STAY = '100000';
const FOOD = '050000';

function makeAmap(overrides = {}) {
  return {
    async districts() {
      return [];
    },
    async searchPoiByDistrict() {
      return [];
    },
    async searchPoiAround() {
      return [];
    },
    ...overrides,
  };
}

function mkPoi(id, typecode, extra = {}) {
  return {
    id,
    name: 'P' + id,
    address: 'addr',
    lng: 120,
    lat: 30,
    typecode,
    category: String(typecode).startsWith('10') ? 'stay' : 'food',
    rating: '4.5',
    cost: '50',
    tel: '123',
    photos: ['https://img/1.jpg', 'https://img/2.jpg'],
    tags: ['招牌'],
    ...extra,
  };
}

function fullPage(prefix, typecode) {
  return Array.from({ length: 25 }, (_, k) => mkPoi(`${prefix}-${k}`, typecode));
}

test('P42 分批突破 200：13 区各 200 条 → 该分类入库 > 200', async () => {
  const db = createDb(':memory:');
  const districts = Array.from({ length: 13 }, (_, i) => ({
    name: '区' + i,
    adcode: '3301' + String(i).padStart(2, '0'),
    lng: 120 + i * 0.01,
    lat: 30,
  }));
  const amap = makeAmap({
    async districts() {
      return districts;
    },
    async searchPoiByDistrict({ adcode, page }) {
      if (page > 8) return [];
      return fullPage(`${adcode}-${page}`, STAY);
    },
    async searchPoiAround() {
      return [];
    },
  });
  const res = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(res.status, 'done');
  const { total } = db.listPois({ city: '杭州', category: 'stay', limit: 1 });
  assert.ok(total > 200, '入库条数应 > 200，实际 ' + total);
  db.close();
});

test('P43 分类纯净：混入 050000 餐饮被丢弃，入库 100% 前缀 10', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async districts() {
      return [{ name: '西湖区', adcode: '330106', lng: 120.13, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('S1', STAY), mkPoi('F1', FOOD), mkPoi('S2', STAY)];
    },
  });
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const { items } = db.listPois({ city: '杭州', category: 'stay', limit: 100 });
  assert.strictEqual(items.length, 2);
  items.forEach((p) => assert.ok(String(p.typecode).startsWith('10'), 'typecode=' + p.typecode));
  db.close();
});

test('P44 去重：同一 poi_id 在多区重复出现 → 只入库 1 条', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async districts() {
      return [
        { name: 'A区', adcode: '330101', lng: 120.1, lat: 30.1 },
        { name: 'B区', adcode: '330102', lng: 120.2, lat: 30.2 },
      ];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('DUP', STAY), mkPoi('ONLY-A', STAY)];
    },
  });
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const { total, items } = db.listPois({ city: '杭州', category: 'stay', limit: 100 });
  assert.strictEqual(total, items.length);
  const ids = items.map((p) => p.id);
  assert.strictEqual(ids.filter((id) => id === 'DUP').length, 1);
  db.close();
});

test('P45 增量：二次采集同一数据 → n_inserted=0、n_updated>0', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async districts() {
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('I1', STAY), mkPoi('I2', STAY)];
    },
  });
  const first = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(first.n_inserted, 2);

  const second = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(second.n_inserted, 0);
  assert.ok(second.n_updated > 0, 'n_updated 应 > 0，实际 ' + second.n_updated);
  db.close();
});

test('P46 逐区容错：某区失败 → 整轮完成、status=partial、其余区已入库', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async districts() {
      return [
        { name: 'A区', adcode: '330101', lng: 120.1, lat: 30.1 },
        { name: 'B区', adcode: '330102', lng: 120.2, lat: 30.2 },
        { name: 'C区', adcode: '330103', lng: 120.3, lat: 30.3 },
      ];
    },
    async searchPoiByDistrict({ adcode, page }) {
      if (adcode === '330102') {
        const e = new Error('DAILY_QUERY_OVER_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      }
      if (page > 1) return [];
      return [mkPoi(`P-${adcode}`, STAY)];
    },
  });
  const res = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  assert.strictEqual(res.status, 'partial');
  const { total } = db.listPois({ city: '杭州', category: 'stay', limit: 100 });
  assert.strictEqual(total, 2);
  const failed = res.districts.filter((d) => d.ok === false);
  assert.strictEqual(failed.length, 1);
  db.close();
});

test('P53 二级分片递归：某区永远返回 200 → 继续缩小半径分片，最终入库 > 200', async () => {
  const db = createDb(':memory:');
  const radii = [];
  const amap = makeAmap({
    async districts() {
      return [{ name: '西湖区', adcode: '330106', lng: 120.13, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 8) return [];
      return fullPage(`text-${page}`, STAY);
    },
    async searchPoiAround({ radius, page }) {
      if (page === 1) radii.push(radius);
      if (page > 8) return [];
      return fullPage(`around-${radius}-${page}`, STAY);
    },
  });
  const res = await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const { total } = db.listPois({ city: '杭州', category: 'stay', limit: 100000 });
  assert.ok(total > 200, '最终入库应 > 200，实际 ' + total);
  assert.ok(radii.length >= 2, '应至少两次不同半径分片，实际 ' + JSON.stringify(radii));
  assert.ok(radii[0] > radii[radii.length - 1], '半径应递减：' + JSON.stringify(radii));
  assert.strictEqual(res.status, 'done');
  db.close();
});

test('P57 图片与标签落库：photos 为 JSON 数组且 tags 非空', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async districts() {
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('IMG1', STAY)];
    },
  });
  await collectCityCategory({ city: '杭州', category: 'stay', amap, db, intervalMs: 0 });
  const row = db.getPoi('IMG1');
  const photos = JSON.parse(row.photos);
  const tags = JSON.parse(row.tags);
  assert.ok(Array.isArray(photos) && photos.length >= 1, 'photos=' + row.photos);
  assert.ok(Array.isArray(tags) && tags.length >= 1, 'tags=' + row.tags);
  db.close();
});

test('采集元数据：run 记录 n_fetched/n_inserted 与逐区 detail', async () => {
  const db = createDb(':memory:');
  const amap = makeAmap({
    async districts() {
      return [{ name: '上城区', adcode: '330102', lng: 120.17, lat: 30.25 }];
    },
    async searchPoiByDistrict({ page }) {
      if (page > 1) return [];
      return [mkPoi('R1', STAY), mkPoi('R2', STAY)];
    },
  });
  const run = db.createRun({ city: '杭州', category: 'stay' });
  const res = await collectCityCategory({
    city: '杭州',
    category: 'stay',
    amap,
    db,
    intervalMs: 0,
    onProgress: (p) => db.updateRun(run.id, { detail: p.districts }),
  });
  assert.strictEqual(res.n_inserted, 2);
  const stored = db.getRun(run.id);
  assert.ok(stored);
  db.close();
});
