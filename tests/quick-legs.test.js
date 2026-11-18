/* P11：左边挑点 → 右边实时给出先后顺序 + 相邻两点的耗时（用户 2026-11-09）。
   三层：① quickroute.js 纯计算真跑 ② 页面接线（顺序号/每段耗时/上移下移/方式切换） ③ 兜底口径（直线估算带 ≈）。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const ROUTE = read('web/js/route.js');
const UI = read('web/js/ui.js');
const QR = read('web/js/quickroute.js');

// 假 window：给一个固定「直线距离」的 Geo 垫片，方便算准
function loadQR(straightM) {
  const win = {
    TravelGeo: {
      distanceM: (a, b) => {
        if (!a || !b || typeof a.lng !== 'number' || typeof b.lng !== 'number') return NaN;
        return typeof straightM === 'number' ? straightM : 1000;
      },
    },
  };
  new Function('window', QR)(win);
  return win.TravelQuickRoute;
}

test('quickroute：相邻两点逐段估算（n 个点 n-1 段），里程按绕行系数放大', () => {
  const R = loadQR(1000); // 每段直线 1 km
  const pins = [
    { id: 'a', lng: 120, lat: 30 },
    { id: 'b', lng: 120.01, lat: 30 },
    { id: 'c', lng: 120.02, lat: 30 },
  ];
  const legs = R.estimateLegs(pins, 'driving');
  assert.strictEqual(legs.length, 2, '3 个点应有 2 段');
  assert.strictEqual(legs[0].distance, Math.round(1000 * R.modeMeta('driving').detour));
  assert.ok(legs[0].estimate, '直线估算要标记成 estimate');
  assert.ok(legs[0].duration > 0);
  // 步行比驾车慢
  const walk = R.estimateLegs(pins, 'walking');
  assert.ok(walk[0].duration > legs[0].duration, '步行用时应该比驾车长');
  // 坏点不炸
  const bad = R.estimateLegs([{ id: 'x' }, { id: 'y' }], 'driving');
  assert.deepStrictEqual(bad[0], { ok: false, estimate: true, distance: 0, duration: 0 });
  assert.deepStrictEqual(R.estimateLegs([{ id: 'x' }], 'driving'), [], '一个点没有段');
});

test('quickroute：单段文案与汇总文案（估算带 ≈、拿不到用时说清楚）', () => {
  const R = loadQR();
  assert.match(R.legText({ estimate: true, distance: 3200, duration: 720 }), /^≈ 12 分 · 3\.2 km$/);
  assert.match(R.legText({ estimate: false, distance: 3200, duration: 720 }), /^12 分 · 3\.2 km$/);
  assert.equal(R.legText({ duration: 0, distance: 0 }), '耗时未知');
  assert.equal(R.legText(null), '');
  // 方式名可以外面给（「最快」不是 QuickRoute 里的一种方式）
  assert.match(R.summarize([{ distance: 1000, duration: 600 }], 'auto', { label: '最快' }), /^最快 /);

  const real = R.summarize(
    [
      { ok: true, duration: 600, distance: 2000 },
      { ok: true, duration: 900, distance: 4000 },
    ],
    'driving',
    {}
  );
  assert.match(real, /^驾车 25 分 6\.0 km 2 段$/);
  const est = R.summarize([{ ok: false, estimate: true, duration: 600, distance: 2000 }], 'walking', {});
  assert.match(est, /^步行 ≈ 10 分 2\.0 km 1 段$/, '估算要带 ≈');
  const partial = R.summarize(
    [
      { ok: true, duration: 600, distance: 2000 },
      { ok: false, estimate: true, duration: 0, distance: 0 },
    ],
    'transit',
    {}
  );
  assert.match(partial, /1 段没算出来/, '某段没结果要说清楚');
});

test('结构：右侧有实时耗时条（汇总 + 步行/公交/驾车），选中项带序号与逐段耗时', () => {
  assert.match(HTML, /id="quick-legs"/, '缺实时耗时容器');
  assert.match(HTML, /id="ql-summary"/, '缺汇总行');
  assert.match(HTML, /id="ql-modes"/, '缺出行方式切换');
  assert.ok(HTML.indexOf('/js/quickroute.js') < HTML.indexOf('/js/app.js'), 'quickroute.js 要先加载');
  // 选中项：序号 + 段耗时 + 上移/下移
  assert.match(UI, /class="sel-order"/, '缺序号');
  assert.match(UI, /class="sel-leg/, '缺每段耗时');
  assert.match(UI, /handlers\.onMove\(i, -1\)/, '缺上移');
  assert.match(UI, /handlers\.onMove\(i, 1\)/, '缺下移');
  assert.match(UI, /legs\[i - 1\]/, '第 i 项显示的应是「上一站 → 这里」那一段');
  // 接线：一条路线只规划一次（挑点视图与行程视图共用），不再各算一遍
  assert.match(APP, /const QuickRoute = window\.TravelQuickRoute/, 'app.js 未使用 quickroute');
  const pick = APP.match(/function pickLegsFor\(pins\)[\s\S]*?\n  \}/);
  assert.ok(pick, '缺 pickLegsFor');
  assert.match(pick[0], /Route\.getLegs\(\)/, '已规划好用实测的');
  assert.match(pick[0], /QuickRoute\.estimateLegs\(list, mode\)/, '还没回来先用直线估一版顶着（带 ≈）');
  assert.ok(!/API\.itineraryRoute/.test(pick[0]), '不得再发第二遍规划请求（高德逐段规划花配额）');
  assert.match(APP, /legs: pick\.legs/, '挑点清单用这份段数据');
  const sync = APP.match(/function syncRoute\(\)[\s\S]*?\n  \}/);
  assert.ok(sync, '缺 syncRoute');
  assert.match(sync[0], /Route\.draw\(state\.city, stops, \{/, '一条路线都从 syncRoute 走');
  assert.match(sync[0], /onLegs: onRouteLegs/, '段数据回填');
  assert.match(sync[0], /fit: state\.view === 'itinerary'/, '挑点阶段别抢镜头');
  assert.match(APP, /function renderSelection[\s\S]*?syncRoute\(\)/, '挑点视图也要把线画出来');
  assert.match(APP, /function setRouteMode\(key\)[\s\S]*?Route\.setMode\(key\)/, '挑点的芯片与行程视图那排共用一份状态');
  assert.match(ROUTE, /function setMode\(key\)[\s\S]*?\n  \}/, 'route.js 要给出 setMode');
  assert.match(ROUTE, /getLegs: \(\) => \(lastData && lastDataKey === lastRouteKey/, '换了路线但新结果没到时不得拿旧数字充数');
  assert.match(APP, /onMove:\s*\(index, delta\) => onMoveDisplayed\(panelPins/, '选中面板未接上移/下移');
  const mover = APP.match(/async function\s+onMoveDisplayed\(pins, index, delta\)[\s\S]*?\n  \}/);
  assert.ok(mover, '缺 onMoveDisplayed');
  assert.match(mover[0], /applyManualOrder\(ids\)/, '改顺序要落库（经 applyManualOrder）');
  assert.match(APP, /async function applyManualOrder[\s\S]*?Selection\.reorder\(ids\)/, '落库要走 Selection.reorder');
  assert.match(APP, /const chips = Route \? \[Route\.AUTO_MODE\]\.concat\(Route\.MODES\)/, '方式切换要能改 mode（与行程视图同一份）');
  assert.match(CSS, /\.quick-legs\s*\{/, '缺 .quick-legs 样式');
  assert.match(CSS, /\.sel-order\s*\{/, '缺 .sel-order 样式');
  assert.match(CSS, /\.sel-leg\s*\{/, '缺 .sel-leg 样式');
  // 两张清单同一个读法：段写在点上面（用户 2026-11-18「路线要放在一起看」）
  assert.match(UI, /'<div class="sel-leg'[\s\S]{0,120}<div class="poi-head">'/, '挑点清单的段也要写在点上面');
});
