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

test('点地图任意处：就近接管到库里真有的点（底图标注点不动）', () => {
  assert.match(MAP, /function nearestPoi/, 'map.js 缺 nearestPoi');
  assert.match(MAP, /nearestPoi,/, 'nearestPoi 未导出');
  // 回调要把点击处经纬度带出来
  const onMapClick = MAP.match(/function onMapClick[\s\S]*?\n  \}/)[0];
  assert.match(onMapClick, /e\.lnglat/, 'onMapClick 未把 lnglat 传给回调');
  assert.match(APP, /onMapClick\(\(lnglat\) => onMapBlankClick\(lnglat\)\)/, 'app.js 未把 lnglat 传下去');
  const blank = APP.match(/function onMapBlankClick[\s\S]*?\n  \}/)[0];
  assert.match(blank, /MapCtl\.nearestPoi\(/, 'onMapBlankClick 未就近接管');
  assert.match(blank, /onPickPoi\(near\)/, '命中附近的点时应弹它的卡片');
  // 再点同一个：收起来（不是反复弹）
  assert.match(blank, /state\.cardPoi === near/, '未处理「再点同一个收起」');
  // 关卡片时把 cardPoi 一并清掉
  const hide = APP.match(/function hideInfoCard[\s\S]*?\n  \}/)[0];
  assert.match(hide, /state\.cardPoi = null/, 'hideInfoCard 未清 cardPoi');
});
