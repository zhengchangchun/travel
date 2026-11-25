'use strict';
/*
 * 高德网页版兜底（2026-11-25）
 *
 * 为什么要有它：高德 Web 服务的 `place/*` 是**按 key 按月**的配额（个人 5000 次/月），
 * 用尽后搜索整条链就断了。但高德网页版（www.amap.com）走的是**网页端自己的配额**，
 * 与 Web 服务完全分开 —— 这是「不申请新 key 也能继续用」的唯一一条路。
 *
 * 代价（必须如实说）：
 *   · 必须用真实浏览器（纯 HTTP 会被风控返回 HTML 验证页）
 *   · 连续快速请求会触发滑块验证（FAIL_SYS_USER_VALIDATE / punishTextFetch）
 *     ⇒ 严格限速（默认 1 次 / 8 秒），且失败就退，不重试
 *   · 比 Web 服务慢（每次要开一次页面，约 10–25 秒）
 *
 * 所以它只做**兜底**：Web 服务配额用尽时才走，且只用于「用户主动搜一个词」这种低频场景，
 * 不用于批量采集（采集会瞬间打爆风控）。
 *
 * 字段比 Web 服务还全：rating / 人均 / 图片 / typecode / 招牌菜 / 商圈。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PW = path.join(os.homedir(), '.nanobot', 'workspace', 'tools', 'browser', 'pw.cjs');
const SCRIPT = path.join(ROOT, 'tools', 'amap-web-fetch.cjs');

// 限速：默认 8 秒一次。风控很敏感，宁可慢。
const DEFAULT_MIN_INTERVAL_MS = 8000;
// 单次抓取超时（开页面 + 等接口）
const FETCH_TIMEOUT_MS = 60000;

let lastCallAt = 0;
// 风控冷却：被 punish 之后一段时间内不再尝试（避免越撞越死）
let blockedUntil = 0;
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000; // 10 分钟

function minIntervalMs() {
  const n = Number(process.env.AMAP_WEB_MIN_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBlocked() {
  return Date.now() < blockedUntil;
}

function blockRemainingMs() {
  return Math.max(0, blockedUntil - Date.now());
}

// 跑一次抓取子进程，stdout 一行 JSON
function runFetch({ keyword, city, profile }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      AMAP_WEB_KEYWORD: String(keyword || ''),
      AMAP_WEB_CITY: String(city || ''),
    };
    const args = [PW, 'run', SCRIPT];
    if (profile) args.push('--profile', profile);
    const child = spawn(process.execPath, args, {
      env,
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* 已经退了 */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), FETCH_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => finish({ ok: false, error: 'SPAWN_FAILED', message: e.message }));
    child.on('close', () => {
      // stdout 可能有多行（pw.cjs 会打日志），取最后一行能解析的 JSON
      const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const j = JSON.parse(lines[i]);
          finish(j);
          return;
        } catch (e) {
          /* 继续往前找 */
        }
      }
      finish({ ok: false, error: 'BAD_OUTPUT', message: (err || out).slice(0, 300) });
    });
  });
}

// 城市名 → adcode（网页版要 adcode，不是城市名）
const CITY_ADCODE = {
  杭州: '330100',
  三亚: '460200',
  成都: '510100',
  厦门: '350200',
  西安: '610100',
  大理: '532900',
  重庆: '500000',
  昆明: '530100',
  长沙: '430100',
  青岛: '370200',
  大连: '210200',
  沈阳: '210100',
  上海: '310000',
  北京: '110000',
  广州: '440100',
  深圳: '440300',
  南京: '320100',
  苏州: '320500',
  武汉: '420100',
};

function adcodeOf(city) {
  const s = String(city || '').trim().replace(/市$/, '');
  return CITY_ADCODE[s] || '';
}

// 主入口：按关键词搜（走网页版配额）
// 返回 { ok, items, error, blocked, cooldownMs }
async function searchByWeb({ keyword, city, profile } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, error: 'EMPTY_KEYWORD', items: [] };
  if (isBlocked()) {
    return { ok: false, error: 'BLOCKED', blocked: true, cooldownMs: blockRemainingMs(), items: [] };
  }
  const adcode = adcodeOf(city);
  if (!adcode) return { ok: false, error: 'UNKNOWN_CITY', items: [] };

  // 限速
  const wait = lastCallAt + minIntervalMs() - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const r = await runFetch({ keyword: kw, city: adcode, profile });
  if (!r || !r.ok) {
    // 风控：进冷却
    if (r && (r.error === 'NO_DATA' || /punish|VALIDATE/i.test(String(r.message || '')))) {
      blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      return { ok: false, error: 'BLOCKED', blocked: true, cooldownMs: BLOCK_COOLDOWN_MS, items: [] };
    }
    return { ok: false, error: (r && r.error) || 'FETCH_FAILED', items: [] };
  }
  return { ok: true, items: Array.isArray(r.items) ? r.items : [], ms: r.ms };
}

function status() {
  return {
    minIntervalMs: minIntervalMs(),
    blocked: isBlocked(),
    cooldownMs: blockRemainingMs(),
    lastCallAt: lastCallAt ? new Date(lastCallAt).toISOString() : null,
  };
}

function resetBlock() {
  blockedUntil = 0;
  lastCallAt = 0;
}

module.exports = {
  searchByWeb,
  adcodeOf,
  status,
  resetBlock,
  isBlocked,
  minIntervalMs,
  CITY_ADCODE,
  DEFAULT_MIN_INTERVAL_MS,
  BLOCK_COOLDOWN_MS,
};
