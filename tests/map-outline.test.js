/* P21：选城市先给「整座城市的轮廓与范围」——
   ① map.js 画/清城市边框（一个环一个 Polygon，点击要冒泡到地图）
   ② map.fitOutline 把相机收到外接矩形，并在 moveend 后 resolve
   ③ app.js：切城市先走轮廓路径（拿不到才退回主城区 + z13），整城视野靠倍率门槛不落点
   纯前端模块，不需要网络与高德 key。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'map.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'web', 'js', 'api.js'), 'utf8');

function harness() {
  const stats = { polygons: [], bounds: [], removed: 0 };
  const listeners = new Map();
  const fakeMap = {
    zoomValue: 9,
    on(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(cb);
    },
    off(ev, cb) {
      const list = listeners.get(ev) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(ev) {
      (listeners.get(ev) || []).slice().forEach((cb) => cb());
    },
    getZoom() {
      return fakeMap.zoomValue;
    },
    getBounds: () => null,
    add() {},
    remove() {
      stats.removed += 1;
    },
    setBounds(bounds, immediately, avoid) {
      stats.bounds.push({ sw: bounds.sw, ne: bounds.ne, immediately, avoid });
    },
    setFitView() {},
    resize() {},
    setZoomAndCenter() {},
  };
  const win = {
    AMap: {
      Map: function () {
        return fakeMap;
      },
      Marker: function (opts) {
        this.setMap = () => {};
        this.getExtData = () => opts.extData;
        this.setContent = () => {};
        this.on = () => {};
      },
      Polygon: function (opts) {
        stats.polygons.push(opts);
        this.opts = opts;
        this.setMap = () => {};
      },
      Bounds: function (sw, ne) {
        this.sw = sw;
        this.ne = ne;
      },
      Pixel: function () {},
      Polyline: function () {},
      Text: function () {},
    },
    addEventListener: () => {},
    TravelCategories: { all: () => [{ key: 'food' }], colorOf: () => '#000', labelOf: () => '美食' },
    TravelScoreColor: null,
  };
  const doc = { createElement: () => ({}), head: { appendChild() {} } };
  new Function('window', 'document', MAP)(win, doc);
  return { MapCtl: win.TravelMap, fakeMap, stats };
}

const RINGS = [
  [
    [118.34, 29.19],
    [120.72, 29.19],
    [120.72, 30.56],
    [118.34, 29.19],
  ],
];

test('map.drawCityOutline：一个环一个多边形，描边 + 淡填充，点击冒泡到地图', async () => {
  const h = harness();
  await h.MapCtl.init('map', { jsApiKey: 'K' });
  const n = h.MapCtl.drawCityOutline(RINGS);
  assert.strictEqual(n, 1);
  assert.strictEqual(h.MapCtl.cityOutlineCount(), 1);
  const poly = h.stats.polygons[0];
  assert.deepStrictEqual(poly.path, RINGS[0], '轮廓点要原样交给高德');
  assert.ok(poly.strokeWeight >= 2, '边框要看得见');
  assert.strictEqual(poly.bubble, true, '轮廓盖住整座城，点击必须还能冒泡（点地图查地址照旧）');
  assert.ok(poly.fillOpacity > 0 && poly.fillOpacity < 0.2, '填充只能是暗示，不能盖住底图');

  // 换城市/拿不到轮廓时清掉
  h.MapCtl.clearCityOutline();
  assert.strictEqual(h.MapCtl.cityOutlineCount(), 0);
  assert.ok(h.stats.removed >= 1, '要从地图上摘掉');
});

test('map.drawCityOutline：多段（岛屿/飞地）各画一条，脏点不画空图', async () => {
  const h = harness();
  await h.MapCtl.init('map', { jsApiKey: 'K' });
  const two = RINGS.concat([
    [
      [121.0, 31.0],
      [121.1, 31.0],
      [121.1, 31.1],
    ],
  ]);
  assert.strictEqual(h.MapCtl.drawCityOutline(two), 2);
  h.MapCtl.clearCityOutline();
  assert.strictEqual(h.MapCtl.drawCityOutline([[['bad', 1]]]), 0, '点数不够/全是脏点 ⇒ 一个都不画');
  assert.strictEqual(h.MapCtl.cityOutlineCount(), 0);
});

test('map.fitOutline：按外接矩形收相机，moveend 后 resolve；没 bbox 就不动相机', async () => {
  const h = harness();
  await h.MapCtl.init('map', { jsApiKey: 'K' });
  const p = h.MapCtl.fitOutline([118.344933, 29.188757, 120.721945, 30.563114]);
  assert.strictEqual(h.stats.bounds.length, 1);
  assert.deepStrictEqual(h.stats.bounds[0].sw, [118.344933, 29.188757]);
  assert.deepStrictEqual(h.stats.bounds[0].ne, [120.721945, 30.563114]);
  assert.ok(Array.isArray(h.stats.bounds[0].avoid), '要给留白，别让边框贴着屏幕边');
  let settled = false;
  p.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(settled, false, '相机没落定前不该 resolve');
  h.fakeMap.emit('moveend');
  await p;
  assert.strictEqual(settled, true);
  assert.strictEqual(await h.MapCtl.fitOutline(null), false, '没有 bbox 时不调 setBounds');
  assert.strictEqual(h.stats.bounds.length, 1);
});

test('app.js：切城市先走「城市轮廓」路径，拿不到才退回主城区 + z13', () => {
  assert.match(APP, /async function loadCityOutline\(city\)/, '缺 loadCityOutline');
  assert.match(APP, /API\.cityBoundary\(/, '要走 /api/city/boundary');
  assert.match(APP, /MapCtl\.drawCityOutline\(/, '拿到轮廓要画边框');
  assert.match(APP, /await MapCtl\.fitOutline\(outline\.bbox\)/, '要把相机收到全城');
  const setCity = APP.match(/async function setCity[\s\S]*?\n  \}/);
  assert.ok(setCity, '缺 setCity');
  const outlineAt = setCity[0].indexOf('loadCityOutline');
  const fallbackAt = setCity[0].indexOf('setZoomAndCenter');
  assert.ok(outlineAt >= 0 && fallbackAt > outlineAt, '轮廓路径要在主城区兜底之前');
  assert.match(setCity[0], /else if \(center && MapCtl\.isReady\(\)\)/, '轮廓拿不到才退回老路径');
  assert.match(APP, /state\.outline = null;/);
  assert.match(API, /cityBoundary: \(city\)/, 'api.js 缺 cityBoundary');
});

test('app.js：整城视野不落点（倍率门槛仍在），放大进城才落点', () => {
  assert.match(APP, /const MIN_MARKER_ZOOM = \d+;/, '缺落点倍率门槛');
  const gate = APP.match(/if \(zoom != null && \(zoom < MIN_MARKER_ZOOM[\s\S]{0,260}/);
  assert.ok(gate, '缺倍率门槛分支');
  assert.match(gate[0], /state\.pois = \[\]/, '倍率不够时不该有待落点');
  assert.match(gate[0], /MapCtl\.clearMarkers\(\)/, '倍率不够时地图上不该有点');
  assert.match(gate[0], /放大地图以加载本区域地点/, '要告诉用户怎么看到点');
});
