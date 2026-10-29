const test = require('node:test');
const assert = require('node:assert');

const amap = require('../server/amap');

function withFetch(payloads, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const payload = typeof payloads === 'function' ? payloads(String(url)) : payloads;
    return { ok: true, status: 200, json: async () => payload };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = orig;
    });
}

test.beforeEach(() => {
  amap.setConfig({ amap: { webServiceKey: 'TESTKEY' } });
});

test('classifyType 按 typecode 前缀映射分类', () => {
  assert.strictEqual(amap.classifyType('050202'), 'food');
  assert.strictEqual(amap.classifyType('100000'), 'stay');
  assert.strictEqual(amap.classifyType('110000'), 'sight');
  assert.strictEqual(amap.classifyType('080000'), 'play');
  assert.strictEqual(amap.classifyType('999999'), null);
  assert.strictEqual(amap.classifyType(''), null);
});

test('normalizePoi 归一化为内部结构（address 非空、坐标数字、分类正确）', () => {
  const raw = {
    id: 'B0I1ODBA7N',
    name: '牛New寿喜烧(来福士店)',
    address: '新业路228号杭州来福士广场4楼',
    location: '120.212943,30.249170',
    typecode: '050202',
    type: '餐饮服务;外国餐厅;日本料理',
    tel: '0571-86022015',
    biz_ext: { rating: '4.7', cost: '172.00', opentime2: '周一至周日 11:00-14:30,17:00-21:30' },
    photos: [{ url: 'https://img/1.jpg' }, { url: 'https://img/2.jpg' }],
    tag: '虎皮凤爪,椒麻大虾',
  };
  const poi = amap.normalizePoi(raw);
  assert.strictEqual(poi.id, 'B0I1ODBA7N');
  assert.strictEqual(poi.name, '牛New寿喜烧(来福士店)');
  assert.strictEqual(poi.address, '新业路228号杭州来福士广场4楼');
  assert.strictEqual(poi.lng, 120.212943);
  assert.strictEqual(poi.lat, 30.24917);
  assert.strictEqual(poi.category, 'food');
  assert.strictEqual(poi.rating, '4.7');
  assert.strictEqual(poi.cost, '172.00');
  assert.strictEqual(poi.tel, '0571-86022015');
  assert.strictEqual(poi.opentime, '周一至周日 11:00-14:30,17:00-21:30');
  assert.strictEqual(poi.photo, 'https://img/1.jpg');
  assert.deepStrictEqual(poi.tags, ['虎皮凤爪', '椒麻大虾']);
});

test('normalizePoi address 为空数组时回退到行政区拼接', () => {
  const poi = amap.normalizePoi({
    id: 'X',
    name: '某点',
    address: [],
    location: '120.1,30.1',
    typecode: '110000',
    pname: '浙江省',
    cityname: '杭州市',
    adname: '西湖区',
  });
  assert.strictEqual(poi.address, '浙江省杭州市西湖区');
  assert.strictEqual(poi.category, 'sight');
});

test('amapGet 成功返回解析后的 JSON', async () => {
  await withFetch({ status: '1', infocode: '10000', pois: [] }, async () => {
    const json = await amap.amapGet('/v3/place/text', { keywords: 'x' });
    assert.strictEqual(json.status, '1');
  });
});

test('amapGet status!=1 时抛出 AMAP_ERROR 并带上 info', async () => {
  await withFetch(
    { status: '0', infocode: '10001', info: 'INVALID_USER_KEY' },
    async () => {
      await assert.rejects(
        () => amap.amapGet('/v3/place/text', { keywords: 'x' }),
        (err) => {
          assert.strictEqual(err.code, 'AMAP_ERROR');
          assert.match(err.message, /INVALID_USER_KEY/);
          return true;
        }
      );
    }
  );
});

test('amapGet 请求 URL 带 key 与参数', async () => {
  await withFetch({ status: '1', infocode: '10000' }, async (calls) => {
    await amap.amapGet('/v3/place/text', { keywords: '西湖', city: '杭州' });
    assert.match(calls[0], /key=TESTKEY/);
    assert.match(calls[0], /keywords=/);
    assert.match(calls[0], /city=/);
  });
});

test('searchCity 只保留 level=city 的项并解析 center', async () => {
  const payload = {
    status: '1',
    infocode: '10000',
    districts: [
      { name: '浙江省', level: 'province', center: '120.1,30.1' },
      { name: '杭州市', level: 'city', center: '120.15507,30.27415', adcode: '330100', citycode: '0571' },
    ],
  };
  await withFetch(payload, async () => {
    const cities = await amap.searchCity('杭州');
    assert.strictEqual(cities.length, 1);
    assert.strictEqual(cities[0].name, '杭州市');
    assert.strictEqual(cities[0].lng, 120.15507);
    assert.strictEqual(cities[0].lat, 30.27415);
  });
});

test('searchPoi 无关键词时使用分类通用词，且 page 被钳制到 25', async () => {
  const payload = { status: '1', infocode: '10000', pois: [] };
  await withFetch(payload, async (calls) => {
    await amap.searchPoi({ city: '杭州', category: 'food', page: 99 });
    assert.match(calls[0], /keywords=/);
    assert.match(decodeURIComponent(calls[0]), /美食/);
    assert.match(calls[0], /page=25/);
    assert.match(calls[0], /extensions=all/);
  });
});

test('nearbyPoi 组装 location 与 radius', async () => {
  const payload = { status: '1', infocode: '10000', pois: [] };
  await withFetch(payload, async (calls) => {
    await amap.nearbyPoi({ lng: 120.15507, lat: 30.27415, category: 'sight', radius: 2000 });
    assert.match(calls[0], /place\/around/);
    assert.match(calls[0], /location=120.15507%2C30.27415/);
    assert.match(calls[0], /radius=2000/);
  });
});

test('poiDetail 返回归一化后的单个 POI', async () => {
  const payload = {
    status: '1',
    infocode: '10000',
    pois: [
      { id: 'D1', name: '西湖', address: '西湖区', location: '120.1,30.2', typecode: '110000' },
    ],
  };
  await withFetch(payload, async () => {
    const poi = await amap.poiDetail('D1');
    assert.strictEqual(poi.id, 'D1');
    assert.strictEqual(poi.category, 'sight');
  });
});
