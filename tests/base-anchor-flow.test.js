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
  assert.match(HTML, /id="base-around-btn"[^>]*>看周边/, 'index 缺「看周边」按钮');
  assert.match(HTML, /id="base-clear-btn"/, 'index 缺清除按钮');
  assert.match(HTML, /<script src="\/js\/geo\.js"><\/script>/, 'index 未引 geo.js');
});

test('锚点状态与持久化：state.bases（可多个）+ localStorage 读写 + 旧键迁移', () => {
  assert.match(APP, /base:\s*null/, 'state 缺 base（当前锚点）');
  assert.match(APP, /bases:\s*\[\]/, 'state 缺 bases（可多个锚点）');
  assert.match(APP, /baseRadiusM:\s*\d+/, 'state 缺 baseRadiusM');
  assert.match(APP, /const BASES_KEY = 'travel\.bases'/, '缺多锚点持久化键');
  assert.match(APP, /const BASE_ACTIVE_KEY = 'travel\.baseActiveId'/, '缺「当前锚点」持久化键');
  assert.match(APP, /const BASE_RADIUS_KEY = 'travel\.baseRadiusM'/, '缺半径持久化键');
  assert.match(APP, /function\s+loadBaseFromStore/, '缺 loadBaseFromStore');
  assert.match(APP, /function\s+saveBaseToStore/, '缺 saveBaseToStore');
  assert.match(APP, /localStorage\.getItem\(BASES_KEY\)/, '未从 localStorage 读多锚点');
  assert.match(APP, /localStorage\.setItem\(BASES_KEY/, '未把多锚点写 localStorage');
  // 旧版单锚点数据要能迁移过来
  assert.match(APP, /localStorage\.getItem\(BASE_KEY\)/, '旧单锚点键要留着做迁移');
  // 启动时恢复
  assert.match(APP, /loadBaseFromStore\(\);\s*\n\s*renderBase\(\);/m, '启动未恢复锚点');
});

test('多个锚点：加/切当前/删一个/清全部，且地图支持多个锚点', () => {
  assert.match(APP, /function\s+setBase\(poi\)/, '缺 setBase');
  // 再点「住这」＝取消这个锚点（列表里已有就不重复加）
  const setter = APP.match(/function\s+setBase\(poi\)[\s\S]*?\n  \}/);
  assert.ok(setter, '缺 setBase 函数体');
  assert.match(setter[0], /findBaseIndex\(id\)\s*>=\s*0/, '应先看是否已是锚点');
  assert.match(setter[0], /state\.bases\.push/, '新锚点要 push 进列表');
  assert.match(APP, /function\s+setActiveBase/, '缺「切当前锚点」');
  assert.match(APP, /function\s+removeBase/, '缺「删一个锚点」');
  assert.match(APP, /function\s+clearBase/, '缺「清空」');
  assert.match(APP, /state\.bases\.splice/, '删一个应 splice');
  // 卡片里要有列表容器（多个锚点名 + ×）
  assert.match(HTML, /<ul id="base-list" class="base-list hidden"><\/ul>/, '缺锚点列表容器');
  assert.match(APP, /base-row-name/, '缺行内「点名字切当前」按钮');
  assert.match(APP, /base-row-del/, '缺行内删除按钮');
  // 地图：多锚点高亮
  assert.match(MAP, /baseIds/, 'map.js 应按多个锚点高亮');
  assert.match(MAP, /function\s+setBase\(ids\)[\s\S]{0,160}map\(String\)/, 'map.setBase 应接收数组');
  assert.match(APP, /MapCtl\.setBase\(state\.bases\.map/, '渲染时应把全部锚点交给地图');
  // 「住这」按钮对锚点之一即视为已选中
  assert.match(APP, /function\s+baseIs[\s\S]{0,120}findBaseIndex/, 'baseIs 应看整个列表');
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

test('一键回中：回中按钮把相机拉回住宿锚点且不重查接口', () => {
  assert.match(HTML, /id="base-locate-btn"[^>]*>回中/, 'index 缺「回中」按钮');
  const m = APP.match(/function\s+locateBase[\s\S]*?\n  \}/);
  assert.ok(m, '缺 locateBase');
  assert.match(m[0], /flyTo\(Number\(b\.lng\), Number\(b\.lat\), 15\)/, '回中未把相机拉到锚点');
  assert.ok(!/fetchPoisInView|liveSearchViewport/.test(m[0]), '回中不应触发查询');
  assert.match(APP, /locateBtn\.onclick = locateBase/, '按钮未绑定');
});

test('同一范围重复查看不重复打接口：TTL 内直接走缓存', () => {
  assert.match(APP, /const QUERY_TTL_MS = 10 \* 60 \* 1000/, '缺 TTL 常量');
  assert.match(APP, /queriedAt: \{\}/, 'state 缺 queriedAt');
  assert.match(APP, /function\s+queryKeyOf/, '缺 queryKeyOf');
  assert.match(APP, /function\s+recentlyQueried/, '缺 recentlyQueried');
  const m = APP.match(/async function\s+liveSearchViewport[\s\S]*?\n  \}/);
  assert.ok(m, '缺 liveSearchViewport');
  assert.match(m[0], /const age = recentlyQueried\(key\)/, '未先查 TTL');
  assert.match(m[0], /走缓存（0 次调用）/, '缺去重提示');
  assert.match(m[0], /state\.queriedAt\[key\] = Date\.now\(\)/, '查完未记录时间戳');
  // 去重判断必须在真正发请求之前
  const dupAt = m[0].indexOf('recentlyQueried(key)');
  const reqAt = m[0].indexOf('API.liveInView(');
  assert.ok(dupAt >= 0 && reqAt > dupAt, 'TTL 去重应在发请求之前');
});

test('锚点不再强行常驻：没选住宿就不该冒出住宿旗子（但地图标记与卡片仍在）', () => {
  assert.ok(!/ensureBaseVisible/.test(APP), '不应再有「把锚点硬塞进可见集合」的逻辑');
  assert.match(APP, /const full = currentList\(\)/, 'refresh 应直接用过滤结果');
  assert.match(APP, /function\s+renderBase/, '锚点卡片仍在（改半径/回中/清除都在这）');
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
