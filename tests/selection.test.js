const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createDb } = require('../server/db');

const POI_A = {
  id: 'PA',
  name: '牛New寿喜烧(来福士店)',
  address: '新业路228号杭州来福士广场4楼',
  lng: 120.212943,
  lat: 30.24917,
  category: 'food',
  rating: '4.7',
  cost: '172.00',
  tel: '0571-86022015',
  photo: 'https://img/a.jpg',
};
const POI_B = {
  id: 'PB',
  name: '雷峰塔',
  address: '南山路15号',
  lng: 120.14869,
  lat: 30.23177,
  category: 'sight',
  rating: '4.6',
  cost: '40',
};

function oldDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-old-'));
  const file = path.join(dir, 'travel.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id),
      poi_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      category TEXT NOT NULL,
      rating TEXT,
      cost TEXT,
      tel TEXT,
      photo TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO trips (city, title) VALUES ('杭州', '旧行程');
    INSERT INTO pins (trip_id, poi_id, name, lng, lat, category)
      VALUES (1, 'OLD1', '旧点', 120.1, 30.2, 'food');
  `);
  raw.close();
  return file;
}

test('迁移：旧库（无 sort_order）自动补列且旧数据保留', () => {
  const file = oldDbFile();
  const db = createDb(file);
  const cols = db.raw.prepare('PRAGMA table_info(pins)').all().map((c) => c.name);
  assert.ok(cols.includes('sort_order'), 'sort_order 列应被补齐');
  const pins = db.getPinsByTrip(1);
  assert.strictEqual(pins.length, 1);
  assert.strictEqual(pins[0].name, '旧点');
  assert.strictEqual(Number(pins[0].sort_order), 0);
  db.close();
});

test('迁移幂等：对已含 sort_order 的库重复 createDb 不报错', () => {
  const file = oldDbFile();
  const db1 = createDb(file);
  db1.close();
  const db2 = createDb(file);
  assert.strictEqual(db2.getPinsByTrip(1).length, 1);
  db2.close();
});

test('idx_pins_poi 索引存在', () => {
  const db = createDb(':memory:');
  const idx = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r) => r.name);
  assert.ok(idx.includes('idx_pins_poi'));
  db.close();
});

test('getOrCreateCityTrip 同城市多次调用返回同一行程，标题含「我的行程」', () => {
  const db = createDb(':memory:');
  const t1 = db.getOrCreateCityTrip('杭州', 1);
  const t2 = db.getOrCreateCityTrip('杭州', 1);
  assert.strictEqual(t1.id, t2.id);
  assert.match(t1.title, /我的行程/);
  assert.strictEqual(t1.city, '杭州');
  db.close();
});

test('insertPinIfAbsent：同 (city, poi_id) 幂等，返回同一条', () => {
  const db = createDb(':memory:');
  const p1 = db.insertPinIfAbsent('杭州', POI_A, 1);
  const p2 = db.insertPinIfAbsent('杭州', POI_A, 1);
  assert.strictEqual(p1.id, p2.id);
  assert.strictEqual(db.getSelectionByCity('杭州', 1).length, 1);
  db.close();
});

test('getSelectionByCity 按 sort_order, id 升序，且仅返回本城市', () => {
  const db = createDb(':memory:');
  db.insertPinIfAbsent('杭州', POI_A, 1);
  db.insertPinIfAbsent('杭州', POI_B, 1);
  db.insertPinIfAbsent('上海', { id: 'PS', name: '外滩', lng: 121.5, lat: 31.2, category: 'sight' }, 1);
  const list = db.getSelectionByCity('杭州', 1);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map((p) => p.poi_id), ['PA', 'PB']);
  db.close();
});

test('reorderPins 按数组下标写 sort_order 并持久化', () => {
  const db = createDb(':memory:');
  db.insertPinIfAbsent('杭州', POI_A, 1);
  db.insertPinIfAbsent('杭州', POI_B, 1);
  db.reorderPins('杭州', ['PB', 'PA'], 1);
  const list = db.getSelectionByCity('杭州', 1);
  assert.deepStrictEqual(list.map((p) => p.poi_id), ['PB', 'PA']);
  db.close();
});

test('deletePinByPoi 删除本城市匹配点，不存在返回 changes=0', () => {
  const db = createDb(':memory:');
  db.insertPinIfAbsent('杭州', POI_A, 1);
  const r = db.deletePinByPoi('杭州', 'PA', 1);
  assert.strictEqual(Number(r.changes), 1);
  assert.strictEqual(db.getSelectionByCity('杭州', 1).length, 0);
  assert.strictEqual(Number(db.deletePinByPoi('杭州', 'PA', 1).changes), 0);
  db.close();
});

test('buildItineraryMarkdown 含标题/序号/详细地址/评分人均（一条路线就是一个清单，不按类别分组）', () => {
  const db = createDb(':memory:');
  db.insertPinIfAbsent('杭州', POI_A, 1);
  db.insertPinIfAbsent('杭州', POI_B, 1);
  const md = db.buildItineraryMarkdown('杭州', {}, null, 1);
  assert.match(md, /^# 杭州 · 我的行程（2 个地点）/m);
  assert.ok(!/^## /m.test(md), '不再按类别分组（分组标题会让「一条路线」读起来断断续续）');
  assert.match(md, /1\. 牛New寿喜烧\(来福士店\)/);
  assert.match(md, /新业路228号杭州来福士广场4楼/);
  assert.match(md, /★4\.7/);
  assert.match(md, /¥172/);
  db.close();
});

test('updatePinNote 改备注', () => {
  const db = createDb(':memory:');
  const pin = db.insertPinIfAbsent('杭州', POI_A, 1);
  db.updatePinNote(pin.id, '记得提前订位');
  assert.strictEqual(db.getPin(pin.id).note, '记得提前订位');
  db.close();
});

// ---------- T6b F4-2 标题去重 ----------

test('getOrCreateCityTrip 修复「城市 · 城市 · …」重复标题（F4-2）', () => {
  const db = createDb(':memory:');
  const t = db.createTrip({ city: '杭州', title: '杭州 · 杭州 · 我的行程', userId: 1});
  const got = db.getOrCreateCityTrip('杭州', 1);
  assert.strictEqual(got.id, t.id);
  assert.strictEqual(got.title, '杭州 · 我的行程');
  assert.strictEqual(db.getTrip(t.id).title, '杭州 · 我的行程');
  db.close();
});

test('getOrCreateCityTrip 新建城市行程标题为「城市 · 我的行程」（F4-2）', () => {
  const db = createDb(':memory:');
  const t = db.getOrCreateCityTrip('三亚市', 1);
  assert.strictEqual(t.title, '三亚市 · 我的行程');
  assert.ok(!/三亚市 · 三亚市/.test(t.title));
  db.close();
});
