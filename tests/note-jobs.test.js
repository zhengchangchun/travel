// P10-⑩：笔记长任务（抓一条 / 搜一批）—— 有进度、能取消、两次不互相覆盖
// 三层：① 任务表本身（内存注册表）② runFetcher 的进度行与取消 ③ HTTP（起任务/轮询/取消 + 同步接口没被破坏）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const IMG_DIR = path.join(os.tmpdir(), 'travel-note-jobs-img-' + process.pid);
process.env.TRAVEL_NOTE_IMG_DIR = IMG_DIR;

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const { createNoteJobs } = require('../server/note-jobs');
const { runFetcher, fetchNote, searchNotes } = require('../server/note-fetch');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const testImgDir = path.join(__dirname, '..', 'artifacts-test-note-jobs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  fs.rmSync(testImgDir, { recursive: true, force: true });
});

// ---------- ① 任务表 ----------

test('note-jobs：起任务 → 进行中能看到阶段 → 跑完带结果', async () => {
  const jobs = createNoteJobs();
  const job = jobs.start('discover', { platform: 'xhs' }, async (hooks) => {
    hooks.onProgress('打开搜索页');
    await sleep(30);
    return { items: [1, 2] };
  });
  assert.match(job.id, /^nj_[0-9a-f]{12}$/);
  await sleep(10); // 任务体是异步起的：给它一拍，进度才会上来
  const mid = jobs.view(jobs.get(job.id));
  assert.strictEqual(mid.status, 'running');
  assert.strictEqual(mid.stage, '打开搜索页');
  assert.ok(mid.result === null, '没跑完不给结果');
  await sleep(60);
  const done = jobs.view(jobs.get(job.id));
  assert.strictEqual(done.status, 'done');
  assert.deepStrictEqual(done.result.items, [1, 2]);
  assert.ok(done.elapsed_ms >= 0);
  assert.strictEqual(done.error, null);
});

test('note-jobs：同 kind+platform 新的顶旧（两个浏览器抢一个 profile 会双双失败）', async () => {
  const jobs = createNoteJobs();
  const slow = jobs.start('discover', { platform: 'xhs' }, async (hooks) => {
    for (let i = 0; i < 200; i += 1) {
      if (hooks.isCanceled()) return { ok: false, error: 'CANCELED', message: '已取消' };
      await sleep(10);
    }
    return { items: ['不该跑到这里'] };
  });
  let killed = 0;
  jobs.get(slow.id).handle.child = { kill: () => (killed += 1) }; // 假装挂了个子进程
  const fresh = jobs.start('discover', { platform: 'xhs' }, async () => ({ items: [] }));
  assert.strictEqual(jobs.view(jobs.get(slow.id)).status, 'canceled');
  assert.strictEqual(killed, 1, '旧任务的子进程要被 kill');
  assert.strictEqual(jobs.view(jobs.get(fresh.id)).status, 'running');
  // 另一个平台不受影响
  const other = jobs.start('discover', { platform: 'douyin' }, async () => ({ items: [] }));
  assert.strictEqual(jobs.view(jobs.get(fresh.id)).status, 'running');
  assert.strictEqual(jobs.view(jobs.get(other.id)).status, 'running');
});

