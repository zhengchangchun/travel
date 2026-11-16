/* 右栏「加地点」：在右栏打字按名字找地点，回车加进「我的选择」，
   接下来的路就是既有那条 —— 规划行程 → 分享（用户 2026-11-16
   「右边的话 可以添加地点 规划路线 进行分享」）。
   覆盖两层：① placebox.js 纯逻辑真跑（建议项/上下键/回车选谁）② 前端结构（挂在 #add-combo 上、走同一套搜索接口） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const PLACEBOX = read('web/js/placebox.js');

// 在假 window 里跑 placebox.js（它只挂 window.TravelPlaceBox，加载期不碰 DOM）
function loadPlaceBox(cats) {
  const win = {};
  const fn = new Function('window', PLACEBOX);
  fn(Object.assign(win, cats ? { TravelCategories: cats } : {}));
  return win.TravelPlaceBox;
}

const CATS = {
  labelOf: (k) => ({ food: '美食', stay: '住宿', sight: '景点', play: '游玩' }[k] || k),
};

test('placebox.buildOptions：去重、限条数，副标题带分类/评分/地址，已选的标出来', () => {
  const P = loadPlaceBox(CATS);
  const results = [
    { id: 'A1', name: '西湖风景名胜区', category: 'sight', rating: '4.9', address: '龙井路 1 号' },
    { id: 'A1', name: '西湖风景名胜区', category: 'sight', rating: '4.9', address: '龙井路 1 号' }, // 重复
    { id: 'A2', name: '楼外楼', category: 'food', rating: '4.5', cost: '120.00', address: '' },
    { poi_id: 'A3', name: '之江实验室', category: 'sight', rating: '', address: '三泰路' },
    { name: '', category: 'food' },
    null,
  ];
  const opts = P.buildOptions(results, { isSelected: (p) => p.id === 'A2' });
  assert.deepStrictEqual(opts.map((o) => o.key), ['A1', 'A2', 'A3'], '去重 + 丢掉没名字的');
  assert.strictEqual(opts[0].name, '西湖风景名胜区');
  assert.match(opts[0].sub, /景点/);
  assert.match(opts[0].sub, /★ 4\.9/);
  assert.match(opts[0].sub, /龙井路 1 号/);
  assert.strictEqual(opts[1].selected, true, '已在选择里的要标出来');
  assert.strictEqual(opts[0].selected, false);
  assert.deepStrictEqual(P.buildOptions(results, { limit: 1 }).map((o) => o.key), ['A1'], '条数上限生效');
  assert.deepStrictEqual(P.buildOptions(null), [], '没有结果不炸');
});

test('placebox：上下键首尾循环；回车没高亮就用第一条', () => {
  const P = loadPlaceBox(CATS);
  assert.strictEqual(P.moveActive(-1, 1, 3), 0, '没高亮时按下 ⇒ 第一条');
  assert.strictEqual(P.moveActive(2, 1, 3), 0, '末条再下 ⇒ 回到第一条');
  assert.strictEqual(P.moveActive(0, -1, 3), 2, '第一条再上 ⇒ 末条');
  assert.strictEqual(P.moveActive(0, 1, 0), -1, '没选项时给 -1');
  assert.strictEqual(P.pickIndex([{ key: 'a' }], -1), 0, '回车用第一条');
  assert.strictEqual(P.pickIndex([{ key: 'a' }, { key: 'b' }], 1), 1, '有高亮就用高亮');
  assert.strictEqual(P.pickIndex([], 0), -1, '空列表回车无事可做');
});

test('placebox：状态行与空态都说人话（含「回车加入」）', () => {
  const P = loadPlaceBox(CATS);
  assert.match(P.statusText(3, '西湖'), /找到 3 个地点/);
  assert.match(P.statusText(3, '西湖'), /回车加入/);
  assert.match(P.emptyText('zzz'), /没找到「zzz」/);
  assert.match(P.emptyText(''), /输入地点名/);
});

test('index.html：加地点输入框挂在右栏「我的选择」里，且 placebox.js 先于 app.js', () => {
  assert.match(HTML, /data-card="search"/, '左栏的「搜索地点」还在（两处分工不同）');
  const pin = HTML.match(/<section class="card pin-card">[\s\S]*?<\/section>/)[0];
  assert.match(pin, /id="add-combo"/, '加地点下拉要挂在右栏「我的选择」卡里');
  assert.match(pin, /id="add-input"/, '缺加地点输入框');
  assert.match(pin, /role="combobox"[\s\S]{0,80}aria-controls="add-results"/, '输入框要按 combobox 语义连上下拉');
  assert.match(pin, /id="add-results"[\s\S]{0,60}role="listbox"/, '下拉缺 listbox 角色');
  const iPlace = HTML.indexOf('/js/placebox.js');
  const iApp = HTML.indexOf('/js/app.js');
  assert.ok(iPlace > 0 && iPlace < iApp, 'placebox.js 必须在 app.js 之前加载');
});

test('app.js：打字出建议（同一套搜索接口）→ 回车/点一下加进「我的选择」', () => {
  const fn = APP.match(/async function runAddSearch\(q\)[\s\S]*?\n  \}/)[0];
  assert.match(fn, /API\.searchPoi\(\{ city: state\.city, keywords: q \}\)/, '加地点要走同一套搜索（含本地/OSM 兜底）');
  assert.match(fn, /TravelPlaceBox|PlaceBox\.buildOptions/, '缺纯逻辑模块的接线');
  assert.match(fn, /seq !== addSeq \|\| !input \|\| input\.value\.trim\(\) !== q/, '缺过期响应守卫');

  const add = APP.match(/async function addPlaceToSelection\(opt\)[\s\S]*?\n  \}/)[0];
  assert.match(add, /Selection\.select\(poi\)/, '加入要走 Selection.select（幂等加）');
  assert.match(add, /await reloadSelection\(\)/, '加完要同步右栏清单');
  assert.match(add, /规划行程 → 分享/, '加完要告诉用户下一步在哪');
  assert.ok(!/Selection\.toggle/.test(add), '加地点不该把已在选择里的点「点掉」');

  // 交互接线：input / keydown / focus / blur / 点外面收起
  assert.match(APP, /addInput\.addEventListener\('input'/, '输入框没接 input');
  assert.match(APP, /addInput\.addEventListener\('keydown', onAddKey\)/, '输入框没接键盘');
  assert.match(APP, /addListOpen\(\) && addCombo && !addCombo\.contains\(e\.target\)\) closeAddList\(\)/, '点外面没收起加地点下拉');
  assert.match(APP, /addInput\.addEventListener\('blur'/, '失焦没收起下拉');
  const key = APP.match(/async function onAddKey\(e\)[\s\S]*?\n  \}/)[0];
  assert.match(key, /ArrowDown/, '缺上下键');
  assert.match(key, /Escape/, '缺 Esc');
  assert.match(key, /addPlaceToSelection\(/, '回车要真的加入');
});

test('样式：加地点复用城市下拉那套（.combo / .combo-list / .city-item）', () => {
  ['\\.combo\\s*\\{', '\\.combo-input', '\\.combo-list', '\\.combo-head', '\\.city-item'].forEach((re) => {
    assert.match(CSS, new RegExp(re), '缺样式 ' + re);
  });
  assert.match(CSS, /@media \(max-width: 1100px\)[\s\S]{0,200}\.combo-list\s*\{\s*position:\s*static/, '窄屏下拉要在流内（浮层会被侧栏剪掉）');
});
