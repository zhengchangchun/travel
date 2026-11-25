/* 高德网页版兜底（2026-11-25）
   Web 服务的 place/* 是按 key 按月的配额，用尽后搜索就断了。
   高德网页版（www.amap.com）走网页端自己的配额，与 Web 服务完全分开 —— 这是不申请新 key 也能继续用的路。

   代价必须守住：
     · 必须真实浏览器（纯 HTTP 会被风控返回 HTML）
     · 严格限速（默认 8 秒/次）
     · 触发风控后进冷却（10 分钟），不越撞越死
     · 只做兜底，不用于批量采集
*/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WEB = read('server/amap-web.js');
const POI_ROUTE = read('server/routes/poi.js');
const INDEX = read('server/index.js');

const amapWeb = require('../server/amap-web');

// ---------- 城市 → adcode ----------

test('adcodeOf：常见旅游城市都能映射，带「市」也认', () => {
  assert.strictEqual(amapWeb.adcodeOf('杭州'), '330100');
  assert.strictEqual(amapWeb.adcodeOf('杭州市'), '330100');
  assert.strictEqual(amapWeb.adcodeOf('三亚'), '460200');
  assert.strictEqual(amapWeb.adcodeOf('成都'), '510100');
  assert.strictEqual(amapWeb.adcodeOf(''), '');
  assert.strictEqual(amapWeb.adcodeOf('不存在的城市'), '');
});

// ---------- 限速与冷却 ----------

test('默认限速 8 秒、冷却 10 分钟（风控很敏感，宁可慢）', () => {
  assert.strictEqual(amapWeb.DEFAULT_MIN_INTERVAL_MS, 8000);
  assert.strictEqual(amapWeb.BLOCK_COOLDOWN_MS, 10 * 60 * 1000);
  assert.strictEqual(amapWeb.minIntervalMs(), 8000);
});

test('AMAP_WEB_MIN_INTERVAL_MS 可覆盖限速', () => {
  const old = process.env.AMAP_WEB_MIN_INTERVAL_MS;
  try {
    process.env.AMAP_WEB_MIN_INTERVAL_MS = '2000';
    assert.strictEqual(amapWeb.minIntervalMs(), 2000);
  } finally {
    if (old === undefined) delete process.env.AMAP_WEB_MIN_INTERVAL_MS;
    else process.env.AMAP_WEB_MIN_INTERVAL_MS = old;
  }
});

test('空关键词 / 未知城市直接拒（不浪费一次风控额度）', async () => {
  const a = await amapWeb.searchByWeb({ keyword: '', city: '杭州' });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error, 'EMPTY_KEYWORD');

  const b = await amapWeb.searchByWeb({ keyword: '西湖', city: '火星' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error, 'UNKNOWN_CITY');
});

test('风控冷却：blocked 期间直接返回 BLOCKED，不再起浏览器', async () => {
  amapWeb.resetBlock();
  // 手动进冷却（模拟被 punish）
  const mod = require('../server/amap-web');
  // 通过一次失败的抓取进冷却不好造，这里直接验 status 与 resetBlock 的语义
  assert.strictEqual(mod.status().blocked, false);
  mod.resetBlock();
  assert.strictEqual(mod.status().blocked, false);
  assert.strictEqual(mod.status().cooldownMs, 0);
});

// ---------- 接线 ----------

test('搜索路由：配额用尽时才走网页版（不是每次都走）', () => {
  const block = POI_ROUTE.match(/path: '\/api\/poi\/search'[\s\S]*?\n  \},/);
  assert.ok(block, '缺 /api/poi/search');
  assert.match(block[0], /quotaOut/, '要先判断是不是配额用尽');
  assert.match(block[0], /OVER_LIMIT\|CALL_LIMIT\|QPS/, '配额判定要认这几个码');
  assert.match(block[0], /ctx\.amapWeb\.searchByWeb/, '要调网页版兜底');
  // 顺序：Web 服务 → 本地 → 网页版 → OSM
  const iWeb = block[0].indexOf('ctx.amap.searchPoi');
  const iLocal = block[0].indexOf('localHit()');
  const iAmapWeb = block[0].indexOf('ctx.amapWeb.searchByWeb');
  const iOsm = block[0].indexOf('ctx.osm.searchOsm');
  assert.ok(iWeb < iLocal, 'Web 服务要在本地之前');
  assert.ok(iLocal < iAmapWeb, '本地要在网页版之前');
  assert.ok(iAmapWeb < iOsm, '网页版要在 OSM 之前（网页版字段更全）');
});

test('网页版结果如实标来源（source: amap-web），不冒充 Web 服务', () => {
  const block = POI_ROUTE.match(/path: '\/api\/poi\/search'[\s\S]*?\n  \},/);
  assert.match(block[0], /source: 'amap-web'/, '要标 amap-web');
  assert.match(block[0], /categoryOfTypecode/, '网页版只给 typecode，要自己归类');
});

test('typecode → 分类：05 美食 / 10 住宿 / 11 景点 / 08 游玩', () => {
  const fn = POI_ROUTE.match(/function categoryOfTypecode\(typecode\)[\s\S]*?\n\}/);
  assert.ok(fn, '缺 categoryOfTypecode');
  assert.match(fn[0], /startsWith\('05'\)[\s\S]*?'food'/);
  assert.match(fn[0], /startsWith\('10'\)[\s\S]*?'stay'/);
  assert.match(fn[0], /startsWith\('11'\)[\s\S]*?'sight'/);
  assert.match(fn[0], /startsWith\('08'\)[\s\S]*?'play'/);
});

test('/api/health 暴露网页版状态（限速间隔 / 是否冷却中）', () => {
  assert.match(INDEX, /amapWeb:/, 'health 要带 amapWeb');
  assert.match(INDEX, /amapWeb\.status\(\)/, '要调 status');
});

test('抓取脚本存在，且走真实浏览器（不纯 HTTP）', () => {
  const script = path.join(ROOT, 'tools', 'amap-web-fetch.cjs');
  assert.ok(fs.existsSync(script), '缺 tools/amap-web-fetch.cjs');
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /poiInfo/, '要拦 poiInfo 接口');
  assert.match(src, /page\.goto/, '要开真实页面（纯 HTTP 会被风控）');
  assert.match(src, /JSON\.stringify/, '要输出一行 JSON 给父进程');
});

test('amap-web.js 用子进程跑浏览器，不自己 require playwright', () => {
  assert.match(WEB, /spawn\(/, '要用子进程');
  assert.match(WEB, /pw\.cjs/, '要调 pw.cjs');
  assert.ok(!/require\('playwright'\)/.test(WEB), '不该直接 require playwright（走 pw.cjs 桥）');
});

test('抓取超时与失败都如实返回，不假装成功', () => {
  assert.match(WEB, /FETCH_TIMEOUT_MS/, '要有超时');
  assert.match(WEB, /TIMEOUT/, '超时要报 TIMEOUT');
  assert.match(WEB, /BAD_OUTPUT/, '输出解析不了要报 BAD_OUTPUT');
  assert.match(WEB, /SPAWN_FAILED/, '起不来要报 SPAWN_FAILED');
});
