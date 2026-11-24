/* 规划页的「默认态」（2026-11-24 用户：「默认不显示所有 默认左侧展开 右侧如果未添加行程的情况下先隐藏」）

   ① 默认不显示所有：打开/切城都不预选分类 ⇒ 地图与列表都空着，等他点分类
   ② 默认左侧展开：左栏收起状态键升 v2（旧值不再生效），开机就是展开
   ③ 右侧未添加行程先隐藏：手里 0 个点时右栏收起；加进第一个点自动展开；
      他手动点过箭头之后按他的来（不再自动） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');

test('默认不显示所有：打开与切城都不预选分类', () => {
  const boot = APP.slice(APP.indexOf('async function boot()'), APP.indexOf('async function boot()') + 6000);
  assert.match(boot, /state\.activeCats = new Set\(\);/, '开机不该预选分类');
  assert.ok(!/state\.activeCats = new Set\(Cats\.all\(\)\.map/.test(boot), '开机不该四类全选');
  const setCity = APP.match(/async function setCity[\s\S]*?\n  \}/);
  assert.ok(setCity, '缺 setCity');
  assert.match(setCity[0], /state\.activeCats = new Set\(\);/, '切城也不预选分类');
  // 但「关键词搜索」仍要全选（那是「我要找这个东西」，不该被分类挡掉）
  const search = APP.match(/async function doPoiSearch[\s\S]*?\n  \}/);
  assert.ok(search, '缺 doPoiSearch');
  assert.match(search[0], /state\.activeCats = new Set\(Cats\.all\(\)\.map/, '搜索仍应全选分类');
});

test('默认左侧展开：状态键升 v2，开机按它恢复', () => {
  assert.match(APP, /const SIDEBAR_COLLAPSED_KEY = 'travel\.sidebar-collapsed\.v2'/, '左栏状态键要升 v2');
  assert.match(APP, /applySidebarCollapsed\(loadSidebarCollapsed\(\)\)/, '开机要按存的状态恢复');
});

test('右侧未添加行程先隐藏：0 个点收起，加点自动展开', () => {
  assert.match(APP, /const PANEL_KEY = 'travel\.panel-collapsed\.v2'/, '右栏也要有自己的状态键');
  assert.match(APP, /function syncPanelAuto\(\)/, '缺 syncPanelAuto');
  const fn = APP.match(/function syncPanelAuto\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, '拿不到 syncPanelAuto');
  assert.match(fn[0], /Selection\.count\(\) === 0/, '判据是「手里有没有点」');
  assert.match(fn[0], /readPanelChoice\(\) !== null/, '他手动定过就别自动');
  assert.match(fn[0], /narrowScreen\(\)/, '窄屏不这么干（那里右栏是整幅一行）');
  // 加点/删点都会走 renderSelection ⇒ 在那里同步
  const render = APP.match(/function renderSelection\(\)[\s\S]*?\n  \}/);
  assert.ok(render, '缺 renderSelection');
  assert.match(render[0], /syncPanelAuto\(\)/, 'renderSelection 里要同步右栏显隐');
  // 手动点箭头 ⇒ 记住他的选择
  const toggle = APP.match(/function onTogglePanel\(\)[\s\S]*?\n  \}/);
  assert.ok(toggle, '缺 onTogglePanel');
  assert.match(toggle[0], /savePanelChoice\(/, '手动点过要记住');
});

test('右栏收起/展开走 applyPanelCollapsed（class + aria + 地图 resize 一处收口）', () => {
  const apply = APP.match(/function applyPanelCollapsed\(collapsed\)[\s\S]*?\n  \}/);
  assert.ok(apply, '缺 applyPanelCollapsed');
  assert.match(apply[0], /classList\.toggle\('collapsed'/, '要切 collapsed');
  assert.match(apply[0], /aria-expanded/, '要同步 aria-expanded');
  assert.match(apply[0], /MapCtl\.resize/, '收起后地图变宽要 resize');
  assert.match(apply[0], /if \(panel\.classList\.contains\('collapsed'\) === next\) return;/, '状态没变就别折腾地图');
});
