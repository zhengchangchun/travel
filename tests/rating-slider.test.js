/* P10：评分过滤从「一排选项 chip」改成一个可拖的滑块（用户 2026-11-09：「评分那个不要说选项 要是个可以滑动的选择器」）。
   两层：① rating.js 纯逻辑真跑（滑块位置 ↔ 过滤键、文案、填充比例）② 页面接线与样式结构。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const UI = read('web/js/ui.js');
const RATING = read('web/js/rating.js');

// 在假 window 里跑 rating.js（它只挂 window.TravelRating，加载期不碰 DOM）
function loadRating() {
  const win = {};
  new Function('window', RATING)(win);
  return win.TravelRating;
}

// ---------- ① 纯逻辑 ----------

test('rating：滑块位置 → 过滤键（0 不限 / 5 满分 / 其余 ≥N）', () => {
  const R = loadRating();
  assert.strictEqual(R.valueToFilter(0), 'all', '0 = 不限');
  assert.strictEqual(R.valueToFilter('0'), 'all', '字符串形态也要认');
  assert.strictEqual(R.valueToFilter(5), 'top', '5 = 只留满分（与列表星标同一口径）');
  assert.strictEqual(R.valueToFilter(4), '4.0', '整数位置给「≥ 4.0」');
  assert.strictEqual(R.valueToFilter(4.5), '4.5');
  assert.strictEqual(R.valueToFilter(3.5), '3.5');
  assert.strictEqual(R.valueToFilter(-3), 'all', '越界夹回来');
  assert.strictEqual(R.valueToFilter(99), 'top');
  assert.strictEqual(R.valueToFilter(''), 'all', '空值当不限');
  assert.strictEqual(R.valueToFilter('abc'), 'all');
});

test('rating：过滤键 → 滑块位置（认不出来当不限）', () => {
  const R = loadRating();
  assert.strictEqual(R.filterToValue('all'), 0);
  assert.strictEqual(R.filterToValue(''), 0);
  assert.strictEqual(R.filterToValue('top'), 5);
  assert.strictEqual(R.filterToValue('4.0'), 4);
  assert.strictEqual(R.filterToValue('4.5'), 4.5);
  assert.strictEqual(R.filterToValue('9'), 5, '越界夹到顶');
  assert.strictEqual(R.filterToValue('nope'), 0);
  // 来回一趟要稳定（滑块拖动 → state → 再渲染，不漂）
  ['all', 'top', '3.5', '4.0', '4.5'].forEach((f) => {
    assert.strictEqual(R.valueToFilter(R.filterToValue(f)), f, f + ' 来回一趟应不变');
  });
});

test('rating：文案与无障碍说明是人话', () => {
  const R = loadRating();
  assert.strictEqual(R.labelOf('all'), '不限');
  assert.strictEqual(R.labelOf('4.0'), '≥ 4.0');
  assert.match(R.labelOf('top'), /满分/);
  assert.strictEqual(R.ariaOf('all'), '不限评分');
  assert.strictEqual(R.ariaOf('4.5'), '只看 4.5 分及以上');
  assert.match(R.ariaOf('top'), /满分/);
});

test('rating：填充比例按 0~5 换算（不给 CSS 塞负数/超 100%）', () => {
  const R = loadRating();
  assert.strictEqual(R.percentOf(0), '0%');
  assert.strictEqual(R.percentOf(4), '80%');
  assert.strictEqual(R.percentOf(5), '100%');
  assert.strictEqual(R.percentOf(-1), '0%');
  assert.strictEqual(R.percentOf(7), '100%');
  assert.strictEqual(R.clampValue(4.2), 4, '对齐 0.5 一档');
});

// ---------- ② 页面接线 ----------

test('结构：评分是一个滑块而不是一排选项', () => {
  assert.ok(!/rating-chips/.test(HTML), '不该再有评分 chip 容器');
  assert.ok(!/renderRatingChips|rating-chip/.test(UI), 'ui.js 不该再有 chip 渲染');
  assert.match(
    HTML,
    /<input id="rating-slider" type="range" min="0" max="5" step="0\.5"/,
    '要有 0~5、0.5 一档的滑块'
  );
  assert.match(HTML, /id="rating-value"/, '要有显示当前值的徽标');
  assert.match(HTML, /拖动滑块/, '要说明怎么用（0 = 不限）');
  assert.match(HTML, /<script src="\/js\/rating\.js">/, 'rating.js 要挂进页面（且在 app.js 之前）');
  assert.ok(HTML.indexOf('/js/rating.js') < HTML.indexOf('/js/app.js'), 'rating.js 必须先加载');
});

test('接线：拖动跟手 + 松手重算一次（不一步一重建列表）', () => {
  assert.match(APP, /const\s+Rating\s*=\s*window\.TravelRating/, 'app.js 应用 rating.js 的纯逻辑');
  assert.match(APP, /function\s+renderRatingSlider/, '缺渲染函数');
  assert.match(APP, /function\s+paintRating/, '缺「只动界面」的绘制函数');
  assert.match(APP, /input\.style\.setProperty\('--rating-pct'/, '滑块的已填充比例要靠 CSS 变量');
  assert.match(APP, /setAttribute\('aria-valuetext'/, '无障碍说明要跟着更新');
  const slide = APP.match(/function\s+onRatingSlide[\s\S]*?\n  \}/);
  assert.ok(slide, '缺 onRatingSlide');
  assert.match(slide[0], /paintRating\(value\)/, '拖动时要立刻更新徽标');
  assert.match(slide[0], /setTimeout\([\s\S]*?140\)/, '停下手再重算（防抖）');
  assert.match(slide[0], /onPickRating\(next\)/, '防抖后走既有的评分筛选入口');
  assert.match(
    APP,
    /ratingSlider\.addEventListener\('input',[\s\S]{0,80}onRatingSlide/,
    'input 事件要接上（拖动即时）'
  );
  assert.match(APP, /ratingSlider\.addEventListener\('change'/, 'change 也要接（键盘/点轨道松手）');
  // 评分筛选仍然不得动地图（沿用 L12 口径）
  const pick = APP.match(/function\s+onPickRating[\s\S]*?\n  \}/);
  assert.ok(pick, '缺 onPickRating');
  assert.ok(!/fitView|setZoomAndCenter/.test(pick[0]), '改评分不该动相机');
});

test('样式：滑块自己画轨道/滑块头，且不再走 chip 样式', () => {
  assert.match(CSS, /\.rating-slider input\[type="range"\]/, '缺滑块样式');
  assert.match(CSS, /-webkit-slider-runnable-track/, '缺轨道样式（深色底要看得出已填充部分）');
  assert.match(CSS, /-webkit-slider-thumb/, '缺滑块头样式');
  assert.match(CSS, /var\(--rating-pct/, '轨道填充要用 --rating-pct');
  assert.match(CSS, /\.rating-value \{/, '缺当前值徽标样式');
  assert.ok(!/\.rating-chip/.test(CSS), 'chip 样式该清掉');
});
