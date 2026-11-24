const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'css', 'style.css'), 'utf8');

test('切城市常量：落在核心区（兜底 14 级），MIN_MARKER_ZOOM=13', () => {
  // 2026-11-24 用户改口径：「打开时默认定点在核心区域，不是查看整个城市」⇒
  // 原来的 CITY_ZOOM=13（整城视野）不再是默认，改成核心区 + 兜底 14 级。
  assert.match(APP, /const\s+CORE_ZOOM_FALLBACK\s*=\s*14/, '缺 CORE_ZOOM_FALLBACK=14');
  assert.ok(!/const\s+CITY_ZOOM/.test(APP), 'CITY_ZOOM 应已随整城默认一起退场');
  assert.match(APP, /const\s+MIN_MARKER_ZOOM\s*=\s*13/, '缺 MIN_MARKER_ZOOM=13');
});

test('先定位后加载：切城市用 setZoomAndCenter，并等 moveend', () => {
  assert.match(APP, /MapCtl\.setZoomAndCenter/, '未调用 setZoomAndCenter');
  assert.match(APP, /await\s+MapCtl\.setZoomAndCenter/, '未 await 相机落定（moveend）');
  assert.ok(
    /已定格在|定位到/.test(APP),
    '缺落位提示（「已定格在 …核心区」或「定位到 …城区」）'
  );
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

test('默认评分过滤：初始即勾选 ≥4.0，切城市保持同一默认', () => {
  assert.match(APP, /const\s+DEFAULT_RATING_FILTER\s*=\s*'4\.0'/, '缺默认评分过滤常量 4.0');
  assert.match(APP, /ratingFilter:\s*DEFAULT_RATING_FILTER/, '初始 ratingFilter 未用默认值');
  assert.match(
    APP,
    /state\.ratingFilter\s*=\s*DEFAULT_RATING_FILTER/,
    '切城市未重置为同一默认值'
  );
  // TDZ 守卫：state 初始化会读该常量，常量必须先声明
  assert.ok(
    APP.indexOf('const DEFAULT_RATING_FILTER') < APP.indexOf('const state ='),
    'DEFAULT_RATING_FILTER 必须在 state 之前声明（否则运行时 TDZ 报错）'
  );
});

test('默认不选分类：未选分类不显示地点，选了就只看选中的那些', () => {
  assert.ok(!/showAll/.test(APP), '「全部」那个隐藏模式应该已经删干净');
  assert.ok(!/ALL_CAT_KEY/.test(APP), '「全部」chip 常量应已删除');
  assert.match(APP, /function\s+passesCat/, '缺分类过滤函数 passesCat');
  assert.match(APP, /if\s*\(!state\.activeCats\.size\)\s*return false/, '未选分类应不显示地点');
  assert.match(APP, /state\.activeCats\.has\(p\.category\)/, '选中分类后应只显示该分类');
  assert.match(APP, /function\s+catFilterEmpty/, '缺空筛选态判定 catFilterEmpty');
  assert.match(APP, /return state\.activeCats\.size === 0/, '空筛选态＝没选任何分类');
  // 分类 chip 就是四个真实分类，一个不多一个不少
  assert.match(APP, /UI\.renderChips\(\$\('chips'\), Cats\.all\(\)/, '分类 chip 只渲染真实分类');
  // 只看我选中的：显式挑的点不受分类/评分过滤影响
  assert.match(
    APP,
    /function\s+currentList[\s\S]*?state\.onlySelected\)\s*return Selection\.list\(\)/,
    '只看选中应直接返回选中集'
  );
});

test('切城市回到「未选分类」（默认不显示所有）；关键词搜索不过滤分类', () => {
  const m = APP.match(/function\s+setCity[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 setCity');
  // 2026-11-24 用户「默认不显示所有」⇒ 打开/切城都不预选分类（此前是四类全选，2026-11-11 的口径）
  assert.match(m[0], /state\.activeCats = new Set\(\);/, 'setCity 应回到未选分类');
  assert.ok(!/state\.activeCats = new Set\(Cats\.all\(\)/.test(m[0]), 'setCity 不该再预选四类');
  const s = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/);
  assert.ok(s, '未找到 doPoiSearch');
  assert.match(
    s[0],
    /state\.activeCats = new Set\(Cats\.all\(\)\.map/, '关键词搜索应不过滤分类（四个 chip 全选中）'
  );
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

test('L12 筛选不得动地图：分类/评分/只看选中后不 fitView、不改中心与比例', () => {
  assert.match(APP, /const\s+fit\s*=\s*!!\(\s*opts\s*&&\s*opts\.fit\s*\)/, 'refresh 默认不应 fit');
  assert.match(APP, /function\s+onToggleChip[\s\S]*?refresh\(\);/, '分类筛选不应触发 fit');
  assert.match(APP, /function\s+onPickRating[\s\S]*?refresh\(\);/, '评分筛选不应触发 fit');
  assert.match(APP, /function\s+onToggleOnlySelected[\s\S]*?refresh\(\);/, '只看选中不应触发 fit');
  assert.ok(!/setFitView/.test(APP), 'app.js 不应调用 setFitView');
  // 筛选路径不得出现 setZoomAndCenter：只允许出现在切城市那一段（核心区 + 兜底两条分支）
  const zoomCenterCalls = (APP.match(/setZoomAndCenter/g) || []).length;
  assert.strictEqual(zoomCenterCalls, 2, 'setZoomAndCenter 只该有两条：核心区落位 + 城市中心兜底');
  const setCity = APP.match(/async function setCity[\s\S]*?\n  \}/);
  assert.ok(setCity, '缺 setCity');
  const inside = (setCity[0].match(/setZoomAndCenter/g) || []).length;
  assert.strictEqual(inside, 2, '这两次都必须在切城市里，别处不许动相机');
});
