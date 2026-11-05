// OSM 兜底（Photon）：字段归一、地址拼装、URL 与失败形状（全部离线，注入 fetch）
const test = require('node:test');
const assert = require('node:assert');

const {
  searchOsm,
  normalizeFeature,
  addressOf,
  categoryOf,
  matchesName,
  MIN_INTERVAL_MS,
} = require('../server/geocode-osm');

const FEATURE = {
  geometry: { type: 'Point', coordinates: [120.1445, 30.2489] },
  properties: {
    osm_id: 2308774,
    osm_type: 'R',
    osm_key: 'water',
    osm_value: 'lake',
    name: '西湖',
    street: '苏堤',
    district: '西湖区',
    city: '杭州市',
    state: '浙江省',
  },
};

test('normalizeFeature：坐标/名字/地址/id 归一，来源标 osm', () => {
  const p = normalizeFeature(FEATURE);
  assert.strictEqual(p.id, 'osm:R2308774');
  assert.strictEqual(p.name, '西湖');
  assert.strictEqual(p.lng, 120.1445);
  assert.strictEqual(p.lat, 30.2489);
  assert.strictEqual(p.source, 'osm');
  assert.match(p.address, /苏堤/);
  assert.strictEqual(p.rating, '', 'OSM 没有评分，不许编');
  assert.strictEqual(p.category, 'sight');
  // 没坐标的直接丢
  assert.strictEqual(normalizeFeature({ properties: { name: 'x' } }), null);
});

test('addressOf / categoryOf：去重拼地址、类目映射', () => {
  assert.strictEqual(addressOf({ street: '苏堤', district: '西湖区', city: '杭州市', state: '浙江省' }), '苏堤 西湖区 杭州市 浙江省');
  assert.strictEqual(addressOf({ city: '杭州市', state: '杭州市' }), '杭州市', '重复的不重复列');
  assert.strictEqual(categoryOf({ osm_value: 'cafe' }), 'food');
  assert.strictEqual(categoryOf({ osm_value: 'hotel' }), 'stay');
  assert.strictEqual(categoryOf({ osm_value: 'theme_park' }), 'play');
  assert.strictEqual(categoryOf({ osm_value: 'bakery' }), 'sight', '认不出的给个中性类目');
});

test('searchOsm：带城市一起查、limit 生效；HTTP 错如实抛', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ features: [FEATURE] }) };
  };
  const out = await searchOsm({ city: '杭州', keywords: '西湖', fetchImpl });
  assert.strictEqual(out.length, 1);
  assert.match(urls[0], /photon\.komoot\.io\/api\/\?q=/);
  assert.match(decodeURIComponent(urls[0]), /西湖 杭州/);
  assert.match(urls[0], /limit=5/);

  const out2 = await searchOsm({ city: '杭州', keywords: '西湖', limit: 9, fetchImpl });
  assert.match(urls[1], /limit=9/);
  assert.strictEqual(out2[0].name, '西湖');

  await assert.rejects(
    () => searchOsm({ city: '杭州', keywords: 'x', fetchImpl: async () => ({ ok: false, status: 429 }) }),
    /photon HTTP 429/
  );
  assert.deepStrictEqual(await searchOsm({ city: '杭州', keywords: '   ', fetchImpl }), [], '空关键词不发请求');
});

test('matchesName：只认同名的（不许拿无关街道凑数）', () => {
  assert.strictEqual(matchesName('西湖', '西湖'), true);
  assert.strictEqual(matchesName('西湖', '西湖风景名胜区'), true, '包含关系算命中');
  assert.strictEqual(matchesName('Seesaw Coffee', 'seesaw coffee'), true, '大小写/空格不敏感');
  assert.strictEqual(matchesName('1%', '环城东路'), false, '这就是 OSM 拿街道凑数的例子');
  assert.strictEqual(matchesName('COFFEE', '九龙大道'), false);
  assert.strictEqual(matchesName('精选店', '华星路'), false);
  assert.strictEqual(matchesName('缓奏咖啡店', '某个咖啡馆'), false);
  assert.strictEqual(matchesName('', '西湖'), false);
  assert.strictEqual(matchesName('a', 'a'), false, '单个字符太容易误命中');
});

test('searchOsm：礼节——最小请求间隔 ≥1s（别把公共服务当自家接口）', () => {
  assert.ok(MIN_INTERVAL_MS >= 1000, '间隔太小会违反 Photon 使用约定');
});
