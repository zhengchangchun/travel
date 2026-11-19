/* P13 行程分享：
   ① 分享包三件套（自包含 HTML / 纯文本 / JSON）—— 纯函数，不联网
   ② 接口 POST /api/trips/:id/share（载荷+文本）与 /share/export（落盘）
   ③ 分享页不许内嵌任何 key，链接一律走免 key 的高德 URI
   ④ 右栏改名「行程规划」+ 两个入口按钮的结构约束  */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');
const share = require('../server/share');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('web/index.html');
const APP = read('web/js/app.js');
const API = read('web/js/api.js');
const CSS = read('web/css/style.css');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};
const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#2ECC71', icon: 'sight' },
];

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: { async searchPoiAround() { return []; }, async searchPoiInArea() { return []; } },
    collectIntervalMs: 0,
    ...opts,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    db,
    base,
    close: () =>
      new Promise((resolve) =>
        app.server.close(() => {
          if (!opts.db) db.close();
          resolve();
        })
      ),
  };
}

const req = async (base, p, opts) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, body, res };
};

const SAMPLE = {
  trip: { id: 7, title: '杭州行程' },
  city: '杭州',
  stops: [
    { name: '西湖', address: '杭州市西湖区', lng: 120.14, lat: 30.24, category: 'sight', rating: '4.8' },
    { name: '楼外楼', address: '孤山路30号', lng: 120.135, lat: 30.253, category: 'food', rating: '4.3', cost: '120', note: '东坡肉' },
  ],
  base: { name: '如家', lng: 120.16, lat: 30.25 },
  labels: { food: { label: '美食' }, sight: { label: '景点' } },
  when: '2026-11-11T20:00:00+08:00',
};
const payload = () => share.buildPayload(SAMPLE);

// ---------- ① 纯函数 ----------

test('分享载荷：按顺序编号、分类翻中文、每点一个免 key 的高德链接', () => {
  const p = payload();
  assert.equal(p.stops.length, 2);
  assert.deepEqual(p.stops.map((s) => s.seq), [1, 2]);
  assert.equal(p.stops[0].categoryLabel, '景点');
  assert.equal(p.stops[1].categoryLabel, '美食');
  p.stops.forEach((s) => assert.match(s.url, /^https:\/\/uri\.amap\.com\/marker\?position=/));
  assert.equal(p.stats.count, 2);
  assert.deepEqual(p.stats.byCategory, { 景点: 1, 美食: 1 });
  assert.equal(p.stats.hasBase, true);
  assert.match(p.links.firstToLast, /^https:\/\/uri\.amap\.com\/navigation\?/);
});

test('纯文本：标题 + 数量 + 逐点（序号/分类/评分/地址/链接）+ 全程路线', () => {
  const text = share.buildText(payload());
  assert.match(text, /^杭州行程（2 个点 \+ 住宿）/);
  assert.match(text, /1\. 西湖（景点 · ★4\.8）/);
  assert.match(text, /2\. 楼外楼（美食 · ★4\.3 · ¥120）/);
  assert.match(text, /孤山路30号/);
  assert.match(text, /备注：东坡肉/);
  assert.match(text, /高德：https:\/\/uri\.amap\.com\/marker\?/);
  assert.match(text, /全程路线（首 → 尾，驾车）/);
  // 顺序就是行程顺序：西湖一定排在楼外楼前面
  assert.ok(text.indexOf('西湖') < text.indexOf('楼外楼'));
});

test('分享出的 HTML：自包含、可点链接、不泄露任何 key', () => {
  const html = share.buildHtml(payload());
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<svg [^>]*aria-label="行程点顺序示意图"/);
  assert.match(html, /https:\/\/uri\.amap\.com\/marker\?/);
  assert.match(html, /https:\/\/uri\.amap\.com\/navigation\?/);
  assert.match(html, /在高德打开/);
  assert.match(html, /由旅迹导出/);
  assert.ok(!/key=/.test(html), '分享页不许出现任何 key 参数');
  assert.ok(!/restapi\.amap\.com/.test(html), '分享页不许依赖需要 key 的高德接口');
  assert.ok(!/JSKEY|jsApiKey/.test(html), '不许把本地 key 带进分享页');
});

