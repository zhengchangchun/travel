const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Diff = require('../web/js/diffplan');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MAP = read('web/js/map.js');
const UI = read('web/js/ui.js');
const APP = read('web/js/app.js');
const HTML = read('web/index.html');

test('planDiff：保留/新增/移除三分，且顺序＝新列表顺序', () => {
  const d = Diff.planDiff(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(d.order, ['b', 'c', 'd']);
  assert.deepEqual(d.keep, ['b', 'c']);
  assert.deepEqual(d.add, ['d']);
  assert.deepEqual(d.remove, ['a']);
});

test('planDiff：完全相同 ⇒ 无增无删（这就是「不重画」的判据）', () => {
  const keys = ['a', 'b', 'c'];
  const d = Diff.planDiff(keys, keys);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
  assert.deepEqual(d.keep, keys);
});

test('planDiff：空→有 / 有→空 / 重复键只渲染一次', () => {
  assert.deepEqual(Diff.planDiff([], ['a']).add, ['a']);
  const gone = Diff.planDiff(['a', 'b'], []);
  assert.deepEqual(gone.remove, ['a', 'b']);
  assert.deepEqual(gone.order, []);
  const dup = Diff.planDiff([], ['a', 'a', 'b']);
  assert.deepEqual(dup.order, ['a', 'b']);
  assert.deepEqual(Diff.planDiff(null, null).order, []);
});

test('signatureOf：内容没变 ⇒ 签名一致；任一字段变 ⇒ 签名变', () => {
  const base = ['店名', '地址', 'food', '4.6', '88', false, false];
  assert.equal(Diff.signatureOf(base), Diff.signatureOf(base.slice()));
  assert.notEqual(Diff.signatureOf(base), Diff.signatureOf(['店名', '地址', 'food', '4.6', '88', true, false]));
  assert.equal(Diff.signatureOf([null, undefined]), Diff.signatureOf(['', '']));
});

test('地图旗子走增量：syncMarkers 保留不动的，只补/删变化的那部分', () => {
  const m = MAP.match(/function\s+syncMarkers[\s\S]*?\n  \}/);
  assert.ok(m, 'map.js 缺 syncMarkers');
  assert.match(m[0], /markers\.delete\(k\)/, '未删除消失的旗子');
  assert.match(m[0], /map\.remove\(/, '未从地图移除');
  assert.match(m[0], /if \(!markers\.has\(k\)\)/, '已有的旗子应跳过（不重画）');
  assert.match(m[0], /addChunk\(/, '新增走批量 addChunk');
  assert.ok(!/clearMarkers\(\)/.test(m[0]), 'syncMarkers 不应整屏清空');
  assert.match(MAP, /\n    syncMarkers,/, 'syncMarkers 未导出');
  assert.match(APP, /MapCtl\.syncMarkers\(/, 'renderMap 未走增量');
});

test('结果列表走增量：键 + 签名复用节点，不再整屏 innerHTML 清空', () => {
  assert.match(HTML, /<script src="\/js\/diffplan\.js"><\/script>/, 'index 未引 diffplan.js');
  const m = UI.match(/function\s+renderResults[\s\S]*?\n  \}/);
  assert.ok(m, '缺 renderResults');
  assert.match(m[0], /TravelDiff/, '未用 TravelDiff');
  assert.match(m[0], /replaceChildren/, '未用 replaceChildren 一次性换序');
  assert.match(m[0], /hit\.sig === sig/, '未按签名复用节点');
  assert.match(m[0], /li\.dataset\.key/, '节点未记 key');
  assert.match(m[0], /buildItem\(/, '缺单条渲染函数');
  assert.ok(!/container\.innerHTML = '';\s*\n\s*pois\.forEach/.test(m[0]), '不应再整屏清空重建');
});
