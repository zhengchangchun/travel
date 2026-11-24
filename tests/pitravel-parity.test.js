/* 对标圆周旅迹（2026-11-24 用户「你可以对比下圆周旅迹这个产品，优化下整体」）后补的三件事：

   ① 一次粘多条链接一起解析（圆周旅迹 5.0 的「多条整合解析」）：
      文案里有几个链接就抓几个，逐条报结果，一条失败不影响其他条
   ② 多天行程按天配色（它每天一种颜色）：单天不启用，保持按出行方式配色
   ③ 行程总览读数：多天时把「几天 / 每天几个点」摆出来 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { extractUrls, extractUrl } = require('../server/note-share');
const NOTES_ROUTE = read('server/routes/notes.js');
const NOTES_JS = read('web/js/notes.js');
const MAP = read('web/js/map.js');
const ROUTE = read('web/js/route.js');

test('extractUrls：一次粘多条，去重保序；单条仍走 extractUrl', () => {
  const text =
    '看这个 https://v.douyin.com/a1/ 还有 https://xhslink.com/b2 ，再来 https://v.douyin.com/a1/ 重复的';
  assert.deepEqual(extractUrls(text), ['https://v.douyin.com/a1/', 'https://xhslink.com/b2']);
  assert.deepEqual(extractUrls('没有链接的正文'), []);
  // 尾巴上的中文标点不许粘进 URL（与 extractUrl 同一口径）
  assert.deepEqual(extractUrls('https://v.douyin.com/iJabcDE/，复制此链接'), ['https://v.douyin.com/iJabcDE/']);
  assert.equal(extractUrl('https://v.douyin.com/iJabcDE/，复制此链接'), 'https://v.douyin.com/iJabcDE/');
});

test('批量抓取：逐条抓、一条失败不影响其他条、上限 10 条', () => {
  assert.match(NOTES_ROUTE, /const FETCH_MANY_MAX = 10/, '要有上限');
  assert.match(NOTES_ROUTE, /async function fetchManyAndIngest/, '缺批量实现');
  const fn = NOTES_ROUTE.match(/async function fetchManyAndIngest[\s\S]*?\n\}/);
  assert.ok(fn, '拿不到 fetchManyAndIngest');
  const body = fn[0];
  assert.match(body, /for \(let i = 0; i < picked\.length; i \+= 1\)/, '要逐条跑（不是 Promise.all 一把梭）');
  assert.match(body, /items\.push\(\{ url, ok: false/, '单条失败要记下来继续');
  assert.match(body, /continue;/, '失败后继续下一条');
  assert.match(body, /hooks\.isCanceled/, '要能中途取消');
  assert.match(body, /hooks\.onProgress/, '要报「第几条」');
  assert.match(body, /skipped: uniq\.length - picked\.length/, '超上限的要如实报跳过几条');
  // 任务入口
  assert.match(NOTES_ROUTE, /kind === 'fetch-many'/, '缺 fetch-many 任务入口');
  assert.match(NOTES_ROUTE, /extractUrls\(raw\)/, '任务入口要从文案里取全部链接');
});

test('前端：粘多条自动走批量，逐条报结果', () => {
  assert.match(NOTES_JS, /function countUrls\(text\)/, '缺 countUrls');
  assert.match(NOTES_JS, /if \(n > 1\) \{\s*\n\s*await onFetchMany\(raw, n\);/, '多条要走批量');
  assert.match(NOTES_JS, /async function onFetchMany\(raw, n\)/, '缺 onFetchMany');
  const fn = NOTES_JS.match(/async function onFetchMany\(raw, n\)[\s\S]*?\n  \}/);
  assert.ok(fn, '拿不到 onFetchMany');
  assert.match(fn[0], /runJob\('fetch-many'/, '要起 fetch-many 任务');
  assert.match(fn[0], /抓到 ' \+ okItems\.length/, '要报「抓到 N / M 条」');
  assert.match(fn[0], /失败 ' \+ badItems\.length/, '失败的条数要单独说');
});

test('多天行程按天配色：单天不启用（保持按出行方式配色）', () => {
  assert.match(MAP, /const DAY_COLORS = \[/, '缺按天配色表');
  assert.match(MAP, /function dayStyle\(day\)/, '缺 dayStyle');
  const draw = MAP.match(/function drawRoute\(legs, mode, handlers\)[\s\S]*?\n  \}/);
  assert.ok(draw, '缺 drawRoute');
  assert.match(draw[0], /const days = handlers && Array\.isArray\(handlers\.days\)/, '要接 days');
  assert.match(draw[0], /day \? dayStyle\(day\) : routeStyle\(legMode\)/, '有天数才按天配色，否则按方式');
  // route.js 只在多天时传 days
  assert.match(ROUTE, /const multiDay = dayOfLeg\.some\(\(d\) => d > 1\)/, '要判多天');
  assert.match(ROUTE, /days: multiDay \? dayOfLeg : null/, '单天不传 days');
});

test('行程总览：多天时给出「几天 / 每天几个点」', () => {
  const totals = ROUTE.match(/function renderTotals\(\)[\s\S]*?\n  \}/);
  assert.ok(totals, '缺 renderTotals');
  assert.match(totals[0], /const dayCount = days\.reduce/, '要算天数');
  assert.match(totals[0], /dayCount > 1/, '只在多天时显示');
  assert.match(totals[0], /' 天<\/b><small>'/, '要显示「N 天」');
  assert.match(totals[0], /' 点'\)\.join\(' · '\)/, '要显示每天几个点');
});
