const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'css', 'style.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
const MAP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'map.js'), 'utf8');

const LEFT_MARK = 'id="sidebar"';
const MAP_MARK = 'id="map-wrap"';
const RIGHT_MARK = 'id="right-panel"';

function slice() {
  const l = HTML.indexOf(LEFT_MARK);
  const m = HTML.indexOf(MAP_MARK);
  const r = HTML.indexOf(RIGHT_MARK);
  return { l, m, r, left: HTML.slice(l, m), map: HTML.slice(m, r), right: HTML.slice(r) };
}

// 「我挑的」相关元素：全部只应出现在右栏
const PIN_IDS = [
  'selection-count',
  'only-selected-btn',
  'plan-btn',
  'selection-list',
  'itinerary-panel',
  'itinerary-list',
  'route-modes',
  'route-totals',
  'route-legs',
];

test('三栏骨架：左「全部」／中 地图／右「我挑的」，顺序正确', () => {
  const { l, m, r } = slice();
  assert.ok(l >= 0, '缺左栏 #sidebar');
  assert.ok(m > l, '缺中栏 #map-wrap（应在左栏之后）');
  assert.ok(r > m, '缺右栏 #right-panel（应在中栏之后）');
});

test('右栏包含全部「我挑的」元素', () => {
  const { right } = slice();
  PIN_IDS.forEach((id) => {
    assert.ok(right.includes(id), '右栏缺少 ' + id);
  });
});

test('左栏不含任何「我挑的」元素（无残留）', () => {
  const { left } = slice();
  PIN_IDS.forEach((id) => {
    assert.ok(!left.includes(id), '左栏残留 ' + id);
  });
});

test('右栏可折叠：存在折叠按钮与折叠样式', () => {
  assert.ok(HTML.includes('panel-toggle'), 'index 缺折叠按钮');
  assert.match(CSS, /\.collapsed/, 'CSS 缺折叠样式');
  assert.match(CSS, /1100px/, 'CSS 缺窄屏断点 1100px');
});

test('左右两栏各自独立滚动', () => {
  assert.match(CSS, /#sidebar[^}]*overflow-y\s*:\s*auto/s, '左栏应 overflow-y:auto');
  assert.match(CSS, /right-body[^}]*overflow-y\s*:\s*auto/s, '右栏内容应 overflow-y:auto');
});

test('地图自适应：map.js 暴露 resize，app.js 折叠后调用 resize', () => {
  assert.match(MAP, /resize/, 'map.js 缺 resize');
  assert.match(APP, /collapsed/, 'app.js 未处理折叠');
  assert.match(APP, /resize/, 'app.js 折叠后未调 resize');
});
