/* P10：解释性文字收进「i」气泡（用户 2026-11-09：「这种解释说明的都可以使用 tip …没必要直接放在页面上」）。
   口径：常驻的说明段（.hint）从卡片里搬进 data-tip，鼠标悬停 / 键盘聚焦才出气泡；
   但「状态」和「空态引导」这类当下必须看见的文案不许搬（有守卫钉住，别越删越干净）。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('web/index.html');
const CSS = read('web/css/style.css');
const APP = read('web/js/app.js');
const NOTES = read('web/js/notes.js');
const DETAIL = read('web/js/detail.js');

// 搬进气泡的 5 段说明（改前都是常驻的 <p class="hint">）
const TIPS = [
  '打字即出建议 · ↑↓ 选、回车确认',
  '默认不选；选中哪个分类就只显示哪个分类，再点一下取消（可多选）',
  '拖动滑块调最低分：0 = 不过滤，5 = 只看 5 分',
  '先定住宿，再看它周边的美食与景点（一次查询 ≤4 次调用，其余走缓存）',
  '粘链接（小红书 / 抖音 / 快手 / B站）或整段分享文案，本机自己抓（用已登录的浏览器 profile）',
];

test('说明文字改成 i 气泡：页面正文里不再常驻这 5 段', () => {
  TIPS.forEach((text) => {
    assert.ok(!HTML.includes('>' + text + '<'), `说明还在正文里：「${text}」`);
    assert.ok(
      HTML.includes('data-tip="' + text + '"'),
      `说明没搬进气泡：「${text}」`
    );
  });
  // 卡里的说明段只该剩「当下必须看见」的那些：这里不该再有 .hint
  assert.ok(!/<p class="hint">/.test(HTML), 'index 里不该再剩常驻的 .hint 说明段');
});

test('气泡挂得住：标题条右侧一组 + 键盘可聚焦 + 点它不折叠卡片', () => {
  const tipCount = (HTML.match(/class="tip"/g) || []).length;
  assert.strictEqual(tipCount, 5, '5 个说明点，一个不多一个不少');
  assert.match(HTML, /<span class="tip" data-tip="[^"]+" tabindex="0" aria-label="用法说明">i<\/span>/, '说明点要能 Tab 到并带 aria 名');
  // 右侧一组：当前城市 / 本地 N / i / 箭头 一起靠右
  assert.match(CSS, /\.bar-right \{[^}]*margin-left:\s*auto/, '右侧一组要靠右');
  assert.match(HTML, /<span class="bar-right"><span class="bar-note">当前 <b id="current-city">/,
    '城市卡的「当前 …」要跟 i / 箭头同组');
  // 气泡本体：悬停 / 聚焦才显示
  assert.match(CSS, /\.tip::after \{[^}]*content:\s*attr\(data-tip\)/, '气泡文本取 data-tip');
  assert.match(CSS, /\.tip:hover::after,\s*\.tip:focus-visible::after/, '悬停与键盘聚焦都要出气泡');
  assert.match(CSS, /opacity:\s*0;\s*visibility:\s*hidden/, '默认藏着');
  // 标题条是「点一下折叠」的按钮 ⇒ 点说明点不能顺带折叠
  assert.match(APP, /function\s+bindTips/, '缺 bindTips');
  assert.match(APP, /\['click',\s*'mousedown',\s*'keydown'\]/, '点击/按下/按键都要拦住冒泡');
  assert.match(APP, /e\.stopPropagation\(\)/, '要 stopPropagation');
  assert.match(APP, /bindTips\(\);/, 'bindTips 要真的接上');
});

test('不许把「当下必须看见」的文案也搬进气泡（守卫）', () => {
  // 状态栏 / 空态：仍由 JS 写在页面上（未选分类不写引导，但倍率不够要说）
  assert.match(APP, /放大地图以加载本区域地点/, '倍率不够的提示不该被搬走');
  // 结果汇总 / 状态栏这些动态读数还在
  assert.match(HTML, /id="result-summary"/, '结果汇总不能删');
  assert.match(HTML, /id="map-status"/, '地图状态栏不能删');
  // 笔记的进度/取消仍在页面上（长任务必须看得见）
  assert.match(HTML, /id="note-progress"/, '进度行不能删');
  assert.match(HTML, /id="note-cancel-btn"/, '取消按钮不能删');
  assert.match(NOTES, /function setProgress/, '进度写入不能删');
  // 信息卡「怎么关」的行留着：它只在卡片打开时出现（不是常驻说明）
  assert.match(DETAIL, /card-dismiss-hint/, '信息卡的关法提示应保留');
});
