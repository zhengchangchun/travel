const test = require('node:test');
const assert = require('node:assert');

const {
  isCommentPhoto,
  buildPhotos,
  parseTags,
  amapDetailUrl,
  toDetail,
} = require('../server/poi-detail');

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
  { key: 'stay', label: '住宿', amapCode: '100000', color: '#4A6CF7', icon: 'bed' },
  { key: 'sight', label: '景点', amapCode: '110000', color: '#22A06B', icon: 'camera' },
  { key: 'play', label: '游玩', amapCode: '080000', color: '#9B51E0', icon: 'play' },
];

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

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const app = createApp({
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db,
    amap: opts.amap || amapFixture(),
    collectIntervalMs: 0,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    db,
    close: () =>
      new Promise((resolve) =>
        app.server.close(() => {
          if (!opts.db) db.close();
          resolve();
        })
      ),
  };
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

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

// ---------- 纯函数 ----------

test('isCommentPhoto：含 aos-comment 为 true，否则 false', () => {
  assert.strictEqual(isCommentPhoto('https://aos-comment.amap.com/x/comment/y.jpg'), true);
  assert.strictEqual(isCommentPhoto('https://store.is.autonavi.com/showpic/z'), false);
  assert.strictEqual(isCommentPhoto(''), false);
  assert.strictEqual(isCommentPhoto(null), false);
});

test('buildPhotos：逐张映射 url/isComment/source，过滤空值', () => {
  const photos = buildPhotos([
    'https://store.is.autonavi.com/a',
    'https://aos-comment.amap.com/b',
    '',
    null,
  ]);
  assert.strictEqual(photos.length, 2);
  assert.deepStrictEqual(photos[0], {
    url: 'https://store.is.autonavi.com/a',
    isComment: false,
    source: 'amap',
  });
  assert.deepStrictEqual(photos[1], {
    url: 'https://aos-comment.amap.com/b',
    isComment: true,
    source: 'amap',
  });
});

test('parseTags：按逗号切、去空、去重、最多 12 个', () => {
  assert.deepStrictEqual(parseTags(['虎皮凤爪', '椒麻大虾']), ['虎皮凤爪', '椒麻大虾']);
  // 额外逗号 / 空格 / 空项
  assert.deepStrictEqual(parseTags('甲,乙,,  ,丙,'), ['甲', '乙', '丙']);
  // 重复去重
  assert.deepStrictEqual(parseTags(['甲', '甲', '乙']), ['甲', '乙']);
  // 上限 12
  const many = Array.from({ length: 20 }, (_, i) => '菜' + i);
  assert.strictEqual(parseTags(many).length, 12);
  assert.deepStrictEqual(parseTags(null), []);
});

test('amapDetailUrl：拼 https://www.amap.com/detail/<poi_id>', () => {
  assert.strictEqual(amapDetailUrl('B0FF'), 'https://www.amap.com/detail/B0FF');
});

test('toDetail：兼容 db 行（JSON 字符串）与高德结构（数组）', () => {
  const fromRow = toDetail(
    {
      poi_id: 'X1',
      name: '店',
      category: 'food',
      address: 'a',
      lng: 1.5,
      lat: 2.5,
      rating: '4.6',
      cost: '88',
      tel: '010',
      photos: JSON.stringify(['https://aos-comment.amap.com/p']),
      tags: JSON.stringify(['甲', '乙']),
    },
    'X1'
  );
  assert.strictEqual(fromRow.amapUrl, 'https://www.amap.com/detail/X1');
  assert.strictEqual(fromRow.photos[0].isComment, true);
  assert.strictEqual(fromRow.photos[0].source, 'amap');
  assert.deepStrictEqual(fromRow.tags, ['甲', '乙']);
  assert.strictEqual(fromRow.opentime, '');

  const fromAmap = toDetail(
    { id: 'X2', name: '店2', category: 'stay', lng: 3, lat: 4, photos: ['u'], tags: ['丙'], opentime: '全天' },
    'X2'
  );
  assert.strictEqual(fromAmap.poi_id, 'X2');
  assert.strictEqual(fromAmap.opentime, '全天');
  assert.strictEqual(fromAmap.amapUrl, 'https://www.amap.com/detail/X2');
});

// ---------- HTTP ----------

test('P58 GET /api/pois/:poiId 已缓存 → 200 含 photos/tags/amapUrl', async () => {
  const db = createDb(':memory:');
  seedPoi(db);
  const { base, close } = await start({ db });
  try {
    const { status, body } = await getJson(base, '/api/pois/D1');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.poi_id, 'D1');
    assert.ok(Array.isArray(body.data.photos));
    assert.strictEqual(body.data.photos.length, 2);
    assert.ok(Array.isArray(body.data.tags));
    assert.deepStrictEqual(body.data.tags, ['虎皮凤爪', '椒麻大虾', '渣渣牛肉锅']);
    assert.strictEqual(body.data.amapUrl, 'https://www.amap.com/detail/D1');
    assert.strictEqual(body.data.rating, '4.7');
    assert.strictEqual(body.data.address, '上城区xx路1号');
  } finally {
    await close();
  }
});

test('P59 photos[].isComment 判定正确（含 aos-comment 为 true）', async () => {
  const db = createDb(':memory:');
  seedPoi(db);
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(base, '/api/pois/D1');
    const comment = body.data.photos.filter((p) => p.isComment);
    assert.strictEqual(comment.length, 1);
    assert.ok(comment[0].url.includes('aos-comment'));
    body.data.photos.forEach((p) => {
      assert.strictEqual(p.isComment, p.url.includes('aos-comment'));
    });
  } finally {
    await close();
  }
});

test('P60 不存在的 poiId → 404', async () => {
  const { base, close } = await start();
  try {
    const { status } = await getJson(base, '/api/pois/NO_SUCH_ID');
    assert.strictEqual(status, 404);
  } finally {
    await close();
  }
});

test('P61 未缓存但高德有 → 回退 place/detail 返回，且不落库', async () => {
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
        cost: '40',
        tel: '',
        opentime: '09:00-22:00',
        photos: ['https://aos-comment.amap.com/live'],
        tags: ['手冲'],
      };
    },
  });
  const { base, db, close } = await start({ amap });
  try {
    const { status, body } = await getJson(base, '/api/pois/LIVE_ONLY');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.name, '实时咖啡店');
    assert.strictEqual(body.data.photos[0].isComment, true);
    assert.deepStrictEqual(body.data.tags, ['手冲']);
    assert.strictEqual(db.getPoi('LIVE_ONLY'), null);
  } finally {
    await close();
  }
});

test('P62 amapUrl 形如 https://www.amap.com/detail/<poi_id>', async () => {
  const db = createDb(':memory:');
  seedPoi(db, { poi_id: 'B0FFHDP24G' });
  const { base, close } = await start({ db });
  try {
    const { body } = await getJson(base, '/api/pois/B0FFHDP24G');
    assert.strictEqual(body.data.amapUrl, 'https://www.amap.com/detail/B0FFHDP24G');
  } finally {
    await close();
  }
});
