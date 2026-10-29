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

const SAMPLE_POI = {
  id: 'P1',
  name: '牛New寿喜烧',
  address: '新业路228号',
  lng: 120.212943,
  lat: 30.24917,
  category: 'food',
  rating: '4.7',
  cost: '172.00',
};

function fakeAmap(overrides = {}) {
  return {
    async searchCity(q) {
      return [{ name: '杭州市', adcode: '330100', center: '120.15507,30.27415', lng: 120.15507, lat: 30.27415 }];
    },
    async searchPoi() {
      return [SAMPLE_POI];
    },
    async nearbyPoi() {
      return [{ ...SAMPLE_POI, id: 'N1', name: '附近点' }];
    },
    async poiDetail() {
      return SAMPLE_POI;
    },
    ...overrides,
  };
}

async function start(opts = {}) {
  const app = createApp({
    config: TEST_CONFIG,
    db: createDb(':memory:'),
    amap: fakeAmap(opts.amapOverrides),
    ...opts,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => close(app) };
}

function close(app) {
  return new Promise((resolve) => {
    app.server.close(() => {
      app.db.close();
      resolve();
    });
  });
}

async function getJson(base, p) {
  const res = await fetch(base + p);
  const body = await res.json();
  return { status: res.status, body };
}

test('GET /api/health 返回 ok 与 status=up', async () => {
  const { base, close: done } = await start();
  try {
    const { status, body } = await getJson(base, '/api/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.status, 'up');
    assert.ok(body.data.uptime >= 0);
  } finally {
    await done();
  }
});

test('GET /api/config 下发 jsApiKey 与 4 条分类', async () => {
  const { base, close: done } = await start();
  try {
    const { body } = await getJson(base, '/api/config');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.jsApiKey, 'JSKEY');
    assert.strictEqual(body.data.defaultCity, '杭州');
    assert.strictEqual(body.data.categories.length, 4);
  } finally {
    await done();
  }
});

test('GET /api/city/search 返回城市列表', async () => {
  const { base, close: done } = await start();
  try {
    const { body } = await getJson(base, '/api/city/search?q=' + encodeURIComponent('杭州'));
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data[0].name, '杭州市');
    assert.ok(body.data[0].lng);
  } finally {
    await done();
  }
});

test('GET /api/poi/search 返回归一化 POI（address 非空）', async () => {
  const { base, close: done } = await start();
  try {
    const { body } = await getJson(base, '/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food');
    assert.strictEqual(body.ok, true);
    assert.ok(body.data.length >= 1);
    assert.ok(body.data[0].address.length > 0);
    assert.ok(body.data[0].lng);
  } finally {
    await done();
  }
});

test('同一 POI 请求第二次命中缓存（hits 增加）', async () => {
  const { base, app, close: done } = await start();
  try {
    const path = '/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food';
    await getJson(base, path);
    const hitsBefore = app.cache.stats().hits;
    await getJson(base, path);
    assert.strictEqual(app.cache.stats().hits, hitsBefore + 1);
  } finally {
    await done();
  }
});

test('高德失败归一为 502 AMAP_ERROR', async () => {
  const err = new Error('INVALID_USER_KEY');
  err.code = 'AMAP_ERROR';
  const { base, close: done } = await start({
    amapOverrides: {
      searchPoi: async () => {
        throw err;
      },
    },
  });
  try {
    const { status, body } = await getJson(
      base,
      '/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food'
    );
    assert.strictEqual(status, 502);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error.code, 'AMAP_ERROR');
    assert.match(body.error.msg, /INVALID_USER_KEY/);
  } finally {
    await done();
  }
});

