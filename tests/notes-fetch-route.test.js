// P5 抓取路由：抓单条（预览/落库/去重更新）、按关键词搜、重抓刷新
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMG_DIR = path.join(os.tmpdir(), 'travel-notes-fetch-img-' + process.pid);
process.env.TRAVEL_NOTE_IMG_DIR = IMG_DIR;

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
];

function startImageServer() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, referer: req.headers.referer || '' });
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, hits, base: 'http://127.0.0.1:' + server.address().port })
    );
  });
}

// 假抓取器：按注入结果返回，记录被调的参数
function fakeFetch(result) {
  const calls = [];
  return {
    calls,
    noteFetch: {
      fetchNote(args) {
        calls.push({ op: 'fetchNote', ...args });
        return Promise.resolve(typeof result === 'function' ? result(args) : result);
      },
      searchNotes(args) {
        calls.push({ op: 'searchNotes', ...args });
        return Promise.resolve(typeof result === 'function' ? result(args) : result);
      },
    },
  };
}

async function startApp(opts) {
  const app = createApp({
    authFallbackUser: true,
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

test.after(() => {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
});

test('POST /api/notes/fetch：默认只预览（图落本地、库不写），save=1 才入库', async () => {
  const img = await startImageServer();
  const { noteFetch, calls } = fakeFetch({
    ok: true,
    platform: 'xhs',
    mode: 'url',
    url: 'https://www.xiaohongshu.com/explore/abc',
    title: '杭州咖啡地图',
    content: '第一家 Seesaw 南山路店',
    author: '咖啡因',
    kind: 'note',
    cover_url: img.base + '/cover.webp',
    image_urls: [img.base + '/1.webp', img.base + '/2.webp'],
    tags: ['杭州'],
  });
  const db = createDb(':memory:');
  const app = await startApp({ db, noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const preview = await req(base, 'POST', '/api/notes/fetch', {
      url: 'https://www.xiaohongshu.com/explore/abc',
      city: '杭州',
    });
    assert.strictEqual(preview.status, 200);
    const d = preview.body.data;
    assert.strictEqual(d.saved, false);
    assert.strictEqual(d.preview, true);
    assert.strictEqual(d.fetch.platform, 'xhs');
    assert.strictEqual(d.note.title, '杭州咖啡地图');
    assert.strictEqual(d.note.source, '小红书');
    assert.match(d.note.cover_url, /^\/notes-img\/[0-9a-f]{16}\.(webp|png)$/);
    assert.strictEqual(d.note.images.length, 2);
    assert.strictEqual(d.download.saved, 2);
    assert.strictEqual(db.listNotes(1).length, 0, '没点存就不写库');
    // 封面/图下载带平台 referer
    assert.ok(img.hits.every((h) => h.referer === 'https://www.xiaohongshu.com/'), JSON.stringify(img.hits));

    const saved = await req(base, 'POST', '/api/notes/fetch', {
      url: 'https://www.xiaohongshu.com/explore/abc',
      city: '杭州',
      save: true,
    });
    assert.strictEqual(saved.body.data.saved, true);
    assert.strictEqual(saved.body.data.updated, false);
    assert.ok(saved.body.data.note.id > 0);
    assert.strictEqual(db.listNotes(1).length, 1);
    // 再抓一次同一条 ⇒ 更新而不是变成两条
    const again = await req(base, 'POST', '/api/notes/fetch', {
      url: 'https://www.xiaohongshu.com/explore/abc',
      city: '杭州',
      save: true,
    });
    assert.strictEqual(again.body.data.updated, true);
    assert.strictEqual(db.listNotes(1).length, 1, '同链接不重复入库');
    assert.strictEqual(calls.filter((c) => c.op === 'fetchNote').length, 3);
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => img.server.close(r));
  }
});

test('POST /api/notes/fetch：分享文案里带链接也能抓；没链接 400；抓取失败 502 带原因', async () => {
  const { noteFetch } = fakeFetch((args) => {
    if (args.url.includes('bad')) return { ok: false, error: 'NEED_LOGIN', message: '需要重新扫码登录' };
    return {
      ok: true,
      platform: 'douyin',
      url: args.url,
      title: '@@7.61 https://www.iesdouyin.com/share/video/745 复制此链接，打开抖音搜索，直接观看视频！',
      content: '@@7.61 https://www.iesdouyin.com/share/video/745 复制此链接，打开抖音搜索，直接观看视频！ 让打扰人',
      kind: 'video',
    };
  });
  const app = await startApp({ noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const viaShare = await req(base, 'POST', '/api/notes/fetch', {
      share_text: '7.6 复制打开抖音，看看【某人】杭州探店 https://v.douyin.com/iJabcDE/ 复制此链接',
    });
    assert.strictEqual(viaShare.status, 200);
    assert.strictEqual(viaShare.body.data.fetch.platform, 'douyin');
    assert.strictEqual(viaShare.body.data.note.kind, 'video');
    assert.strictEqual(viaShare.body.data.note.source, '抖音');
    assert.ok(!/https?:\/\//.test(viaShare.body.data.note.title), '标题里不留链接');
    assert.ok(!/复制此链接/.test(viaShare.body.data.note.title), '标题里不留分享话术');

    const noLink = await req(base, 'POST', '/api/notes/fetch', { share_text: '纯文字，没有链接' });
    assert.strictEqual(noLink.status, 400);
    const empty = await req(base, 'POST', '/api/notes/fetch', {});
    assert.strictEqual(empty.status, 400);

    // 抖音 desc 里混着分享串：标题/正文要洗过
    const dirty = await req(base, 'POST', '/api/notes/fetch', {
      share_text: '看看 https://v.douyin.com/iJabcDE/',
      save: true,
    });
    assert.strictEqual(dirty.status, 200);

    const boom = await req(base, 'POST', '/api/notes/fetch', { url: 'https://www.douyin.com/video/bad1' });
    assert.strictEqual(boom.status, 502);
    assert.strictEqual(boom.body.error.code, 'NEED_LOGIN');
    assert.match(boom.body.error.msg, /扫码登录/);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/discover：按关键词搜返回候选（封面落本地），标出哪些已在本地库', async () => {
  const img = await startImageServer();
  const { noteFetch, calls } = fakeFetch({
    ok: true,
    platform: 'xhs',
    items: [
      { url: 'https://www.xiaohongshu.com/explore/1', title: 'A', author: 'a', source_type: 'xhs', cover_url: img.base + '/c1.webp' },
      { url: 'https://www.xiaohongshu.com/explore/2', title: 'B', author: 'b', cover_url: img.base + '/c2.webp' },
    ],
  });
  const db = createDb(':memory:');
  db.addNoteFull({ userId: 1, url: 'https://www.xiaohongshu.com/explore/1', title: 'A', source_type: 'xhs' });
  const app = await startApp({ db, noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const r = await req(base, 'POST', '/api/notes/discover', { keyword: '杭州咖啡', platform: 'xhs', limit: 50 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.total, 2);
    assert.strictEqual(r.body.data.items[0].exists, true);
    assert.strictEqual(r.body.data.items[1].exists, false);
    assert.match(r.body.data.items[0].cover_url, /^\/notes-img\/[0-9a-f]{16}\.png$/, '封面下到本地再给前端');
    assert.ok(img.hits.every((h) => h.referer === 'https://www.xiaohongshu.com/'));
    assert.strictEqual(calls[0].limit, 30, 'limit 封顶 30');
    const noKw = await req(base, 'POST', '/api/notes/discover', {});
    assert.strictEqual(noKw.status, 400);
    assert.strictEqual(db.listNotes(1).length, 1, '搜不写库');
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => img.server.close(r));
  }
});

test('POST /api/notes/:id/refresh：按库里链接重抓并覆盖正文/图', async () => {
  let round = 0;
  const { noteFetch } = fakeFetch(() => {
    round += 1;
    return {
      ok: true,
      platform: 'xhs',
      url: 'https://www.xiaohongshu.com/explore/xyz',
      title: '标题 v' + round,
      content: '正文 v' + round,
      author: '作者',
      kind: 'note',
      image_urls: [],
      cover_url: '',
    };
  });
  const db = createDb(':memory:');
  const app = await startApp({ db, noteFetch });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://www.xiaohongshu.com/explore/xyz',
      city: '杭州',
      title: '标题 v0',
      content: '正文 v0',
      source: '小红书',
      source_type: 'xhs',
    });
    const id = created.body.data.id;
    const r = await req(base, 'POST', '/api/notes/' + id + '/refresh', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.note.title, '标题 v1');
    assert.strictEqual(r.body.data.note.content, '正文 v1');
    assert.strictEqual(db.listNotes(1).length, 1);
    const missing = await req(base, 'POST', '/api/notes/9999/refresh', {});
    assert.strictEqual(missing.status, 404);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
