const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDb } = require('../server/db');

test('createDb 建表幂等（可重复初始化）', () => {
  const db = createDb(':memory:');
  db.close();
  const db2 = createDb(':memory:');
  assert.deepStrictEqual(db2.listTrips(), []);
  db2.close();
});

test('createTrip / listTrips 往返', () => {
  const db = createDb(':memory:');
  const trip = db.createTrip({ city: '杭州', title: '周末杭州' });
  assert.ok(trip.id > 0);
  assert.strictEqual(trip.city, '杭州');
  assert.strictEqual(trip.title, '周末杭州');
  const all = db.listTrips();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, trip.id);
  db.close();
});

test('addPin 后 getPinsByTrip 能取回，字段完整', () => {
  const db = createDb(':memory:');
  const trip = db.createTrip({ city: '杭州', title: 'T' });
  const pin = db.addPin({
    trip_id: trip.id,
    poi_id: 'B123',
    name: '西湖',
    address: '西湖区龙井路1号',
    lng: 120.15,
    lat: 30.25,
    category: 'sight',
    rating: '4.8',
    cost: '0',
    tel: '0571-12345',
    photo: 'https://img/x.jpg',
    note: '必去',
  });
  assert.ok(pin.id > 0);
  const pins = db.getPinsByTrip(trip.id);
  assert.strictEqual(pins.length, 1);
  assert.strictEqual(pins[0].name, '西湖');
  assert.strictEqual(pins[0].address, '西湖区龙井路1号');
  assert.strictEqual(pins[0].lng, 120.15);
  assert.strictEqual(pins[0].category, 'sight');
  db.close();
});

test('持久化：写文件后重开仍能读到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-db-'));
  const file = path.join(dir, 'nested', 'travel.db');
  const db = createDb(file);
  const trip = db.createTrip({ city: '杭州', title: '持久化' });
  db.addPin({ trip_id: trip.id, name: '点A', lng: 1, lat: 2, category: 'food' });
  db.close();

  const reopened = createDb(file);
  const trips = reopened.listTrips();
  assert.strictEqual(trips.length, 1);
  const pins = reopened.getPinsByTrip(trips[0].id);
  assert.strictEqual(pins.length, 1);
  assert.strictEqual(pins[0].name, '点A');
  reopened.close();
});

test('deleteTrip 级联删除其下 pins', () => {
  const db = createDb(':memory:');
  const trip = db.createTrip({ city: '杭州', title: 'T' });
  db.addPin({ trip_id: trip.id, name: 'p1', lng: 1, lat: 1, category: 'food' });
  db.addPin({ trip_id: trip.id, name: 'p2', lng: 2, lat: 2, category: 'stay' });
  assert.strictEqual(db.getPinsByTrip(trip.id).length, 2);

  db.deleteTrip(trip.id);
  assert.strictEqual(db.listTrips().length, 0);
  assert.strictEqual(db.getPinsByTrip(trip.id).length, 0);
  db.close();
});

test('notes CRUD：按城市过滤', () => {
  const db = createDb(':memory:');
  const n = db.addNote({ city: '杭州', url: 'https://xhs/1', title: '西湖笔记', source: 'xhs' });
  assert.ok(n.id > 0);
  db.addNote({ city: '上海', url: 'https://xhs/2' });

  assert.strictEqual(db.listNotes('杭州').length, 1);
  assert.strictEqual(db.listNotes('杭州')[0].title, '西湖笔记');
  assert.strictEqual(db.listNotes().length, 2);

  db.deleteNote(n.id);
  assert.strictEqual(db.listNotes('杭州').length, 0);
  db.close();
});

test('POI 内容指纹：写库时落 content_sha256；存量行重开时回填；集合指纹可对账', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-hash-'));
  const file = path.join(dir, 'travel.db');
  const poi = {
    poi_id: 'H1',
    city: '杭州',
    adcode: '330100',
    category: 'stay',
    name: 'A店',
    address: 'a',
    lng: 120.16,
    lat: 30.25,
    typecode: '100000',
    rating: '4.6',
    cost: '88',
    tel: 't',
    photos: ['u1'],
    tags: ['x'],
  };
  let db = createDb(file);
  db.upsertPoi(poi);
  const h1 = db.poiContentHash('H1');
  assert.match(h1, /^[0-9a-f]{64}$/, '写入时应落 64 位指纹');

  // 字段变了 ⇒ 指纹变
  db.upsertPoi({ ...poi, rating: '4.9' });
  assert.notEqual(db.poiContentHash('H1'), h1, '内容变 ⇒ 指纹变');

  const digits = db.poiDigest('杭州');
  assert.equal(digits.total, 1);
  assert.equal(digits.hashed, 1);
  assert.match(digits.digest, /^[0-9a-f]{64}$/);
  db.close();

  // 模拟存量库：指纹列被置空 ⇒ 重开时应回填
  const raw = new (require('node:sqlite').DatabaseSync)(file);
  raw.exec("UPDATE pois SET content_sha256 = NULL WHERE poi_id = 'H1'");
  raw.close();
  db = createDb(file);
  assert.match(db.poiContentHash('H1'), /^[0-9a-f]{64}$/, '重开时应回填存量行指纹');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
