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
    add() {},
    setFitView() {},
  };
  return fake;
}

function loadMap(fakeMap) {
  const win = {
    AMap: {
      Map: function () {
        return fakeMap;
      },
      Marker: function () {
        this.setMap = () => {};
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
