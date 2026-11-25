/* 机票价格 / 「最近去哪便宜」（2026-11-25）
   ① 价格**只放内存**，绝不落盘（用户口径：「不能持久化到我这，要不然数据更新了 我们就都是错的」）
   ② 缓存有 TTL，过期重抓；抓失败退回旧数据要标 stale
   ③ 推荐排序：按「连续 N 天均价」排，不是按单日最低
   ④ 跨年日期要补对年份（12 月看 01-05 是明年） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fares = require('../server/fares');
const rank = require('../server/fare-rank');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FARES = read('server/fares.js');
const ROUTE = read('server/routes/fares.js');
const DB = read('server/db.js');

// ---------- ① 不落盘 ----------

test('价格模块不写库、不写文件（只放进程内存）', () => {
  // 不许 require 数据库 / fs 写操作
  assert.ok(!/require\(['"]\.\/db['"]\)/.test(FARES), 'fares.js 不该引 db');
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(FARES), 'fares.js 不该写文件');
  assert.ok(!/INSERT INTO|UPDATE .* SET/.test(FARES), 'fares.js 不该写库');
  // 缓存是模块级变量
  assert.match(FARES, /let cache = \{ at: 0, data: null, running: null \}/, '缓存应是模块级内存变量');
});

test('pois / 新表都不存机票价格', () => {
  assert.ok(!/CREATE TABLE[^;]*fare/i.test(DB), '不该有 fares 表');
  assert.ok(!/CREATE TABLE[^;]*flight/i.test(DB), '不该有 flight 表');
});

test('缓存 TTL 默认 30 分钟，可用环境变量覆盖', () => {
  assert.strictEqual(fares.DEFAULT_TTL_MS, 30 * 60 * 1000);
  const old = process.env.FARE_TTL_MS;
  process.env.FARE_TTL_MS = '60000';
  assert.strictEqual(fares.ttlMs(), 60000);
  if (old === undefined) delete process.env.FARE_TTL_MS;
  else process.env.FARE_TTL_MS = old;
});

test('接口如实回报缓存状态（cached / ageSeconds / stale）', () => {
  assert.match(ROUTE, /cached: !!r\.cached/, '要回报 cached');
  assert.match(ROUTE, /ageSeconds: r\.ageSeconds/, '要回报多久前抓的');
  assert.match(ROUTE, /stale: !!r\.stale/, '要回报是不是旧数据');
  assert.match(ROUTE, /ttlSeconds/, '要回报缓存多久过期');
});

// ---------- ② 日期与窗口 ----------

test('跨年：12 月看到 01-05 要算成明年', () => {
  const now = new Date('2026-12-20T10:00:00');
  assert.strictEqual(rank.toFullDate('01-05', now), '2027-01-05');
  assert.strictEqual(rank.toFullDate('12-25', now), '2026-12-25');
  // 同月不跨年
  assert.strictEqual(rank.toFullDate('11-28', new Date('2026-11-25T10:00:00')), '2026-11-28');
});

test('非法日期返回 null（不编造）', () => {
  assert.strictEqual(rank.toFullDate('13-40', new Date()), null);
  assert.strictEqual(rank.toFullDate('', new Date()), null);
  assert.strictEqual(rank.toFullDate('abc', new Date()), null);
});

test('bestWindow：只认连续日期，断档不算一个窗口', () => {
  const days = [
    { date: '2026-11-26', price: 500 },
    { date: '2026-11-27', price: 400 },
    // 11-28 缺
    { date: '2026-11-29', price: 100 },
    { date: '2026-11-30', price: 100 },
    { date: '2026-12-01', price: 100 },
  ];
  const w = rank.bestWindow(days, 3);
  assert.ok(w, '应找到窗口');
  // 11-29~12-01 连续且总价 300，比 11-26~11-27 那组（断档）更优
  assert.strictEqual(w.start, '2026-11-29');
  assert.strictEqual(w.end, '2026-12-01');
  assert.strictEqual(w.total, 300);
  assert.strictEqual(w.avg, 100);
});

test('bestWindow：天数不够返回 null', () => {
  assert.strictEqual(rank.bestWindow([{ date: '2026-11-26', price: 100 }], 3), null);
  assert.strictEqual(rank.bestWindow([], 3), null);
});

// ---------- ③ 排序 ----------

test('排序按「连续 N 天均价」，不是按单日最低', () => {
  const raw = {
    // 单日最低 100，但前后两天很贵 ⇒ 3 天均价高
    A: { days: [
      { md: '11-26', price: 900 },
      { md: '11-27', price: 100 },
      { md: '11-28', price: 900 },
    ] },
    // 单日最低 200，但三天都便宜 ⇒ 均价低，应该排前面
    B: { days: [
      { md: '11-26', price: 200 },
      { md: '11-27', price: 200 },
      { md: '11-28', price: 200 },
    ] },
  };
  const out = rank.rankDestinations(raw, { now: new Date('2026-11-25T10:00:00'), span: 3 });
  assert.strictEqual(out[0].city, 'B', 'B 的 3 天均价更低，应排第一');
  assert.strictEqual(out[1].city, 'A');
});

test('抓失败的目的地直接不出现（不拿「暂无」占位）', () => {
  const raw = {
    好: { days: [{ md: '11-26', price: 300 }, { md: '11-27', price: 300 }, { md: '11-28', price: 300 }] },
    坏: { error: 'timeout' },
  };
  const out = rank.rankDestinations(raw, { now: new Date('2026-11-25T10:00:00') });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].city, '好');
});

test('窗口外的日期被剔除（只看未来 N 天）', () => {
  const raw = {
    X: { days: [
      { md: '11-26', price: 300 },
      { md: '11-27', price: 300 },
      { md: '11-28', price: 300 },
      { md: '01-20', price: 100 }, // 60 天后，窗口 30 天外
    ] },
  };
  const out = rank.rankDestinations(raw, { now: new Date('2026-11-25T10:00:00'), windowDays: 30 });
  assert.strictEqual(out[0].days, 3, '窗口外那天不该算进来');
  assert.strictEqual(out[0].low, 300, '最低价不该取窗口外那个 100');
});

test('过去的日期被剔除', () => {
  const raw = {
    X: { days: [
      { md: '11-20', price: 100 }, // 已经过去
      { md: '11-26', price: 300 },
      { md: '11-27', price: 300 },
      { md: '11-28', price: 300 },
    ] },
  };
  const out = rank.rankDestinations(raw, { now: new Date('2026-11-25T10:00:00') });
  assert.strictEqual(out[0].low, 300, '过去的日期不该参与');
});

test('savingPct：比中位价便宜多少（用来标「比平时便宜」）', () => {
  const raw = {
    X: { days: [
      { md: '11-26', price: 500 },
      { md: '11-27', price: 500 },
      { md: '11-28', price: 250 },
      { md: '11-29', price: 500 },
      { md: '11-30', price: 500 },
    ] },
  };
  const out = rank.rankDestinations(raw, { now: new Date('2026-11-25T10:00:00') });
  assert.strictEqual(out[0].median, 500);
  assert.strictEqual(out[0].savingPct, 50, '250 比中位 500 便宜 50%');
});

// ---------- ④ 页面 ----------

test('页面：有「去哪便宜」入口，且写明价格不落盘', () => {
  const HEAD = read('web/js/headbar.js');
  assert.match(HEAD, /item\('\/fares', '去哪便宜'\)/, '导航要有「去哪便宜」');
  const HTML = read('web/fares.html');
  assert.match(HTML, /不存到本机/, '页面要写明价格不落盘');
  const JS = read('web/js/fares.js');
  assert.match(JS, /ageText/, '要显示多久前抓的');
  assert.match(JS, /stale/, '要处理「这次没抓成功」');
});
