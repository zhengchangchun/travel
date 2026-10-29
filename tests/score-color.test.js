const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'web', 'js', 'score-color.js'), 'utf8');

function load() {
  const win = {
    TravelCategories: { colorOf: () => '#FF6B35' },
  };
  const fn = new Function('window', CODE);
  fn(win);
  return win.TravelScoreColor;
}

function lightness(hsl) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/.exec(hsl);
  assert.ok(m, '应为 hsl 字符串: ' + hsl);
  return Number(m[3]);
}

function hue(hsl) {
  const m = /hsl\(\s*([\d.]+)\s*,/.exec(hsl);
  return Number(m[1]);
}

test('色阶常量：TOP_RATING 默认 5.0，明度区间 72%→34%', () => {
  const SC = load();
  assert.strictEqual(SC.TOP_RATING, 5.0);
  assert.strictEqual(SC.LIGHT, 72);
  assert.strictEqual(SC.DARK, 34);
});

test('无评分 → 最浅（72%）', () => {
  const SC = load();
  assert.strictEqual(lightness(SC.colorFor('food', null)), 72);
  assert.strictEqual(lightness(SC.colorFor('food', '')), 72);
});

test('评分由浅入深：3.0(72) > 4.0(53) > 5.0(34)', () => {
  const SC = load();
  const l3 = lightness(SC.colorFor('food', '3.0'));
  const l4 = lightness(SC.colorFor('food', '4.0'));
  const l5 = lightness(SC.colorFor('food', '5.0'));
  assert.strictEqual(l3, 72);
  assert.strictEqual(l5, 34);
  assert.ok(l3 > l4 && l4 > l5, `应递减: ${l3} > ${l4} > ${l5}`);
});

test('色相保持分类色相不变（美食橙）', () => {
  const SC = load();
  const base = SC.hexToHsl('#FF6B35');
  assert.ok(Math.abs(hue(SC.colorFor('food', '3.0')) - base.h) < 0.5);
  assert.ok(Math.abs(hue(SC.colorFor('food', '5.0')) - base.h) < 0.5);
});

test('isTop 阈值：5.0 为满分，4.9 不是', () => {
  const SC = load();
  assert.strictEqual(SC.isTop('5.0'), true);
  assert.strictEqual(SC.isTop(5), true);
  assert.strictEqual(SC.isTop('4.9'), false);
  assert.strictEqual(SC.isTop('4.99'), false);
  assert.strictEqual(SC.isTop(null), false);
  assert.strictEqual(SC.isTop(''), false);
});
