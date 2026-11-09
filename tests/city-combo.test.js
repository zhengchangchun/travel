/* P10：城市「输入框 + 下拉建议」合成一个控件（用户 2026-11-08：「城市那个输入框和下拉框现在一般都合成一个」）。
   覆盖三层：① citybox.js 纯逻辑真跑（建议项/上下键/回车选谁）② 前端与样式结构 ③ /api/city/search 契约。
   结构断言的用意：下拉必须挂在输入框上（#city-combo），不能再有独立的「搜索」按钮 + 另一块结果列表。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const CITYBOX = read('web/js/citybox.js');

// 在假 window 里跑 citybox.js（它只挂 window.TravelCityBox，加载期不碰 DOM）
function loadCityBox() {
  const win = {};
  const fn = new Function('window', CITYBOX);
  fn(win);
  return win.TravelCityBox;
}

// ---------- ① 纯逻辑 ----------

test('citybox：高德结果 → 下拉项（去重、带坐标、带副标题）', () => {
  const Box = loadCityBox();
  const opts = Box.buildOptions('杭州', [
    { name: '杭州市', lng: 120.209903, lat: 30.246566, adcode: '330100', citycode: '0571' },
    { name: '杭州市', lng: 1, lat: 2 }, // 重复项丢
    { name: '' }, // 脏数据丢
  ]);
  assert.strictEqual(opts.length, 1, '同一城市名只留一条');
  assert.strictEqual(opts[0].name, '杭州市');
  assert.strictEqual(opts[0].city.name, '杭州', '切城市的键要去掉尾字「市」（否则本地已收录的点看不见）');
  assert.strictEqual(opts[0].city.display, '杭州市', '显示名保留高德的写法');
  assert.strictEqual(opts[0].raw, false);
  assert.strictEqual(opts[0].city.lng, 120.209903);
  assert.strictEqual(opts[0].city.lat, 30.246566);
  assert.strictEqual(opts[0].city.adcode, '330100');
  assert.match(opts[0].sub, /主城区/, '要告诉用户点了会跳到哪');

  assert.deepStrictEqual(Box.buildOptions('', [{ name: '杭州市' }]), [], '空查询不出建议');
  assert.deepStrictEqual(Box.buildOptions('杭州', null), [], '结果不是数组时当空处理');
  assert.strictEqual(Box.cityKey('杭州市'), '杭州');
  assert.strictEqual(Box.cityKey('阿克苏地区'), '阿克苏地区', '只去尾字「市」，别的后缀不动');
  assert.strictEqual(Box.cityKey(' 辽阳 '), '辽阳');
});

test('citybox：搜索失败只给一条「只切名字」兜底，坐标为空', () => {
  const Box = loadCityBox();
  const raw = Box.rawOption('辽阳', '高德额度用完了');
  assert.ok(raw, '失败时要给兜底项，别把用户卡死');
  assert.strictEqual(raw.raw, true);
  assert.strictEqual(raw.name, '辽阳');
  assert.strictEqual(raw.city.lng, null);
  assert.strictEqual(raw.city.lat, null);
  assert.match(raw.sub, /只切名字、地图不动/, '要说清代价');
  assert.match(raw.sub, /高德额度用完了/, '要带上原因');
  assert.strictEqual(Box.rawOption('  '), null, '空查询没有兜底项');
});

test('citybox：↑↓ 首尾循环，回车选高亮/名字对齐/第一条', () => {
  const Box = loadCityBox();
  assert.strictEqual(Box.moveActive(-1, 1, 3), 0, '↓ 从无高亮开始 ⇒ 第一条');
  assert.strictEqual(Box.moveActive(-1, -1, 3), 2, '↑ 从无高亮开始 ⇒ 最后一条');
  assert.strictEqual(Box.moveActive(2, 1, 3), 0, '↓ 到底回头');
  assert.strictEqual(Box.moveActive(0, -1, 3), 2, '↑ 到头绕尾');
  assert.strictEqual(Box.moveActive(0, 1, 0), -1, '空列表没有高亮');

  const opts = [
    { name: '杭州', raw: false },
    { name: '杭州市', raw: false },
    { name: '杭州东站', raw: false },
  ];
  assert.strictEqual(Box.pickIndex(opts, '杭州', 2), 2, '高亮优先');
  assert.strictEqual(Box.pickIndex(opts, '杭州', -1), 0, '名字对齐优先于「第一条」');
  assert.strictEqual(Box.pickIndex(opts, '杭州市', -1), 0, '「杭州」≈「杭州市」都算对齐，取先命中的');
  assert.strictEqual(Box.pickIndex([{ name: '杭州市' }, { name: '苏州' }], '苏州', -1), 1, '对齐项在后面也能选中');
  assert.strictEqual(Box.pickIndex(opts, '苏州', -1), 0, '都不对齐时用第一条');
  assert.strictEqual(Box.pickIndex([], '杭州', -1), -1, '没有建议就没有可选项');
});

test('citybox：下拉顶部说明与空态都是人话', () => {
  const Box = loadCityBox();
  assert.match(Box.statusText(3, '杭州'), /找到 3 个城市/);
  assert.match(Box.statusText(3, '杭州'), /回车确认/);
  assert.strictEqual(Box.statusText(0, '杭州'), '');
  assert.match(Box.emptyText('杭洲'), /没找到城市「杭洲」/);
  assert.match(Box.emptyText('杭洲'), /换个写法/);
});

// ---------- ② 结构（HTML / app.js / CSS） ----------

test('结构：一个控件 —— 下拉挂在输入框上，且不再有独立的搜索按钮', () => {
  assert.match(HTML, /id="city-combo"/, '缺输入框 + 下拉的容器 #city-combo');
  const comboBlock = HTML.match(/<div id="city-combo"[\s\S]*?<\/div>\s*<p class="hint">/);
  assert.ok(comboBlock, '#city-combo 结构不符合预期');
  assert.match(comboBlock[0], /<input id="city-input"[^>]*role="combobox"/, '输入框要是 combobox');
  assert.match(comboBlock[0], /aria-expanded="false"/, '下拉初始是收起的（aria）');
  assert.match(comboBlock[0], /aria-controls="city-results"/, '输入框要指向自己的下拉');
  assert.match(comboBlock[0], /id="city-results" class="combo-list hidden"/, '下拉默认收起');
  assert.ok(!/city-search-btn/.test(HTML), '合成一个控件后不该再有单独的「搜索」按钮');
  assert.ok(!/id="city-results" class="result-list"/.test(HTML), '下拉不该再当独立结果列表');
  assert.match(HTML, /↑↓ 选、回车确认/, '要告诉用户能怎么操作');
});

test('结构：打字就查（防抖）+ 上下键/回车/Esc + 点外面收起', () => {
  assert.ok(!/function\s+doCitySearch/.test(APP), '旧的「点按钮才搜」入口应删掉');
  assert.match(APP, /const\s+CityBox\s*=\s*window\.TravelCityBox/, 'app.js 应使用 citybox 纯逻辑');
  assert.match(APP, /function\s+scheduleCitySearch/, '缺防抖入口');
  assert.match(APP, /addEventListener\('input',[\s\S]{0,60}scheduleCitySearch/, 'input 事件要触发搜索');
  assert.match(APP, /function\s+onCityKey/, '缺键盘处理');
  assert.match(APP, /e\.key === 'ArrowDown'/, '缺 ↓ 键');
  assert.match(APP, /e\.key === 'Escape'/, '缺 Esc 收起');
  assert.match(APP, /function\s+pickCity/, '缺选中的落点');
  assert.match(APP, /addEventListener\('click',[\s\S]{0,200}closeCityList\(\)/, '点外面应收起下拉');
  assert.match(APP, /addEventListener\('blur',[\s\S]{0,320}closeCityList\(\)/, 'Tab 走开也要收起下拉');
  assert.match(APP, /function\s+closeCityList[\s\S]{0,300}citySeq\s*\+=\s*1/, '收起时要把在飞的搜索作废（否则下拉会又被弹开）');
  assert.match(APP, /setAttribute\('tabindex', '-1'\)/, '下拉项不进 Tab 序列（Tab 要能走出去）');
  assert.match(APP, /citySeq/, '快打字时要有「只认最后一次响应」的守卫');
  assert.match(APP, /setAttribute\('aria-expanded'/, '下拉开合要同步 aria-expanded');
});

test('结构：下拉是浮层、贴在输入框下方，样式不再走 .result-list', () => {
  const block = CSS.match(/\.combo-list\s*\{[\s\S]*?\n\}/);
  assert.ok(block, '缺 .combo-list 样式');
  assert.match(block[0], /position:\s*absolute/);
  assert.match(block[0], /overflow-y:\s*auto/, '城市多时下拉要能滚');
  assert.match(block[0], /max-height:/, '要有高度上限，别把侧栏顶穿');
  assert.match(CSS, /\.combo-list\s+\.city-item\.active/, '高亮项要有自己的样式');
  assert.match(
    CSS,
    /@media \(max-width: 1100px\)[\s\S]*?\.combo-list\s*\{\s*position:\s*static/,
    '窄屏侧栏是限高滚动容器，浮层会被剪掉 ⇒ 下拉要在流内展开'
  );
});

test('结构：窄屏（≤1100px）城市卡默认展开，否则输入框藏在折叠里', () => {
  assert.match(APP, /function\s+narrowScreen/, '缺窄屏判定');
  assert.match(APP, /window\.innerWidth\s*<=\s*1100/, '窄屏口径要与 CSS 的 1100px 断点一致');
  const fn = APP.match(/function\s+cardExpanded[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 cardExpanded');
  assert.match(fn[0], /name === 'city'[\s\S]{0,40}narrowScreen\(\)/, '城市卡在窄屏要默认展开');
});

// ---------- ③ 服务端契约（下拉依赖 /api/city/search 给不带「市」的可用项） ----------

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};

async function start(amap) {
  const app = createApp({
    config: TEST_CONFIG,
    categories: [{ key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35' }],
    db: createDb(':memory:'),
    amap,
    collectIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base };
}

test('/api/city/search：带上坐标（下拉项靠它跳主城区）+ 缺 q 明确报错', async () => {
  let seen = null;
  const amap = {
    async searchCity(q) {
      seen = q;
      return [{ name: '杭州市', adcode: '330100', citycode: '0571', lng: 120.2, lat: 30.24 }];
    },
  };
  const { app, base } = await start(amap);
  try {
    const res = await fetch(`${base}/api/city/search?q=%20%E6%9D%AD%E5%B7%9E%20`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(seen, '杭州', '前后空格要去掉再查');
    assert.strictEqual(body.data[0].lng, 120.2, '下拉项需要 lng/lat 才能跳地图');
    assert.strictEqual(body.data[0].lat, 30.24);

    const bad = await fetch(`${base}/api/city/search?q=`);
    assert.strictEqual(bad.status, 400, '空查询应 400，不该静默返回空数组');
    const badBody = await bad.json();
    assert.strictEqual(badBody.error.code, 'BAD_REQUEST');
  } finally {
    app.server.close();
  }
});