test('分享页的转义：名字/备注里的尖括号不会破坏页面', () => {

  const p = share.buildPayload(
    Object.assign({}, SAMPLE, {
      stops: [{ name: '<img src=x onerror=alert(1)>', lng: 120.1, lat: 30.2, category: 'food', note: 'a & b' }],
    })
  );
  const html = share.buildHtml(p);
  assert.ok(!html.includes('<img src=x'), '未转义的名字会注入');
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /a &amp; b/);
});

test('示意图：0 / 1 / 多点都不崩（单点居中，多点有连线）', () => {
  assert.equal(share.sketchSvg([]), '');
  const one = share.sketchSvg([{ seq: 1, name: 'A', lng: 120, lat: 30 }]);
  assert.match(one, /<circle/);
  const many = share.sketchSvg([
    { seq: 1, name: 'A', lng: 120, lat: 30 },
    { seq: 2, name: 'B', lng: 120.1, lat: 30.1 },
    { seq: 0, kind: 'base', name: '住', lng: 120.05, lat: 30.05 },
  ]);
  assert.match(many, /<path d="M/);
  assert.match(many, />住</);
  assert.match(many, />1</);
});

test('落盘：一次写 html + txt + json 三个文件，文件名去掉非法字符', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-share-'));
  const out = share.writePackage(dir, share.buildPayload(Object.assign({}, SAMPLE, { city: '杭州', trip: { id: 7, title: '西湖/一日游' } })));
  assert.equal(out.files.length, 3);
  out.files.forEach((f) => {
    assert.ok(fs.existsSync(f.path), '缺文件 ' + f.name);
    assert.ok(!/[/\\:]/.test(path.basename(f.name).replace(/-/g, '')), '文件名不该带路径分隔符');
  });
  assert.match(out.files[0].name, /^杭州-西湖-一日游-\d{4}-\d{2}-\d{2}\.html$/);
  assert.ok(!/[·\s]/.test(out.files[0].name), '文件名里不该留中点/空格');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- ② 接口 ----------

async function withTmpShareDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-sharedir-'));
  const old = process.env.TRAVEL_SHARE_DIR;
  process.env.TRAVEL_SHARE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.TRAVEL_SHARE_DIR;
    else process.env.TRAVEL_SHARE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('POST /api/trips/:id/share 返回载荷与文本；/share/export 落盘并能从 /share/ 预览', async () => {
  await withTmpShareDir(async (dir) => {
    const s = await start();
    try {
      const trip = (await req(s.base, '/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: '杭州', title: '杭州行程' }),
      })).body.data;
      await req(s.base, '/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_id: trip.id, name: '西湖', lng: 120.14, lat: 30.24, category: 'sight', rating: '4.8' }),
      });
      await req(s.base, '/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_id: trip.id, name: '楼外楼', lng: 120.135, lat: 30.253, category: 'food' }),
      });

      const preview = await req(s.base, `/api/trips/${trip.id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: { name: '如家', lng: 120.16, lat: 30.25 } }),
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.data.payload.stops.length, 2);
      assert.equal(preview.body.data.payload.stops[0].categoryLabel, '景点');
      assert.match(preview.body.data.text, /西湖/);

      // 不带 base 也要能用（锚点只存在浏览器时）
      const noBase = await req(s.base, `/api/trips/${trip.id}/share`, { method: 'POST' });
      assert.equal(noBase.status, 200);
      assert.equal(noBase.body.data.payload.base, null);
      assert.equal(noBase.body.data.payload.stats.count, 2);

      const exp = await req(s.base, `/api/trips/${trip.id}/share/export`, { method: 'POST' });
      assert.equal(exp.status, 200);
      const data = exp.body.data;
      assert.equal(data.count, 2);
      assert.equal(data.files.length, 3);
      data.files.forEach((f) => assert.ok(fs.existsSync(path.join(dir, f.name)), '缺 ' + f.name));
      assert.match(data.preview, /^\/share\//);

      // 浏览器里能直接打开看（静态服务 /share/*）
      const page = await fetch(s.base + data.preview);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') || '', /text\/html/);
      const body = await page.text();
      assert.match(body, /uri\.amap\.com/);

      // 路径穿越不许跑出去
      const evil = await fetch(s.base + '/share/..%2F..%2Fserver%2Fdb.js');
      assert.ok(evil.status === 403 || evil.status === 404, '静态服务必须挡住路径穿越');
    } finally {
      await s.close();
    }
  });
});

test('分享接口的边界：空行程 400、行程不存在 404', async () => {
  await withTmpShareDir(async () => {
    const s = await start();
    try {
      const trip = (await req(s.base, '/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: '杭州', title: '空行程' }),
      })).body.data;
      const empty = await req(s.base, `/api/trips/${trip.id}/share/export`, { method: 'POST' });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error.code, 'EMPTY_TRIP');
      // 空行程仍可以拿载荷（前端要靠 stops 判空位，给一句人话）
      const preview = await req(s.base, `/api/trips/${trip.id}/share`, { method: 'POST' });
      assert.equal(preview.status, 200);
      assert.deepEqual(preview.body.data.payload.stops, []);
      const missing = await req(s.base, '/api/trips/99999/share/export', { method: 'POST' });
      assert.equal(missing.status, 404);
    } finally {
      await s.close();
    }
  });
});

// ---------- ③ 让分享文件「现身」（POST /api/share/reveal）----------

test('分享文件能一键在文件管理器里选中（不真弹 Finder，reveal 可注入）', async () => {
  await withTmpShareDir(async (dir) => {
    const seen = [];
    const s = await start({
      reveal: (full) => {
        seen.push(full);
        return { ok: true };
      },
    });
    try {
      const trip = (await req(s.base, '/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: '杭州', title: '现身' }),
      })).body.data;
      await req(s.base, '/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_id: trip.id, name: '西湖', lng: 120.14, lat: 30.24, category: 'sight' }),
      });
      const exp = await req(s.base, `/api/trips/${trip.id}/share/export`, { method: 'POST' });
      const html = exp.body.data.files.find((f) => f.kind === 'html');
      assert.ok(html, '应该有一个 html 文件');

      const ok = await req(s.base, '/api/share/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: html.name }),
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.file, html.name);
      assert.equal(seen.length, 1, 'reveal 应该被调一次');
      assert.equal(seen[0], path.join(dir, html.name));

      // 没给文件名 / 文件不存在 / 路径穿越：都要拒，且绝不调 reveal
      const noFile = await req(s.base, '/api/share/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(noFile.status, 400);
      const missing = await req(s.base, '/api/share/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'nope.html' }),
      });
      assert.equal(missing.status, 404);
      const evil = await req(s.base, '/api/share/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: '../../server/db.js' }),
      });
      assert.equal(evil.status, 404, '路径穿越必须被挡');
      assert.equal(seen.length, 1, '被拒的请求不该触发 reveal');
    } finally {
      await s.close();
    }
  });
});

test('reveal 失败（比如没有图形环境）要报 500 REVEAL_FAILED，而不是假装成功', async () => {
  await withTmpShareDir(async (dir) => {
    const s = await start({ reveal: () => ({ ok: false, message: 'open -R: 不行' }) });
    try {
      fs.writeFileSync(path.join(dir, 'x.html'), '<html></html>', 'utf8');
      const r = await req(s.base, '/api/share/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'x.html' }),
      });
      assert.equal(r.status, 500);
      assert.equal(r.body.error.code, 'REVEAL_FAILED');
      assert.match(r.body.error.msg, /不行/);
    } finally {
      await s.close();
    }
  });
});

// ---------- ④ 结构约束 ----------

test('右栏改名「行程规划」，并且分享有两个入口（行程视图工具条 + 我的行程卡）', () => {
  assert.match(HTML, /<div class="right-head">\s*<h2>行程规划<\/h2>/, '右栏标题应为行程规划');
  assert.ok(!/我挑的/.test(HTML), 'index.html 里不该再有旧名「我挑的」');
  const bar = HTML.match(/<div class="row itin-toolbar">[\s\S]*?<\/div>/);
  assert.ok(bar, '缺行程工具条');
  assert.match(bar[0], /id="itinerary-share"/, '行程视图里要有分享按钮');
  assert.match(HTML, /id="trip-share-btn"/, '「我的行程」卡里也要有分享按钮');
  assert.match(HTML, /id="share-result"/, '缺分享结果块');
  assert.match(CSS, /\.share-result\s*\{/, '分享结果块要有样式');
});

test('app.js / api.js：分享走 POST /api/trips/:id/share/export，并把文本复制到剪贴板', () => {
  assert.match(API, /exportTripShare:\s*\(tripId, payload\)[\s\S]{0,80}\/share\/export/, 'api.js 缺 exportTripShare');
  const js = APP.match(/async function onShareTrip\(modes\)[\s\S]*?\n  \}/);
  assert.ok(js, '缺 onShareTrip');
  assert.match(js[0], /API\.exportTripShare\(/, '要调导出接口');
  assert.match(js[0], /copyText\(res\.text\)/, '生成后要顺手把文案复制好');
  assert.match(js[0], /shareBase\(\)/, '住宿锚点在浏览器里，要带上');
  assert.match(APP, /\$\('itinerary-share'\)\.onclick = \(\) => onShareTrip\(\)/);
  assert.match(APP, /tripShareBtn\.onclick = \(\) => onShareTrip\(\)/);
  // 预览链接要能在同一个服务里打开
  const render = APP.match(/function renderShareResult\(res\)[\s\S]*?\n  \}/);
  assert.ok(render, '缺 renderShareResult');
  assert.match(render[0], /res\.preview/, '结果块要给出预览链接');
});

test('分享结果块要给出「发出去」的动作：下载网页版 + 在文件管理器里显示 + 复制文案 + 预览', () => {
  const render = APP.match(/function renderShareResult\(res\)[\s\S]*?\n  \}/);
  assert.ok(render, '缺 renderShareResult');
  assert.match(render[0], /dl\.download = htmlFile\.name/, '网页版要能下载（download 属性）');
  assert.match(render[0], /API\.revealShare\(htmlFile\.name\)/, '要有「在文件管理器里显示」');
  assert.match(render[0], /copyText\(res\.text\)/, '要有复制文案');
  assert.match(render[0], /res\.preview/, '要有预览链接');
  // 点完分享要自己滚到结果处并闪一下（结果块在「我的行程」卡里，点按钮的地方在行程面板顶部）
  assert.match(render[0], /scrollIntoView/, '结果块要滚动到可见');
  assert.match(render[0], /share-flash/, '结果块要闪一下');
  assert.match(CSS, /\.share-result \.share-acts\s*\{/, '动作行要有样式');
  assert.match(CSS, /@keyframes share-flash/, '闪烁动画要有样式');
  assert.match(API, /revealShare:\s*\(file\)/, 'api.js 缺 revealShare');
});

test('生成中要禁用两个分享入口，避免重复点把配额打满', () => {
  const js = APP.match(/async function onShareTrip\(modes\)[\s\S]*?\n  \}/);
  assert.ok(js, '缺 onShareTrip');
  assert.match(js[0], /b\.disabled = true/, '生成中要禁用按钮');
  assert.match(js[0], /b\.disabled = false/, '要在 finally 里恢复');
});

test('默认的 reveal 实现：macOS 走 /usr/bin/open -R，其它平台各走各的，不猜路径', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'trips.js'), 'utf8');
  assert.match(src, /run\('\/usr\/bin\/open', \['-R', full\]\)/, 'macOS 要在 Finder 里选中该文件');
  assert.match(src, /'explorer', \['\/select,' \+ full\]/, 'Windows 要在资源管理器里选中');
  assert.match(src, /'xdg-open', \[path\.dirname\(full\)\]/, '其它平台打开所在目录');
  // 绝对路径调 open；路径必须先 basename 再 resolve（不能接受任何传入路径）
  assert.match(src, /path\.resolve\(dir, path\.basename\(name\)\)/);
  assert.match(src, /path\.dirname\(full\) !== dir/);
  // 真实二进制在本机就该在（拿一个不存在的文件试：应当报错而不是假装成功）
  if (process.platform === 'darwin') {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('/usr/bin/open', ['-R', path.join(os.tmpdir(), 'travel-share-no-such-file-xyz')]);
    assert.notEqual(r.status, 0, 'open -R 对不存在的文件应返回非 0（这是 REVEAL_FAILED 分支的依据）');
  }
});
