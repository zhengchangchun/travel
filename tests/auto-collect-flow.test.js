const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('web/js/app.js');
const MAP = read('web/js/map.js');
const UI = read('web/js/ui.js');
const API = read('web/js/api.js');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');

test('L13/L14 门控与自动采集：MIN_COLLECT_ZOOM=13，缩小时不采、放大时自动采', () => {
  assert.match(APP, /const\s+MIN_COLLECT_ZOOM\s*=\s*13/, '缺 MIN_COLLECT_ZOOM=13');
  assert.match(APP, /zoom\s*<\s*MIN_COLLECT_ZOOM/, '缺 zoom<MIN_COLLECT_ZOOM 门控');
  assert.match(APP, /放大地图以加载本区域地点/, '缺缩小时提示');
  assert.match(APP, /本区域加载中/, '缺采集中提示');
  assert.match(APP, /autoCollectViewport/, '缺自动采集函数');
  assert.match(APP, /API\.coverage/, '未调用覆盖查询');
  assert.match(APP, /API\.collectViewport/, '未调用按视野采集');
});

test('L14 自动采集在放大路径触发（先读缓存落旗，再自动采）', () => {
  const posList = APP.indexOf('API.listPois');
  const posAuto = APP.indexOf('autoCollectViewport(bbox, seq)');
  assert.ok(posList >= 0 && posAuto > posList, '应先读缓存再自动采集');
});

test('L16 渐进补旗：完成后重读缓存并增量补旗（addMarkers），不整体重画', () => {
  assert.match(APP, /mergeViewFromCache/, '缺采集后重读缓存');
  assert.match(APP, /mergeNewItems/, '缺增量合并');
  assert.match(APP, /MapCtl\.addMarkers/, '增量补旗应调 addMarkers');
  assert.match(MAP, /function\s+addMarkers/, 'map.js 缺 addMarkers');
  assert.match(MAP, /markerCount/, 'map.js 缺 markerCount');
});

test('L19 采集全城（补全）按钮保留', () => {
  assert.match(HTML, /id="collect-btn"[^>]*>采集全城（补全）/, '按钮文案未改');
  assert.match(APP, /onCollect/, '全城采集入口丢失');
  assert.match(APP, /pollCollect/, '全城采集进度轮询丢失');
});

test('N20 切城市重置当前行程并重取', () => {
  const m = APP.match(/function\s+setCity[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 setCity');
  const body = m[0];
  assert.match(body, /state\.trip\s*=\s*null/, 'setCity 未重置 state.trip');
  assert.match(body, /API\.listTrips\(state\.city\)/, 'setCity 未按新城市重取行程');
  assert.match(body, /refreshTrips/, 'setCity 未刷新行程界面');
});

test('视野提示资产就绪（ui.setViewHint / #view-hint / CSS）', () => {
  assert.match(UI, /setViewHint/, 'ui.js 缺 setViewHint');
  assert.match(HTML, /id="view-hint"/, 'index 缺 #view-hint');
  assert.match(CSS, /\.view-hint/, 'css 缺 .view-hint');
});

test('API 资产：coverage 与 collectViewport', () => {
  assert.match(API, /coverage:/, 'api.js 缺 coverage');
  assert.match(API, /collectViewport:/, 'api.js 缺 collectViewport');
});

// ---------- T9 实时加载优化前端资产 ----------

test('T9 R1 前端一次只采一个分类（轮转，不再传 all）', () => {
  assert.match(APP, /CATEGORY_ROTATION/, 'app.js 缺分类轮转表');
  assert.match(APP, /pickCollectCategory/, 'app.js 缺单分类选择函数');
  assert.match(APP, /categoryRotation/, 'app.js 未使用配置里的轮转顺序');
  // coverage / collectViewport 都应以单分类调用（由 pickCollectCategory 产出）
  assert.match(APP, /API\.coverage\([^)]*category\s*:\s*collectCategory/, 'coverage 未传单分类');
  assert.match(
    APP,
    /API\.collectViewport\([^)]*category\s*:\s*collectCategory/,
    'collectViewport 未传单分类'
  );
});

test('T9 R2 前端切视野时停旧轮询并释放旧认领', () => {
  assert.match(APP, /stopViewportPoll/, 'app.js 缺停止旧视野采集轮询');
});

test('T9 R4 进度可见：显示本区域已采 x / y 格', () => {
  assert.match(APP, /UI\.setViewProgress/, 'app.js 未更新已采格进度');
  assert.match(UI, /setViewProgress/, 'ui.js 缺 setViewProgress');
  assert.match(UI, /本区域已采/, 'ui.js 缺「本区域已采」文案');
  assert.match(HTML, /id="view-progress"/, 'index 缺 #view-progress 容器');
});
