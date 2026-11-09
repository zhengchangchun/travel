// 笔记抓取（服务端入口）：让本机 Playwright + 各平台已登录 profile 去把笔记/视频抓回来
//
// 为什么不在 Node 里直接请求平台接口：抖音要 a_bogus、小红书要 x-s，都是页面 JS 现算的签名。
// 所以走「浏览器里让页面自己加载，我们只拦它自己的响应」这条路（见 tools/note-fetch.cjs）。
//
// 本模块只负责：拼命令、跑子进程、解析 stdout 的一行 JSON、把失败形状统一成
//   { ok:false, error, message }（error 取值：BAD_PLATFORM / NEED_LOGIN / NO_DATA / FETCH_FAIL / TIMEOUT / NOT_IMPLEMENTED）
const { spawn } = require('node:child_process');
const path = require('node:path');
const { sourceOfUrl } = require('./note-share');

const ROOT = path.join(__dirname, '..');
const NODE = process.env.TRAVEL_NODE || '/opt/homebrew/bin/node';
const PW_CJS =
  process.env.TRAVEL_PW ||
  path.join(process.env.HOME || '', '.nanobot', 'workspace', 'tools', 'browser', 'pw.cjs');
const SCRIPT = path.join(ROOT, 'tools', 'note-fetch.cjs');
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAVEL_FETCH_TIMEOUT_MS) || 90000;
// 抓取器在 stdout 上吐的进度行（`#progress 打开搜索页`）。它不参与结果解析（结果取最后一行 JSON）
const PROGRESS_PREFIX = '#progress ';

// 长任务钩子（P10-⑩）：让上层能看到「现在到哪一步」、并在取消时把子进程杀掉
function hookCanceled(hooks) {
  try {
    return !!(hooks && typeof hooks.isCanceled === 'function' && hooks.isCanceled());
  } catch (err) {
    return false;
  }
}

function hookProgress(hooks, stage) {
  try {
    if (hooks && typeof hooks.onProgress === 'function') hooks.onProgress(stage);
  } catch (err) {
    /* 进度上报失败不影响抓取 */
  }
}

// 平台 → 本机浏览器 profile（B站走官方接口，不需要浏览器）
const PROFILE = { xhs: 'xhs', douyin: 'douyin', kuaishou: 'kuaishou' };

function platformOfUrl(url) {
  const hit = sourceOfUrl(url);
  return hit ? hit.source_type : '';
}

// 平台用哪个浏览器 profile：默认按表；可用 TRAVEL_PROFILE_XHS / _DOUYIN / _KUAISHOU 换（换号/换登录态时用）
function profileFor(sourceType) {
  if (!sourceType) return '';
  const env = process.env['TRAVEL_PROFILE_' + String(sourceType).toUpperCase()];
  if (env) return env;
  return PROFILE[sourceType] || '';
}

function fail(error, message, extra) {
  return Object.assign({ ok: false, error, message }, extra || {});
}

// 跑 pw.cjs（位置参数：mode platform a [b]），把最后一行 JSON 当结果
function runFetcher(argv, opts = {}) {
  const spawnImpl = opts.spawnImpl || spawn;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const hooks = opts.hooks || {};
  return new Promise((resolve) => {
    if (hookCanceled(hooks)) {
      resolve(fail('CANCELED', '已取消'));
      return;
    }
    let child;
    try {
      child = spawnImpl(NODE, [PW_CJS, 'run', SCRIPT].concat(argv), {
        env: Object.assign({}, process.env, opts.env || {}),
      });
    } catch (err) {
      resolve(fail('FETCH_FAIL', '抓取器启动失败：' + err.message));
      return;
    }
    // 把子进程交给上层：取消时可以直接 kill
    try {
      if (typeof hooks.onChild === 'function') hooks.onChild(child);
    } catch (err) {
      /* 忽略 */
    }
    let out = '';
    let err = '';
    let tail = ''; // 未成行的 stdout 尾巴（进度行按行解析）
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* 已退出 */
      }
      resolve(res);
    };
    const timer = setTimeout(() => finish(fail('TIMEOUT', '抓取超时（' + timeoutMs + 'ms）')), timeoutMs);
    if (child.stdout)
      child.stdout.on('data', (d) => {
        const text = d.toString();
        out += text;
        tail += text;
        const lines = tail.split('\n');
        tail = lines.pop();
        lines.forEach((l) => {
          const t = l.trim();
          if (t.startsWith(PROGRESS_PREFIX)) hookProgress(hooks, t.slice(PROGRESS_PREFIX.length).trim());
        });
        // 取消要快：一有输出就查一次，别等超时
        if (hookCanceled(hooks)) finish(fail('CANCELED', '已取消'));
      });
    if (child.stderr) child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => finish(fail('FETCH_FAIL', '抓取器跑不起来：' + e.message)));
    child.on('close', () => {
      if (hookCanceled(hooks)) {
        finish(fail('CANCELED', '已取消'));
        return;
      }
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].startsWith('{')) continue;
        try {
          finish(JSON.parse(lines[i]));
          return;
        } catch (e) {
          /* 继续往前找 */
        }
      }
      finish(fail('FETCH_FAIL', '抓取器没吐出结果' + (err ? '：' + err.trim().slice(0, 200) : '')));
    });
  });
}

