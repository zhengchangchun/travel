/* 搜「湖滨步行街」点不了（用户 2026-11-11）——两处根因各钉一条：
   ① 关键词搜索命中了一条 3.7 分的酒店，被浏览用的默认评分过滤（≥4.0）滤成 0 条 ⇒ 屏幕上没东西可点
   ② 地图自己飞过去之后，视野加载把列表换成「这一片的所有点」⇒ 刚搜到的东西三秒就没了
   另加一条：底图自带的 POI 标注（「湖滨步行街」这种）本来点不动 ⇒ 点它就近接管到库里真有的点 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('web/js/app.js');
const MAP = read('web/js/map.js');
const UI = read('web/js/ui.js');

test('关键词搜索不套浏览用的评分过滤（否则命中却被滤成 0 条）', () => {
  const fn = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/);
  assert.ok(fn, '未找到 doPoiSearch');
  assert.match(fn[0], /state\.ratingFilter = 'all'/, '搜索时未把评分过滤放开');
  assert.match(fn[0], /renderRatingSlider\(\)/, '放开评分过滤后未同步滑块');
  // 分类也要全选中（列表与 chip 口径一致）
  assert.match(fn[0], /state\.activeCats = new Set\(Cats\.all\(\)/, '搜索时分类未全选');
});

test('结果条在「搜索结果」口径下不说「本视野」', () => {
  const fn = APP.match(/function renderResultSummary[\s\S]*?\n  \}/);
  assert.ok(fn, '未找到 renderResultSummary');
  assert.match(fn[0], /state\.searchKey/, '结果条未区分搜索口径');
  assert.match(fn[0], /搜索「/, '搜索口径下应说明是搜索结果');
});

test('搜索后地图自己飞过去的那一下，不拿视野点冲掉搜索结果', () => {
  assert.match(APP, /searchHold: null/, 'state 缺 searchHold');
  const fn = APP.match(/function onViewChanged[\s\S]*?\n  \}/);
  assert.ok(fn, '未找到 onViewChanged');
  assert.match(fn[0], /state\.searchHold/, 'onViewChanged 未看 searchHold');
  assert.match(fn[0], /viewMatchesHold\(\)/, 'onViewChanged 未判断视野是否真动过');
  assert.ok(/function viewMatchesHold/.test(APP), '缺 viewMatchesHold');
  // getBounds() 给的是普通对象（不是 AMap.Bounds）：别再写 b.getWest() 这种不存在的 API（真踩过）
  const holdFn = APP.match(/function viewMatchesHold[\s\S]*?\n  \}/)[0];
  assert.match(holdFn, /b\.minLng/, 'viewMatchesHold 应从 minLng/maxLng 算中心');
  assert.ok(!/b\.getWest\(\)/.test(holdFn), 'viewMatchesHold 用了不存在的 b.getWest()');
  // 搜索命中后要真的记下锁定视野
  const search = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/)[0];
  assert.match(search, /state\.searchHold = \{/, '搜索后未锁定视野');
  // 回到视野口径时标要清掉（否则结果条一直说「搜索结果」）
  const fetch = APP.match(/async function fetchPoisInView[\s\S]*?\n  \}/)[0];
  assert.match(fetch, /state\.searchKey = ''/, '回到视野口径时未清 searchKey');
  // 切城市 / 清空筛选也要清
  assert.match(APP.match(/async function setCity[\s\S]*?\n  \}/)[0], /state\.searchKey = ''/, 'setCity 未清 searchKey');
  assert.match(APP.match(/function onResetFilters[\s\S]*?\n  \}/)[0], /state\.searchKey = ''/, 'onResetFilters 未清 searchKey');
});

test('点地图任意处：一律问「这里是哪」，不用附近的点冒充点击处', () => {
  // 回调要把点击处经纬度带出来
  const onMapClick = MAP.match(/function onMapClick[\s\S]*?\n  \}/)[0];
  assert.match(onMapClick, /e\.lnglat/, 'onMapClick 未把 lnglat 传给回调');
  assert.match(APP, /onMapClick\(\(lnglat\) => onMapBlankClick\(lnglat\)\)/, 'app.js 未把 lnglat 传下去');

  const blank = APP.match(/function onMapBlankClick[\s\S]*?\n  \}/)[0];
  assert.match(blank, /lookupAddress\(/, 'onMapBlankClick 应直接去查这个位置');
  assert.ok(!/nearestPoi/.test(blank), 'onMapBlankClick 不该再拿附近最近的点冒充点击处');
  assert.ok(!/nearestPoi/.test(MAP), 'map.js 不该再留 nearestPoi 那套就近接管');

  // 后端口径：25m 内才算「点击处那一条」，其余一律只进附近列表
  const route = read('server/routes/poi.js');
  assert.match(route, /distance <= 25/, '后端缺「25m 内才算点击处那条」的判定');
  assert.match(route, /nearby,/, '后端要把附近的一起给出来');

  // 「这一带还有」里我们库里真有的那条可点开；点开的那个不飞相机（它就在眼前）
  assert.match(read('web/js/detail.js'), /data-nearby/, '附近列表里我们库里的点应可点开');
  assert.match(APP, /function pickNearby/, 'app.js 缺 pickNearby');
  assert.match(APP, /noFly/, '从地图上点开的点不该再飞相机');

  // 关卡片时把 cardPoi 一并清掉
  const hide = APP.match(/function hideInfoCard[\s\S]*?\n  \}/)[0];
  assert.match(hide, /state\.cardPoi = null/, 'hideInfoCard 未清 cardPoi');
});

/* 用户 2026-11-16「可以根据名称去搜索地点」：整城视野（轮廓屏）里搜名字曾经等于没搜 ——
   列表是换了，但地图上一个点不落、结果条还把它说成「全城高分精选」，飞过去落定那一下
   又按脚下的小框把命中裁掉。这三条口径各自钉一颗钉子。 */
