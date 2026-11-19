/* 备份 / 导出（2026-11-19）：把数据库快照 + 分享包 + 实景图 打成一个 zip
   - 零依赖：自己写 ZIP 头（deflateRaw 压缩），数据库用 VACUUM INTO 拍一致性快照
   - 备份要登录；包里带 README.txt 说明怎么恢复 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const backup = require('../server/backup');

const ROOT = path.join(__dirname, '..');
const TEST_CONFIG = { port: 0, amap: { webServiceKey: 'K', jsApiKey: 'J', jsApiSecurityCode: 'S' }, defaultCity: '杭州' };

async function start() {
  const db = createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: [{ key: 'sight', label: '景点', amapCode: '110000', color: '#1677ff' }],
    db,
    amap: { async amapGet() { return { status: '1' }; } },
    routeIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, db, close: () => new Promise((r) => app.server.close(() => { db.close(); r(); })) };
}

const call = async (base, method, url, body, cookie) => {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    json = null;
  }
  return { status: res.status, body: json };
};

test('createBackup：生成一个能解开、能列出内容的 zip（含 travel.db 与 README.txt）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-backup-'));
  const shareDir = path.join(dir, 'share');
  const photoDir = path.join(dir, 'photos');
  fs.mkdirSync(shareDir);
  fs.mkdirSync(photoDir);
  fs.writeFileSync(path.join(shareDir, 'a.html'), '<html>shares</html>');
  fs.writeFileSync(path.join(shareDir, 'a.txt'), '文本版');
  fs.writeFileSync(path.join(photoDir, 'p.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  process.env.TRAVEL_SHARE_DIR = shareDir;
  process.env.TRAVEL_FEATURED_PHOTO_DIR = photoDir;
  process.env.TRAVEL_BACKUP_DIR = path.join(dir, 'backups');

  const db = createDb(':memory:');
  db.createTrip({ city: '三亚', title: '备份用行程', userId: 1 });
  try {
    const out = backup.createBackup({ db });
    const full = path.join(out.dir, out.file);
    assert.ok(fs.existsSync(full), 'zip 要真的落盘');
    assert.ok(out.bytes > 1000, '体积不该是空的：' + out.bytes);
    assert.equal(out.shares, 2, '两个分享文件都进包');
    assert.equal(out.photos, 1, '实景图进包');
    assert.ok(out.dbBytes > 0, '数据库快照要有内容');

    const head = fs.readFileSync(full).subarray(0, 4);
    assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04], '要是 ZIP 头 PK\\x03\\x04');

    // 系统有 unzip 就真解一遍列目录（没有就跳过这一步）
    const probe = spawnSync('/usr/bin/unzip', ['-l', full], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      const list = probe.stdout;
      assert.match(list, /travel\.db/);
      assert.match(list, /README\.txt/);
      assert.match(list, /share\/a\.html/);
      assert.match(list, /featured-photos\/p\.jpg/);
      const testRun = spawnSync('/usr/bin/unzip', ['-t', full], { encoding: 'utf8' });
      assert.equal(testRun.status, 0, 'unzip -t 应全通过：' + testRun.stdout);
    }

    // 列表接口：能看到刚打的这个
    const items = backup.listBackups(5);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, out.file);

    // 包外不能读：路径穿越要挡住
    assert.equal(backup.backupPath('../../etc/passwd'), null);
    assert.ok(backup.backupPath(out.file));
  } finally {
    db.close();
    delete process.env.TRAVEL_SHARE_DIR;
    delete process.env.TRAVEL_FEATURED_PHOTO_DIR;
    delete process.env.TRAVEL_BACKUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API：备份要登录；打完能在列表里看到；reveal 只认备份目录里的文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-backup-api-'));
  process.env.TRAVEL_BACKUP_DIR = path.join(dir, 'backups');
  process.env.TRAVEL_SHARE_DIR = path.join(dir, 'share');
  fs.mkdirSync(process.env.TRAVEL_SHARE_DIR, { recursive: true });
  const s = await start();
  try {
    // 没登录：401
    for (const [m, u] of [['POST', '/api/backup'], ['GET', '/api/backup']]) {
      const r = await call(s.base, m, u, m === 'POST' ? {} : null);
      assert.equal(r.status, 401, m + ' ' + u + ' 应 401');
    }

    // 登录后
    const reg = await call(s.base, 'POST', '/api/auth/register', { username: 'bk-user', password: 'pass-bk-user-1' });
    const cookie = reg.cookie || null;
    const meRes = await fetch(s.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bk-user', password: 'pass-bk-user-1' }),
    });
    const ck = (meRes.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(ck && ck.includes('travel_session'));

    const made = await call(s.base, 'POST', '/api/backup', {}, ck);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.match(made.body.data.file, /^travel-backup-\d{8}-\d{6}\.zip$/);

    const list = await call(s.base, 'GET', '/api/backup', null, ck);
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].name, made.body.data.file);

    const bad = await call(s.base, 'POST', '/api/backup/reveal', { name: '../travel.db' }, ck);
    assert.equal(bad.status, 404, '路径穿越要挡住');

    const ok = await call(s.base, 'POST', '/api/backup/reveal', { name: made.body.data.file }, ck);
    // 无头环境里 open -R 可能失败，这里只要求「不是 404」：认得出文件即可
    assert.notEqual(ok.status, 404);
  } finally {
    await s.close();
    delete process.env.TRAVEL_BACKUP_DIR;
    delete process.env.TRAVEL_SHARE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('前端接线：设置页有「立即备份」与备份列表', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const html = read('web/settings.html');
  assert.match(html, /id="bk-now"/, '设置页缺「立即备份」按钮');
  assert.match(html, /id="bk-list"/, '设置页缺备份列表');
  const js = read('web/js/settings.js');
  assert.match(js, /wireBackup/, '缺 wireBackup');
  assert.match(js, /\/api\/backup'/, '要走 /api/backup 接口');
  assert.match(js, /data-reveal/, '每个备份要能发到 Finder');
});