test('note-jobs：cancel 立刻改状态、结果不再采用；重复 cancel / 未知 id 不炸', async () => {
  const jobs = createNoteJobs();
  let sawCancel = false;
  const job = jobs.start('fetch', { url: 'https://x/1' }, async (hooks) => {
    for (let i = 0; i < 200; i += 1) {
      if (hooks.isCanceled()) {
        sawCancel = true;
        return { note: { id: 1 } };
      }
      await sleep(10);
    }
    return { note: { id: 1 } };
  });
  let killed = 0;
  jobs.get(job.id).handle.child = { kill: () => (killed += 1) };
  await sleep(30);
  const canceled = jobs.view(jobs.cancel(job.id));
  assert.strictEqual(canceled.status, 'canceled');
  assert.strictEqual(canceled.error, 'CANCELED');
  assert.strictEqual(canceled.result, null);
  assert.strictEqual(killed, 1);
  await sleep(60);
  const after = jobs.view(jobs.get(job.id));
  assert.strictEqual(after.status, 'canceled', '任务自己回来了也不能把状态改成 done');
  assert.strictEqual(after.result, null, '取消后结果不能采用');
  assert.ok(sawCancel, '任务应被告知已取消');
  const again = jobs.view(jobs.cancel(job.id));
  assert.strictEqual(again.status, 'canceled', '重复取消是幂等的');
  assert.strictEqual(jobs.cancel('nj_nope'), null);
  assert.strictEqual(jobs.get('nj_nope'), null);
});

test('note-jobs：任务抛错记成 failed；HttpError 带码时原样带上', async () => {
  const jobs = createNoteJobs();
  const j1 = jobs.start('discover', { platform: 'xhs' }, async () => {
    throw Object.assign(new Error('需要登录'), { code: 'NEED_LOGIN' });
  });
  await sleep(20);
  const v1 = jobs.view(jobs.get(j1.id));
  assert.strictEqual(v1.status, 'failed');
  assert.strictEqual(v1.error, 'NEED_LOGIN');
  assert.match(v1.message, /需要登录/);

  const j2 = jobs.start('discover', { platform: 'xhs' }, async () => {
    throw new Error('炸了');
  });
  await sleep(20);
  const v2 = jobs.view(jobs.get(j2.id));
  assert.strictEqual(v2.error, 'INTERNAL_ERROR');
});

test('note-jobs：跑完的结果留 TTL，过期/超量自动清', async () => {
  const jobs = createNoteJobs({ ttlMs: 200, maxJobs: 2 });
  const a = jobs.start('discover', { platform: 'xhs' }, async () => ({ items: [] }));
  await sleep(30);
  assert.ok(jobs.get(a.id), '刚跑完还在（TTL 内）');
  await sleep(260);
  assert.strictEqual(jobs.get(a.id), null, '过期了要清掉');
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(jobs.start('discover', { platform: 'p' + i }, async () => ({})).id);
  assert.ok(jobs.size() <= 2, '最多留 maxJobs 个');
  assert.ok(jobs.get(ids[2]), '新的留着');
});

// ---------- ② 抓取器外壳：进度行 + 取消 ----------

function fakeSpawn(lines, opts = {}) {
  const calls = [];
  const spawnImpl = (cmd, argv) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = 0;
    child.kill = () => {
      child.killed += 1;
    };
    if (!opts.hang) {
      setTimeout(() => {
        lines.forEach((l) => child.stdout.emit('data', Buffer.from(l + '\n')));
        if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
        child.emit('close', 0);
      }, opts.delay || 0);
    }
    return child;
  };
  return { spawnImpl, calls };
}

test('runFetcher：把 #progress 行当进度上报，且不影响结果解析', async () => {
  const { spawnImpl } = fakeSpawn([
    '#progress 打开搜索页',
    'some log',
    '#progress 等搜索接口返回（最多 30 秒）',
    '{"ok":true,"items":[]}',
  ]);
  const stages = [];
  const r = await runFetcher(['search', 'xhs', '杭州咖啡'], {
    spawnImpl,
    hooks: { onProgress: (s) => stages.push(s) },
  });
  assert.deepStrictEqual(stages, ['打开搜索页', '等搜索接口返回（最多 30 秒）']);
  assert.strictEqual(r.ok, true, '进度行不该破坏「取最后一行 JSON」');
  assert.deepStrictEqual(r.items, []);
});

