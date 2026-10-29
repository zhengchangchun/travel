const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../server/index');
const { createDb } = require('../server/db');

const TEST_CONFIG = {
  port: 0,
  amap: { webServiceKey: 'K', jsApiKey: 'JSKEY', jsApiSecurityCode: 'SEC' },
  defaultCity: '杭州',
  usingExample: false,
};

function planResult(mode, distance, duration) {
  return {
    mode,
    distance,
    duration,
    polyline: [
      [120.1, 30.2],
      [120.2, 30.3],
    ],
    steps: [{ instruction: '走', distance, duration, polyline: [[120.1, 30.2], [120.2, 30.3]] }],
    transit: mode === 'transit' ? { distance, duration, cost: 4, segments: [{ type: 'bus', name: '28路', distance, duration }] } : null,
    degraded: false,
  };
}

function fakeAmap(overrides = {}) {
  const calls = [];
  const amap = {
    calls,
    async planWalking(o, d) {
      calls.push({ mode: 'walking', o, d });
      return planResult('walking', 800, 600);
    },
    async planDriving(o, d) {
      calls.push({ mode: 'driving', o, d });
      if (overrides.driving) return overrides.driving(o, d, calls);
      return planResult('driving', 3200, 720);
    },
    async planTransit(o, d, city) {
      calls.push({ mode: 'transit', o, d, city });
      return planResult('transit', 8000, 1800);
    },
  };
  return amap;
}

