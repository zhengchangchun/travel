#!/usr/bin/env node
/*
 * T5 自测（mock 高德，不烧配额）：单点详情接口 + 详情面板前端资产 + 工程约束。
 * 逐条打印 PASS/FAIL，全绿 exit 0；供 scripts/smoke.sh 调用。
 * 判据 P58–P67（见 docs/tasks/2026-10-29-T5-评价展示.md §6）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const ROOT = path.join(__dirname, '..');

const CATEGORIES = [
  { key: 'food', label: '美食', amapCode: '050000', color: '#FF6B35', icon: 'food' },
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: '' },
  defaultCity: '杭州',
  usingExample: false,
};

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function amapFixture(overrides = {}) {
  return {
    async districts() {
      return [];
    },
    async poiDetail() {
      return null;
    },
    ...overrides,
  };
}

async function withApp(deps, fn) {
  const amap = deps.amap || amapFixture();
  const db = deps.db || createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap,
    collectIntervalMs: 0,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = {
    base,
    amap,
    db,
    get: async (p) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json() };
    },
  };
  try {
    await fn(api);
  } finally {
    await new Promise((r) => app.server.close(r));
    if (!deps.db) db.close();
  }
}

function seedPoi(db, overrides = {}) {
  return db.upsertPoi({
    poi_id: 'D1',
    city: '杭州',
    adcode: '330102',
    category: 'food',
    name: '招牌鱼头馆',
    address: '上城区xx路1号',
    lng: 120.17,
    lat: 30.25,
    typecode: '050000',
    rating: '4.7',
    cost: '172',
    tel: '0571-1234',
    photos: [
      'https://store.is.autonavi.com/showpic/aaa',
      'https://aos-comment.amap.com/D1/comment/bbb_2048.jpg',
    ],
    tags: ['虎皮凤爪', '椒麻大虾', '渣渣牛肉锅'],
    fetched_at: '2026-10-30T00:00:00Z',
    ...overrides,
  });
}

const CHECKS = [];
function check(id, desc, fn) {
  CHECKS.push({ id, desc, fn });
}

// ---------- 接口（mock 高德） ----------

check('P58', 'GET /api/pois/:poiId 已缓存 → 200 含 photos/tags/amapUrl', async () => {
  const db = createDb(':memory:');
  seedPoi(db);
  await withApp({ db }, async (api) => {
    const { status, body } = await api.get('/api/pois/D1');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.data.photos) && body.data.photos.length === 2);
    assert.ok(Array.isArray(body.data.tags));
    assert.strictEqual(body.data.tags.length, 3);
    assert.ok(body.data.amapUrl);
  });
});

check('P59', 'photos[].isComment 判定：含 aos-comment 为 true，其余 false', async () => {
  const db = createDb(':memory:');
  seedPoi(db);
  await withApp({ db }, async (api) => {
    const { body } = await api.get('/api/pois/D1');
    assert.strictEqual(body.data.photos.filter((p) => p.isComment).length, 1);
    body.data.photos.forEach((p) => {
      assert.strictEqual(p.isComment, p.url.includes('aos-comment'));
      assert.strictEqual(p.source, 'amap');
    });
  });
});

check('P60', '不存在的 poiId → 404', async () => {
  await withApp({}, async (api) => {
    const { status } = await api.get('/api/pois/NO_SUCH_ID');
    assert.strictEqual(status, 404);
  });
});

check('P61', '未缓存但高德有 → 回退 place/detail 返回（不落库）', async () => {
  const amap = amapFixture({
    async poiDetail(id) {
      return {
        id,
        name: '实时咖啡店',
        category: 'food',
        address: '实时地址',
        lng: 120.1,
        lat: 30.2,
        rating: '4.9',
        photos: ['https://aos-comment.amap.com/live'],
        tags: ['手冲', '拿铁'],
      };
    },
  });
  const db = createDb(':memory:');
  await withApp({ amap, db }, async (api) => {
    const { status, body } = await api.get('/api/pois/LIVE_ONLY');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.name, '实时咖啡店');
    assert.strictEqual(body.data.photos[0].isComment, true);
    assert.strictEqual(db.getPoi('LIVE_ONLY'), null);
  });
});

check('P62', 'amapUrl 形如 https://www.amap.com/detail/<poi_id>', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { poi_id: 'B0FFHDP24G' });
  await withApp({ db }, async (api) => {
    const { body } = await api.get('/api/pois/B0FFHDP24G');
    assert.strictEqual(body.data.amapUrl, 'https://www.amap.com/detail/B0FFHDP24G');
  });
});

// ---------- 前端资产（P63–P66） ----------

check('P63', '详情面板资产：图集 + 用户实拍角标 + 招牌菜 chip + 评分 + 详细地址', () => {
  const detail = readFile('web/js/detail.js');
  const idx = readFile('web/index.html');
  ['gallery-img', 'badge-comment', '用户实拍', 'dish-chip', 'addr-text', 'detail-note'].forEach(
    (k) => assert.ok(detail.includes(k), '详情面板缺资产: ' + k)
  );
  assert.ok(detail.includes('rating'), '详情面板未见评分');
  assert.ok(idx.includes('id="infocard"'), 'index 缺 #infocard 容器');
});

check('P64', '「去高德看评价」按钮存在且 href 用后端 amapUrl', () => {
  const detail = readFile('web/js/detail.js');
  const api = readFile('web/js/api.js');
  const idx = readFile('web/index.html');
  assert.ok(detail.includes('去高德看评价'), '缺「去高德看评价」按钮');
  assert.ok(detail.includes('data.amapUrl'), '按钮 href 未使用 amapUrl');
  assert.ok(detail.includes('target="_blank"'), '按钮未新窗口打开');
  assert.ok(api.includes('getPoiDetail'), 'api.js 缺 getPoiDetail');
  assert.ok(idx.includes('/js/detail.js'), 'index 未加载 detail.js');
});

check('P65', '无假评价：无硬编码评价文案 / 无 featured_reviews，且含诚实标注', () => {
  const detail = readFile('web/js/detail.js');
  const src = [
    'web/js/detail.js',
    'web/js/ui.js',
    'web/js/app.js',
    'web/index.html',
  ]
    .map(readFile)
    .join('\n');
  const FAKE = ['味道很棒', '强烈推荐', '环境不错', '服务态度好', '性价比高', '好评如潮', '超级好吃', '必点'];
  FAKE.forEach((w) => assert.ok(!src.includes(w), '疑似硬编码假评价: ' + w));
  assert.ok(!src.includes('featured_reviews'), '前端不应出现 featured_reviews');
  assert.ok(!detail.includes('class="review') && !detail.includes('reviews.map'), '详情面板不应渲染评价列表');
  assert.ok(detail.includes('不提供评价正文'), '缺诚实标注（说明高德不给评价正文）');
  assert.ok(detail.includes('去高德看评价'), '诚实标注未指向「去高德看评价」');
});

check('P66', '窄屏 375px 详情面板样式就绪（图集 / 角标 / 招牌菜 + 480px 媒体查询）', () => {
  const css = readFile('web/css/style.css');
  ['.gallery-img', '.badge-comment', '.dish-chip', '.detail-note'].forEach((k) =>
    assert.ok(css.includes(k), 'CSS 缺详情面板样式: ' + k)
  );
  assert.ok(/@media \(max-width: 480px\)/.test(css), 'CSS 缺 480px 断点（375px 窄屏）');
});

// ---------- 工程约束（P67，与 P28/P51 同口径） ----------

check('P67', '工程约束：无 node_modules / key 未硬编码 / scripts 无 $VAR 紧跟非 ASCII', () => {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) throw new Error('存在 node_modules');
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (p.dependencies && Object.keys(p.dependencies).length) throw new Error('dependencies 非空');
  }

  const keyFile = path.join(ROOT, 'config', 'local.json');
  if (fs.existsSync(keyFile)) {
    const key = (JSON.parse(fs.readFileSync(keyFile, 'utf8')).amap || {}).webServiceKey || '';
    if (key) {
      const hits = [];
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) {
            if (f.name !== 'node_modules') walk(p);
            continue;
          }
          if (!/\.(js|cjs|mjs|html|css|sh|json)$/.test(f.name)) continue;
          if (path.relative(ROOT, p) === path.join('config', 'local.json')) continue;
          if (fs.readFileSync(p, 'utf8').includes(key)) hits.push(path.relative(ROOT, p));
        }
      };
      ['server', 'web', 'scripts', 'tests', 'config'].forEach((d) => {
        const dir = path.join(ROOT, d);
        if (fs.existsSync(dir)) walk(dir);
      });
      if (hits.length) throw new Error('key 疑似硬编码: ' + hits.join(','));
    }
  }

  const bad = [];
  const scriptsDir = path.join(ROOT, 'scripts');
  for (const f of fs.readdirSync(scriptsDir)) {
    if (!f.endsWith('.sh')) continue;
    const t = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    const re = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;
    let m;
    while ((m = re.exec(t))) bad.push(f + ': ' + m[0]);
  }
  if (bad.length) throw new Error('脚本卫生问题: ' + bad.join(' | '));
});

async function main() {
  for (const c of CHECKS) {
    try {
      await c.fn();
      process.stdout.write(`PASS  ${c.id} ${c.desc}\n`);
    } catch (err) {
      process.stdout.write(`FAIL  ${c.id} ${c.desc} :: ${err.message}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`T5 mock 检查通过：${CHECKS.length} 项\n`);
}

main().catch((err) => {
  process.stdout.write('FAIL  T5 mock 运行异常 :: ' + (err && err.message) + '\n');
  process.exit(1);
});
