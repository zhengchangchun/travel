/* P9 体验修复（用户 2026-11-06 的 UX 审计 → P0/P1）：
   ① 首屏空态只留一处引导 + 一个能点的动作
   ② 报错过一层人话（不再把 USER_DAILY_QUERY_OVER_LIMIT 这种裸码甩给用户）
   ③ 落旗有上限（点「美食」5000 面旗把地图埋掉）
   ④ 信息卡更好关（× 好点 + 告诉用户 Esc / 点空白也能关）
   ⑤ 右栏「我的选择」与「我的行程」不再撞脸
   ⑥ 「搜索地点」高德不可用时回退本地已收录
   ⑦ 0 个点时「规划行程」置灰
   ⑧ 次要文字对比度（--ink-3 提亮）
   纯结构约束 + 少量可跑的行为（错误人话化、空态 CTA、落旗上限、服务端回退）。 */
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
const MAP = read('web/js/map.js');
const UI = read('web/js/ui.js');
const DETAIL = read('web/js/detail.js');
const NOTES = read('web/js/notes.js');
const ERRORS = read('web/js/errors.js');

// 在假 window 里跑一个前端模块（这些模块都只挂 window.xxx，加载期不碰 DOM）
function loadUi(src, extra) {
  const win = {};
  const doc = {
    createElement() {
      return { className: '', textContent: '', title: '', style: {}, children: [], appendChild(c) {
        this.children.push(c);
      } };
    },
    getElementById: () => null,
  };
  const fn = new Function('window', 'document', src);
  fn(win, doc);
  return { win, doc, ...(extra || {}) };
}

function fakeBox() {
  return {
    children: [],
    innerHTML: '',
    replaceChildren() {
      this.children = [];
    },
    appendChild(c) {
      this.children.push(c);
    },
  };
}

// ---------- ② 错误人话化 ----------

test('errors.js：已知码给人话、认不出也不吞线索', () => {
  const { win } = loadUi(ERRORS);
  const E = win.TravelErrors;
  assert.ok(E && typeof E.humanize === 'function', '缺 TravelErrors.humanize');

  const quota = E.humanize({ code: 'AMAP_ERROR', message: 'USER_DAILY_QUERY_OVER_LIMIT' });
  assert.ok(quota.indexOf('USER_DAILY_QUERY_OVER_LIMIT') < 0, '不该把裸码给用户看');
  assert.match(quota, /额度用完/, '额度用尽要说人话');
  assert.match(quota, /本地已收录/, '要给出还能做什么');

  // 后端 live.errors 里只有高德原句（没有 code），也要认得出来
  assert.strictEqual(E.humanize('USER_DAILY_QUERY_OVER_LIMIT'), quota);

  assert.match(E.humanize({ code: 'NETWORK_ERROR' }), /连不上本机后端/);
  assert.match(E.humanize({ code: 'TIMEOUT' }), /抓取超时/);
  assert.match(E.humanize({ code: 'NEED_CAPTCHA' }), /验证码/);

  const unknown = E.humanize(new Error('SomethingWentWrong_42'));
  assert.match(unknown, /暂时没成功/, '认不出来也要说人话');
  assert.match(unknown, /SomethingWentWrong_42/, '原始串要留一截，方便排查');

  // 后端已经写好中文说明时别再包一层（否则「行程不存在」→「暂时没成功（行程不存在）」）
  assert.strictEqual(E.humanize(new Error('行程不存在')), '行程不存在');
  assert.strictEqual(E.humanize({ code: 'HTTP_ERROR', message: '行程里没有这个地点' }), '行程里没有这个地点');
  // 但裸码即使带 code 也要换成表里的话，不能被 looksHuman 放过
  assert.match(E.humanize({ code: 'HTTP_ERROR', message: 'INVALID_USER_KEY' }), /Key 无效/);
  assert.strictEqual(typeof E.looksHuman, 'function', 'looksHuman 要可测');
  assert.strictEqual(E.looksHuman('行程不存在'), true);
  assert.strictEqual(E.looksHuman('NETWORK_ERROR'), false);
});

