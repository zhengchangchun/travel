/* 首页 03「这四件事」的卷轴（2026-11-24）：用户要 Apple 产品页那种「先刷重点」的感觉。
   这一块是纯前端的（滚动推进 + 图片/文案都是静态的），所以只钉结构与退路：
   ① 四条重点各带 小标签 / 主张 / 一句话，编号从 01 排到 04，初始只亮第一张
   ② 底部四段进度轨与四条重点一一对应，文案一字不差
   ③ 外层按重点数撑高（4 × 88vh），舞台 sticky 钉在头部下面 —— sticky 一旦被写坏就退化成「一直显示第一张」
   ④ 窄屏（≤860px）与 prefers-reduced-motion 必须有退路：位置回到 static、进度轨隐藏，四条照样全在
   ⑤ 老的 .features 四宫格不许留着（搬完要拆干净，否则两套版面同时存在） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web/home.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/css/home.css'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'web/js/home.js'), 'utf8');

const KICKS = ['精选线路', '美景一起看', '找搭子', '网红打卡', '路程时间', '随时改'];

function slides() {
  return HTML.split('<article class="reel-slide').slice(1);
}

test('03 卷轴：六条重点，各带小标签 / 主张 / 一句话', () => {
  const s = slides();
  assert.equal(s.length, 6, '应有六条重点');
  s.forEach((chunk, i) => {
    const body = chunk.slice(0, chunk.indexOf('</article>'));
    assert.match(body, /class="reel-ico"/, `第 ${i + 1} 条缺图标`);
    assert.match(body, /class="reel-kick"/, `第 ${i + 1} 条缺小标签`);
    const claim = body.match(/class="reel-claim">([^<]+)<i>。<\/i>/);
    assert.ok(claim, `第 ${i + 1} 条的主张要以铜色句号收尾`);
    assert.ok(claim[1].length >= 4 && claim[1].length <= 9, `第 ${i + 1} 条的主张长度（${claim[1].length}）应在 4–9 字，否则卷轴里会折行`);
    assert.match(body, /class="reel-text">[^<]{10,}</, `第 ${i + 1} 条缺一句话说明`);
    assert.ok(body.includes(`class="reel-mark" aria-hidden="true">0${i + 1}<`), `第 ${i + 1} 条的水印编号应是 0${i + 1}`);
    assert.ok(body.includes(KICKS[i]), `第 ${i + 1} 条小标签应是「${KICKS[i]}」`);
  });
  assert.equal((HTML.match(/reel-slide is-on/g) || []).length, 1, '初始只应亮一张');
  assert.match(HTML, /class="reel-slide is-on" data-i="0"/, '初始亮的应是第一张');
});

test('03 卷轴：底部六段进度轨与六条重点对得上', () => {
  const rails = HTML.split('<button class="reel-tab').slice(1);
  assert.equal(rails.length, 6, '应有六段进度轨');
  rails.forEach((chunk, i) => {
    const body = chunk.slice(0, chunk.indexOf('</button>'));
    assert.ok(body.includes(KICKS[i]), `第 ${i + 1} 段进度轨文案应是「${KICKS[i]}」`);
    assert.match(body, /<b>0\d<\/b>/, `第 ${i + 1} 段应带编号`);
  });
  assert.equal((HTML.match(/reel-tab is-on/g) || []).length, 1, '进度轨初始只应亮一段');
  assert.match(HTML, /id="reel-idx"/, '缺右上角的 01 / 04 读数');
  assert.match(HTML, /id="reel-bar"/, '缺底部进度条');
});

test('03 卷轴：外层按重点数撑高，舞台 sticky 在头部下面', () => {
  const n = slides().length;
  const varAttr = HTML.match(/class="reel" id="reel" style="--reel-n: (\d+)"/);
  assert.ok(varAttr, 'HTML 要把重点数写进 --reel-n');
  assert.equal(Number(varAttr[1]), n, '--reel-n 要与实际重点数一致（否则滚动长度对不上）');
  assert.match(CSS, /\.reel\s*\{[^}]*height:\s*calc\(var\(--reel-n, 4\) \* 78vh\)/, '外层高度应随重点数走');
  assert.match(CSS, /@supports \(height: 1svh\)[\s\S]*?calc\(var\(--reel-n, 4\) \* 78svh\)/, '移动端要用 svh 兜住地址栏');
  assert.match(CSS, /\.reel-stage\s*\{[^}]*position:\s*sticky[^}]*top:\s*var\(--head-h\)/, '舞台要 sticky 钉在头部下面');
  assert.match(CSS, /\.reel-slide\.is-on\s*\{[^}]*opacity:\s*1/, '亮着的那张要完全显出来');
  assert.match(CSS, /\.reel-slide\.is-past\s*\{[^}]*translateY\(-/, '走过的往上走一点，方向感才对');
});

test('03 卷轴：窄屏与减少动效有退路（退回一列卡片，内容不变）', () => {
  const rule = CSS.match(/@media \(max-width: 860px\), \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
  assert.ok(rule, '缺窄屏 / 减少动效的退路');
  const body = rule[0];
  assert.match(body, /\.reel\s*\{[^}]*height:\s*auto/, '窄屏时不该再撑高');
  assert.match(body, /\.reel-stage\s*\{[^}]*position:\s*static/, '窄屏时舞台要回到普通流');
  assert.match(body, /\.reel-slide\s*\{[^}]*position:\s*static/, '窄屏时重点要回到普通流（否则互相盖住）');
  assert.match(body, /\.reel-tabs[^{]*\{\s*display:\s*none/, '窄屏时进度轨要收起来');
});

test('03 卷轴：滚动推进 + 点进度轨跳转都接上了', () => {
  assert.match(JS, /function wireReel\(\)/, '缺 wireReel');
  assert.match(JS, /wireShowcase\(\);\s*\n\s*wireReel\(\);/, 'init 里要真的调起来');
  assert.match(JS, /addEventListener\('scroll'/, '要监听滚动');
  assert.match(JS, /Math\.floor\(p \* ctx\.n/, '按滚动占比折算第几张');
  assert.match(JS, /scrollTo\(\{ top: Math\.round\(target\)/, '点进度轨要能滚过去');
  assert.match(JS, /window\.innerWidth <= 860/, '窄屏不接线（版面已是静态列表）');
});

test('03 卷轴：老的 .features 四宫格已经拆干净', () => {
  assert.ok(!/class="grid features"/.test(HTML), 'home.html 里不该还有四宫格');
  assert.ok(!/\.features\b/.test(CSS), 'home.css 里不该还有 .features');
  assert.ok(!/\.feat-ico\b/.test(CSS), 'home.css 里不该还有 .feat-ico');
});