test('runFetcher：被取消时不 spawn / 立刻以 CANCELED 收尾，并把子进程句柄交给上层', async () => {
  const { spawnImpl, calls } = fakeSpawn(['{"ok":true}'], { hang: true });
  const r0 = await runFetcher(['url', 'xhs', 'u'], {
    spawnImpl,
    hooks: { isCanceled: () => true },
  });
  assert.strictEqual(r0.error, 'CANCELED');
  assert.strictEqual(calls.length, 0, '已经取消就别起进程了');

  let child = null;
  const state = { canceled: false };
  const p = runFetcher(['url', 'xhs', 'u'], {
    spawnImpl,
    hooks: {
      isCanceled: () => state.canceled,
      onChild: (c) => (child = c),
    },
  });
  await sleep(30);
  assert.ok(child && typeof child.kill === 'function', 'onChild 要拿到句柄，取消时才能 kill');
  state.canceled = true;
  child.stdout.emit('data', Buffer.from('#progress 还在跑\n'));
  const r1 = await p;
  assert.strictEqual(r1.error, 'CANCELED');
  assert.ok(child.killed >= 1, '取消后要把子进程杀掉');
});

test('fetchNote / searchNotes：取消后不再重试（原来会再来一次 90 秒）', async () => {
  // ① 第一次尝试中途被取消 ⇒ 直接 CANCELED，不再起第二次
  const { spawnImpl, calls } = fakeSpawn([], { stderr: 'boom' });
  const state = { canceled: false };
  const canceledSpawn = (cmd, argv) => {
    state.canceled = true;
    return spawnImpl(cmd, argv);
  };
  const a = await fetchNote({
    url: 'https://www.xiaohongshu.com/explore/abc',
    spawnImpl: canceledSpawn,
    hooks: { isCanceled: () => state.canceled },
  });
  assert.strictEqual(a.error, 'CANCELED');
  assert.strictEqual(calls.length, 1, '取消后不得重试');

  // ② 取消发生在「重试前的 1.2 秒等待」里 ⇒ 也只跑一次
  const slow = fakeSpawn([], { stderr: 'boom' });
  const s2 = { canceled: false };
  const impl2 = (cmd, argv) => {
    const child = slow.spawnImpl(cmd, argv);
    setTimeout(() => (s2.canceled = true), 5); // 首次失败前先取消
    return child;
  };
  const b = await fetchNote({
    url: 'https://www.xiaohongshu.com/explore/abc',
    spawnImpl: impl2,
    hooks: { isCanceled: () => s2.canceled },
  });
  assert.strictEqual(b.error, 'CANCELED');
  assert.strictEqual(slow.calls.length, 1);

  const c = await searchNotes({
    platform: 'xhs',
    keyword: '杭州',
    spawnImpl: canceledSpawn,
    hooks: { isCanceled: () => state.canceled },
  });
  assert.strictEqual(c.error, 'CANCELED');
});

