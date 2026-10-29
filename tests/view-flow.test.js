const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'css', 'style.css'), 'utf8');

test('切城市常量：CITY_ZOOM=13，MIN_MARKER_ZOOM=13', () => {
  assert.match(APP, /const\s+CITY_ZOOM\s*=\s*13/, '缺 CITY_ZOOM=13');
  assert.match(APP, /const\s+MIN_MARKER_ZOOM\s*=\s*13/, '缺 MIN_MARKER_ZOOM=13');
});

test('先定位后加载：切城市用 setZoomAndCenter，并等 moveend', () => {
  assert.match(APP, /MapCtl\.setZoomAndCenter/, '未调用 setZoomAndCenter');
  assert.match(APP, /await\s+MapCtl\.setZoomAndCenter/, '未 await 相机落定（moveend）');
  assert.match(APP, /定位中/, '缺「定位中」提示');
});

test('视野加载：onMoveEnd 注册 + bbox 请求 + getBounds', () => {
  assert.match(APP, /onMoveEnd/, '未注册 onMoveEnd');
  assert.match(APP, /getBounds/, '未取 getBounds');
  assert.match(APP, /bbox/, '请求未带 bbox');
  assert.match(APP, /API\.listPois/, '未调用 listPois');
});

test('倍率阈值是唯一门控：zoom<MIN_MARKER_ZOOM 时不请求只提示', () => {
  assert.match(APP, /zoom\s*<\s*MIN_MARKER_ZOOM/, '缺倍率阈值判断');
  assert.match(APP, /放大地图以加载本区域地点/, '缺阈值提示文案');
});

test('竞态：递增请求序号，只应用最后一次响应', () => {
  assert.match(APP, /state\.viewSeq\s*\+=\s*1/, '缺递增请求序号');
  assert.match(APP, /seq\s*!==\s*state\.viewSeq/, '未用序号丢弃过期响应');
});

test('无数量限制：源码不得出现 5000 全局封顶，也不做抽稀', () => {
  assert.ok(!/5000/.test(APP), 'app.js 不应再出现 5000 封顶');
  assert.ok(!/limit\s*:\s*\d{3,}/.test(APP), 'app.js 不应再写死 limit 封顶');
  assert.ok(!/抽稀/.test(APP), 'app.js 不应做抽稀');
});

test('双口径计数：当前视野 N 条 · 全城已收录 M 条', () => {
  assert.match(APP, /setViewCount/, 'app 未调用 setViewCount');
  assert.match(APP, /poisStats/, 'app 未取全城已收录数（poisStats）');
  assert.match(UI, /setViewCount/, 'ui.js 缺 setViewCount');
  assert.match(UI, /当前视野/, 'ui.js 缺「当前视野」');
  assert.match(UI, /全城已收录/, 'ui.js 缺「全城已收录」');
  assert.match(HTML, /id="view-count"/, 'index 缺 #view-count 容器');
  assert.match(CSS, /\.view-count/, 'css 缺 .view-count 样式');
});