test('行程与加点 CRUD + 校验', async () => {
  const { base, app, close: done } = await start();
  try {
    const created = await (
      await fetch(base + '/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: '杭州', title: '周末' }),
      })
    ).json();
    assert.strictEqual(created.ok, true);
    const tripId = created.data.id;

    const bad = await fetch(base + '/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州' }),
    });
    assert.strictEqual(bad.status, 400);

    const pinRes = await (
      await fetch(base + '/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trip_id: tripId,
          name: '西湖',
          address: '西湖区',
          lng: 120.1,
          lat: 30.2,
          category: 'sight',
        }),
      })
    ).json();
    assert.strictEqual(pinRes.ok, true);

    const pins = await getJson(base, `/api/trips/${tripId}/pins`);
    assert.strictEqual(pins.body.data.length, 1);

    const trips = await getJson(base, '/api/trips');
    assert.strictEqual(trips.body.data.length, 1);

    const del = await fetch(base + `/api/trips/${tripId}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    // 行程删除后：其 pins 已级联删除，行程不复存在（再次查询 → 404）
    const pinsAfter = await getJson(base, `/api/trips/${tripId}/pins`);
    assert.strictEqual(pinsAfter.status, 404);
    assert.strictEqual(app.db.getPinsByTrip(tripId).length, 0);
  } finally {
    await done();
  }
});

test('不存在行程的 pins 返回 404', async () => {
  const { base, close: done } = await start();
  try {
    const { status, body } = await getJson(base, '/api/trips/9999/pins');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  } finally {
    await done();
  }
});

test('notes CRUD', async () => {
  const { base, close: done } = await start();
  try {
    const add = await (
      await fetch(base + '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: '杭州', url: 'https://xhs/1', title: '笔记' }),
      })
    ).json();
    assert.strictEqual(add.ok, true);

    const list = await getJson(base, '/api/notes?city=%E6%9D%AD%E5%B7%9E');
    assert.strictEqual(list.body.data.length, 1);
  } finally {
    await done();
  }
});

test('未知 API 路径返回 404 JSON', async () => {
  const { base, close: done } = await start();
  try {
    const { status, body } = await getJson(base, '/api/nope');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.ok, false);
  } finally {
    await done();
  }
});

test('静态托管：/ 返回 index.html', async () => {
  const { base, close: done } = await start();
  try {
    const res = await fetch(base + '/');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const text = await res.text();
    assert.match(text, /<html/i);
  } finally {
    await done();
  }
});

test('静态不存在文件返回 404', async () => {
  const { base, close: done } = await start();
  try {
    const res = await fetch(base + '/nope.css');
    assert.strictEqual(res.status, 404);
  } finally {
    await done();
  }
});

// ---------- T2 选中接口 ----------

async function selectPoi(base, city, poi) {
  const res = await fetch(base + '/api/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city, poi }),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /api/selection 选中后 GET 返回该点 count=1（P17）', async () => {
  const { base, close: done } = await start();
  try {
    const sel = await selectPoi(base, '杭州', SAMPLE_POI);
    assert.strictEqual(sel.status, 200);
    assert.strictEqual(sel.body.ok, true);
    assert.ok(sel.body.data.tripId > 0);
    assert.strictEqual(sel.body.data.pin.poi_id, 'P1');

    const got = await getJson(base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(got.body.data.count, 1);
    assert.strictEqual(got.body.data.pins.length, 1);
    assert.strictEqual(got.body.data.pins[0].poi_id, 'P1');
  } finally {
    await done();
  }
});

test('同 (city, poi_id) 重复选中仍 count=1（P18 幂等）', async () => {
  const { base, close: done } = await start();
  try {
    await selectPoi(base, '杭州', SAMPLE_POI);
    await selectPoi(base, '杭州', SAMPLE_POI);
    const got = await getJson(base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(got.body.data.count, 1);
  } finally {
    await done();
  }
});

test('DELETE /api/selection 取消选中 → count=0（P19）', async () => {
  const { base, close: done } = await start();
  try {
    await selectPoi(base, '杭州', SAMPLE_POI);
    const del = await fetch(
      base + '/api/selection?city=' + encodeURIComponent('杭州') + '&poi_id=P1',
      { method: 'DELETE' }
    );
    assert.strictEqual(del.status, 200);
    const got = await getJson(base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(got.body.data.count, 0);
  } finally {
    await done();
  }
});

test('DELETE 不存在的 poi_id → 404', async () => {
  const { base, close: done } = await start();
  try {
    const del = await fetch(
      base + '/api/selection?city=' + encodeURIComponent('杭州') + '&poi_id=NOPE',
      { method: 'DELETE' }
    );
    assert.strictEqual(del.status, 404);
  } finally {
    await done();
  }
});

test('POST /api/selection 缺 poi 字段 → 400', async () => {
  const { base, close: done } = await start();
  try {
    const ser = await selectPoi(base, '杭州', { name: '没有坐标' });
    assert.strictEqual(ser.status, 400);
    assert.strictEqual(ser.body.error.code, 'BAD_REQUEST');
  } finally {
    await done();
  }
});

test('GET /api/selection 缺 city → 400', async () => {
  const { base, close: done } = await start();
  try {
    const { status, body } = await getJson(base, '/api/selection');
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error.code, 'BAD_REQUEST');
  } finally {
    await done();
  }
});

test('PUT /api/selection/order 顺序持久化（P20）', async () => {
  const { base, close: done } = await start();
  try {
    await selectPoi(base, '杭州', SAMPLE_POI);
    await selectPoi(base, '杭州', { ...SAMPLE_POI, id: 'P2', name: '雷峰塔', category: 'sight' });
    const put = await fetch(base + '/api/selection/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '杭州', poi_ids: ['P2', 'P1'] }),
    });
    assert.strictEqual(put.status, 200);
    const got = await getJson(base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.deepStrictEqual(
      got.body.data.pins.map((p) => p.poi_id),
      ['P2', 'P1']
    );
  } finally {
    await done();
  }
});

test('GET /api/selection/export 返回 Markdown（P21）', async () => {
  const { base, close: done } = await start();
  try {
    await selectPoi(base, '杭州', SAMPLE_POI);
    const res = await fetch(
      base + '/api/selection/export?city=' + encodeURIComponent('杭州') + '&format=md'
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    const text = await res.text();
    assert.match(text, /# 杭州 · 我的行程/);
    assert.match(text, /## 美食/);
    assert.match(text, /新业路228号/);
  } finally {
    await done();
  }
});

test('POST /api/pins 向后兼容：省略 trip_id 时按 city 自动归集', async () => {
  const { base, close: done } = await start();
  try {
    const res = await (
      await fetch(base + '/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: '杭州',
          poi_id: 'PX',
          name: '西湖',
          address: '西湖区',
          lng: 120.1,
          lat: 30.2,
          category: 'sight',
        }),
      })
    ).json();
    assert.strictEqual(res.ok, true);
    assert.ok(res.data.trip_id > 0);
    const got = await getJson(base, '/api/selection?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(got.body.data.count, 1);
  } finally {
    await done();
  }
});

test('PATCH /api/pins/:id 改备注', async () => {
  const { base, close: done } = await start();
  try {
    const sel = await selectPoi(base, '杭州', SAMPLE_POI);
    const pinId = sel.body.data.pin.id;
    const res = await (
      await fetch(base + '/api/pins/' + pinId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: '必吃' }),
      })
    ).json();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.note, '必吃');
  } finally {
    await done();
  }
});
