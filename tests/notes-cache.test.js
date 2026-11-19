// 笔记本地缓存：内容/图/来源落本地，之后页面只从本地读（不再去平台）
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMG_DIR = path.join(os.tmpdir(), 'travel-notes-img-test-' + process.pid);
process.env.TRAVEL_NOTE_IMG_DIR = IMG_DIR;

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const { extFor, nameFor } = require('../server/note-images');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

// 一张 1x1 的假图（PNG 头 + 任意字节，够验下载/落盘/静态服务）
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

function startImageServer() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url.startsWith('/bad')) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(FAKE_PNG);
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, hits, base: 'http://127.0.0.1:' + server.address().port })
    );
  });
}

async function startApp(db) {
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db: db || createDb(':memory:'),
    amap: {},
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
  let json = null;
  const text = await res.text();
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

test('extFor / nameFor：类型与扩展名归一，同 URL 稳定', () => {
  assert.strictEqual(extFor('image/jpeg', 'x'), '.jpg');
  assert.strictEqual(extFor('image/webp; charset=x', 'x'), '.webp');
  assert.strictEqual(extFor('', 'https://a.com/b.png?x=1'), '.png');
  assert.strictEqual(extFor('', 'https://a.com/b.jpeg'), '.jpg');
  assert.strictEqual(extFor('', 'https://a.com/b'), '.jpg');
  assert.strictEqual(nameFor('https://a.com/b.png'), nameFor('https://a.com/b.png'));
  assert.match(nameFor('https://a.com/b.png'), /^[0-9a-f]{16}$/);
});

test('POST /api/notes：内容 + 来源 + 图片全部落本地，返回可访问 URL', async () => {
  const img = await startImageServer();
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const r = await req(base, 'POST', '/api/notes', {
      url: 'https://www.xiaohongshu.com/explore/abc',
      city: '杭州',
      title: '杭州咖啡地图｜10 家私藏',
      source: '小红书',
      source_type: 'xhs',
      author: '咖啡因中毒者',
      content: '第一家：湖滨的 %Arabica，第二家：南山路的 Seesaw',
      image_urls: [img.base + '/a.png', img.base + '/b.png', img.base + '/bad.png'],
      tags: ['咖啡', '杭州'],
    });
    assert.strictEqual(r.status, 200);
    const d = r.body.data;
    assert.strictEqual(d.title, '杭州咖啡地图｜10 家私藏');
    assert.strictEqual(d.source, '小红书');
    assert.strictEqual(d.source_type, 'xhs');
    assert.strictEqual(d.images.length, 2, '两张成功、一张 500 失败');
    assert.match(d.images[0], /^\/notes-img\/[0-9a-f]{16}\.png$/);
    assert.strictEqual(d.cover_url, d.images[0], '没给封面时用第一张图');
    assert.deepStrictEqual(d.tags, ['咖啡', '杭州']);
    assert.strictEqual(d.download.requested, 3, '图片明细在 download 上');
    assert.strictEqual(d.download.saved, 2);
    assert.strictEqual(d.download.failed.length, 1);
    // 文件真的落盘了（按文件名逐个核，不依赖目录里其它用例的残留）
    d.images.forEach((u) => {
      assert.ok(fs.existsSync(path.join(IMG_DIR, path.basename(u))), '应落盘：' + u);
    });
    // 静态服务能取到（前端之后就从本地读）
    const got = await fetch(base + d.images[0]);
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.headers.get('content-type'), 'image/png');
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => img.server.close(r));
  }
});

test('POST /api/notes：下载明细如实回报（失败不吞）', async () => {
  const img = await startImageServer();
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const r = await req(base, 'POST', '/api/notes', {
      url: 'https://www.douyin.com/video/1',
      title: 'T',
      source: '抖音',
      source_type: 'douyin',
      image_urls: [img.base + '/ok.png', img.base + '/bad.png'],
    });
    assert.strictEqual(r.status, 200);
    const meta = r.body.data.download;
    assert.strictEqual(meta.requested, 2);
    assert.strictEqual(meta.saved, 1);
    assert.strictEqual(meta.failed.length, 1);
    assert.match(meta.failed[0].error, /500/);
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => img.server.close(r));
  }
});

test('图片下载幂等：同 URL 再存一次不再重复下载', async () => {
  const img = await startImageServer();
  const db = createDb(':memory:');
  const app = await startApp(db);
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const payload = {
      url: 'https://x.com/1',
      title: 'A',
      source: '小红书',
      image_urls: [img.base + '/same.png'],
    };
    await req(base, 'POST', '/api/notes', payload);
    const beforeHits = img.hits.length;
    const beforeFiles = fs.readdirSync(IMG_DIR).length;
    await req(base, 'POST', '/api/notes', Object.assign({}, payload, { url: 'https://x.com/2' }));
    assert.strictEqual(img.hits.length, beforeHits, '第二次不该再打图源');
    assert.strictEqual(fs.readdirSync(IMG_DIR).length, beforeFiles, '不该新增文件');
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => img.server.close(r));
  }
});

