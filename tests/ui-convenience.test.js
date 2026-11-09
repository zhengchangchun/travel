/* P8 操作便利：侧栏卡片可折叠 +「筛选 · 结果」合并成一屏 + 结果列表独立滚动 / 分页 + 地图关卡片
   这些是纯结构约束（无浏览器），防止后续改动把便利性又改回去。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const MAP = read('web/js/map.js');
const NOTES = read('web/js/notes.js');

const CARD_NAMES = ['city', 'search', 'filter', 'base', 'note'];

test('侧栏每张卡都带 data-card（可折叠的钩子）', () => {
  CARD_NAMES.forEach((name) => {
    assert.match(HTML, new RegExp('data-card="' + name + '"'), '缺 data-card=' + name);
  });
  assert.match(HTML, /id="cards-toggle-all"/, '缺「收起全部卡片」按钮');
});

test('筛选与结果在同一张卡里：chips / 评分 / 结果条 / 列表同属 filter 卡', () => {
  const start = HTML.indexOf('data-card="filter"');
  const end = HTML.indexOf('data-card="base"');
  assert.ok(start >= 0 && end > start, 'filter 卡与 base 卡顺序不对');
  const block = HTML.slice(start, end);
  ['id="chips"', 'id="rating-slider"', 'id="result-summary"', 'id="filter-clear-btn"', 'id="result-list"']
    .forEach((id) => {
      assert.ok(block.includes(id), 'filter 卡里缺 ' + id);
    });
});

test('结果卡不再排在最后一张（不用滚过所有卡片才看到结果）', () => {
  const filterAt = HTML.indexOf('data-card="filter"');
  const noteAt = HTML.indexOf('data-card="note"');
  assert.ok(filterAt >= 0 && noteAt > filterAt, '结果/筛选应当排在笔记卡之前');
});

test('id 不重复（拆卡时最容易踩的坑）', () => {
  const ids = HTML.match(/id="([^"]+)"/g) || [];
  const seen = new Set();
  ids.forEach((raw) => {
    const id = raw.slice(4, -1);
    assert.ok(!seen.has(id), 'id 重复：' + id);
    seen.add(id);
  });
});

test('CSS：卡片收起态隐藏内容，结果列表独立滚动', () => {
  assert.match(CSS, /\.card\.collapsed\s*>\s*\.card-body\s*\{\s*display:\s*none/, '缺收起态样式');
  assert.match(CSS, /\.result-scroll[^}]*overflow-y\s*:\s*auto/s, '结果列表应独立滚动');
  assert.match(CSS, /\.result-scroll[^}]*max-height/s, '结果列表应限高（否则又把侧栏撑爆）');
  // 原来的两栏独立滚动口径不能丢
  assert.match(CSS, /#sidebar[^}]*overflow-y\s*:\s*auto/s, '左栏应 overflow-y:auto');
});

test('app.js：折叠状态、分页、看全部、点空白关卡片都有实现', () => {
  assert.match(APP, /CARDS_KEY/, '缺折叠状态持久化键');
  assert.match(APP, /travel\.cards/, '折叠状态应落 localStorage');
  assert.match(APP, /function\s+applyCardState/, '缺 applyCardState');
  assert.match(APP, /function\s+toggleCard/, '缺 toggleCard');
  assert.match(APP, /function\s+loadCardState/, '缺 loadCardState');
  assert.match(APP, /RESULT_PAGE/, '缺结果分页常量');
  assert.match(APP, /function\s+renderResultMore/, '缺「显示更多」');
  assert.match(APP, /function\s+onResetFilters/, '缺一键「回到默认」');
  assert.match(APP, /function\s+onMapBlankClick/, '缺点地图空白关卡片');
  assert.match(APP, /Escape/, '缺 Esc 关卡片');
});

test('「只看我选中的」仍留在右栏，不因拆卡跑回左栏', () => {
  const left = HTML.slice(HTML.indexOf('id="sidebar"'), HTML.indexOf('id="map-wrap"'));
  assert.ok(!left.includes('only-selected-btn'), '左栏不该出现「只看我选中的」');
});

test('map.js 暴露 onMapClick；notes.js 支持回车即抓 / 即搜', () => {
  assert.match(MAP, /function\s+onMapClick/, 'map 缺 onMapClick');
  assert.match(MAP, /onMapClick,/, 'map 未导出 onMapClick');
  assert.match(NOTES, /note-link'\)[\s\S]{0,120}Enter/, '笔记链接输入框缺回车抓取');
  assert.match(NOTES, /note-keyword'\)[\s\S]{0,120}Enter/, '笔记关键词输入框缺回车搜索');
});

test('落旗必须分帧：syncMarkers 不许一次性同步建完（几千面会把主线程堵死）', () => {
  assert.match(MAP, /const MARKER_CHUNK\s*=/, '缺分帧常量');
  const m = MAP.match(/function\s+syncMarkers[\s\S]*?\n  \}/);
  assert.ok(m, '缺 syncMarkers');
  assert.match(m[0], /addChunk/, 'syncMarkers 应走批量 addChunk');
  assert.match(m[0], /requestAnimationFrame/, 'syncMarkers 应分帧 append');
  assert.match(m[0], /toAdd/, 'syncMarkers 应先算出待补清单再分帧画');
  assert.ok(!/wanted\.forEach\([\s\S]*?addMarker\(p/.test(m[0]), '不应在遍历里同步建旗');
  assert.match(MAP, /function\s+addChunk/, '缺 addChunk');
});
