/* 规划页「显示 / 隐藏」按使用流程与操作频率来定（2026-11-24 用户：
   「按照使用流程 每个的操作频率 合理修改显示和隐藏」）。

   规矩（改的时候要连着这里一起改）：
     高频 常显：搜索、筛选·结果（挑点）、我的选择（排行程）
     中频 常显但排后：住宿锚点（有锚点才展开）
     低频 默认收起：城市（每趟设一次；窄屏另说）、笔记→找地方、我的行程（建趟/切趟/分享各一次）
   另外：改了默认值就必须升 CARDS_KEY，否则浏览器里存过的旧折叠状态会把新默认盖住。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('web/index.html');
const APP = read('web/js/app.js');

test('默认显隐按频率定：低频的收起，高频的展开', () => {
  const fn = APP.slice(APP.indexOf('function cardExpanded('), APP.indexOf('function cardSections('));
  assert.ok(fn, '找不到 cardExpanded');
  assert.match(fn, /name === 'trip'\) return false;/, '我的行程（低频）应默认收起');
  assert.match(fn, /name === 'note'\) return false;/, '笔记卡（低频）应默认收起');
  assert.match(fn, /name === 'city'\) return narrowScreen\(\)/, '城市卡：窄屏展开（入口要看得见）');
  assert.match(fn, /name === 'base'\) return state\.bases\.length > 0/, '住宿锚点：设过才展开');
  assert.match(fn, /return true; \/\/ search \/ filter/, '搜索与筛选·结果（高频）保持展开');
});

test('我的行程卡：可折叠 + 标题条给摘要（趟名 · 几个点）', () => {
  assert.match(HTML, /class="card trip-card" data-card="trip"/, '我的行程卡要能折叠（data-card 钩子）');
  const start = HTML.indexOf('data-card="trip"');
  const end = HTML.indexOf('</section>', start);
  const block = HTML.slice(start, end);
  assert.match(block, /<h2 class="card-bar">我的行程 /, '标题条要挂上 card-bar（点它折叠）');
  assert.match(block, /id="trip-name"/, '摘要里要有当前趟名');
  assert.match(block, /id="trip-count"/, '摘要里要有这一趟几个点');
  assert.match(block, /<div class="card-body">/, '内容要包在 card-body 里（收起时整块隐藏）');
  // 低频动作都在 card-body 里：收起时不该露出「分享」这种收尾才用的按钮
  const bodyAt = block.indexOf('<div class="card-body">');
  ['id="trip-share-btn"', 'id="trip-new-btn"', 'id="trip-delete-btn"', 'id="trip-list"'].forEach((id) => {
    assert.ok(block.indexOf(id) > bodyAt, id + ' 应该在 card-body 里（低频动作收起时不占地方）');
  });
  assert.match(APP, /tripCount\) tripCount\.textContent = String\(pins\.length\)/, 'JS 要把点数写进摘要');
});

test('右栏按流程排：住宿锚点 → 笔记找地方 → 我的行程', () => {
  const right = HTML.slice(HTML.indexOf('id="right-panel"'));
  const atBase = right.indexOf('data-card="base"');
  const atNote = right.indexOf('data-card="note"');
  const atTrip = right.indexOf('data-card="trip"');
  assert.ok(atBase >= 0 && atNote > atBase && atTrip > atNote, '顺序应是 base → note → trip');
  assert.ok(!HTML.slice(0, HTML.indexOf('id="map-wrap"')).includes('data-card="trip"'), '我的行程卡在右栏，不在左栏');
});

test('改了默认值就升状态键，否则旧状态把新默认盖住', () => {
  assert.match(APP, /const CARDS_KEY = 'travel\.cards\.v2'/, 'CARDS_KEY 应已升到 v2');
  assert.match(APP, /localStorage\.getItem\(CARDS_KEY\)/, '读的还是这个键');
  assert.match(APP, /localStorage\.setItem\(CARDS_KEY/, '写的也是这个键');
});