// ---------- ③ HTTP：任务接口 + 同步接口仍在 ----------

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [{ key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' }];

async function startApp(opts = {}) {
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db: opts.db || createDb(':memory:'),
    amap: {},
    noteFetch: opts.noteFetch,
    collectIntervalMs: 0,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return app;
}

async function req(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function waitJob(base, id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  for (;;) {
    const r = await req(base, 'GET', '/api/notes/jobs/' + id);
    if (r.status !== 200 || r.body.data.status !== 'running') return r.body.data;
    if (Date.now() > deadline) throw new Error('等任务超时');
    await sleep(30);
  }
}

test('POST /api/notes/jobs：立即拿 id；轮询能看到阶段；跑完给候选（封面落本地、标出已入库）', async () => {
  const searchCalls = [];
  const noteFetch = {
    searchNotes(args) {
      searchCalls.push(args);
      return (async () => {
        assert.strictEqual(typeof args.hooks.onProgress, 'function', '任务要把进度钩子透给抓取器');
        args.hooks.onProgress('打开小红书搜索页');
        await sleep(80);
        args.hooks.onProgress('等搜索接口返回（最多 30 秒）');
        await sleep(80);
        return {
          ok: true,
          platform: 'xhs',
          mode: 'search',
          items: [
            { id: 'a1', url: 'https://www.xiaohongshu.com/explore/a1', title: '甲', cover_url: '' },
            { id: 'a2', url: 'https://www.xiaohongshu.com/explore/a2', title: '乙', cover_url: '' },
          ],
        };
      })();
    },
  };
  const app = await startApp({ noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const started = await req(base, 'POST', '/api/notes/jobs', {
      kind: 'discover',
      keyword: '杭州咖啡',
      platform: 'xhs',
    });
    assert.strictEqual(started.status, 200);
    const job = started.body.data;
    assert.match(job.id, /^nj_/);
    assert.strictEqual(job.status, 'running');
    assert.strictEqual(job.kind, 'discover');

    await sleep(50);
    const mid = (await req(base, 'GET', '/api/notes/jobs/' + job.id)).body.data;
    assert.strictEqual(mid.status, 'running');
    assert.match(mid.stage, /打开小红书搜索页|等搜索接口/, '进行中要看得到「到哪一步」');
    assert.ok(mid.elapsed_ms >= 0, '要能算「已多少秒」');

    const done = await waitJob(base, job.id);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.result.keyword, '杭州咖啡');
    assert.strictEqual(done.result.items.length, 2);
    assert.strictEqual(done.result.items[0].exists, false);
    assert.strictEqual(searchCalls.length, 1);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/jobs/:id/cancel：状态转 canceled、结果不采用', async () => {
  let finished = false;
  const noteFetch = {
    searchNotes(args) {
      return (async () => {
        args.hooks.onProgress('打开小红书搜索页');
        for (let i = 0; i < 200; i += 1) {
          if (args.hooks.isCanceled()) return { ok: false, error: 'CANCELED', message: '已取消' };
          await sleep(10);
        }
        finished = true;
        return { ok: true, platform: 'xhs', items: [] };
      })();
    },
  };
  const app = await startApp({ noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const job = (
      await req(base, 'POST', '/api/notes/jobs', { kind: 'discover', keyword: '杭州咖啡' })
    ).body.data;
    await sleep(60);
    const canceled = await req(base, 'POST', '/api/notes/jobs/' + job.id + '/cancel', {});
    assert.strictEqual(canceled.status, 200);
    assert.strictEqual(canceled.body.data.status, 'canceled');
    assert.strictEqual(canceled.body.data.result, null);
    await sleep(120);
    const after = (await req(base, 'GET', '/api/notes/jobs/' + job.id)).body.data;
    assert.strictEqual(after.status, 'canceled', '取消后不会被后台结果改成 done');
    assert.strictEqual(after.result, null);
    assert.strictEqual(finished, false, '任务确实被打住了，没跑完整');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/jobs：抓取失败的原因原样带出来（前端再过一层人话）', async () => {
  const noteFetch = {
    searchNotes() {
      return Promise.resolve({ ok: false, error: 'NEED_LOGIN', message: '小红书要重新扫码登录' });
    },
  };
  const app = await startApp({ noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const job = (
      await req(base, 'POST', '/api/notes/jobs', { kind: 'discover', keyword: '杭州咖啡' })
    ).body.data;
    const done = await waitJob(base, job.id);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.error, 'NEED_LOGIN');
    assert.match(done.message, /扫码登录/);
    assert.strictEqual(done.result, null);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/jobs：参数校验与未知 id 都明确报错（不是 500）', async () => {
  const app = await startApp({ noteFetch: { searchNotes: () => Promise.resolve({ ok: true, items: [] }) } });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const noKind = await req(base, 'POST', '/api/notes/jobs', { kind: 'nope' });
    assert.strictEqual(noKind.status, 400);
    const noKw = await req(base, 'POST', '/api/notes/jobs', { kind: 'discover' });
    assert.strictEqual(noKw.status, 400);
    assert.strictEqual(noKw.body.error.code, 'BAD_REQUEST');
    const noUrl = await req(base, 'POST', '/api/notes/jobs', { kind: 'fetch', share_text: '没有链接的一段话' });
    assert.strictEqual(noUrl.status, 400);
    const missing = await req(base, 'GET', '/api/notes/jobs/nj_nope');
    assert.strictEqual(missing.status, 404);
    const cancelMissing = await req(base, 'POST', '/api/notes/jobs/nj_nope/cancel', {});
    assert.strictEqual(cancelMissing.status, 404);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/jobs（kind=fetch）：跑完给 note 形状，同步接口仍在', async () => {
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-note-jobs-'));
  const noteFetch = {
    fetchNote() {
      return Promise.resolve({
        ok: true,
        platform: 'xhs',
        mode: 'url',
        url: 'https://www.xiaohongshu.com/explore/abc',
        title: '杭州咖啡地图',
        content: '第一家 Seesaw 南山路店',
        author: '咖啡因',
        kind: 'note',
        cover_url: '',
        image_urls: [],
        tags: ['杭州'],
      });
    },
  };
  const db = createDb(':memory:');
  const app = await startApp({ db, noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const job = (
      await req(base, 'POST', '/api/notes/jobs', {
        kind: 'fetch',
        share_text: '分享文案 https://www.xiaohongshu.com/explore/abc 完',
        city: '杭州',
        save: true,
      })
    ).body.data;
    const done = await waitJob(base, job.id);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.result.note.title, '杭州咖啡地图');
    assert.strictEqual(done.result.saved, true);
    assert.strictEqual(db.listNotes().length, 1);
    // 同步接口还在（命令行/老调用方）
    const sync = await req(base, 'POST', '/api/notes/fetch', {
      url: 'https://www.xiaohongshu.com/explore/abc',
      city: '杭州',
    });
    assert.strictEqual(sync.status, 200);
    assert.strictEqual(sync.body.data.preview, true);
    assert.strictEqual(sync.body.data.note.title, '杭州咖啡地图');
  } finally {
    await new Promise((r) => app.server.close(r));
    fs.rmSync(imgDir, { recursive: true, force: true });
  }
});

// ---------- ④ 前端与标记 ----------

test('结构：页面上有进度行与「取消」，前端走任务接口（不再是干等的请求）', () => {
  const HTML = read('web/index.html');
  const NOTES = read('web/js/notes.js');
  const API = read('web/js/api.js');
  const CSS = read('web/css/style.css');
  assert.match(HTML, /id="note-progress"/, '缺进度行');
  assert.match(HTML, /id="note-cancel-btn"[^>]*hidden/, '取消按钮默认藏起来');
  assert.match(API, /startNoteJob:/, 'api.js 缺 startNoteJob');
  assert.match(API, /getNoteJob:/, 'api.js 缺 getNoteJob');
  assert.match(API, /cancelNoteJob:/, 'api.js 缺 cancelNoteJob');
  assert.ok(!/API\.discoverNotes\(/.test(NOTES), '搜索应改走任务接口');
  assert.ok(!/API\.fetchNote\(/.test(NOTES), '抓取应改走任务接口');
  assert.ok(!/API\.refreshNote\(/.test(NOTES), '重抓应改走任务接口');
  assert.match(NOTES, /async function runJob/, '缺任务轮询器');
  assert.match(NOTES, /已 ' \+ secs \+ ' 秒/, '要显示「已 N 秒」');
  assert.match(NOTES, /st\.job !== id/, '要有「被取消/被顶替就不再管」的守卫');
  assert.match(NOTES, /function onCancelJob/, '缺取消处理');
  assert.match(NOTES, /setLive\(/, '缺进度行/取消按钮的显隐');
  assert.match(CSS, /\.note-live \{/, '缺进度行样式');
});