test('app.js / notes.js / route.js：界面报错都走 human()，不再直吐 err.message', () => {
  assert.match(APP, /function\s+human\(err\)/, 'app.js 缺 human()');
  assert.match(NOTES, /function\s+human\(err\)/, 'notes.js 缺 human()');
  assert.match(read('web/js/route.js'), /function\s+human\(err\)/, 'route.js 缺 human()');
  // 全量扫描：任何面向用户的 err.message 拼接都不该再出现（只允许 human() 内部的兜底）
  const offenders = ['app.js', 'notes.js', 'route.js'].filter((f) => {
    const src = read('web/js/' + f);
    return /(setStatus|setHint|setProgress|showMapError|textContent)\s*\([^)]*\+\s*err\.message/.test(src);
  });
  assert.deepStrictEqual(offenders, [], '这些文件还在直吐 err.message：' + offenders.join('、'));
  assert.ok(!/'搜索失败：'\s*\+\s*err\.message/.test(APP), '搜索失败不该直吐 err.message');
  assert.ok(!/'实时搜索失败：'\s*\+\s*err\.message/.test(APP), '实时搜索失败不该直吐 err.message');
  const liveFn = APP.split('function reportLiveResult')[1] || '';
  const bareErrs = (liveFn.match(/errors\[0\]/g) || []).length;
  const humanErrs = (liveFn.match(/human\(errors\[0\]\)/g) || []).length;
  assert.strictEqual(bareErrs, humanErrs, 'live.errors 第一条必须全过 human()');
  assert.ok(!/setHint\('搜索失败：'\s*\+\s*err\.message/.test(NOTES), 'notes 搜索失败不该直吐 err.message');
  assert.ok(!/err\.message\s*\+\s*'（'\s*\+\s*\(?err\.code/.test(NOTES), 'notes 不该把 code 拼给用户看');
});

test('index.html：errors.js 在 app.js / notes.js 之前加载', () => {
  const at = (p) => HTML.indexOf(p);
  assert.ok(at('/js/errors.js') > 0, '没引 errors.js');
  assert.ok(at('/js/errors.js') < at('/js/app.js'), 'errors.js 应在 app.js 之前');
  assert.ok(at('/js/errors.js') < at('/js/notes.js'), 'errors.js 应在 notes.js 之前');
});

// ---------- ① 首屏空态：不唠叨（用户 2026-11-09 又收紧了：连「显示全部」那块引导也不要） ----------

test('ui.js：空态只在给了文案时写一句，不再有 CTA', () => {
  const { win, doc } = loadUi(UI);
  const box = fakeBox();
  win.TravelUI.renderResults(box, [], () => {}, { emptyText: '放大地图以加载本区域地点' });
  assert.strictEqual(box.children.length, 1, '空态一条');
  assert.match(box.children[0].textContent, /放大地图/, '文案照写');
  assert.strictEqual(box.children[0].children.length, 0, '不再挂 CTA 按钮');

  // 不给文案就什么都不渲染（未选分类时就该是空的）
  const box2 = fakeBox();
  win.TravelUI.renderResults(box2, [], () => {}, {});
  assert.strictEqual(box2.children.length, 0, '没文案就别占位置');
  assert.ok(!/emptyAction|empty-cta/.test(UI), 'ui.js 不该再留 CTA 那份代码');
  void doc;
});

test('app.js：未选分类时列表空着、状态栏闭嘴；只有「倍率不够」才说一句', () => {
  assert.ok(!/显示全部/.test(APP), '「显示全部」这个引导应彻底删掉');
  assert.ok(!/emptyAction/.test(APP), 'emptyAction 应不再传');
  assert.match(APP, /UI\.setStatus\(''\);/, '未选分类态状态栏应为空');
  assert.match(APP, /el\.textContent = '—'/, '未选分类态结果条应为占位符');
  assert.match(APP, /state\.zoomTooLow = true/, '倍率不够要单独标记（那时才说「放大」）');
  assert.match(APP, /\? '放大地图以加载本区域地点'/, '倍率不够时空态只说这一句');
});

test('CSS：空态 CTA 的样式一并清掉', () => {
  assert.ok(!/\.empty-cta/.test(CSS), 'CSS 不该再留 .empty-cta');
});

// ---------- ③ 落旗上限 ----------

test('map.js：落旗有上限，超出时保留已选中/住宿锚点并回报 dropped', () => {
  assert.match(MAP, /const MARKER_LIMIT\s*=\s*\d+/, '缺落旗上限常量');
  const { win } = loadUi(MAP);
  const MapCtl = win.TravelMap;
  assert.strictEqual(typeof MapCtl.markerLimit, 'function', 'markerLimit 未导出');
  const limit = MapCtl.markerLimit();
  assert.ok(limit > 100 && limit <= 2000, '上限要在「看得清」的量级，实际 ' + limit);
  assert.strictEqual(typeof MapCtl.capMarkers, 'function', 'capMarkers 未导出（上限逻辑要可测）');

  const total = limit + 700;
  const list = [];
  for (let i = 0; i < total; i += 1) {
    list.push({ id: 'p' + i, lng: 120 + i / 10000, lat: 30 + i / 10000 });
  }
  // 未选中的普通点在很后面：必须仍然能被保进来
  const picked = list[total - 1];
  MapCtl.setBase('p0');
  const capped = MapCtl.capMarkers(list, (p) => p.id === picked.id);
  assert.strictEqual(capped.items.length, limit, '超出上限就要截断到上限');
  assert.strictEqual(capped.dropped, total - limit, 'dropped 要如实回报');
  const has = (id) => capped.items.some((p) => p.id === id);
  assert.ok(has(picked.id), '已选中的点必须保留');
  assert.ok(has('p0'), '住宿锚点必须保留');
});

test('app.js：落旗被截断时结果条说明「地图按评分优先落 N 个点」', () => {
  assert.match(APP, /state\.markerInfo = MapCtl\.syncMarkers\(/, 'renderMap 要收下落旗回执');
  assert.match(APP, /mi\.dropped > 0/, '被截断要判出来');
  assert.match(APP, /地图每类挑高分的落/, '结果条要说明落旗上限与截断口径');
});

// ---------- ④ 信息卡更好关 ----------

test('信息卡：× 是个好点的按钮，并告诉用户 Esc / 点空白也能关', () => {
  assert.match(DETAIL, /card-dismiss-hint/, '缺「还能怎么关」的提示行');
  assert.match(DETAIL, /title="关闭（按 Esc 也行，或点地图空白处）"/, '× 的说明要写全');
  assert.match(CSS, /\.card-dismiss-hint\s*\{/, '缺 .card-dismiss-hint 样式');
  const close = CSS.match(/\.card-close\s*\{[^}]*\}/gs) || [];
  assert.ok(close.length, '缺 .card-close 样式');
  assert.ok(
    close.some((rule) => /width:\s*2[4-9]px|min-width:\s*2[4-9]px/.test(rule)),
    '× 的点击区要够大（≥24px）'
  );
});

// ---------- ⑤ 右栏两张卡不再撞脸 ----------

test('右栏：「我的选择」是挑点区、「我的行程」是存档区，各有说明与样式', () => {
  assert.match(HTML, /<p class="card-sub">挑点：[^<]*规划行程/, '「我的选择」缺说明');
  assert.match(HTML, /class="card trip-card"/, '「我的行程」应带 trip-card 类');
  assert.match(CSS, /\.card-sub\s*\{/, '缺 .card-sub 样式');
  assert.match(CSS, /\.trip-card\s*\{[^}]*border-style:\s*dashed/s, '存档卡要有区分样式');
  assert.match(CSS, /\.pin-card\s*\{[^}]*border-left/s, '挑点卡要有区分样式');
});

// ---------- ⑦ 规划行程 / 自动成线 0 点置灰 ----------

test('app.js：0 个点时「规划行程 / 自动成线」置灰并给原因', () => {
  assert.match(APP, /planBtn\.disabled = noPin/, '规划行程没有置灰');
  assert.match(APP, /autoBtn\.disabled = noPin/, '自动成线没有置灰');
  assert.match(APP, /const noPin = count === 0/, '置灰判据要写清楚');
  const appHtml = read('web/index.html');
  assert.match(appHtml, /id="auto-plan-btn"[^>]*/, 'index 里应有自动成线按钮');
  assert.match(CSS, /button:disabled\s*\{[^}]*cursor:\s*not-allowed/s, '置灰按钮要给鼠标交代');
});

// ---------- ⑧ 次要文字对比度 ----------

test('CSS：次要文字色提亮（--ink-3 不再是 #6f7887）', () => {
  assert.ok(!/--ink-3:\s*#6f7887/.test(CSS), '--ink-3 太暗（实测 ~3.9:1），应提亮');
  assert.match(CSS, /--ink-3:\s*#9aa3b2/, '--ink-3 应提到 #9aa3b2 一档');
});

// ---------- ⑥ 「搜索地点」本地回退 ----------

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
];

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const amap = opts.amap || {};
  const calls = amap.calls || { poiSearch: 0 };
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: {
      calls,
      async searchPoi() {
        calls.poiSearch += 1;
        return [];
      },
      ...amap,
    },
    collectIntervalMs: 0,
    // OSM 兑底（Photon）默认注入空实现：单测一律离线，要测兑底就自己塞一个假的
    osm: opts.osm || { searchOsm: async () => [] },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    db,
    amap,
    base,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

const SEED = [
  { poi_id: 'L1', city: '杭州', category: 'food', name: '老王火锅', address: '上城区某路 1 号', lng: 120.17, lat: 30.25, rating: '4.6' },
  { poi_id: 'L2', city: '杭州', category: 'food', name: '火锅青年', address: '上城区某路 2 号', lng: 120.18, lat: 30.26, rating: '3.9' },
  { poi_id: 'L3', city: '杭州', category: 'stay', name: '某酒店', address: '上城区某路 3 号', lng: 120.19, lat: 30.27, rating: '4.9' },
  { poi_id: 'L4', city: '上海', category: 'food', name: '上海火锅', address: '黄浦区', lng: 121.47, lat: 31.23, rating: '4.9' },
];

test('db.searchPoisLocal：按城市 + 关键词（多词 AND）+ 评分降序，命中带 local 标记', () => {
  const db = createDb(':memory:');
  SEED.forEach((p) => db.upsertPoi(p));
  const hit = db.searchPoisLocal({ city: '杭州', keywords: '火锅' });
  assert.deepStrictEqual(hit.map((p) => p.poi_id), ['L1', 'L2'], '应按评分降序，且不跨城市');
  assert.strictEqual(hit[0].local, true, '本地命中要带 local:true');
  assert.strictEqual(hit[0].id, 'L1', 'mapPoiRow 的 id 别名要保留');
  assert.deepStrictEqual(db.searchPoisLocal({ city: '杭州', keywords: '老王 火锅' }).map((p) => p.poi_id), ['L1']);
  assert.deepStrictEqual(db.searchPoisLocal({ city: '杭州', keywords: '火锅', category: 'stay' }), []);
  assert.deepStrictEqual(db.searchPoisLocal({ city: '杭州', keywords: '' }), []);
});

test('GET /api/poi/search：高德报错时回退本地已收录，并如实告知来源', async () => {
  const s = await start({
    amap: {
      calls: { poiSearch: 0 },
      async searchPoi() {
        this.calls.poiSearch += 1;
        const err = new Error('USER_DAILY_QUERY_OVER_LIMIT');
        err.code = 'AMAP_ERROR';
        throw err;
      },
    },
  });
  try {
    SEED.forEach((p) => s.db.upsertPoi(p));
    const res = await fetch(s.base + '/api/poi/search?city=' + encodeURIComponent('杭州') + '&keywords=' + encodeURIComponent('火锅'));
    const body = await res.json();
    assert.strictEqual(res.status, 200, '有本地结果时不该报 502');
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.data.map((p) => p.poi_id), ['L1', 'L2']);
    assert.strictEqual(body.data[0].local, true, '前端要靠 local 标记说明来源');
    assert.strictEqual(s.amap.calls.poiSearch, 1, '高德仍应被尝试一次');
  } finally {
    await s.close();
  }
});

test('GET /api/poi/search：高德没结果时也回退本地；两边都没有才报高德的错', async () => {
  const s = await start(); // 默认 fixture：searchPoi 返回 []
  try {
    SEED.forEach((p) => s.db.upsertPoi(p));
    const url = '?city=' + encodeURIComponent('杭州') + '&keywords=';
    const empty = await (await fetch(s.base + '/api/poi/search' + url)).json();
    assert.deepStrictEqual(empty.data, [], '关键词为空时不该瞎猜，返回空');

    const hit = await (await fetch(s.base + '/api/poi/search' + url + encodeURIComponent('火锅'))).json();
    assert.deepStrictEqual(hit.data.map((p) => p.poi_id), ['L1', 'L2'], '远端 0 条 ⇒ 用本地');
  } finally {
    await s.close();
  }

  const s2 = await start({
    amap: {
      calls: { poiSearch: 0 },
      async searchPoi() {
        this.calls.poiSearch += 1;
        const err = new Error('USER_DAILY_QUERY_OVER_LIMIT');
        err.code = 'AMAP_ERROR';
        throw err;
      },
    },
  });
  try {
    // 本地也没有 ⇒ 如实把高德的原因报出来（前端再过一层人话）
    const res = await fetch(s2.base + '/api/poi/search?city=' + encodeURIComponent('杭州') + '&keywords=' + encodeURIComponent('火锅'));
    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'AMAP_ERROR');
    assert.strictEqual(body.error.msg, 'USER_DAILY_QUERY_OVER_LIMIT');
  } finally {
    await s2.close();
  }
});

test('GET /api/poi/search：高德没额度 + 本地也没命中 ⇒ 拿 OSM 兑底，但只认同名', async () => {
  const osmCalls = [];
  const s = await start({
    amap: {
      calls: { poiSearch: 0 },
      async searchPoi() {
        this.calls.poiSearch += 1;
        const err = new Error('USER_DAILY_QUERY_OVER_LIMIT');
        err.code = 'AMAP_ERROR';
        throw err;
      },
    },
    osm: {
      async searchOsm(args) {
        osmCalls.push(args);
        return [
          { id: 'osm:R1', name: '杭州大剧院', address: '之江东路 66 号', lng: 120.21, lat: 30.25, category: 'play', source: 'osm' },
          { id: 'osm:W9', name: '环城东路', address: '', lng: 120.17, lat: 30.24, category: 'sight', source: 'osm' },
        ];
      },
    },
  });
  try {
    const res = await fetch(
      s.base + '/api/poi/search?city=' + encodeURIComponent('杭州') + '&keywords=' + encodeURIComponent('杭州大剧院')
    );
    const body = await res.json();
    assert.strictEqual(res.status, 200, 'OSM 有同名 ⇒ 不该报错');
    assert.deepStrictEqual(body.data.map((p) => p.id), ['osm:R1'], '名字对不上的（环城东路）不要 —— 错点比没点更坏');
    assert.strictEqual(body.data[0].source, 'osm', '来源要如实标 osm（前端靠它写「来自 OpenStreetMap」）');
    assert.strictEqual(osmCalls.length, 1, 'OSM 只该被叫一次');
    assert.strictEqual(osmCalls[0].city, '杭州', 'OSM 兑底要带上城市');
    assert.strictEqual(osmCalls[0].keywords, '杭州大剧院');
  } finally {
    await s.close();
  }
});

test('GET /api/poi/search：三边都没命中才报高德的原因（OSM 不拿别的点凑数）', async () => {
  const s = await start({
    amap: {
      calls: { poiSearch: 0 },
      async searchPoi() {
        this.calls.poiSearch += 1;
        const err = new Error('USER_DAILY_QUERY_OVER_LIMIT');
        err.code = 'AMAP_ERROR';
        throw err;
      },
    },
    osm: {
      async searchOsm() {
        return [{ id: 'osm:W9', name: '环城东路', address: '', lng: 120.17, lat: 30.24, category: 'sight', source: 'osm' }];
      },
    },
  });
  try {
    const res = await fetch(
      s.base + '/api/poi/search?city=' + encodeURIComponent('杭州') + '&keywords=' + encodeURIComponent('杭州大剧院')
    );
    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'AMAP_ERROR');
    assert.match(body.error.msg, /USER_DAILY_QUERY_OVER_LIMIT/);
  } finally {
    await s.close();
  }
});
