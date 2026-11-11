const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'map.js'), 'utf8');

function makeFakeMap() {
  const listeners = new Map();
  const bounds = {
    getSouthWest: () => ({ getLng: () => 120.1, getLat: () => 30.2 }),
    getNorthEast: () => ({ getLng: () => 120.3, getLat: () => 30.4 }),
  };
  const fake = {
    zoomValue: 11,
    lastCenter: null,
    setZoomAndCenterCalls: 0,
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
    getBounds() {
      return bounds;
    },
    getZoom() {
      return fake.zoomValue;
    },
    setZoomAndCenter(zoom, center) {
      fake.setZoomAndCenterCalls += 1;
      fake.zoomValue = zoom;
      fake.lastCenter = center;
    },
    resize() {},
    remove() {},
    // 忠实模拟 AMap：add 支持数组，且会把每个覆盖物上图（setMap）
    add(overlay) {
      const list = Array.isArray(overlay) ? overlay : [overlay];
      list.forEach((m) => {
        if (m && typeof m.setMap === 'function') m.setMap(fake);
      });
    },
    setFitView() {},
  };
  return fake;
}

function loadMap(fakeMap, stats = {}) {
  const win = {
    AMap: {
      Map: function () {
        return fakeMap;
      },
      Marker: function () {
        stats.created = (stats.created || 0) + 1;
        this.setMap = () => {
          stats.mapped = (stats.mapped || 0) + 1;
        };
        this.on = () => {};
      },
      Pixel: function () {},
      Polyline: function () {},
      Text: function () {},
    },
    addEventListener: () => {},
    TravelCategories: { colorOf: () => '#000', labelOf: () => 'x' },
    TravelScoreColor: null,
  };
  const doc = {
    createElement: () => ({}),
    head: { appendChild() {} },
  };
  new Function('window', 'document', MAP)(win, doc);
  return win.TravelMap;
}

function pois(prefix, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: prefix + i,
    name: prefix + i,
    lng: 120 + i * 0.001,
    lat: 30,
    category: 'food',
  }));
}

test('map.getBounds 返回 {minLng,minLat,maxLng,maxLat}', async () => {
  const fake = makeFakeMap();
  const MapCtl = loadMap(fake);
  await MapCtl.init('map', { jsApiKey: 'K' });
  assert.deepStrictEqual(MapCtl.getBounds(), {
    minLng: 120.1,
    minLat: 30.2,
    maxLng: 120.3,
    maxLat: 30.4,
  });
});

test('map.getZoom 返回当前倍率', async () => {
  const fake = makeFakeMap();
  fake.zoomValue = 13;
  const MapCtl = loadMap(fake);
  await MapCtl.init('map', { jsApiKey: 'K' });
  assert.strictEqual(MapCtl.getZoom(), 13);
});

test('map.setZoomAndCenter(lng,lat,zoom) 落定后（moveend）resolve，并调用 SDK', async () => {
  const fake = makeFakeMap();
  const MapCtl = loadMap(fake);
  await MapCtl.init('map', { jsApiKey: 'K' });
  const p = MapCtl.setZoomAndCenter(116.405, 39.905, 13);
  assert.strictEqual(fake.setZoomAndCenterCalls, 1);
  assert.deepStrictEqual(fake.lastCenter, [116.405, 39.905]);
  let settled = false;
  p.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(settled, false, '未收到 moveend 前不应 resolve');
  fake.emit('moveend');
  await p;
  assert.strictEqual(settled, true);
  assert.strictEqual(MapCtl.getZoom(), 13);
});

test('map.onMoveEnd 内部防抖 300ms：连续 moveend 只回调一次', async () => {
  const fake = makeFakeMap();
  const MapCtl = loadMap(fake);
  await MapCtl.init('map', { jsApiKey: 'K' });
  let calls = 0;
  MapCtl.onMoveEnd(() => {
    calls += 1;
  });
  fake.emit('moveend');
  fake.emit('moveend');
  fake.emit('moveend');
  assert.strictEqual(calls, 0, '防抖期内不应立即回调');
  await new Promise((r) => setTimeout(r, 360));
  assert.strictEqual(calls, 1, '防抖后只回调一次');
});

test('map.onMoveEnd 同时响应 zoomend（缩放也算视野变化）', async () => {
  const fake = makeFakeMap();
  const MapCtl = loadMap(fake);
  await MapCtl.init('map', { jsApiKey: 'K' });
  let calls = 0;
  MapCtl.onMoveEnd(() => {
    calls += 1;
  });
  fake.emit('zoomend');
  await new Promise((r) => setTimeout(r, 360));
  assert.strictEqual(calls, 1);
});

test('map.js 暴露视野接口（getBounds/onMoveEnd/setZoomAndCenter/getZoom）', () => {
  assert.match(MAP, /getBounds/);
  assert.match(MAP, /onMoveEnd/);
  assert.match(MAP, /setZoomAndCenter/);
  assert.match(MAP, /getZoom/);
});

test('map.setMarkers 分批渲染：全部点最终落图', async () => {
  const fake = makeFakeMap();
  const stats = {};
  const MapCtl = loadMap(fake, stats);
  await MapCtl.init('map', { jsApiKey: 'K' });
  MapCtl.setMarkers(pois('P', 7), () => false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(stats.mapped, 7);
});

test('map.setMarkers 取消过期批次：只保留最后一次渲染', async () => {
  const fake = makeFakeMap();
  const stats = {};
  const MapCtl = loadMap(fake, stats);
  await MapCtl.init('map', { jsApiKey: 'K' });
  fake.zoomValue = 15; // 落旗上限现在按缩放变，这条只测「过期批次取消」，用大缩放走满额
  MapCtl.setMarkers(pois('A', 500), () => false);
  MapCtl.setMarkers(pois('B', 3), () => false);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(stats.mapped < 500, '过期批次应被取消（不应把 500 个都画完）');
  assert.strictEqual(stats.mapped, 203, '首批 200 + 新批 3');
});

test('map.js 提供 setMarkers 分批接口', () => {
  assert.match(MAP, /setMarkers/);
});

test('map.getMap 暴露底层 AMap 实例（便于联动/取证）', async () => {
  const fake = makeFakeMap();
  const MapCtl = loadMap(fake);
  await MapCtl.init('map', { jsApiKey: 'K' });
  assert.strictEqual(MapCtl.getMap(), fake);
});
