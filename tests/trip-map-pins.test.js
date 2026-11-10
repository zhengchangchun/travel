/* P16 分享页图上可点的点位：
   ① 投影必须是「高德静态地图那一套」（zoom 用 512 像素世界 —— 这是实测出来的 2 倍关系）
   ② 取景自己算（location+zoom 显式给），点才画得准
   ③ 序号团由分享页自己画（既是标记也是可点区域），点一下跳到对应地点卡
   全部离线：投影是纯函数，取景与出图用假 amap。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const routemap = require('../server/routemap');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const STOPS = [
  { name: 'A', lng: 120.1296, lat: 30.2461 },
  { name: 'B', lng: 120.1667, lat: 30.24 },
  { name: 'C', lng: 120.101, lat: 30.2408 },
];

// ---------- 投影 ----------

test('投影：zoom 按 512 像素世界算（实测 z13 下 0.02° 经度 = 232px，256 会差一半）', () => {
  assert.equal(routemap.TILE, 512, 'zoom 世界尺寸必须是 512 像素（实测值，别改回 256）');
  const view = { center: { lng: 121.5, lat: 30.3 }, zoom: 13, width: 760, height: 430 };
  const a = routemap.pointPercent(121.5, 30.3, view);
  assert.ok(Math.abs(a.left - 50) < 0.01 && Math.abs(a.top - 50) < 0.01, '中心点必须落在图正中间');
  const b = routemap.pointPercent(121.52, 30.3, view);
  const dx = ((b.left - a.left) / 100) * 760;
  assert.ok(Math.abs(dx - 232) < 6, '0.02° 经度应约 232px，实测 ' + dx.toFixed(1));
});

test('取景：bbox 中心 + 能装下所有点的最大 zoom；点铺得越开 zoom 越小', () => {
  const tight = routemap.fitView(STOPS, { width: 760, height: 430, pad: 44 });
  assert.ok(Math.abs(tight.center.lng - (120.101 + 120.1667) / 2) < 1e-6);
  assert.ok(Math.abs(tight.center.lat - (30.24 + 30.2461) / 2) < 1e-6);
  // 所有点都要落在留边之内
  STOPS.forEach((s) => {
    const p = routemap.pointPercent(s.lng, s.lat, tight);
    const x = (p.left / 100) * 760;
    const y = (p.top / 100) * 430;
    assert.ok(x >= 44 && x <= 760 - 44 && y >= 44 && y <= 430 - 44, '点跑出留边了：' + s.name);
  });
  const wide = routemap.fitView(
    [
      { lng: 120.0, lat: 30.0 },
      { lng: 121.0, lat: 31.0 },
    ],
    { width: 760, height: 430, pad: 44 }
  );
  assert.ok(wide.zoom < tight.zoom, '铺得越开 zoom 应当越小');
});

test('取景把路线上的点也算进去（路线会绕出点位矩形）', () => {
  const onlyStops = routemap.fitView(STOPS, { width: 760, height: 430 });
  const withRoute = routemap.fitViewForStopsAndPoints(STOPS, [[119.9, 30.0]], { width: 760, height: 430 });
  assert.ok(withRoute.zoom <= onlyStops.zoom, '算上路线上的点后不该放大');
});

// ---------- 出图：不再让高德画 marker ----------

test('出图：不让高德画 marker（序号由分享页自己画，位置与可点区域同一套投影）', async () => {
  const asked = [];
  const amap = {
    async planDriving(o, d) {
      const [olng, olat] = o.split(',').map(Number);
      const [dlng, dlat] = d.split(',').map(Number);
      return { polyline: [[olng, olat], [dlng, dlat]], distance: 1000, duration: 600 };
    },
    async planWalking(o, d) {
      return this.planDriving(o, d);
    },
    async staticMap(params) {
      asked.push(params);
      return { buffer: Buffer.from('89504e47', 'hex'), contentType: 'image/png' };
    },
  };
  const out = await routemap.buildShareMaps({
    amap,
    cache: { get() {}, set() {} },
    intervalMs: 0,
    stops: STOPS,
    modes: ['driving'],
    mapGapMs: 0,
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].markers, undefined, '不该再传 markers（否则和我们自己画的序号对不上）');
  assert.ok(asked[0].location && asked[0].zoom, '必须显式给 location+zoom，取景才可算');
  assert.equal(asked[0].scale, 1);
  const m = out.maps.driving;
  assert.equal(m.pins.length, 3);
  m.pins.forEach((p, i) => {
    assert.equal(p.seq, i + 1);
    assert.ok(p.left > 0 && p.left < 100 && p.top > 0 && p.top < 100, '点位要落在图内：' + JSON.stringify(p));
  });
  assert.ok(m.view && m.view.zoom === out.maps.driving.view.zoom);
});

// ---------- 分享页 ----------

test('分享页：图上的序号团是可点按钮（起点绿 / 终点红），点一下跳到地点卡', () => {
  const maps = {
    driving: {
      mode: 'driving',
      modeLabel: '驾车',
      distance: 2000,
      duration: 600,
      image: 'data:image/png;base64,AAA',
      groupCount: 2,
      view: { center: { lng: 120.15, lat: 30.24 }, zoom: 13, width: 760, height: 430 },
      legs: [
        { index: 0, fromSeq: 1, toSeq: 2, from: { name: 'A' }, to: { name: 'B' }, distance: 1000, duration: 300, color: '#1677ff', ok: true },
        { index: 1, fromSeq: 2, toSeq: 3, from: { name: 'B' }, to: { name: 'C' }, distance: 1000, duration: 300, color: '#22aa66', ok: true },
      ],
      pins: [
        { seq: 1, name: 'A', left: 20.5, top: 30.25 },
        { seq: 2, name: 'B', left: 50, top: 50 },
        { seq: 3, name: 'C', left: 79.5, top: 69.75 },
      ],
    },
  };
  const html = share.buildHtml(
    share.buildPayload({ trip: { id: 1, title: '杭州行程' }, city: '杭州', stops: STOPS, labels: {}, maps })
  );
  assert.match(html, /class="pin start" data-seq="1"[^>]*style="left:20\.5%;top:30\.25%">1</, '起点要绿、要带序号');
  assert.match(html, /class="pin" data-seq="2"[^>]*>2</);
  assert.match(html, /class="pin end" data-seq="3"[^>]*>3</, '终点要红');
  assert.match(html, /title="A"/, '要有名字提示');
  assert.match(html, /\.pin \{ position:absolute/, '要有样式');
  assert.match(html, /document\.querySelector\('\.stop\[data-seq="' \+ seq \+ '"\]'\)/, '点序号要能定位到地点卡');
  assert.match(html, /data-seq="1">/, '地点卡要带 data-seq 才能对上');
  assert.ok(!/key=/.test(html), '分享页不许出现 key');
});

test('没算出位置的点不会画成跑到图外（超范围的直接不画）', () => {
  const maps = {
    driving: {
      mode: 'driving',
      modeLabel: '驾车',
      distance: 1000,
      duration: 300,
      image: 'data:image/png;base64,AAA',
      groupCount: 1,
      legs: [],
      pins: [
        { seq: 1, name: 'A', left: 50, top: 50 },
        { seq: 2, name: 'B', left: 130, top: 50 },
      ],
    },
  };
  const html = share.buildHtml(
    share.buildPayload({ trip: { id: 1, title: 't' }, city: 'c', stops: [], labels: {}, maps })
  );
  assert.match(html, /data-seq="1"/);
  assert.ok(!/data-seq="2"/.test(html), '超出图外的点不该画');
});
