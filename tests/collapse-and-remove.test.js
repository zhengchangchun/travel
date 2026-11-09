/* P11：
   ① 「收起」控件不再是文字按钮，统一成一个小箭头素材（展开态指向右，收起态翻向左）
   ② 「移除不了」两处根因——(a) 没有真 poi_id 的点按 poi_id 删必然 404；
      (b) 移除后「我的行程」卡不同步，看起来像没删掉
   这里是纯结构约束 + selection.js 的真执行（无浏览器），防止改回去。 */
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
const SEL = read('web/js/selection.js');
const APIJS = read('web/js/api.js');

// ---------- ① 收起控件 = 小箭头 ----------

test('两个「收起」控件都换成了内联箭头素材，按钮里不再有文字', () => {
  ['panel-toggle', 'cards-toggle-all'].forEach((id) => {
    const m = HTML.match(new RegExp('<button[^>]*id="' + id + '"[\\s\\S]*?</button>'));
    assert.ok(m, '缺按钮 ' + id);
    assert.match(m[0], /class="icon-chev"/, id + ' 应内含 .icon-chev 小箭头');
    assert.match(m[0], /<svg[^>]*viewBox="0 0 24 24"/, id + ' 的箭头应是内联 SVG（不依赖字体字形）');
    assert.ok(!/收起\s*[‹›]|收起全部卡片\s*</.test(m[0]), id + ' 不该再把「收起 …」当按钮文字');
  });
  // 文案退到 title / aria-label，别丢可发现性
  assert.match(HTML, /id="panel-toggle"[\s\S]*?aria-label="收起右栏"/);
  assert.match(HTML, /id="cards-toggle-all"[\s\S]*?aria-label="把侧栏卡片一次收起 \/ 展开"/);
});

test('.icon-chev 有定义，且收起态翻向左（rotate 180）', () => {
  assert.match(CSS, /\.icon-chev\s*\{[^}]*stroke:\s*currentColor/, '.icon-chev 应继承文字色');
  assert.match(CSS, /\.cards-toggle-all\.is-collapsed\s+\.icon-chev/, '「收起全部卡片」收起态要翻箭头');
  assert.match(
    CSS,
    /#right-panel\.collapsed\s+\.panel-toggle\s+\.icon-chev\s*\{\s*transform:\s*rotate\(180deg\)/,
    '右栏收起后箭头要翻向左'
  );
  // 窄条时整条「我挑的」可点（抽屉惯例）
  assert.match(CSS, /#right-panel\s+\.right-head\s*\{\s*cursor:\s*pointer/);
});

test('app.js：收起控件只切 class / 改 aria，不再写 textContent', () => {
  const all = APP.match(/const all = \$\('cards-toggle-all'\);[\s\S]*?\n    \}/);
  assert.ok(all, '缺 applyCardState 里的「收起全部卡片」分支');
  assert.match(all[0], /classList\.toggle\('is-collapsed'/, '收起态应切 is-collapsed');
  assert.ok(!/all\.textContent/.test(all[0]), '不该再往按钮里写文字');

  const panel = APP.match(/function onTogglePanel\(\)[\s\S]*?\n  \}/);
  assert.ok(panel, '缺 onTogglePanel');
  assert.ok(!/btn\.textContent/.test(panel[0]), '右栏按钮不该再写「收起 ‹ / 展开 ›」文字');
  assert.match(panel[0], /aria-label/, '应以 aria-label 表达收起 / 展开');
  assert.match(panel[0], /aria-expanded/, '应同步 aria-expanded');
});

// ---------- ② 「我的行程」移除不了 ----------

test('选中集一变就同步「我的行程」卡（原来只在没有行程时才同步 ⇒ 删了还显示）', () => {
  const sub = APP.match(/Selection\.subscribe\(\(\) => \{[\s\S]*?\n    \}\);/);
  assert.ok(sub, '缺 Selection.subscribe');
  assert.match(sub[0], /syncTripFromServer\(\)/, '订阅回调里必须同步行程卡');
  assert.ok(
    !/if \(!state\.trip\)\s*syncTripFromServer/.test(sub[0]),
    '不能只在 state.trip 为空时才同步（那正是「移除不了」的根因）'
  );
});

test('行程卡里的 × 删完走 reloadSelection（选中集 / 星标 / 地图一起对齐）', () => {
  const rt = APP.match(/async function refreshTrips\(\)[\s\S]*?\n  \}/);
  assert.ok(rt, '缺 refreshTrips');
  assert.match(rt[0], /API\.deletePin\(pin\.id\)/, '行程卡按 pin 行号删');
  assert.match(rt[0], /await reloadSelection\(\)/, '删完要整单对齐，不能只刷自己这张卡');
});

test('「加入行程」后也 reloadSelection（否则星标 / 我的选择不同步）', () => {
  const add = APP.match(/async function onAddPin\(poi\)[\s\S]*?\n  \}/);
  assert.ok(add, '缺 onAddPin');
  assert.match(add[0], /await reloadSelection\(\)/);
});

// ---------- selection.js 真执行：按「有没有真 poi_id」选删法 ----------

function loadSelection(api) {
  const fakeWindow = { TravelAPI: api };
  // eslint-disable-next-line no-new-func
  new Function('window', SEL)(fakeWindow);
  return fakeWindow.TravelSelection;
}

