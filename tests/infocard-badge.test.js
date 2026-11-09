/* 信息卡图集的「来源」徽标（用户 2026-11-09 截图里那个黑色色块）：
   它是 .badge-comment —— 基础规则写了 top:8px，信息卡里又要 bottom:8px，两个都生效 ⇒
   高度被拉满、变成一整块半透明黑色。这里钉住「只允许一个竖向定位」。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('web/css/style.css');
const DETAIL = read('web/js/detail.js');

function ruleBody(selector) {
  const i = CSS.indexOf(selector + ' {');
  if (i < 0) return '';
  const start = CSS.indexOf('{', i) + 1;
  const end = CSS.indexOf('}', start);
  return CSS.slice(start, end);
}

test('来源徽标只给一个竖向定位：top 与 bottom 不许同时生效', () => {
  const base = ruleBody('.badge-comment');
  const card = ruleBody('.infocard .badge-comment');
  assert.ok(base, '缺 .badge-comment 基础规则');
  assert.ok(card, '缺 .infocard .badge-comment 规则');
  const baseHasTop = /(^|[^-\w])top\s*:/.test(base);
  const cardHasBottom = /(^|[^-\w])bottom\s*:/.test(card);
  assert.ok(!(baseHasTop && !/(^|[^-\w])top\s*:\s*auto/.test(card) && cardHasBottom),
    '信息卡里同时有 top 和 bottom ⇒ 徽标会被拉成一整块黑，信息卡规则必须写 top: auto');
});

test('来源徽标文案仍然是「来源标签 · 来源：平台」', () => {
  assert.match(DETAIL, /class="badge-comment">' \+ esc\(ps\.label\) \+ ' · 来源：' \+ esc\(ps\.source\)/,
    '徽标文案被改动了');
});