test('在轮廓屏里搜名字：必须退出「全城精选」口径，命中要落在地图上', () => {
  const fn = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/)[0];
  assert.match(fn, /state\.overviewPicks = false/, '搜索后未退出轮廓屏口径（地图上不会落点、条上还写全城精选）');
  assert.match(fn, /state\.zoomTooLow = false/, '搜索后未解掉倍率门槛（空态提示会盖在命中上）');
  // 晚一步回来的「全城精选」会把搜索结果顶掉：在飞的那一批要作废
  assert.match(fn, /picksSeq \+= 1/, '搜索未作废在飞的全城精选（它会晚一步把命中顶掉）');
  // 先把口径退掉再 refresh：否则第一帧还是轮廓屏那套（不落点 + 说成全城精选）
  const tail = fn.slice(fn.indexOf('state.zoomTooLow = false'));
  assert.ok(tail.indexOf('refresh()') > -1, '要先退出口径再 refresh，否则第一帧还是轮廓屏那套');
});

test('相机落在命中处：不按这个框裁搜索结果，但旗子要按新倍率重画', () => {
  const prune = APP.match(/function pruneToViewport\(bounds\)[\s\S]*?\n  \}/)[0];
  assert.match(prune, /state\.searchHold && viewMatchesHold\(\)/, 'pruneToViewport 不认搜索锁定 ⇒ 相 机落定会把命中裁成脚下那几条');
  const settled = APP.match(/MapCtl\.onViewSettled\(\(bounds\) => \{[\s\S]*?\n      \}\);/)[0];
  assert.match(settled, /state\.searchHold && viewMatchesHold\(\)/, 'onViewSettled 未给搜索留口');
  assert.match(settled, /renderMap\(currentList\(\), false\)/, '搜索落定后应只重画旗子（列表/状态保持搜索结果口径）');
  // 相机真的被用户动了 ⇒ 还是要回到「视野即口径」
  const view = APP.match(/function onViewChanged\(\)[\s\S]*?\n  \}/)[0];
  assert.match(view, /state\.searchHold = null/, 'onViewChanged 仍要能解除搜索锁定');
});

test('搜不到不该把原来的清单清空，措辞要说「没找到」', () => {
  const fn = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/)[0];
  assert.match(fn, /const before = \{[\s\S]*?pois: state\.pois/, '未备份搜索前的清单状态');
  assert.match(fn, /if \(!hits\.length\) \{/, '缺「一条都没搜到」的分支');
  assert.match(fn, /Object\.assign\(state, before\)/, '搜不到时应把原清单原样放回去');
  assert.match(fn, /没找到「/, '措辞应说「没找到」，别只说「搜索失败」');
  assert.match(fn, /没找到 · ' \+ human\(err\)/, '搜索报错时也要落在「没找到」口径上');
});

test('命中来源要说清：高德 / 本地已收录 / OpenStreetMap，OSM 那条还要打标', () => {
  const fn = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/)[0];
  assert.match(fn, /来自本地已收录/, '本地兑底没说来源');
  assert.match(fn, /来自 OpenStreetMap/, 'OSM 兑底没说来源（不能把别人的数据说成自己的）');
  // 结果行上给 OSM 那几条一个可见的标记
  const item = UI.match(/function buildItem\(poi, key, sig, handlers, onPick\)[\s\S]*?\n  \}/)[0];
  assert.match(item, /poi\.source === 'osm'/, '结果行没给 OSM 命中打标');
  assert.match(read('web/css/style.css'), /\.poi-tag\.src/, '缺 OSM 标记的样式');
});