test('GET /api/notes/search：关键词命中标题/正文/作者，source 区分来源', async () => {
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      city: '杭州',
      title: '湖滨咖啡',
      source: '小红书',
      source_type: 'xhs',
      author: '小 A',
      content: '正文提到 Seesaw',
    });
    await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/2',
      city: '杭州',
      title: '杭州夜宵指南',
      source: '抖音',
      source_type: 'douyin',
      author: '小 B',
      content: '烧烤摊',
    });
    const byTitle = await req(base, 'GET', '/api/notes/search?q=' + encodeURIComponent('咖啡'));
    assert.strictEqual(byTitle.body.data.total, 1);
    assert.strictEqual(byTitle.body.data.items[0].title, '湖滨咖啡');
    const byContent = await req(base, 'GET', '/api/notes/search?q=' + encodeURIComponent('Seesaw'));
    assert.strictEqual(byContent.body.data.total, 1);
    const byAuthor = await req(base, 'GET', '/api/notes/search?q=' + encodeURIComponent('小 B'));
    assert.strictEqual(byAuthor.body.data.total, 1);
    assert.strictEqual(byAuthor.body.data.items[0].source, '抖音');
    // 来源过滤：source 或 source_type 都能认
    const onlyXhs = await req(base, 'GET', '/api/notes/search?source=xhs');
    assert.strictEqual(onlyXhs.body.data.total, 1);
    assert.strictEqual(onlyXhs.body.data.items[0].source, '小红书');
    const onlyXhsCn = await req(base, 'GET', '/api/notes/search?source=' + encodeURIComponent('小红书'));
    assert.strictEqual(onlyXhsCn.body.data.total, 1);
    // 空条件返回全部
    const all = await req(base, 'GET', '/api/notes/search');
    assert.strictEqual(all.body.data.total, 2);
    // 城市过滤
    const other = await req(base, 'GET', '/api/notes/search?city=' + encodeURIComponent('上海'));
    assert.strictEqual(other.body.data.total, 0);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('PATCH /api/notes/:id：给已有笔记补正文/作者（不清掉已有图）', async () => {
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      title: 'B',
      source: '小红书',
      source_type: 'xhs',
    });
    const id = created.body.data.id;
    const patched = await req(base, 'PATCH', '/api/notes/' + id, {
      content: '补充的正文',
      author: '小 C',
      tags: ['咖啡'],
    });
    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.body.data.content, '补充的正文');
    assert.strictEqual(patched.body.data.author, '小 C');
    assert.strictEqual(patched.body.data.title, 'B', '没传的字段不动');
    assert.ok(patched.body.data.fetched_at, '应记下更新时间');
    const missing = await req(base, 'PATCH', '/api/notes/9999', { content: 'x' });
    assert.strictEqual(missing.status, 404);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes：url / share_text / title 全空 → 400', async () => {
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    // P4 起 url 不再是必填（用户可能只贴一段分享文案或正文）
    const r = await req(base, 'POST', '/api/notes', { content: '只给了正文' });
    assert.strictEqual(r.status, 400);
    const ok = await req(base, 'POST', '/api/notes', { title: '只有标题也行' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.data.title, '只有标题也行');
    assert.strictEqual(ok.body.data.url, '', '没链接就存空串');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('存量库前滚：老库也能加 kind / video_url / share_text', async () => {
  const dbPath = path.join(os.tmpdir(), 'travel-notes-mig-p4-' + process.pid + '.db');
  try {
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(dbPath);
    old.exec(
      `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, pin_id INTEGER, city TEXT,
        url TEXT NOT NULL, title TEXT, source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`
    );
    old.exec(`INSERT INTO notes (url, title) VALUES ('https://x.com/old', '老笔记')`);
    old.close();

    const db = createDb(dbPath);
    const rows = db.listNotes();
    assert.strictEqual(rows.length, 1);
    const cols = db.raw.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
    ['kind', 'video_url', 'share_text'].forEach((c) => assert.ok(cols.includes(c), '应前滚出 ' + c));
    const placesCols = db.raw.prepare('PRAGMA table_info(note_places)').all().map((c) => c.name);
    assert.ok(placesCols.includes('poi_id'), 'note_places 表应建出来');
    db.raw.close();
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('存量库前滚：老 notes 表也能加内容字段（ensureColumn 幂等）', async () => {
  const dbPath = path.join(os.tmpdir(), 'travel-notes-mig-' + process.pid + '.db');
  try {
    // 先建一个“老库”（只有基础列），再让 createDb 前滚
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(dbPath);
    old.exec(
      `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, pin_id INTEGER, city TEXT,
        url TEXT NOT NULL, title TEXT, source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`
    );
    old.exec(`INSERT INTO notes (url, title) VALUES ('https://x.com/old', '老笔记')`);
    old.close();

    const db = createDb(dbPath);
    const rows = db.listNotes();
    assert.strictEqual(rows.length, 1, '老数据还在');
    assert.strictEqual(rows[0].title, '老笔记');
    const found = db.searchNotes({ q: '老笔记' });
    assert.strictEqual(found.length, 1, '新加的内容字段可用（搜索走得通）');
    db.raw.close();
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
