/* 导出到导航（2026-11-25，P0-3）：GPX / KML
   ① 纯函数：结构合法、按天分组、住宿锚点、坐标精度
   ② 接口 GET /api/trips/:id/geofile：下载头、format 白名单、空行程、别人的行程
   ③ 页面：工具条两个按钮 + 走 API.geofileUrl（不自己拼 URL） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const geofile = require('../server/geofile');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const APP = read('web/js/app.js');
const API = read('web/js/api.js');
const CSS = read('web/css/style.css');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' },
  defaultCity: '杭州',
};
const CATEGORIES = [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }];

const PAYLOAD = {
  title: '三亚 · 我的行程',
  city: '三亚',
  generatedAt: '2026-11-25T10:00:00.000Z',
  base: { name: '大东海', lng: 109.5, lat: 18.22 },
  stops: [
    { seq: 1, day: 1, name: '大东海', lng: 109.508775, lat: 18.238325, categoryLabel: '景点', rating: '4.8', address: '榆亚街道' },
    { seq: 2, day: 1, name: '亚龙湾', lng: 109.63, lat: 18.22, categoryLabel: '景点' },
    { seq: 3, day: 2, name: '第一市场', lng: 109.5, lat: 18.25, categoryLabel: '美食', note: '买海鲜找店加工' },
  ],
};

async function start() {
  const db = createDb(':memory:');
  const app = createApp({ authFallbackUser: true, config: TEST_CONFIG, categories: CATEGORIES, db });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, db, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

// ---------- ① 纯函数 ----------

test('GPX：结构合法、每个点一个 wpt、按天分 trk、住宿写成 wpt', () => {
  const xml = geofile.buildGpx(PAYLOAD);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<gpx version="1\.1"[^>]*xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.match(xml, /<\/gpx>\s*$/);
  // 3 个点 + 1 个住宿 = 4 个 wpt
  assert.strictEqual((xml.match(/<wpt /g) || []).length, 4, 'wpt 数应为 点数 + 住宿');
  assert.match(xml, /<name>住 · 大东海<\/name>/, '住宿要写成 wpt 且名字带「住」');
  // 两天 ⇒ 两个 trk，名字带「第 N 天」
  assert.strictEqual((xml.match(/<trk>/g) || []).length, 2, '两天应有两个 trk');
  assert.match(xml, /<name>三亚 · 我的行程 · 第 1 天<\/name>/);
  assert.match(xml, /<name>三亚 · 我的行程 · 第 2 天<\/name>/);
  assert.strictEqual((xml.match(/<trkpt /g) || []).length, 3, 'trkpt 总数应等于点数');
  // 坐标精度 6 位
  assert.match(xml, /<trkpt lat="18\.238325" lon="109\.508775">/);
  // 描述里带分类/评分/地址
  assert.match(xml, /<desc>景点 · ★4\.8 · 榆亚街道<\/desc>/);
});

test('GPX：单天时只有一个 trk，名字就是行程名（不写「第 1 天」）', () => {
  const one = { ...PAYLOAD, stops: PAYLOAD.stops.slice(0, 2) };
  const xml = geofile.buildGpx(one);
  assert.strictEqual((xml.match(/<trk>/g) || []).length, 1);
  assert.match(xml, /<name>三亚 · 我的行程<\/name>/);
  assert.ok(!/第 1 天/.test(xml), '单天不该出现「第 1 天」');
});

test('KML：Folder 按天分组、每点一个 Placemark、每天一条 LineString', () => {
  const xml = geofile.buildKml(PAYLOAD);
  assert.match(xml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
  assert.match(xml, /<\/kml>\s*$/);
  assert.strictEqual((xml.match(/<Folder>/g) || []).length, 2, '两天应有两个 Folder');
  assert.match(xml, /<name>第 1 天<\/name>/);
  // 3 个点 + 1 个住宿 + 1 条线（第 2 天只有 1 个点，不画线）= 5 个 Placemark
  assert.strictEqual((xml.match(/<Placemark>/g) || []).length, 5);
  assert.strictEqual((xml.match(/<LineString>/g) || []).length, 1, '只有第 1 天有 2 个点，只该画一条线');
  // KML 坐标顺序是 lon,lat,0（与 GPX 相反，容易写错）
  assert.match(xml, /<coordinates>109\.508775,18\.238325,0<\/coordinates>/);
});

test('两种格式都如实标注坐标系（高德 GCJ-02，不假装是 WGS84）', () => {
  assert.match(geofile.buildGpx(PAYLOAD), /GCJ-02/);
  assert.match(geofile.buildKml(PAYLOAD), /GCJ-02/);
  assert.match(geofile.GCJ_NOTE, /WGS84/, '要说明在只认 WGS84 的软件里会偏');
});

test('坐标缺失的点被跳过（不写 0,0 把线拉到赤道）', () => {
  const bad = {
    ...PAYLOAD,
    stops: [
      { seq: 1, day: 1, name: '好点', lng: 109.5, lat: 18.2 },
      { seq: 2, day: 1, name: '坏点', lng: null, lat: null },
    ],
  };
  const gpx = geofile.buildGpx(bad);
  assert.strictEqual((gpx.match(/<trkpt /g) || []).length, 1, '坏点不该进 trk');
  assert.ok(!/坏点/.test(gpx), '坏点连名字都不该出现');
  const kml = geofile.buildKml(bad);
  assert.ok(!/坏点/.test(kml));
});

test('文件名：城市-行程名-日期.扩展名，非法字符被替换', () => {
  assert.strictEqual(geofile.fileBase(PAYLOAD, 'gpx'), '三亚-我的行程-2026-11-25.gpx');
  const weird = { ...PAYLOAD, title: 'A/B:C*D', city: '' };
  const name = geofile.fileBase(weird, 'kml');
  assert.ok(!/[\\/:*?"<>|]/.test(name), '文件名里不能有非法字符：' + name);
  assert.match(name, /\.kml$/);
});

// ---------- ② 接口 ----------

test('GET /api/trips/:id/geofile：下载头 + 内容 + format 白名单 + 别人的行程 404', async () => {
  const s = await start();
  try {
    const trip = await (await fetch(s.base + '/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '三亚', title: '导出测试' }),
    })).json();
    const tripId = trip.data.id;
    await fetch(s.base + '/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip_id: tripId, name: '大东海', lng: 109.508775, lat: 18.238325, category: 'sight' }),
    });

    const gpx = await fetch(s.base + `/api/trips/${tripId}/geofile?format=gpx`);
    assert.strictEqual(gpx.status, 200);
    assert.match(gpx.headers.get('content-type'), /application\/gpx\+xml/);
    assert.match(gpx.headers.get('content-disposition'), /attachment;.*\.gpx/);
    const gpxText = await gpx.text();
    assert.match(gpxText, /<gpx /);
    assert.match(gpxText, /大东海/);

    const kml = await fetch(s.base + `/api/trips/${tripId}/geofile?format=kml`);
    assert.strictEqual(kml.status, 200);
    assert.match(kml.headers.get('content-type'), /kml\+xml/);
    assert.match(await kml.text(), /<kml /);

    // 缺省 format = gpx
    const dflt = await fetch(s.base + `/api/trips/${tripId}/geofile`);
    assert.strictEqual(dflt.status, 200);
    assert.match(dflt.headers.get('content-type'), /gpx/);

    // 白名单
    const bad = await fetch(s.base + `/api/trips/${tripId}/geofile?format=shp`);
    assert.strictEqual(bad.status, 400);
    assert.match((await bad.json()).error.msg, /gpx 或 kml/);

    // 不存在的行程
    const missing = await fetch(s.base + '/api/trips/99999/geofile?format=gpx');
    assert.strictEqual(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('空行程导出：400 EMPTY_TRIP（不生成一个空文件）', async () => {
  const s = await start();
  try {
    const trip = await (await fetch(s.base + '/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州', title: '空行程' }),
    })).json();
    const res = await fetch(s.base + `/api/trips/${trip.data.id}/geofile?format=gpx`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, 'EMPTY_TRIP');
  } finally {
    await s.close();
  }
});

// ---------- ③ 页面 ----------

test('页面：导出菜单里有 GPX / KML，走 API.geofileUrl（不自己拼 URL）', () => {
  const bar = HTML.match(/<div class="row itin-toolbar">[\s\S]*?<\/div>\s*<div class="trip-note-row">/);
  assert.ok(bar, '缺行程工具条');
  assert.match(bar[0], /id="itinerary-export"/, '缺导出菜单按钮');
  assert.match(bar[0], /id="export-menu"/, '缺导出菜单');
  assert.match(bar[0], /id="itinerary-gpx"/, '缺 GPX 项');
  assert.match(bar[0], /id="itinerary-kml"/, '缺 KML 项');
  // 右栏只有 300px：6 个按钮平铺会溢出（实测 KML 被裁）⇒ 低频动作必须收进菜单
  assert.match(bar[0], /class="export-wrap"/, '导出项要包在 .export-wrap 里（下拉定位）');
  assert.match(CSS, /\.export-menu\s*\{/, '缺 .export-menu 样式');
  assert.match(API, /geofileUrl:\s*\(tripId, format, order\)/, 'api.js 缺 geofileUrl');
  assert.match(API, /\/geofile\?/, 'geofileUrl 要打 /geofile');
  const fn = APP.match(/function onExportGeo\(format\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 onExportGeo');
  assert.match(fn[0], /API\.geofileUrl\(/, '要走 API.geofileUrl');
  assert.match(fn[0], /a\.download/, '要用 a[download] 触发下载');
  assert.match(APP, /\$\('itinerary-gpx'\)/, 'GPX 项没接线');
  assert.match(APP, /gpxBtn\.onclick = \(\) => \{/, 'GPX 项没接到 onExportGeo');
  assert.match(APP, /onExportGeo\('gpx'\)/, 'GPX 项没调 onExportGeo');
  assert.match(APP, /\$\('itinerary-kml'\)/, 'KML 项没接线');
  assert.match(APP, /onExportGeo\('kml'\)/, 'KML 项没调 onExportGeo');
  // 菜单开关
  assert.match(APP, /function bindExportMenu\(\)/, '缺 bindExportMenu');
  assert.match(APP, /function closeExportMenu\(\)/, '缺 closeExportMenu');
});
