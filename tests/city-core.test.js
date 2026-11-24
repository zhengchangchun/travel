/* 打开城市先落在「核心区」（2026-11-24 用户：「页面进入打开的时候默认每个城市应该定点在核心区域
   不是地图上查看整个城市」）。

   ① config/city-core.json 是精选城市的核心点真源（坐标不是手写的，取自 featured-geo 的推荐站点）
   ② /api/city/core 三级来源：精选 → 行政区中心（轮廓缓存里有）→ 都没有就 null 让前端兜底
   ③ 整城视野没被删掉，只是从默认变成「看全城」按需（见 map-outline.test.js） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/city-core.json'), 'utf8'));
const GEO = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/featured-geo.json'), 'utf8'));
const routes = require('../server/routes/city');

const APP = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
const coreRoute = routes.find((r) => r.path === '/api/city/core');
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const call = (query, db) =>
  coreRoute.handler({ query, db: db || { getCityBoundary: () => null }, HttpError });

test('精选城市核心点：坐标必须能在 featured-geo 里找到出处', () => {
  const cities = Object.keys(CORE.cities || {});
  assert.ok(cities.length >= 6, '至少覆盖首页推荐的那六座城');
  const inChina = (lng, lat) => lng > 73 && lng < 136 && lat > 3 && lat < 54;
  cities.forEach((city) => {
    const c = CORE.cities[city];
    assert.ok(typeof c.label === 'string' && c.label.length >= 2, city + ' 缺人话标签');
    assert.ok(Number.isFinite(c.lng) && Number.isFinite(c.lat), city + ' 坐标必须是数字');
    assert.ok(inChina(c.lng, c.lat), city + ' 坐标不在中国境内，八成写错了');
    assert.ok(c.zoom >= 13 && c.zoom <= 17, city + ' zoom 应在 13–17（既能看清街区又不是整城）');
    // 出处：同名站点坐标要在 featured-geo 里对得上（防止手抄坐标）
    const routeId = c.source && c.source.route;
    const stopName = c.source && c.source.stop;
    const stops = (GEO.routes && GEO.routes[routeId]) || [];
    const hit = stops.find((s) => s.name === stopName);
    assert.ok(hit, city + ' 的 source 指不到 featured-geo 里的站：' + routeId + ' · ' + stopName);
    assert.equal(Number(hit.lng), Number(c.lng), city + ' 经度与 featured-geo 不一致');
    assert.equal(Number(hit.lat), Number(c.lat), city + ' 纬度与 featured-geo 不一致');
  });
});

test('/api/city/core：精选城市直接给核心点', () => {
  const out = call({ city: '杭州' });
  assert.equal(out.source, 'curated');
  assert.equal(out.lng, CORE.cities['杭州'].lng);
  assert.equal(out.zoom, CORE.cities['杭州'].zoom);
  assert.ok(out.label.includes('西湖'), '标签要能让人知道落在哪：' + out.label);
});

test('/api/city/core：没精选的城市用行政区中心，仍不是整城视野', () => {
  const out = call({ city: '某小城' }, { getCityBoundary: () => ({ center: [121.5, 29.8] }) });
  assert.equal(out.source, 'district');
  assert.equal(out.lng, 121.5);
  assert.equal(out.zoom, CORE.defaultZoom);
  assert.ok(out.zoom >= 13, '兜底也不能是整城视野');
});

test('/api/city/core：什么都不知道就如实说，让前端兜底', () => {
  const out = call({ city: '无数据城' });
  assert.equal(out.source, 'none');
  assert.equal(out.lng, null);
  assert.equal(out.lat, null);
  assert.equal(out.zoom, CORE.defaultZoom);
});

test('/api/city/core：缺 city 参数 400', () => {
  assert.throws(() => call({}), (err) => err && err.status === 400);
});

test('前端：null 坐标不许当成 (0,0)（Number(null) 是 0，会把人送到赤道）', () => {
  assert.match(APP, /function hasLngLat\(o\)/, '缺坐标守卫 hasLngLat');
  const fn = APP.match(/function hasLngLat\(o\)[\s\S]*?\n  \}/);
  assert.ok(fn, '拿不到 hasLngLat 函数体');
  assert.match(fn[0], /lng === null/, '要显式挡 null');
  assert.match(fn[0], /lng === undefined/, '要显式挡 undefined');
  assert.match(fn[0], /Number\.isFinite/, '剩下才看是不是有限数');
  // core 分支必须走这个守卫，不能只写 Number.isFinite(Number(core.lng))
  assert.match(APP, /const hasCore = hasLngLat\(core\)/, '核心点判断要用 hasLngLat');
  assert.ok(!/Number\.isFinite\(Number\(core\.lng\)\)/.test(APP), '别再退回那个挡不住 null 的写法');
});

test('前端：核心点 → 城市中心 → 城市轮廓中心，三级都落在街区级', () => {
  const start = APP.indexOf('async function setCity');
  const end = APP.indexOf('await loadCityView(state.city)');
  assert.ok(start >= 0 && end > start, '缺 setCity 那一段');
  const body = APP.slice(start, end);
  assert.match(body, /API\.cityCore\(/, '先问核心点');
  assert.match(body, /loadCityOutline\(state\.city\)/, '再退：现取城市轮廓拿行政区中心');
  assert.ok(body.indexOf('cityCore') < body.indexOf('loadCityOutline'), '顺序：核心点 → 轮廓中心');
  assert.match(body, /CORE_ZOOM_FALLBACK/, '兜底也用 14 级，不能是整城');
  assert.ok(!/fitOutline/.test(body), '切城市不许把相机收到全城');
});
