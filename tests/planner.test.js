const test = require('node:test');
const assert = require('node:assert');

const Planner = require('../web/js/planner');
const Geo = require('../web/js/geo');

// 造点：以杭州湖滨为基准，用一个「米」偏移出确定坐标
function pt(id, dxM, dyM) {
  const base = { lng: 120.16, lat: 30.25 };
  const dLat = dyM / Geo.DEG_LAT_M;
  const dLng = dxM / (Geo.DEG_LAT_M * Math.cos((base.lat * Math.PI) / 180));
  return { id, name: 'P' + id, lng: Number((base.lng + dLng).toFixed(6)), lat: Number((base.lat + dLat).toFixed(6)) };
}

test('orderStops：从住宿锚点出发的最近邻顺序（贪心，可预测）', () => {
  const anchor = pt('base', 0, 0);
  // A 100m / B 200m 在正东；C 3km 正东；D 在西北 200m 东 + 2km 北
  // 贪心最近邻：base→A(100)→B(100)→D(2.0km 比 C 的 2.8km 近)→C
  const stops = [pt('C', 3000, 0), pt('A', 100, 0), pt('D', 200, 2000), pt('B', 200, 0)];
  const order = Planner.orderStops(stops, { start: anchor });
  assert.deepEqual(order.map((p) => p.id), ['A', 'B', 'D', 'C']);
});

test('orderStops：没给起点时用第一个点；坐标无效的点附在末尾不丢', () => {
  const stops = [pt('A', 0, 0), pt('B', 500, 0), { id: 'X', name: '无坐标' }, pt('C', 200, 0)];
  const order = Planner.orderStops(stops);
  assert.equal(order.length, 4, '一个都不能丢');
  assert.deepEqual(order.slice(0, 3).map((p) => p.id), ['A', 'C', 'B']);
  assert.equal(order[3].id, 'X', '无效坐标的点应在末尾');
});

test('orderStops：平局用 id 字典序兜底（同输入必同输出）', () => {
  const a = pt('A', 100, 0);
  const b = pt('B', 100, 0); // 与 A 等距
  const o1 = Planner.orderStops([a, b], { start: pt('S', 0, 0) }).map((p) => p.id);
  const o2 = Planner.orderStops([b, a], { start: pt('S', 0, 0) }).map((p) => p.id);
  assert.deepEqual(o1, ['A', 'B']);
  assert.deepEqual(o2, o1, '输入顺序不同也应给同一结果');
});

test('orderStops：空数组/单点/全无效坐标都不炸', () => {
  assert.deepEqual(Planner.orderStops([], { start: pt('S', 0, 0) }), []);
  assert.equal(Planner.orderStops([pt('A', 10, 0)], { start: pt('S', 0, 0) }).length, 1);
  const bad = [{ id: 'X', lng: null, lat: 1 }];
  assert.deepEqual(Planner.orderStops(bad).map((p) => p.id), ['X']);
});

test('pathDistance：逐段求和 + 未知段计数', () => {
  const pts = [pt('A', 0, 0), pt('B', 1000, 0), pt('C', 1000, 1000)];
  const d = Planner.pathDistance(pts);
  assert.equal(d.hops, 2);
  assert.ok(Math.abs(d.distanceM - 2000) < 30, '1km + 1km 应≈2000m，实际 ' + d.distanceM);
  assert.equal(Planner.pathDistance([{ id: 'A', lng: 1, lat: 1 }]).distanceM, 0);
  const unk = Planner.pathDistance([{ id: 'A', lng: null, lat: null }, pt('B', 0, 0)]);
  assert.equal(unk.unknown, 1);
});

test('planStops：闭环回到住宿时 waypoints 末尾补回起点，order 不重复起点', () => {
  const anchor = pt('base', 0, 0);
  const stops = [pt('A', 300, 0), pt('B', 600, 0), anchor];
  const plan = Planner.planStops({ stops, start: anchor, returnToStart: true });
  assert.deepEqual(plan.order.map((p) => p.id), ['base', 'A', 'B'], '住宿应在最前（它是起点）');
  assert.equal(plan.closed, true);
  assert.deepEqual(plan.waypoints.map((p) => p.id), ['base', 'A', 'B', 'base'], '闭环末尾应回到住宿');
  assert.ok(plan.startInPath, '住宿本身也是挑的点');
  assert.ok(plan.distanceM > 0);
});

test('planStops：不闭环时 waypoints 等于 order；没锚点也能排', () => {
  const stops = [pt('A', 0, 0), pt('B', 900, 0)];
  const plan = Planner.planStops({ stops, returnToStart: true });
  assert.equal(plan.closed, false, '没锚点就没有闭环');
  assert.deepEqual(plan.waypoints.map((p) => p.id), plan.order.map((p) => p.id));
  assert.equal(plan.start, null);
});
