/* P22：轮廓之后还可以细选（用户 2026-11-12「轮廓之后还可以细选」）。
   ① 整城视野地图照旧不落点（轮廓才是主角），但列表要有一份可点的「全城高分精选」
   ② 精选只读本地已收录（每类各取一批高分），零高德调用；按分类轮转，别被住宿吃掉整张清单
   ③ 点一条 → 飞到街道级 → 顺便按新视野重新加载（否则飞过去那一屏还是没点）
   纯前端结构 + 少量可跑的行为，不需要网络与高德 key。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const APP = read('web/js/app.js');
const UI = read('web/js/ui.js');
const CSS = read('web/css/style.css');

test('轮廓屏：门槛分支照旧不落点，但要补「全城高分精选」清单', () => {
  assert.match(APP, /const CITY_PICKS_PER_CAT = \d+;/, '缺每类取几条的常量');
  assert.match(APP, /function loadCityPicks\(/, 'app.js 缺 loadCityPicks');
  const gate = APP.match(/if \(zoom != null && \(zoom < MIN_MARKER_ZOOM[\s\S]{0,900}/);
  assert.ok(gate, '缺倍率门槛分支');
  assert.match(gate[0], /loadCityPicks\(\)/, '整城视野没去补可细选的清单');
  assert.match(gate[0], /MapCtl\.clearMarkers\(\)/, '整城视野地图上仍不该有点');
});

test('精选只读本地库：每类一条高分查询，零高德调用', () => {
  const fn = APP.match(/async function loadCityPicks\(\)[\s\S]*?\n  \}\n/);
  assert.ok(fn, '缺 loadCityPicks');
  assert.match(fn[0], /API\.listPois\(/, '精选要走已收录列表（本地库）');
  assert.match(fn[0], /sort: 'rating'/, '精选按评分取');
  assert.match(fn[0], /limit: CITY_PICKS_PER_CAT/, '精选每类有上限');
  assert.match(fn[0], /category: key/, '精选要按分类分别取，保证每类都有份');
  assert.ok(!/liveInView|searchPoi\(/.test(fn[0]), '精选不该打高德实时搜索');
  // 换城 / 已经进城：晚到的响应必须作废
  assert.match(fn[0], /seq !== picksSeq \|\| state\.city !== city \|\| !state\.zoomTooLow/, '缺过期响应守卫');
});

test('精选清单：按分类轮转截断，标记 overviewPicks 且不落图', () => {
  const apply = APP.match(/function applyCityPicks\(items\)[\s\S]*?\n  \}/);
  assert.ok(apply, '缺 applyCityPicks');
  assert.match(apply[0], /MapCtl\.capMarkers\(items/, '精选要按落旗口径的分类轮转截断');
  assert.match(apply[0], /state\.overviewPicks = true/, '没标记清单口径');
  // refresh 里：轮廓屏只把「自己挑过的点」画到地图上
  const refreshFn = APP.match(/function refresh\(opts\)[\s\S]*?\n  \}/);
  assert.ok(refreshFn, '缺 refresh');
  assert.match(refreshFn[0], /state\.overviewPicks/, 'refresh 没区分轮廓屏');
  assert.match(
    refreshFn[0],
    /full\.filter\(\(p\) => Selection\.has\(p\) \|\| baseIs\(p\)\)/,
    '轮廓屏应只画选中 / 住宿锚点'
  );
});

test('点清单一条：飞到街道级 + 按新视野重新加载', () => {
  const pick = APP.match(/function onPickPoi\(poi, opts\)[\s\S]*?\n  \}/);
  assert.ok(pick, '缺 onPickPoi');
  assert.match(pick[0], /state\.overviewPicks === true/, 'onPickPoi 没认轮廓屏清单');
  assert.match(pick[0], /\{ reload: fromPicks \}/, '从清单点进来要带回载标记');
  assert.match(pick[0], /state\.overviewPicks = false/, '点完要退出清单口径');
  const fly = APP.match(/function flyTo\(lng, lat, zoom, opts\)[\s\S]*?\n  \}/);
  assert.ok(fly, '缺 flyTo');
  // 飞行动画有好几秒：reload 这条走「不压视野事件」，让飞行结束的 moveend 自己按新视野加载
  assert.match(fly[0], /if \(opts && opts\.reload\) \{[\s\S]{0,120}?return;/, 'reload 这条应该直接飞、不压视野事件');
  assert.ok(
    !/opts\.reload[\s\S]{0,120}fetchPoisInView/.test(fly[0]),
    '别用定时器卡点加载：飞行动画时长不定，等 moveend 才准'
  );
  // 清单是全城口径，按当前框修剪它没有意义
  const prune = APP.match(/function pruneToViewport\(bounds\)[\s\S]*?\n  \}/);
  assert.ok(prune, '缺 pruneToViewport');
  assert.match(prune[0], /if \(state\.overviewPicks\) return;/, '轮廓屏不该按当前框裁精选清单');
});

test('口径要分家：轮廓屏说「全城精选」，不说「本视野」', () => {
  const summary = APP.match(/function renderResultSummary\(total, shown\)[\s\S]*?\n  \}/);
  assert.ok(summary, '缺 renderResultSummary');
  const pickAt = summary[0].indexOf('state.overviewPicks');
  const viewAt = summary[0].indexOf('/ 本视野 ');
  assert.ok(pickAt >= 0 && viewAt > pickAt, '轮廓屏口径要排在「本视野」口径之前');
  assert.match(summary[0], /全城高分精选 ' \+ shown \+ ' 条/, '结果条缺清单说明');
  assert.match(APP, /UI\.setViewCount\(state\.pois\.length, state\.cityTotal, '全城精选'\)/, '计数条没换口径');
});

test('地图上的提示在亮底图上要能读（不是暗色主题那套浅紫字）', () => {
  const rules = CSS.match(/\.view-hint \{[^}]*\}/g) || [];
  assert.ok(rules.length, 'css 缺 .view-hint');
  assert.ok(!rules.some((r) => /#c8d3ff/.test(r)), '提示字别再是浅紫（浅色底图上看不见）');
  assert.match(rules[rules.length - 1], /color:\s*var\(--ink\)/, '地图区那条提示要用亮字');
});

test('ui.setViewCount：label 缺省「当前视野」，轮廓屏传「全城精选」', () => {
  const el = { textContent: '' };
  const win = {};
  const doc = { getElementById: () => el };
  new Function('window', 'document', UI)(win, doc);
  const U = win.TravelUI;
  assert.ok(U && typeof U.setViewCount === 'function', '缺 setViewCount');
  U.setViewCount(12, 345);
  assert.strictEqual(el.textContent, '当前视野 12 条 · 全城已收录 345 条');
  U.setViewCount(40, 345, '全城精选');
  assert.strictEqual(el.textContent, '全城精选 40 条 · 全城已收录 345 条');
});
