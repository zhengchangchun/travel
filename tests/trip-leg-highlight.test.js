/* P15 路线分段查看 + 选中高亮：
   ① 应用内：点某段 ⇒ 列表行高亮 + 地图那段加粗描边、其余变淡；选中态要能扛住「地图一动就 refresh 重画」
   ② 分享页：每个出行方式一屏（真实路线图 + 分段列表），tab 强调高亮，点分段行就地高亮
   静态地图硬限制：paths 最多 4 条 ⇒ 段多了并组（这条是被 20003 打出来的） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const routemap = require('../server/routemap');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const ROUTE = read('web/js/route.js');
const MAP = read('web/js/map.js');

function legsOf(n, per = 3) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    from: { name: 'P' + i, lng: 120 + i / 1000, lat: 30 },
    to: { name: 'P' + (i + 1), lng: 120 + (i + 1) / 1000, lat: 30 },
    distance: 1000,
    duration: 600,
    ok: true,
    polyline: Array.from({ length: per }, (_, j) => [120 + i / 1000 + j / 10000, 30 + j / 10000]),
  }));
}

// ---------- ① 应用内：选中高亮 ----------

test('地图侧：提供 setRouteSelection，选中的段加粗＋描边、其余变淡；收回时描边要清掉', () => {
  assert.match(MAP, /function setRouteSelection\(/, '缺 setRouteSelection');
  assert.match(MAP, /setRouteSelection,/, 'setRouteSelection 要导出');
  assert.match(MAP, /LEG_SELECTED_EXTRA = \{[\s\S]*outlineColor: '#ffd666'/, '选中的段要有金色描边');
  assert.match(MAP, /LEG_DIM = \{ strokeOpacity:/, '其余段要变淡');
  assert.match(MAP, /isOutline: false/, '收回选中态时必须把描边关掉（setOptions 是合并，会残留）');
  assert.match(MAP, /applyRouteSelection\(\);/, 'drawRoute 之后要应用一次选中态');
  assert.match(MAP, /handlers\.fit !== false/, '重画时不该再抢镜头（fit=false）');
});

test('列表侧：点分段行 = 选中（同一段再点取消），地图与列表同步；进度行给出提示', () => {
  const sel = ROUTE.match(/function selectLeg\([\s\S]*?\n  \}/);
  assert.ok(sel, '缺 selectLeg');
  assert.match(sel[0], /selectedLeg = selectedLeg === n \? null : n/, '同一段再点应取消');
  assert.match(sel[0], /MapCtl\.setRouteSelection\(selectedLeg\)/, '要同步地图高亮');
  assert.match(sel[0], /paintSelection\(\)/, '要刷新列表高亮');
  assert.match(ROUTE, /route-leg-head'\)\.onclick = \(\) => selectLeg\(leg\.index\)/, '点行要选中');
  assert.match(ROUTE, /onLegClick: \(leg\) => selectLeg\(leg\.index\)/, '点地图上的线也要选中同一段');
  assert.match(ROUTE, /li\.classList\.toggle\('sel', on\)/, '列表行要有 sel 类');
  assert.match(ROUTE, /点某段在地图上高亮/, '进度行要告诉用户能点');
  assert.match(CSS, /\.route-leg\.sel\s*\{/, '缺 .route-leg.sel 样式');
  assert.match(ROUTE, /selectLeg,\n\s+getSelectedLeg/, 'TravelRoute 要导出 selectLeg / getSelectedLeg');
});

test('地图一动就会 refresh 重画 ⇒ 同一条路线不能重请求、不能清掉选中态', () => {
  assert.match(ROUTE, /const sameRoute = key === lastRouteKey/, '要按路线身份判断是否同一条');
  assert.match(ROUTE, /if \(sameRoute && lastData\) \{/, '同一条路线直接返回，不要重画/重请求');
  assert.match(ROUTE, /fit: key !== lastFitKey/, '只有换了路线才 setFitView');
});

// ---------- ② 分享页：分段 ----------

test('静态地图只吃 4 条 paths ⇒ 段数多了要并组（5 条必 20003）', () => {
  assert.equal(routemap.MAX_PATHS, 4);
  const legs = legsOf(7);
  const groups = routemap.groupLegs(legs);
  assert.ok(groups.length <= 4, '最多 4 组，实际 ' + groups.length);
  assert.equal(
    groups.reduce((n, g) => n + g.legs.length, 0),
    7,
    '每段都要落在某一组里'
  );
  // 颜色回写给段：列表色点与地图同色
  const colors = new Set(legs.map((l) => l.color));
  assert.ok(colors.size <= 4);
  assert.ok(legs.every((l) => /^#[0-9a-f]{6}$/i.test(l.color)));
  const paths = routemap.buildPathsParamForGroups(groups);
  assert.equal(paths.split('|').length, groups.length, 'paths 条数 = 组数');
  paths.split('|').forEach((p) => {
    assert.equal(p.split(':')[0].split(',').length, 5, '每条 path 仍是 5 字段');
  });
});

test('DP 抽稀：保形（首尾保留、点更少），短折线原样返回', () => {
  const line = Array.from({ length: 200 }, (_, i) => [120 + i / 10000, 30 + Math.sin(i / 10) / 1000]);
  const out = routemap.simplifyPoints(line, 1e-4);
  assert.ok(out.length < line.length, '应当变少');
  assert.ok(out.length >= 2);
  assert.deepEqual(out[0], line[0]);
  assert.deepEqual(out[out.length - 1], line[line.length - 1]);
  assert.equal(routemap.simplifyPoints([[120, 30], [120.1, 30.1]]).length, 2);
});

test('分享页：路线块 = tab（强调高亮）＋ 每个方式一屏（图 + 分段列表）＋ 点分段就地高亮', () => {
  const maps = {
    driving: {
      mode: 'driving',
      modeLabel: '驾车',
      distance: 4000,
      duration: 1000,
      image: 'data:image/png;base64,AAA',
      groupCount: 2,
      legs: [
        { index: 0, fromSeq: 1, toSeq: 2, from: { name: 'A' }, to: { name: 'B' }, distance: 2000, duration: 500, color: '#1677ff', ok: true },
        { index: 1, fromSeq: 2, toSeq: 3, from: { name: 'B' }, to: { name: 'C' }, distance: 2000, duration: 500, color: '#22aa66', ok: true },
      ],
    },
    walking: {
      mode: 'walking',
      modeLabel: '步行',
      distance: 3000,
      duration: 2000,
      image: 'data:image/png;base64,BBB',
      groupCount: 2,
      legs: [{ index: 0, fromSeq: 1, toSeq: 2, from: { name: 'A' }, to: { name: 'B' }, distance: 3000, duration: 2000, color: '#1677ff', ok: true }],
    },
  };
  const html = share.buildHtml(
    share.buildPayload({ trip: { id: 1, title: '杭州行程' }, city: '杭州', stops: legsOf(3).map((l) => l.from), labels: {}, maps })
  );
  assert.match(html, /class="tab on" data-mode="driving" aria-pressed="true"/, '选中的 tab 要强调');
  assert.match(html, /<div class="rpanel on" data-mode="driving"/, '每个方式一屏');
  assert.match(html, /<div class="rpanel" data-mode="walking"/);
  assert.match(html, /class="leg" data-leg="1"/, '缺分段行');
  assert.match(html, /1→2/, '分段要标出点序号区间');
  assert.match(html, /2\.0 km · 8 min/, '分段要带里程/耗时');
  assert.match(html, /li\.classList\.contains\('on'\)/, '点分段要高亮');
  assert.ok(!/key=/.test(html), '分享页不许出现 key');
});

test('分享页样式：tab 选中是填充高亮，分段行有高亮态', () => {
  const html = share.buildHtml(share.buildPayload({ trip: { id: 1, title: 't' }, city: 'c', stops: [], labels: {} }));
  assert.match(html, /\.tab\.on \{ background:var\(--accent\)/, 'tab 选中要有实底高亮');
  assert.match(html, /\.leg\.on \{ border-color:var\(--accent\)/, '分段选中态样式');
});

// ---------- 两个入口都别掉 ----------

test('应用/分享两端都还在（右栏改名与两个分享入口没被这次改动带掉）', () => {
  assert.match(HTML, /<h2>行程规划<\/h2>/);
  assert.match(HTML, /id="itinerary-share"/);
  assert.match(HTML, /id="trip-share-btn"/);
  assert.match(APP, /API\.exportTripShare\(/);
});
