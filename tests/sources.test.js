const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Src = require('../web/js/sources');

const ROOT = path.join(__dirname, '..');
const DETAIL = fs.readFileSync(path.join(ROOT, 'web', 'js', 'detail.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'css', 'style.css'), 'utf8');

test('sourcesFor：多来源入口，每条都带来源名（label）与类型（kind）', () => {
  const list = Src.sourcesFor({ id: 'B0FFH', name: '楼外楼', category: 'food' }, '杭州');
  const keys = list.map((s) => s.key);
  assert.deepEqual(keys, ['amap', 'xhs', 'douyin', 'bilibili', 'weibo']);
  list.forEach((s) => {
    assert.ok(s.label, s.key + ' 缺来源名 label');
    assert.ok(s.kind, s.key + ' 缺类型 kind');
    assert.match(s.url, /^https:\/\//, s.key + ' 应是 https 链接');
  });
  assert.equal(list[0].label, '高德');
  assert.equal(list[0].url, 'https://www.amap.com/detail/B0FFH');
  assert.equal(list.find((s) => s.key === 'xhs').label, '小红书');
  assert.equal(list.find((s) => s.key === 'douyin').label, '抖音');
});

test('关键词＝地点名 + 城市，且做了 URL 编码（中文/空格/斜杠都不能裸拼）', () => {
  assert.equal(Src.keywordOf({ name: '西湖' }, '杭州'), '西湖 杭州');
  assert.equal(Src.keywordOf({ name: 'A/B 店' }, ''), 'A/B 店');
  const xhs = Src.sourcesFor({ id: 'X1', name: 'A/B 店' }, '杭州').find((s) => s.key === 'xhs');
  assert.ok(xhs.url.includes(encodeURIComponent('A/B 店 杭州')), '关键词应被编码: ' + xhs.url);
  assert.ok(!xhs.url.includes('A/B 店 杭州'), '不得裸拼未编码关键词');
});

test('没有名字时只给高德那条；没有 id 时不给高德（其余平台照给）；全空则空', () => {
  const noName = Src.sourcesFor({ id: 'X1', name: '' }, '杭州');
  assert.deepEqual(noName.map((s) => s.key), ['amap'], '没名字就只剩高德自己那条');
  const noId = Src.sourcesFor({ name: '西湖' }, '杭州');
  assert.deepEqual(noId.map((s) => s.key), ['xhs', 'douyin', 'bilibili', 'weibo'], '没 id 时不给高德');
  assert.deepEqual(Src.sourcesFor({}, '杭州'), [], '什么都没给时不应编链接');
  assert.deepEqual(Src.sourcesFor(null, '杭州'), [], '空对象也要安全');
});

test('详情卡渲染来源行：标题写「标明来源」、每条显示来源名、外链安全属性齐', () => {
  assert.match(DETAIL, /TravelSources/, 'detail.js 未用 TravelSources');
  assert.match(DETAIL, /看视频\/笔记（标明来源）/, '缺来源行标题');
  assert.match(DETAIL, /class="src-label"/, '缺来源名展示');
  assert.match(DETAIL, /class="src-kind"/, '缺来源类型展示');
  assert.match(DETAIL, /target="_blank" rel="noopener"/, '外链应有 rel=noopener');
  assert.match(HTML, /<script src="\/js\/sources\.js"><\/script>/, 'index 未引 sources.js');
  assert.match(CSS, /\.src-link/, 'css 缺来源行样式');
});

test('photoSource：图片也标明来源（高德官方图 vs 高德用户实拍）', () => {
  const c = Src.photoSource('https://aos-comment.amap.com/x/comment/y.jpg');
  assert.equal(c.isComment, true);
  assert.equal(c.label, '用户实拍');
  assert.equal(c.source, '高德');
  const o = Src.photoSource('https://store.is.autonavi.com/showpic/z');
  assert.equal(o.isComment, false);
  assert.equal(o.label, '官方图');
  assert.equal(Src.photoSource('').label, '官方图');
  assert.equal(Src.photoSource(null).isComment, false);
});

test('笔记版式：大图头图 + 来源角标 + 缩略图条 + 信息 chip，且保留既有资产', () => {
  const D = DETAIL;
  ['note-hero', 'note-thumbs', 'note-thumb', 'note-chips', 'note-chip'].forEach((k) =>
    assert.ok(D.includes(k), '笔记版式缺 ' + k)
  );
  // 原有 t5 资产不能弄丢
  ['gallery-img', 'badge-comment', '用户实拍', 'dish-chip', 'addr-text', 'detail-note', '去高德看评价'].forEach(
    (k) => assert.ok(D.includes(k), '丢了 t5 资产 ' + k)
  );
  assert.ok(D.includes('来源：'), '图上/信息区应标明来源');
  assert.ok(D.includes('数据来源：高德'), '信息 chip 缺数据来源标注');
  assert.match(D, /photoSource\(/, '未用 photoSource 标注图片来源');
  assert.ok(!/xhsUrl/.test(D), '已由多来源行取代，不应再留旧的小红书按钮变量');
  assert.match(CSS, /\.note-hero/, 'css 缺笔记头图样式');
  assert.match(CSS, /\.note-thumb\.active/, 'css 缺缩略图选中态');
});