async function start(opts = {}) {
  const db = opts.db || createDb(':memory:');
  const amap = opts.amap || fakeAmap(opts.amapOverrides);
  const app = createApp({
    config: TEST_CONFIG,
    db,
    amap,
    routeIntervalMs: 0,
    cache: opts.cache,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    amap,
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

function seedThree(db) {
  db.insertPinIfAbsent('杭州', { id: 'A', name: '甲点', lng: 120.1, lat: 30.2, category: 'food' });
  db.insertPinIfAbsent('杭州', { id: 'B', name: '乙点', lng: 120.2, lat: 30.3, category: 'sight' });
  db.insertPinIfAbsent('杭州', { id: 'C', name: '丙点', lng: 120.3, lat: 30.4, category: 'stay' });
}

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

test('GET /api/route 缺 mode → 400', async () => {
  const { base, close } = await start();
  try {
    const { status, body } = await getJson(base, '/api/route?origin=120.1,30.2&destination=120.2,30.3');
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error.code, 'BAD_REQUEST');
  } finally {
    await close();
  }
});

test('GET /api/route mode 非法 → 400', async () => {
  const { base, close } = await start();
  try {
    const { status } = await getJson(base, '/api/route?mode=fly&origin=120.1,30.2&destination=120.2,30.3');
    assert.strictEqual(status, 400);
  } finally {
    await close();
  }
});

test('GET /api/route 坐标格式错 → 400', async () => {
  const { base, close } = await start();
  try {
    const { status } = await getJson(base, '/api/route?mode=driving&origin=abc&destination=120.2,30.3');
    assert.strictEqual(status, 400);
  } finally {
    await close();
  }
});

test('GET /api/route transit 缺 city → 400', async () => {
  const { base, close } = await start();
  try {
    const { status } = await getJson(base, '/api/route?mode=transit&origin=120.1,30.2&destination=120.2,30.3');
    assert.strictEqual(status, 400);
  } finally {
    await close();
  }
});

test('GET /api/route driving 成功返回归一化结果', async () => {
  const { base, close } = await start();
  try {
    const { status, body } = await getJson(
      base,
      '/api/route?mode=driving&origin=120.1,30.2&destination=120.2,30.3'
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.mode, 'driving');
    assert.strictEqual(body.data.distance, 3200);
    assert.ok(body.data.polyline.length >= 2);
  } finally {
    await close();
  }
});

test('GET /api/route 高德报错 → 502 AMAP_ERROR', async () => {
  const err = new Error('DAILY_QUERY_OVER_LIMIT');
  err.code = 'AMAP_ERROR';
  const { base, close } = await start({
    amap: fakeAmap({
      driving: async () => {
        throw err;
      },
    }),
  });
  try {
    const { status, body } = await getJson(
      base,
      '/api/route?mode=driving&origin=120.1,30.2&destination=120.2,30.3'
    );
    assert.strictEqual(status, 502);
    assert.strictEqual(body.error.code, 'AMAP_ERROR');
  } finally {
    await close();
  }
});

test('GET /api/route 同参数第二次命中缓存（不产生新的高德调用）', async () => {
  const { base, amap, close } = await start();
  try {
    const path = '/api/route?mode=driving&origin=120.1,30.2&destination=120.2,30.3';
    const first = await getJson(base, path);
    assert.strictEqual(first.status, 200);
    const after = amap.calls.length;
    await getJson(base, path);
    assert.strictEqual(amap.calls.length, after, '第二次不应再打高德');
  } finally {
    await close();
  }
});

test('GET /api/itinerary/route 缺 city → 400', async () => {
  const { base, close } = await start();
  try {
    const { status } = await getJson(base, '/api/itinerary/route?mode=driving');
    assert.strictEqual(status, 400);
  } finally {
    await close();
  }
});

test('GET /api/itinerary/route 单点行程 → 400', async () => {
  const db = createDb(':memory:');
  db.insertPinIfAbsent('杭州', { id: 'A', name: '甲点', lng: 120.1, lat: 30.2, category: 'food' });
  const { base, close } = await start({ db });
  try {
    const { status, body } = await getJson(base, '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving');
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error.code, 'BAD_REQUEST');
  } finally {
    await close();
  }
});

test('GET /api/itinerary/route 3 点 → legs=2 且 totalDistance 为两段之和', async () => {
  const db = createDb(':memory:');
  seedThree(db);
  const { base, close } = await start({ db });
  try {
    const { status, body } = await getJson(
      base,
      '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving'
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.mode, 'driving');
    assert.strictEqual(body.data.legs.length, 2);
    assert.strictEqual(body.data.legs[0].ok, true);
    assert.strictEqual(body.data.legs[0].from.name, '甲点');
    assert.strictEqual(body.data.legs[1].to.name, '丙点');
    const sum = body.data.legs.reduce((s, l) => s + l.distance, 0);
    assert.strictEqual(body.data.totalDistance, sum);
    assert.strictEqual(body.data.failed.length, 0);
  } finally {
    await close();
  }
});

test('GET /api/itinerary/route 部分段失败降级 → 200，其余段照常', async () => {
  const db = createDb(':memory:');
  seedThree(db);
  let n = 0;
  const { base, close } = await start({
    db,
    amap: fakeAmap({
      driving: async () => {
        n += 1;
        if (n === 2) {
          const e = new Error('步行距离超过上限');
          e.code = 'AMAP_ERROR';
          throw e;
        }
        return planResult('driving', 1000, 600);
      },
    }),
  });
  try {
    const { status, body } = await getJson(
      base,
      '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving'
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.legs.length, 2);
    assert.strictEqual(body.data.legs[0].ok, true);
    assert.strictEqual(body.data.legs[1].ok, false);
    assert.strictEqual(body.data.legs[1].degraded, true);
    assert.match(body.data.legs[1].reason, /超过上限|失败/);
    assert.strictEqual(body.data.totalDistance, 1000);
    assert.strictEqual(body.data.failed.length, 1);
    assert.strictEqual(body.data.failed[0].index, 1);
  } finally {
    await close();
  }
});

test('GET /api/itinerary/route 一段都成功不了 → 502', async () => {
  const db = createDb(':memory:');
  seedThree(db);
  const { base, close } = await start({
    db,
    amap: fakeAmap({
      driving: async () => {
        const e = new Error('DAILY_QUERY_OVER_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      },
    }),
  });
  try {
    const { status, body } = await getJson(
      base,
      '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving'
    );
    assert.strictEqual(status, 502);
    assert.strictEqual(body.error.code, 'AMAP_ERROR');
  } finally {
    await close();
  }
});

test('GET /api/itinerary/route 连打两次第二次命中缓存（不再打高德）', async () => {
  const db = createDb(':memory:');
  seedThree(db);
  const { base, amap, close } = await start({ db });
  try {
    const path = '/api/itinerary/route?city=' + encodeURIComponent('杭州') + '&mode=driving';
    const first = await getJson(base, path);
    assert.strictEqual(first.status, 200);
    const after = amap.calls.length;
    await getJson(base, path);
    assert.strictEqual(amap.calls.length, after, '第二次不应再打高德');
  } finally {
    await close();
  }
});
