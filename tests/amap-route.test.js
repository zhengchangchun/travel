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

test('parsePolyline 解析高德 "lng,lat;lng,lat" 为坐标数组', () => {
  assert.deepStrictEqual(amap.parsePolyline('120.1,30.2;120.2,30.3'), [
    [120.1, 30.2],
    [120.2, 30.3],
  ]);
});

test('parsePolyline 空值/非法点返回空数组并跳过坏点', () => {
  assert.deepStrictEqual(amap.parsePolyline(''), []);
  assert.deepStrictEqual(amap.parsePolyline(null), []);
  assert.deepStrictEqual(amap.parsePolyline('bad;120.1,30.2'), [[120.1, 30.2]]);
});

const DRIVING_PAYLOAD = {
  status: '1',
  infocode: '10000',
  route: {
    origin: '120.1,30.2',
    destination: '120.2,30.3',
    paths: [
      {
        distance: '3200',
        duration: '720',
        steps: [
          { instruction: '向东行驶300米', distance: '300', duration: '60', polyline: '120.1,30.2;120.12,30.21' },
          { instruction: '右转', distance: '2900', duration: '660', polyline: '120.12,30.21;120.2,30.3' },
        ],
      },
    ],
  },
};

test('planDriving 归一化为统一形状（距离/耗时数字、折线、步骤）', async () => {
  await withFetch(DRIVING_PAYLOAD, async (calls) => {
    const r = await amap.planDriving('120.1,30.2', '120.2,30.3');
    assert.strictEqual(r.mode, 'driving');
    assert.strictEqual(r.distance, 3200);
    assert.strictEqual(r.duration, 720);
    assert.strictEqual(r.degraded, false);
    assert.ok(r.polyline.length >= 3, '相邻段折线拼接后应连续（去重接缝点）');
    assert.deepStrictEqual(r.polyline[0], [120.1, 30.2]);
    assert.deepStrictEqual(r.polyline[r.polyline.length - 1], [120.2, 30.3]);
    assert.strictEqual(r.steps.length, 2);
    assert.strictEqual(r.steps[0].instruction, '向东行驶300米');
    assert.strictEqual(r.transit, null);
    assert.match(calls[0], /direction\/driving/);
    assert.match(calls[0], /origin=120.1%2C30.2/);
  });
});

test('planWalking 走步行接口并归一化', async () => {
  const payload = {
    status: '1',
    infocode: '10000',
    route: {
      paths: [
        { distance: '800', duration: '600', steps: [{ instruction: '步行', distance: '800', duration: '600', polyline: '120.1,30.2;120.11,30.21' }] },
      ],
    },
  };
  await withFetch(payload, async (calls) => {
    const r = await amap.planWalking('120.1,30.2', '120.11,30.21');
    assert.strictEqual(r.mode, 'walking');
    assert.strictEqual(r.distance, 800);
    assert.strictEqual(r.polyline.length, 2);
    assert.match(calls[0], /direction\/walking/);
  });
});

test('planTransit 从 segments 拼出完整折线并带回换乘摘要', async () => {
  const payload = {
    status: '1',
    infocode: '10000',
    route: {
      transits: [
        {
          distance: '8000',
          duration: '1800',
          cost: '4',
          segments: [
            { walking: { distance: '300', duration: '240', steps: [{ polyline: '120.1,30.2;120.11,30.21' }] } },
            {
              bus: {
                buslines: [
                  { name: '28路(植物园-城站)', distance: '7000', duration: '1400', polyline: '120.11,30.21;120.15,30.25', via_num: '8' },
                ],
              },
            },
            { walking: { distance: '700', duration: '160', steps: [{ polyline: '120.15,30.25;120.2,30.3' }] } },
          ],
        },
      ],
    },
  };
  await withFetch(payload, async (calls) => {
    const r = await amap.planTransit('120.1,30.2', '120.2,30.3', '杭州');
    assert.strictEqual(r.mode, 'transit');
    assert.strictEqual(r.distance, 8000);
    assert.strictEqual(r.duration, 1800);
    assert.ok(r.polyline.length >= 4, '折线应由步行+公交拼接');
    assert.ok(r.transit, '应带回换乘摘要');
    assert.strictEqual(r.transit.segments.length, 3);
    assert.strictEqual(r.transit.segments[0].type, 'walking');
    assert.strictEqual(r.transit.segments[1].type, 'bus');
    assert.strictEqual(r.transit.segments[1].name, '28路(植物园-城站)');
    assert.match(calls[0], /direction\/transit\/integrated/);
    assert.match(decodeURIComponent(calls[0]), /city=杭州/);
  });
});

test('planDriving 高德报错时抛 AMAP_ERROR（上层可降级）', async () => {
  await withFetch({ status: '0', infocode: '10003', info: 'DAILY_QUERY_OVER_LIMIT' }, async () => {
    await assert.rejects(
      () => amap.planDriving('120.1,30.2', '120.2,30.3'),
      (err) => {
        assert.strictEqual(err.code, 'AMAP_ERROR');
        assert.match(err.message, /DAILY_QUERY_OVER_LIMIT/);
        return true;
      }
    );
  });
});

test('planDriving 无可用路径时抛 AMAP_ERROR', async () => {
  await withFetch({ status: '1', infocode: '10000', route: { paths: [] } }, async () => {
    await assert.rejects(() => amap.planDriving('120.1,30.2', '120.2,30.3'), (err) => {
      assert.strictEqual(err.code, 'AMAP_ERROR');
      return true;
    });
  });
});

test('planTransit 无公交方案时抛 AMAP_ERROR', async () => {
  await withFetch({ status: '1', infocode: '10000', route: { transits: [] } }, async () => {
    await assert.rejects(() => amap.planTransit('120.1,30.2', '120.2,30.3', '杭州'), (err) => {
      assert.strictEqual(err.code, 'AMAP_ERROR');
      return true;
    });
  });
});