// 重试前先看有没有被取消（取消后不要再起一次）
function retryAllowed(hooks) {
  return !hookCanceled(hooks);
}

// 单条：给链接就抓（小红书/抖音/快手走浏览器，B站走官方接口）
async function fetchNote({ url, timeoutMs, spawnImpl, hooks } = {}) {
  const u = String(url || '').trim();
  if (!u) return fail('BAD_REQUEST', '缺少 url');
  const platform = platformOfUrl(u);
  if (!platform) return fail('BAD_PLATFORM', '认不出这是哪个平台的链接：' + u.slice(0, 60));
  if (platform === 'bilibili') return fetchBilibili(u);
  const profile = profileFor(platform);
  if (!profile) return fail('BAD_PLATFORM', '这个平台还不支持抓取：' + platform);
  const argv = ['--profile', profile, 'url', platform, u];
  const first = await runFetcher(argv, { timeoutMs, spawnImpl, hooks });
  // 同一个浏览器 profile 被别的进程占着时会瞬挂 ⇒ 隔一秒再试一次（取消后不再试）
  if (
    first &&
    first.ok !== true &&
    (first.error === 'TIMEOUT' || first.error === 'FETCH_FAIL') &&
    retryAllowed(hooks)
  ) {
    await new Promise((r) => setTimeout(r, 1200));
    if (!retryAllowed(hooks)) return fail('CANCELED', '已取消');
    return runFetcher(argv, { timeoutMs, spawnImpl, hooks });
  }
  return first;
}

// 按关键词搜（目前小红书已通；其它平台如实报未实现）
async function searchNotes({ platform, keyword, limit, timeoutMs, spawnImpl, hooks } = {}) {
  const p = String(platform || 'xhs');
  const kw = String(keyword || '').trim();
  if (!kw) return fail('BAD_REQUEST', '缺少 keyword');
  const profile = profileFor(p);
  if (!profile) return fail('BAD_PLATFORM', '这个平台还不支持按关键词搜：' + p);
  const argv = ['--profile', profile, 'search', p, kw, String(Number(limit) || 12)];
  const first = await runFetcher(argv, { timeoutMs, spawnImpl, hooks });
  if (
    first &&
    first.ok !== true &&
    (first.error === 'TIMEOUT' || first.error === 'FETCH_FAIL') &&
    retryAllowed(hooks)
  ) {
    await new Promise((r) => setTimeout(r, 1200));
    if (!retryAllowed(hooks)) return fail('CANCELED', '已取消');
    return runFetcher(argv, { timeoutMs, spawnImpl, hooks });
  }
  return first;
}

// ---------- B站：官方接口就能拿（不需要浏览器） ----------
function bvidOf(url) {
  const m = String(url).match(/\/(BV[0-9A-Za-z]{10})/) || String(url).match(/[?&]bvid=(BV[0-9A-Za-z]{10})/);
  return m ? m[1] : '';
}

async function fetchBilibili(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const bvid = bvidOf(url);
  if (!bvid) return fail('BAD_REQUEST', '链接里没找到 BV 号（短链 b23.tv 请先展开）');
  try {
    const res = await fetchImpl('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
        Cookie: 'buvid3=00000000-0000-0000-0000-000000000000infoc',
      },
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data) return fail('NO_DATA', 'B站接口返回：' + (json.message || json.code));
    const d = json.data;
    return {
      ok: true,
      platform: 'bilibili',
      mode: 'url',
      url: 'https://www.bilibili.com/video/' + d.bvid,
      id: d.bvid,
      kind: 'video',
      title: d.title || '',
      content: d.desc || '',
      author: (d.owner && d.owner.name) || '',
      cover_url: d.pic || '',
      image_urls: [],
      video_url: 'https://www.bilibili.com/video/' + d.bvid,
      tags: d.tname ? [d.tname] : [],
      stats: {
        liked: (d.stat && d.stat.like) || '',
        comment: (d.stat && d.stat.reply) || '',
        share: (d.stat && d.stat.share) || '',
        view: (d.stat && d.stat.view) || '',
      },
    };
  } catch (err) {
    return fail('FETCH_FAIL', 'B站抓取失败：' + err.message);
  }
}

module.exports = {
  fetchNote,
  searchNotes,
  fetchBilibili,
  platformOfUrl,
  profileFor,
  runFetcher,
  PW_CJS,
  SCRIPT,
  NODE,
  PROGRESS_PREFIX,
  DEFAULT_TIMEOUT_MS,
};
