/* 抓取失败时把人引到「手动贴正文」（2026-11-25，P1-4）
   抓取依赖本机登录态与平台风控（NEED_LOGIN / NEED_CAPTCHA / FETCH_FAIL / NO_DATA / TIMEOUT），
   这些情况下用户手里其实就有那段正文 ⇒ 自动摊开备用入口、把链接带过去、光标放进去。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOTES = read('web/js/notes.js');
const HTML = read('web/index.html');

test('抓取失败码白名单：登录态 / 验证码 / 抓取失败 / 没内容 / 超时', () => {
  const m = NOTES.match(/const FALLBACK_CODES = \[([\s\S]*?)\];/);
  assert.ok(m, '缺 FALLBACK_CODES');
  ['NEED_LOGIN', 'NEED_CAPTCHA', 'FETCH_FAIL', 'NO_DATA', 'TIMEOUT'].forEach((code) => {
    assert.match(m[1], new RegExp("'" + code + "'"), '白名单缺 ' + code);
  });
});

test('openManualFallback：摊开 details、把链接带进正文框、光标放进去、提示说清下一步', () => {
  const fn = NOTES.match(/function openManualFallback\(reason\)[\s\S]*?\n  \}/);
  assert.ok(fn, '缺 openManualFallback');
  assert.match(fn[0], /\.open = true/, '要把 details 摊开');
  assert.match(fn[0], /note-share/, '要拿到正文框');
  assert.match(fn[0], /note-link/, '要把刚才那条链接带过去');
  assert.match(fn[0], /\.focus\(\)/, '光标要放进正文框');
  assert.match(fn[0], /手动贴正文/, '提示要指向备用入口');
});

test('单条与批量抓取失败都走这条兜底（不是只改一处）', () => {
  const hits = NOTES.match(/FALLBACK_CODES\.includes\(code\)/g) || [];
  assert.ok(hits.length >= 2, '单条与批量两条路径都要接兜底，现在只有 ' + hits.length + ' 处');
  assert.match(NOTES, /function errCode\(err\)/, '缺 errCode（任务失败时 code 在 err.code 上）');
});

test('备用入口的文案改成「抓不到时用这个」（不是「备用」这种看不出何时用的词）', () => {
  assert.match(HTML, /<summary>手动贴正文（抓不到时用这个）<\/summary>/, 'summary 文案要说明什么时候用');
  assert.match(HTML, /id="note-manual"/, 'details 要有 id（JS 靠它摊开）');
});
