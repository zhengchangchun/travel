'use strict';
/*
 * 机票价格（2026-11-25）：给「最近适合去哪旅游」用。
 *
 * ⚠️ 核心口径（用户 2026-11-25 定）：
 *   「不要所有的数据都存在本地，可以做缓存 但是不能持久化到我这，
 *     要不然数据更新了 我们就都是错的」
 *   ⇒ 价格**只放进程内存**，绝不写库、绝不写文件。进程重启就没了，下次重新抓。
 *   ⇒ 缓存 TTL 也短（默认 30 分钟），过期就重新抓，宁可慢一点也不给旧价。
 *
 * 数据来源：同程 ly.com 的每日最低价日历（免登录、URL 可直接构造）。
 *   页面结构是「日期行 + 下一行价格」两行一组，见 tools/browser/ly-calendar.cjs。
 *   抓取走本机 Playwright（`tools/browser/pw.cjs`），因为同程对无头浏览器有风控，
 *   用真实浏览器 profile 才稳。
 *
 * 为什么不在服务端直接 fetch：同程页面是 JS 渲染的，纯 HTTP 拿不到日历。
 * 所以这里 spawn 一个 node 子进程跑 pw.cjs，把 JSON 从 stdout 捞回来。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

// 缓存 TTL：30 分钟。价格变动以小时计，30 分钟足够新；再长就可能给错价。
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// 从杭州出发的候选目的地（机场码 → 中文名）。
// 只放「从杭州能直飞、且是旅游城市」的，别把全国机场都塞进来。
const DESTINATIONS = [
  { code: 'SYX', city: '三亚', airport: '凤凰国际' },
  { code: 'XMN', city: '厦门', airport: '高崎' },
  { code: 'CTU', city: '成都', airport: '天府/双流' },
  { code: 'CKG', city: '重庆', airport: '江北' },
  { code: 'KMG', city: '昆明', airport: '长水' },
  { code: 'XIY', city: '西安', airport: '咸阳' },
  { code: 'CSX', city: '长沙', airport: '黄花' },
  { code: 'TAO', city: '青岛', airport: '胶东' },
  { code: 'DLC', city: '大连', airport: '周水子' },
  { code: 'SHE', city: '沈阳', airport: '桃仙' },
  { code: 'HGH', city: '杭州', airport: '萧山' }, // 出发地，不参与
];

const ORIGIN = { code: 'HGH', city: '杭州' };

// 进程内缓存（不落盘）。key = 'fares'，整批一起存 —— 一次抓 10 个目的地，
// 分开存反而容易出现「一半新一半旧」的拼接错误。
let cache = { at: 0, data: null, running: null };

function ttlMs() {
  const n = Number(process.env.FARE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function isFresh() {
  return !!cache.data && Date.now() - cache.at < ttlMs();
}

function ageSeconds() {
  if (!cache.at) return null;
  return Math.round((Date.now() - cache.at) / 1000);
}

// 跑一次抓取（子进程）。返回 { ok, data, error }
function runScrape({ timeoutMs = 240000 } = {}) {
  return new Promise((resolve) => {
    const script = path.join(os.homedir(), '.nanobot', 'workspace', 'tools', 'browser', 'ly-calendar.cjs');
    const pw = path.join(os.homedir(), '.nanobot', 'workspace', 'tools', 'browser', 'pw.cjs');
    const child = spawn('/bin/zsh', ['-lic', `node ${JSON.stringify(pw)} run ${JSON.stringify(script)} --profile travelcheck`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* 已经退了 */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('JSON='));
      if (!line) {
        resolve({ ok: false, error: (err || out || '抓取没有输出').slice(-400) });
        return;
      }
      try {
        const data = JSON.parse(line.slice('JSON='.length));
        resolve({ ok: true, data });
      } catch (e) {
        resolve({ ok: false, error: '抓取结果不是合法 JSON：' + e.message });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: '起不了抓取进程：' + e.message });
    });
  });
}

/*
 * 拿一批价格。口径：
 *   - 有新鲜缓存 ⇒ 直接给（标 cached:true + ageSeconds）
 *   - 没有 ⇒ 抓一次；抓的过程中再来请求就等同一个 promise（单飞，不重复起浏览器）
 *   - 抓失败 ⇒ 返回上一次的（如果有），并如实标 stale + error；没有就报错
 */
async function getFares({ force = false } = {}) {
  if (!force && isFresh()) {
    return { ok: true, cached: true, ageSeconds: ageSeconds(), data: cache.data };
  }
  if (cache.running) {
    const r = await cache.running;
    return r;
  }
  cache.running = (async () => {
    const r = await runScrape();
    if (r.ok) {
      cache = { at: Date.now(), data: r.data, running: null };
      return { ok: true, cached: false, ageSeconds: 0, data: r.data };
    }
    // 抓失败：有旧数据就给旧的（明确标 stale），没有就报错
    if (cache.data) {
      return {
        ok: true,
        cached: true,
        stale: true,
        ageSeconds: ageSeconds(),
        error: r.error,
        data: cache.data,
      };
    }
    return { ok: false, error: r.error };
  })();
  try {
    return await cache.running;
  } finally {
    cache.running = null;
  }
}

// 测试用：清掉内存缓存
function resetCache() {
  cache = { at: 0, data: null, running: null };
}

module.exports = {
  DESTINATIONS,
  ORIGIN,
  DEFAULT_TTL_MS,
  ttlMs,
  getFares,
  resetCache,
  ageSeconds,
  isFresh,
};
