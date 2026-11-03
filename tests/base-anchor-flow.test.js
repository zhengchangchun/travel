const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('web/js/app.js');
const MAP = read('web/js/map.js');
const UI = read('web/js/ui.js');
const DETAIL = read('web/js/detail.js');
const HTML = read('web/index.html');
const CSS = read('web/css/style.css');

test('侧栏有「住宿锚点」卡片：名称/半径/看周边/清除 四个资产齐', () => {
  assert.match(HTML, /id="base-name"/, 'index 缺 #base-name');
  assert.match(HTML, /id="base-sub"/, 'index 缺 #base-sub');
  assert.match(HTML, /id="base-radius"/, 'index 缺半径选择 #base-radius');
  assert.match(HTML, /id="base-around-btn"[^>]*>看周边美食\/景点/, 'index 缺「看周边」按钮');
  assert.match(HTML, /id="base-clear-btn"/, 'index 缺清除按钮');
  assert.match(HTML, /<script src="\/js\/geo\.js"><\/script>/, 'index 未引 geo.js');
});

test('锚点状态与持久化：state.base/baseRadiusM + localStorage 读写', () => {
  assert.match(APP, /base:\s*null/, 'state 缺 base');
  assert.match(APP, /baseRadiusM:\s*\d+/, 'state 缺 baseRadiusM');
  assert.match(APP, /const BASE_KEY = 'travel\.base'/, '缺锚点持久化键');
  assert.match(APP, /const BASE_RADIUS_KEY = 'travel\.baseRadiusM'/, '缺半径持久化键');
  assert.match(APP, /function\s+loadBaseFromStore/, '缺 loadBaseFromStore');
  assert.match(APP, /function\s+saveBaseToStore/, '缺 saveBaseToStore');
  assert.match(APP, /localStorage\.getItem\(BASE_KEY\)/, '未从 localStorage 读锚点');
  assert.match(APP, /localStorage\.setItem\(BASE_KEY/, '未把锚点写 localStorage');
  // 启动时恢复
  assert.match(APP, /loadBaseFromStore\(\);\s*\n\s*renderBase\(\);/m, '启动未恢复锚点');
});

test('定锚点：setBase/clearBase + 列表与详情卡两个入口', () => {
  assert.match(APP, /function\s+setBase\(poi\)/, '缺 setBase');
  assert.match(APP, /function\s+clearBase\(\)/, '缺 clearBase');
  assert.match(APP, /onSetBase:\s*setBase/, 'refresh 未把 onSetBase 传给列表');
  assert.match(APP, /onSetBase:\s*setBase,?\s*\n\s*\}\);/, '详情卡未接 onSetBase');
  assert.match(UI, /function\s+baseButton/, 'ui 缺 baseButton');
  assert.match(UI, /poi\.category === 'stay' \? baseButton/, '列表未只给住宿项加「住这」');
  assert.match(DETAIL, /data\.category === 'stay' \? .*base-pick/, '详情卡未只给住宿项加「定为住宿」');
  assert.match(DETAIL, /handlers\.onSetBase/, '详情卡未接 onSetBase');
});

test('看周边：分类锁到 美食+景点，相机落到周边框（触发视野加载）', () => {
  const m = APP.match(/function\s+showAroundBase[\s\S]*?\n  \}/);
  assert.ok(m, '缺 showAroundBase');
  assert.match(m[0], /Geo\.bboxAround\(state\.base, state\.baseRadiusM\)/, '未按锚点+半径算框');
  assert.match(m[0], /new Set\(\['food', 'sight'\]\)/, '周边默认应看美食+景点');
  assert.match(m[0], /MapCtl\.fitBbox\(bbox\)/, '未把相机落到周边框');
  assert.match(m[0], /fetchPoisInView\(\)/, '未兜底触发视野加载');
  assert.match(
    APP,
    /const aroundBtn = \$\('base-around-btn'\);\s*\n\s*if \(aroundBtn\) aroundBtn\.onclick = showAroundBase/,
    '按钮未绑定 showAroundBase'
  );
  assert.match(APP, /state\.baseRadiusM = Number\(radiusSel\.value\)/, '半径切换未生效');
});

test('锚点常驻显示：被过滤掉也带上 + 地图金色「住」标', () => {
  assert.match(APP, /function\s+ensureBaseVisible/, '缺 ensureBaseVisible');
  assert.match(APP, /ensureBaseVisible\(currentList\(\)\)/, 'refresh 未用 ensureBaseVisible');
  assert.match(MAP, /function\s+setBase/, 'map 缺 setBase');
  assert.match(MAP, /isBase \? ' base' : ''/, 'flagHtml 未加 base 样式类');
  assert.match(MAP, /flag-base/, 'flagHtml 缺「住」角标');
  assert.match(MAP, /function\s+fitBbox/, 'map 缺 fitBbox');
  assert.match(CSS, /\.flag\.base \.flag-head/, 'css 缺锚点金边');
  assert.match(CSS, /\.flag-base/, 'css 缺「住」角标样式');
});

test('fitBbox 用 AMap.Bounds 且失败不抛', () => {
  const m = MAP.match(/function\s+fitBbox[\s\S]*?\n  \}/);
  assert.ok(m, '缺 fitBbox');
  assert.match(m[0], /new AMap\.Bounds/, '应用 AMap.Bounds');
  assert.match(m[0], /try\s*\{/, 'fitBbox 应 try/catch，失败不抛');
  assert.match(m[0], /return false/, '失败应返回 false 让上层兜底');
});
