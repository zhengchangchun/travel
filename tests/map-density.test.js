/* P20：地图上的点「一眼能不能看」——
   ① 落点上限按缩放收紧（z13 从 160 降到 90）
   ② 远看只画小圆点（12px，不抢底图），近看才是旗子；跨档整批重画
   ③ 截断改为「评分优先」：之前是按接口返回顺序切，屏幕上留的是「先返回的」不是「最好的」
   纯前端模块，不需要网络与高德 key。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'map.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'css', 'style.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');

// 分帧落旗在测试里同步跑完（map.js 走的是全局 requestAnimationFrame）
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};

function harness() {
  const stats = { created: [], offsets: [] };
  const fakeMap = {
    zoomValue: 13,
    on() {},
    off() {},
    getZoom() {
      return fakeMap.zoomValue;
    },
    getBounds: () => null,
    add(overlay) {
      (Array.isArray(overlay) ? overlay : [overlay]).forEach((m) => {
        if (m && typeof m.setMap === 'function') m.setMap(fakeMap);
      });
    },
    remove() {},
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
        stats.created.push(opts);
        this.setMap = () => {};
        this.getExtData = () => opts.extData;
        this.setContent = (c) => {
          opts.content = c;
        };
        this.on = () => {};
      },
      Pixel: function (x, y) {
        this.x = x;
        this.y = y;
        stats.offsets.push([x, y]);
      },
      Polyline: function () {},
      Text: function () {},
    },
    addEventListener: () => {},
    TravelCategories: {
      all: () => [{ key: 'food' }, { key: 'stay' }, { key: 'sight' }, { key: 'play' }],
      colorOf: () => '#336699',
      labelOf: () => '美食',
    },
    TravelScoreColor: null,
  };
  const doc = { createElement: () => ({}), head: { appendChild() {} } };
  new Function('window', 'document', MAP)(win, doc);
  return { MapCtl: win.TravelMap, fakeMap, stats };
}

function pois(n, ratingOf) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + i,
    name: 'n' + String(i).padStart(4, '0'),
    lng: 120 + i * 0.001,
    lat: 30,
    category: 'food',
    rating: ratingOf ? ratingOf(i) : undefined,
  }));
}

test('map.js：远看用圆点、近看用旗子（阈值 13）', () => {
  const { MapCtl } = harness();
  assert.strictEqual(typeof MapCtl.modeForZoom, 'function', 'modeForZoom 要可测');
  assert.strictEqual(MapCtl.modeForZoom(11), 'dot');
  assert.strictEqual(MapCtl.modeForZoom(13), 'dot');
  assert.strictEqual(MapCtl.modeForZoom(14), 'flag');
  assert.strictEqual(MapCtl.modeForZoom(null), 'flag', '拿不到倍率时按老样子给旗子');
});

test('map.js：落点上限随缩放收紧（40/60/90/160/500）', () => {
  const { MapCtl } = harness();
  const tiers = [
    [11, 40],
    [12, 60],
    [13, 90],
    [14, 160],
    [15, 500],
    [18, 500],
  ];
  tiers.forEach(([z, want]) => {
    assert.strictEqual(MapCtl.limitForZoom(z), want, 'zoom ' + z + ' 上限应为 ' + want);
  });
  assert.ok(MapCtl.markerLimit() > 100, '无地图时仍取总上限（老断言依赖）');
});

test('map.js：截断时留评分高的（不是先返回的）', async () => {
  const h = harness();
  await h.MapCtl.init('map', { jsApiKey: 'K' });
  h.fakeMap.zoomValue = 13;
  const list = pois(200, (i) => (i % 5) + 1); // 评分 1–5 循环
  const capped = h.MapCtl.capMarkers(list, () => false);
  assert.strictEqual(capped.items.length, 90, 'z13 应截到 90 个');
  const shown = capped.items.map((p) => p.rating);
  const keptOut = list.filter((p) => capped.items.indexOf(p) < 0).map((p) => p.rating);
  assert.ok(
    Math.min.apply(null, shown) >= Math.max.apply(null, keptOut),
    '被留下的最低分不应低于被丢掉的高分：留下 ' + Math.min.apply(null, shown) + ' / 丢掉 ' + Math.max.apply(null, keptOut)
  );
  // 住宿锚点 + 已选中：名额先给它们（老口径不变）
  h.MapCtl.setBase('p0');
  const picked = list[199];
  const capped2 = h.MapCtl.capMarkers(list, (p) => p.id === picked.id);
  const ids = capped2.items.map((p) => p.id);
  assert.ok(ids.indexOf('p0') >= 0 && ids.indexOf(picked.id) >= 0, '锚点与已选中必须在场');
});

test('map.js：名额按分类轮转，不被单一类别吃光', async () => {
  const h = harness();
  await h.MapCtl.init('map', { jsApiKey: 'K' });
  h.fakeMap.zoomValue = 13;
  // 现实里住宿这类高分扎堆：只按评分排会把整屏都给它（实测 90 个里 85 个住宿）
  const stays = pois(200, () => 4.9).map((p) => Object.assign({}, p, { category: 'stay' }));
  const foods = pois(20, () => 3.1).map((p) => Object.assign({}, p, { category: 'food' }));
  const capped = h.MapCtl.capMarkers(stays.concat(foods), () => false);
  const count = (k) => capped.items.filter((p) => p.category === k).length;
  assert.strictEqual(capped.items.length, 90, '总量仍守上限');
  assert.strictEqual(count('food'), 20, '低分但量少的类别也要全上（轮到它时有人就上）');
  assert.strictEqual(count('stay'), 70, '剩下的名额才轮到住宿');
});

test('map.js：z13 落下的是圆点（12px 居中），放大到 14 整批换回旗子', async () => {
  const h = harness();
  await h.MapCtl.init('map', { jsApiKey: 'K' });
  h.fakeMap.zoomValue = 13;
  const list = pois(120);

  const at13 = h.MapCtl.setMarkers(list, () => false);
  assert.strictEqual(at13.shown, 90);
  assert.strictEqual(at13.dropped, 30, 'dropped 要如实回报');
  assert.strictEqual(h.MapCtl.markerCount(), 90);
  assert.match(String(h.stats.created[0].content), /class="poi-dot/, 'z13 应是圆点，不是旗子');
  assert.ok(!/flag-head/.test(String(h.stats.created[0].content)), 'z13 不该画旗子');
  assert.deepStrictEqual(h.stats.offsets[0], [-6, -6], '圆点以自身为中心');

  const before = h.stats.created.length;
  h.fakeMap.zoomValue = 14;
  const at14 = h.MapCtl.syncMarkers(list, () => false);
  assert.strictEqual(at14.removed, 90, '跨档要把旧的一批摘掉');
  assert.strictEqual(at14.shown, 120, 'z14 上限 160，120 个全落');
  assert.strictEqual(h.MapCtl.markerCount(), 120);
  const fresh = h.stats.created.slice(before);
  assert.ok(fresh.length >= 120, '跨档应重建 120 个覆盖物');
  assert.match(String(fresh[0].content), /flag-head/, 'z14 应换回旗子');
  assert.deepStrictEqual(h.stats.offsets[h.stats.offsets.length - 1], [-13, -34], '旗子钉在尖端');
});

test('CSS：圆点在亮/暗两层都有样式，且比旗子小', () => {
  assert.match(CSS, /\.poi-dot\s*\{[^}]*width:\s*12px/s, '缺 .poi-dot 基础样式');
  const dotRules = CSS.match(/\.poi-dot\s*\{[^}]*\}/gs) || [];
  assert.ok(dotRules.length >= 2, '亮色与暗色两层都要有圆点样式，实际 ' + dotRules.length);
  assert.match(CSS, /\.poi-dot\.base\s*\{/, '住宿锚点的圆点要单独区分');
});

test('app.js：结果条说明落点口径（每类挑高分），不再写「落前 N 面」', () => {
  assert.match(APP, /地图每类挑高分的落/, '要说清留的是怎么挑出来的');
  assert.ok(!/地图只落前/.test(APP), '旧文案应已替换');
});
