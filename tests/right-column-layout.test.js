/* 右栏排版（2026-11-17）：把「点完看不见 / 两层滚动条 / 上下两个出行方式」这类排版坑钉住
   实测来源：每条现在带地址+备注+逐段耗时，220px 的 #selection-list 只能露出 1 行半，还会把行从中间切断；
   行程视图里 #quick-legs 与 #route-modes 是同一件事的两套选择器。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('web/css/style.css');
const HTML = read('web/index.html');
const APP = read('web/js/app.js');
const ROUTE = read('web/js/route.js');

test('#selection-list 不再卡内层高度/内层滚动条（右栏自己滚）', () => {
  const rules = CSS.match(/[^{}]*#selection-list[^{}]*\{[^}]*\}/g) || [];
  assert.equal(rules.length, 0, '#selection-list 不该再有自己的 max-height/overflow 规则：' + rules.join(' '));
  assert.ok(!/max-height:\s*220px/.test(CSS), '旧的 220px 卡口必须删掉');
});

test('行程视图里不再重复一套出行方式（quick-legs 只在挑点阶段出现）', () => {
  const fn = APP.match(/function renderQuickLegs\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 renderQuickLegs');
  assert.match(fn[0], /state\.view !== 'itinerary'/, '行程视图要藏掉实时耗时条');
  assert.match(fn[0], /pins\.length >= 2/, '两个点以上才显示');
  // 行程视图自己那套选择器还在（route.js 往 #route-modes 里画芯片）
  assert.match(HTML, /id="route-modes"/, '行程视图得有 route-modes');
  assert.match(ROUTE, /\$\('route-modes'\)/, 'route.js 要把出行方式芯片画进 #route-modes');
});

test('路线总览里不再手写一行「出行方式：…」（上面那排芯片就是它）', () => {
  assert.ok(!/route-mode-line/.test(ROUTE), 'route.js 不该再渲染 route-mode-line');
  assert.ok(!/出行方式：/.test(ROUTE), '别再把出行方式写成一整行文字');
  assert.ok(!/route-mode-line/.test(CSS), '死样式要一起删干净');
  // 里程/耗时还在
  assert.match(ROUTE, /总里程/);
  assert.match(ROUTE, /总耗时/);
});

test('行程备注看着像个输入框：有「备注」标签 + 自己的一行', () => {
  assert.match(HTML, /class="trip-note-row"/, '缺备注那一行');
  assert.match(HTML, /class="trip-note-label">备注</, '缺「备注」标签（深色底上一行光秃秃的字看不出能编辑）');
  assert.match(CSS, /\.trip-note-row\s*\{[^}]*display:\s*flex/, '备注行要 flex 排');
  assert.match(CSS, /\.trip-note-label\s*\{/, '缺标签样式');
  assert.match(CSS, /\.trip-note-input\s*\{[^}]*flex:\s*1/, '输入框要自己撑满剩下宽度');
});

test('行内间距与按钮尺寸统一（地址/评分 4px，操作行 8px，↑↓ 不缩成小方块）', () => {
  assert.match(CSS, /\.poi-addr \{[^}]*margin-top:\s*4px/, '地址行距要 4px');
  assert.match(CSS, /\.poi-meta \{[^}]*margin-top:\s*4px/, '评分行距也要 4px');
  assert.match(CSS, /\.sel-item \.sel-actions \{[^}]*margin-top:\s*8px/, '操作行距 8px');
  assert.match(CSS, /\.sel-item \.sel-actions \.up,[^}]*min-width:\s*28px/, '挑点列表的 ↑↓ 要有最小宽度');
  assert.match(CSS, /\.itin-btns button \{[^}]*min-width:\s*24px/, '行程视图的 ↑↓ 也要够大');
});
