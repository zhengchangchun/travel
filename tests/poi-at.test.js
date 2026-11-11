/* P19 点地图问「这里是哪」：GET /api/poi/at
   · 这一带库里有点 ⇒ 零调用直接给（用户最想要的也是那个点）
   · 没有 ⇒ 逆地理编码（搜索类配额用尽时它通常还有额度） */
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

const HUBIN = {
  poi_id: 'B0HAV584ZG',
  city: '杭州',
  category: 'stay',
  name: '驿居酒店(杭州西湖湖滨步行街音乐喷泉店)',
  address: '平海路58号平海旺角F3层',
  lng: 120.165652,
  lat: 30.254265,
  rating: '3.7',
};

const REGEO = {
  address: '浙江省绍兴市柯桥区杨汛桥街道岙上沈',
  name: '岙上沈',
  category: null,
  distance: 74.6,
  street: '',
  area: '浙江省 绍兴市 柯桥区 杨汛桥街道',
  building: '',
  neighborhood: '',
  places: [
    { name: '岙上沈', type: '村庄级地名', address: '柯桥区', distance: 74.6 },
    { name: '太平禅寺', type: '寺庙道观', address: '山联村306', distance: 152.8 },
  ],
  roads: [],
};

async function start(opts = {}) {
  const db = createDb(':memory:');
  const calls = { reverse: 0 };
  const amap = {
    async reverseGeocode({ lng, lat }) {
      calls.reverse += 1;
      if (opts.amap && typeof opts.amap.reverseGeocode === 'function') {
        return opts.amap.reverseGeocode({ lng, lat });
      }
      return REGEO;
    },
  };
  const app = createApp({ config: TEST_CONFIG, db, amap });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    db,
    base,
    calls,
    close: () =>
      new Promise((resolve) => {
        app.server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

test('点地图：点击处压着我们的点、名字也对得上 ⇒ 直接弹它的详情（poi 非空）', async () => {
  const { db, base, calls, close } = await start({
    amap: {
      async reverseGeocode() {
        return Object.assign({}, REGEO, { name: '驿居酒店', address: '浙江省杭州市上城区湖滨街道平海路58号' });
      },
    },
  });
  try {
    db.upsertPoi(HUBIN); // 坐标与点击处完全一致
    const { status, body } = await getJson(base, '/api/poi/at?lng=120.165652&lat=30.254265');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.source, 'local');
    assert.strictEqual(body.data.poi.name, HUBIN.name);
    assert.strictEqual(body.data.poi.poi_id, HUBIN.poi_id);
    assert.strictEqual(body.data.name, HUBIN.name, '主名用点击处那一条');
    assert.ok(body.data.address, '地址要有');
    assert.strictEqual(calls.reverse, 1);
  } finally {
    await close();
  }
});

test('点地图：坐标重合但名字对不上 ⇒ 主名是底图上那个（杭州大剧院 ≠ 楼上那家餐厅）', async () => {
  const { db, base, close } = await start({
    amap: {
      async reverseGeocode() {
        return Object.assign({}, REGEO, { name: '杭州大剧院', address: '浙江省杭州市上城区新业路39号' });
      },
    },
  });
  try {
    db.upsertPoi(
      Object.assign({}, HUBIN, { poi_id: 'LUNE1', name: 'La Lune月光女神西餐厅', category: 'food' })
    );
    const { status, body } = await getJson(base, '/api/poi/at?lng=120.165652&lat=30.254265');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.poi, null, '名字对不上就不能当点击处那一条');
    assert.strictEqual(body.data.name, '杭州大剧院', '主名要是底图上写的那个');
    assert.strictEqual(body.data.address, '浙江省杭州市上城区新业路39号');
    const hit = (body.data.nearby || []).find((p) => p.name === 'La Lune月光女神西餐厅');
    assert.ok(hit, '它应该出现在「这一带还有」里');
    assert.strictEqual(hit.poi_id, 'LUNE1');
    assert.ok(hit.distance <= 5, '就在原地，距离要很小，实际 ' + hit.distance);
    assert.strictEqual(hit.source, 'local', '我们库里的那一条要能点开');
  } finally {
    await close();
  }
});

test('点地图：我们的点在一百米外 ⇒ 不冒充点击处，只进「这一带还有」', async () => {
  const { db, base, calls, close } = await start();
  try {
    // +0.001° 经度 ≈ 96m
    db.upsertPoi(Object.assign({}, HUBIN, { poi_id: 'FAR1', name: '一百米外的点', lng: 120.166652 }));
    const { status, body } = await getJson(base, '/api/poi/at?lng=120.165652&lat=30.254265');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.poi, null, '一百米外的点不能当成点击处那一条');
    assert.strictEqual(body.data.source, 'amap');
    assert.strictEqual(body.data.address, REGEO.address, '主信息要是「这个坐标」的地址');
    assert.strictEqual(calls.reverse, 1);
    const hit = (body.data.nearby || []).find((p) => p.name === '一百米外的点');
    assert.ok(hit, '它应该出现在附近列表里');
    assert.strictEqual(hit.poi_id, 'FAR1');
    assert.ok(hit.distance > 50 && hit.distance < 150, '距离要如实标，实际 ' + hit.distance);
  } finally {
    await close();
  }
});

test('点地图：这一带库里没点 ⇒ 逆地理编码拿地址（搜索类额度用尽也能用）', async () => {
  const { base, calls, close } = await start();
  try {
    const { status, body } = await getJson(base, '/api/poi/at?lng=120.30&lat=30.10');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.source, 'amap');
    assert.match(body.data.address, /岙上沈/);
    assert.strictEqual(body.data.name, '岙上沈');
    assert.strictEqual(body.data.lng, 120.3);
    assert.strictEqual(body.data.lat, 30.1);
    assert.strictEqual(calls.reverse, 1);
    const names = (body.data.nearby || []).map((p) => p.name);
    assert.ok(names.includes('太平禅寺'), '这一带还有什么要一起给出来，实际 ' + JSON.stringify(names));
    assert.ok(!names.includes('岙上沈'), '与主名同名的不该在附近列表里重复');
  } finally {
    await close();
  }
});

test('点地图：高德报错（额度用尽等）如实上抛，不吞成假成功', async () => {
  const { base, close } = await start({
    amap: {
      async reverseGeocode() {
        const e = new Error('USER_DAILY_QUERY_OVER_LIMIT');
        e.code = 'AMAP_ERROR';
        throw e;
      },
    },
  });
  try {
    const { status, body } = await getJson(base, '/api/poi/at?lng=120.30&lat=30.10');
    assert.notStrictEqual(status, 200);
    assert.strictEqual(body.ok, false);
  } finally {
    await close();
  }
});

test('点地图：缺参数 / 坐标不是数字 ⇒ 400', async () => {
  const { base, close } = await start();
  try {
    assert.strictEqual((await getJson(base, '/api/poi/at')).status, 400);
    assert.strictEqual((await getJson(base, '/api/poi/at?lng=abc&lat=30')).status, 400);
    assert.strictEqual((await getJson(base, '/api/poi/at?lng=&lat=30')).status, 400);
  } finally {
    await close();
  }
});

test('点地图：同一坐标第二次走缓存（不多打高德）', async () => {
  const { base, calls, close } = await start();
  try {
    await getJson(base, '/api/poi/at?lng=120.30&lat=30.10');
    await getJson(base, '/api/poi/at?lng=120.30&lat=30.10');
    assert.strictEqual(calls.reverse, 1, '同一次点击位置重复查应命中缓存');
  } finally {
    await close();
  }
});