test('没有 poi_id 的点：移除走 DELETE /api/pins/:id，不再按 poi_id 打 404', async () => {
  const calls = [];
  const S = loadSelection({
    async getSelection() {
      return {
        tripId: 17,
        pins: [{ id: 78, poi_id: null, name: '无ID的点', address: '某处', lng: 120.21, lat: 30.24, category: 'sight' }],
      };
    },
    async deletePin(id) { calls.push(['deletePin', id]); },
    async unselectPoi(p) { calls.push(['unselectPoi', p.poiId]); },
  });
  await S.load('杭州');
  const pin = S.list()[0];
  assert.strictEqual(pin.id, 'pin:78', '没有 poi_id 时 key 是本地合成的 pin:<行号>');
  assert.strictEqual(pin.pinId, 78);
  await S.remove(pin);
  assert.deepStrictEqual(calls, [['deletePin', 78]]);
  assert.strictEqual(S.count(), 0, '移除后选中集要清掉');
});

test('有真 poi_id 的点：仍走 DELETE /api/selection?poi_id=', async () => {
  const calls = [];
  const S = loadSelection({
    async getSelection() {
      return { tripId: 17, pins: [{ id: 76, poi_id: 'B023B0BIO8', name: 'CBD公园', lng: 120.2, lat: 30.2, category: 'sight' }] };
    },
    async deletePin(id) { calls.push(['deletePin', id]); },
    async unselectPoi(p) { calls.push(['unselectPoi', p.poiId]); },
  });
  await S.load('杭州');
  const pin = S.list()[0];
  assert.strictEqual(pin.id, 'B023B0BIO8');
  await S.remove(pin);
  assert.deepStrictEqual(calls, [['unselectPoi', 'B023B0BIO8']]);
});

test('移除失败要回滚本地态（不能先消失再偷偷回来）', async () => {
  const S = loadSelection({
    async getSelection() {
      return { tripId: 17, pins: [{ id: 78, poi_id: null, name: '无ID的点', lng: 120.21, lat: 30.24, category: 'sight' }] };
    },
    async deletePin() { throw new Error('boom'); },
    async unselectPoi() { throw new Error('boom'); },
  });
  await S.load('杭州');
  await assert.rejects(() => S.remove(S.list()[0]), /boom/);
  assert.strictEqual(S.count(), 1, '失败要回滚到移除前');
  assert.strictEqual(S.list()[0].name, '无ID的点');
});

test('乐观占位的 pinId 必须是 null（不能把高德 poi_id 当 pin 行号）', async () => {
  let resolveSel = null;
  const S = loadSelection({
    async getSelection() { return { tripId: null, pins: [] }; },
    selectPoi(payload) {
      return new Promise((res) => { resolveSel = () => res({ tripId: 17, pin: { id: 90, poi_id: payload.poi.id, name: payload.poi.name, lng: 120.2, lat: 30.2, category: 'food' } }); });
    },
  });
  await S.load('杭州');
  const p = S.select({ id: 'B0NEW', name: '新点', lng: 120.2, lat: 30.2, category: 'food' });
  const optimistic = S.list()[0];
  assert.strictEqual(optimistic.id, 'B0NEW');
  assert.strictEqual(optimistic.pinId, null, '还没落库 ⇒ 没有 pin 行号');
  resolveSel();
  await p;
  assert.strictEqual(S.list()[0].pinId, 90, '服务端回来后才拿到真行号');
});

// ---------- 服务端：没有 poi_id 的点也能删 ----------

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [{ key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' }];

async function start() {
  const db = createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: { async searchPoiAround() { return []; }, async searchPoiInArea() { return []; } },
    collectIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => app.server.close(() => { db.close(); resolve(); })),
  };
}

const json = async (base, p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('没有 poi_id 的 pin：DELETE /api/selection?poi_id=pin:<n> 必须 404（所以前端改走 /api/pins/:id）', async () => {
  const s = await start();
  try {
    const added = await json(s.base, '/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州', name: '无ID的点', lng: 120.21, lat: 30.24, category: 'sight' }),
    });
    assert.strictEqual(added.status, 200);
    const rowId = added.body.data.id;
    assert.strictEqual(added.body.data.poi_id, null);

    const byPoi = await json(s.base, '/api/selection?city=%E6%9D%AD%E5%B7%9E&poi_id=pin%3A' + rowId, { method: 'DELETE' });
    assert.strictEqual(byPoi.status, 404, '按 poi_id 删合成 key 本来就该 404（这就是「移除不了」）');

    const byPin = await json(s.base, '/api/pins/' + rowId, { method: 'DELETE' });
    assert.strictEqual(byPin.status, 200, '按 pin 行号删必须成功');

    const left = await json(s.base, '/api/selection?city=%E6%9D%AD%E5%B7%9E');
    assert.strictEqual(left.body.data.count, 0);
  } finally {
    await s.close();
  }
});

test('api.js 同时暴露 deletePin 与 unselectPoi（两条删法都要在）', () => {
  assert.match(APIJS, /deletePin:\s*\(id\)\s*=>\s*request\('\/api\/pins\/'/);
  assert.match(APIJS, /unselectPoi:/);
});
