const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('web/js/app.js');
const SEL = read('web/js/selection.js');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');

test('自动成线：入口 + 「回到住宿」开关都在右栏「我的选择」里', () => {
  assert.match(HTML, /id="auto-plan-btn"[^>]*>自动成线/, 'index 缺「自动成线」按钮');
  assert.match(HTML, /id="auto-return"/, 'index 缺「回到住宿」勾选');
  assert.match(HTML, /<script src="\/js\/planner\.js"><\/script>/, 'index 未引 planner.js');
  assert.match(CSS, /\.check\s*\{/, 'css 缺勾选样式');
});

test('自动成线流程：planStops 排序 → Selection.reorder 落库 → 切行程视图画线', () => {
  const m = APP.match(/async function onAutoPlan[\s\S]*?\n  \}/);
  assert.ok(m, '缺 onAutoPlan');
  assert.match(m[0], /Planner\.planStops\(/, '未用 planStops 排序');
  assert.match(m[0], /returnToStart: state\.autoReturn/, '未带「回到住宿」开关');
  assert.match(m[0], /Selection\.reorder\(/, '未把新顺序落库');
  assert.match(m[0], /setView\('itinerary'\)/, '未切到行程视图');
  assert.match(m[0], /直线里程/, '未回报直线里程');
  assert.match(APP, /autoBtn\.onclick = onAutoPlan/, '按钮未绑定');
  assert.match(APP, /state\.autoReturn = !!autoReturn\.checked/, '勾选未生效');
});

test('闭环回到住宿：行程视图画线时把住宿拼在最后一段（行程点序不重复）', () => {
  const m = APP.match(/function renderItinerary[\s\S]*?\n  \}/);
  assert.ok(m, '缺 renderItinerary');
  assert.match(
    m[0],
    /state\.autoReturn && start && list\.length \? list\.concat\(\[start\]\) : list/,
    '未按开关拼闭环段'
  );
  assert.match(APP, /function baseForPlan/, '缺 baseForPlan');
  assert.match(APP, /b\.city !== state\.city\) return null/, '跨城市的锚点不该当起点');
});

test('Selection.reorder：乐观更新 + 落库 + 失败回滚', () => {
  const m = SEL.match(/async function reorder[\s\S]*?\n  \}/);
  assert.ok(m, '缺 Selection.reorder');
  assert.match(m[0], /API\.reorderSelection\(/, '未调用 reorderSelection');
  assert.match(m[0], /pins = backup;/, '失败未回滚');
  assert.match(m[0], /notify\(\);/, '未通知订阅者');
  assert.match(SEL, /\n    reorder,/, 'reorder 未导出');
});
