const test = require('node:test');
const assert = require('node:assert');

const Geo = require('../web/js/geo');

test('bboxAround：以中心 + 半径算经纬框（中心在框内、边长≈2r）', () => {
  const center = { lng: 120.16, lat: 30.25 };
  const b = Geo.bboxAround(center, 1000);
  assert.ok(b, '应返回框');
  assert.ok(Geo.inBbox(center, b), '中心必须在框内');
  // 纬向：2r / 111320 度
  const dLat = b.maxLat - b.minLat;
  assert.ok(Math.abs(dLat - (2000 / Geo.DEG_LAT_M)) < 1e-6, '纬向边长应≈2r/111320');
  // 经向：2r / (111320·cos(lat))，比纬向宽
  const dLng = b.maxLng - b.minLng;
  const expectLng = 2000 / (Geo.DEG_LAT_M * Math.cos((30.25 * Math.PI) / 180));
  assert.ok(Math.abs(dLng - expectLng) < 1e-6, '经向边长应按纬度收缩修正');
  assert.ok(dLng > dLat, '北纬处经向跨度应大于纬向');
});

test('bboxAround：半径为 0/非法、中心缺失时给出合理结果', () => {
  assert.equal(Geo.bboxAround(null, 1000), null, '缺中心应 null');
  assert.equal(Geo.bboxAround({ lng: 'x', lat: 30 }, 1000), null, '非法坐标应 null');
  const tiny = Geo.bboxAround({ lng: 120, lat: 30 }, 0);
  assert.ok(tiny, '半径 0 也要给最小框');
  assert.ok(tiny.maxLng > tiny.minLng && tiny.maxLat > tiny.minLat, '框不能退化');
});

test('bboxQuery：拼成后端 bbox 口径的查询串', () => {
  const s = Geo.bboxQuery({ minLng: 120.15, minLat: 30.24, maxLng: 120.17, maxLat: 30.26 });
  assert.equal(s, '120.15,30.24,120.17,30.26');
  assert.equal(Geo.bboxQuery(null), null);
});

test('inBbox：框内/框外/边界', () => {
  const b = { minLng: 120.15, minLat: 30.24, maxLng: 120.17, maxLat: 30.26 };
  assert.ok(Geo.inBbox({ lng: 120.16, lat: 30.25 }, b));
  assert.ok(Geo.inBbox({ lng: 120.15, lat: 30.24 }, b), '边界算框内');
  assert.ok(!Geo.inBbox({ lng: 120.1499, lat: 30.25 }, b));
  assert.ok(!Geo.inBbox(null, b));
  assert.ok(!Geo.inBbox({ lng: 120.16, lat: 30.25 }, null));
});

test('distanceM：同点为 0、杭州→上海约 165km、非法返回 null', () => {
  const hz = { lng: 120.16, lat: 30.25 };
  assert.equal(Math.round(Geo.distanceM(hz, hz)), 0);
  const sh = { lng: 121.47, lat: 31.23 };
  const d = Geo.distanceM(hz, sh);
  assert.ok(d > 150000 && d < 180000, '杭沪距离应在 150–180km，实际 ' + Math.round(d));
  assert.equal(Geo.distanceM(hz, null), null);
  assert.equal(Geo.distanceM({ lng: 'a', lat: 1 }, hz), null);
});

test('humanDistance：米/公里两档显示', () => {
  assert.equal(Geo.humanDistance(320), '320 m');
  assert.equal(Geo.humanDistance(999), '999 m');
  assert.equal(Geo.humanDistance(1000), '1.0 km');
  assert.equal(Geo.humanDistance(1240), '1.2 km');
  assert.equal(Geo.humanDistance('x'), '');
});
