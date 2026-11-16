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

test('视野门控：MIN_COLLECT_ZOOM=13，缩小时不查不画只提示', () => {
  assert.match(APP, /const\s+MIN_COLLECT_ZOOM\s*=\s*13/, '缺 MIN_COLLECT_ZOOM=13');
  assert.match(APP, /zoom\s*<\s*MIN_COLLECT_ZOOM/, '缺 zoom<MIN_COLLECT_ZOOM 门控');
  assert.match(APP, /放大地图以加载本区域地点/, '缺缩小时提示');
});

test('放大路径：先读缓存落旗 → 再实时搜索本视野', () => {
  const posList = APP.indexOf('API.listPois');
  const posLive = APP.indexOf('liveSearchViewport(bbox, seq)');
  assert.ok(posList >= 0 && posLive > posList, '应先读缓存再实时搜索');
});

test('实时搜索前端资产：API.liveInView + liveSearchViewport + liveCategory', () => {
  assert.match(API, /liveInView:/, 'api.js 缺 liveInView');
  assert.match(API, /\/api\/poi\/inview/, 'api.js 未打 /api/poi/inview');
  assert.match(APP, /function\s+liveSearchViewport/, 'app.js 缺 liveSearchViewport');
  assert.match(APP, /API\.liveInView\(/, 'app.js 未调用 API.liveInView');
  assert.match(APP, /function\s+liveCategory/, 'app.js 缺 liveCategory');
  assert.match(APP, /本区域搜索中/, '缺搜索中提示');
  assert.match(APP, /function\s+reportLiveResult/, '缺实时搜索结果回报');
});

test('默认不选分类 ⇒ 不打高德（省配额）；单选分类 ⇒ 只查该分类', () => {
  assert.match(
    APP,
    /if\s*\(!state\.activeCats\.size\)\s*return null/,
    'liveCategory 未在「未选分类」时返回 null'
  );
  assert.match(APP, /state\.activeCats\.size === 1/, 'liveCategory 未处理单选');
  assert.match(APP, /return 'all'/, 'liveCategory 多选/全部时未走 all');
  const m = APP.match(/function\s+liveSearchViewport[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 liveSearchViewport');
  assert.match(m[0], /if\s*\(!category\)/, 'liveSearchViewport 未在无分类时跳过查询');
});

test('按格收录的前端入口已全部下线（服务端 /api/collect* 仍在）', () => {
  assert.ok(!/autoCollectViewport/.test(APP), 'app.js 不应再有 autoCollectViewport');
  assert.ok(!/pollViewportCollect/.test(APP), 'app.js 不应再有采集轮询');
  assert.ok(!/mergeViewFromCache/.test(APP), 'app.js 不应再有「重读缓存补旗」');
  assert.ok(!/API\.coverage\(/.test(APP), 'app.js 不应再查覆盖格');
  assert.ok(!/API\.collectViewport\(/.test(APP), 'app.js 不应再触发按视野收录');
  assert.ok(!/setViewProgress/.test(APP), 'app.js 不应再有已采格进度');
  assert.ok(!/setViewProgress|本区域已采/.test(UI), 'ui.js 应清掉已采格进度');
  assert.ok(!/id="view-progress"/.test(HTML), 'index 应清掉 #view-progress');
  assert.ok(!/coverage:/.test(API), 'api.js 应清掉 coverage');
  assert.ok(!/collectViewport:/.test(API), 'api.js 应清掉 collectViewport');
});

test('L19 手动采集模块已下线（用户 2026-11-03：数据采集那个模块先去掉）', () => {
  assert.ok(!/id="collect-btn"/.test(HTML), 'index 不应再有采集按钮');
  assert.ok(!/id="collect-progress"/.test(HTML), 'index 不应再有采集进度容器');
  assert.ok(!/\bonCollect\b/.test(APP), 'app.js 不应再有 onCollect 入口');
  assert.ok(!/\bpollCollect\b/.test(APP), 'app.js 不应再有 pollCollect 轮询');
});

test('分类选择变化 ⇒ 对当前视野重跑一次（否则只是在筛缓存）', () => {
  const m = APP.match(/function\s+onToggleChip[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 onToggleChip');
  assert.match(m[0], /fetchPoisInView\(\)/, 'onToggleChip 未重跑视野加载（实时搜索不会触发）');
});

test('只显示当前地图范围内：相机落定立刻裁剪，防抖后再请求', () => {
  assert.match(APP, /function\s+pruneToViewport/, 'app.js 缺 pruneToViewport');
  assert.match(MAP, /function\s+onViewSettled/, 'map.js 缺 onViewSettled（不防抖的落定回调）');
  assert.match(APP, /MapCtl\.onViewSettled\(/, 'app.js 未注册落定裁剪');
  // 落定回调默认按新框裁剪（例外：搜索刚把相机落到命中那一瞬，见 poi-search-visible.test.js）
  assert.match(
    APP,
    /onViewSettled\([\s\S]{0,400}pruneToViewport\(bounds\)/,
    '落定回调未按新框裁剪'
  );
  const m = APP.match(/function\s+onViewChanged[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 onViewChanged');
  assert.match(m[0], /fetchPoisInView\(\)/, 'onViewChanged 未重新请求');
  // 裁剪必须是严格框内（四边都判）
  const p = APP.match(/function\s+pruneToViewport[\s\S]*?\n  \}/);
  assert.ok(p, '未找到 pruneToViewport');
  ['minLng', 'maxLng', 'minLat', 'maxLat'].forEach((k) => {
    assert.ok(p[0].includes('bounds.' + k), 'pruneToViewport 未判 ' + k);
  });
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

test('map.js 落旗资产仍在（addMarkers / markerCount）', () => {
  assert.match(MAP, /function\s+addMarkers/, 'map.js 缺 addMarkers');
  assert.match(MAP, /markerCount/, 'map.js 缺 markerCount');
  assert.match(APP, /MapCtl\.setMarkers/, 'app.js 未整体落旗');
  assert.match(MAP, /onViewSettled,\n/, 'map.js 未导出 onViewSettled');
});

// 关键词搜索后四个分类 chip 全选中；此时点某一个应该是「只看它」，
// 不能把点的那类反而去掉（用户 2026-11-10 走查时发现的点反效果）。
test('分类 chip：全选时点某一个 = 只看它；其余情况才是 toggle', () => {
  const win = {};
  new Function('window', read('web/js/categories.js'))(win);
  const Cats = win.TravelCategories;
  assert.strictEqual(typeof Cats.nextSelection, 'function', 'categories.js 缺 nextSelection');
  const ALL = ['food', 'stay', 'sight', 'play'];

  // 全选 → 点「美食」= 只剩美食（不是把美食去掉）
  assert.deepStrictEqual(Cats.nextSelection(ALL, 'food', ALL), ['food']);
  // 只看美食 → 再点「住宿」= 美食+住宿（加选，按配置顺序）
  assert.deepStrictEqual(Cats.nextSelection(['food'], 'stay', ALL), ['food', 'stay']);
  // 非全选时点已选的 = 取消
  assert.deepStrictEqual(Cats.nextSelection(['food', 'stay'], 'food', ALL), ['stay']);
  // 取消到空 = 未选分类（列表空、等用户自己挑）
  assert.deepStrictEqual(Cats.nextSelection(['food'], 'food', ALL), []);
  // 未选分类时点一个 = 只选它
  assert.deepStrictEqual(Cats.nextSelection([], 'sight', ALL), ['sight']);
  // 全选状态下「一个都没点」的场景不存在；不是全选就不能触发 solo
  assert.deepStrictEqual(Cats.nextSelection(['food', 'stay', 'sight'], 'play', ALL), ALL);

  // app.js 要真的走这个纯函数（别再手写 toggle）
  const fn = APP.match(/function\s+onToggleChip[\s\S]*?\n  \}/);
  assert.ok(fn, '未找到 onToggleChip');
  assert.match(fn[0], /Cats\.nextSelection\(/, 'onToggleChip 未走 Cats.nextSelection');
  assert.ok(!/state\.activeCats\.delete\(/.test(fn[0]), 'onToggleChip 不该再手写 toggle');
});
