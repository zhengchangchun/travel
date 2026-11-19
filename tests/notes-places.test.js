// P4：多平台分享文案 → 本地笔记（图文/视频）→ 提取地名 → 高德补全成候选点
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMG_DIR = path.join(os.tmpdir(), 'travel-notes-places-img-' + process.pid);
process.env.TRAVEL_NOTE_IMG_DIR = IMG_DIR;

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

// 假高德：按关键词回固定结果；关键词里带「炸」的抛错（模拟配额耗尽）
function fakeAmap(calls) {
  const DB = {
    西湖: [{ id: 'B0FFXIHU', name: '西湖', address: '西湖区龙井路1号', lng: 120.15, lat: 30.25, rating: '4.8', category: 'sight', photo: 'p1' }],
    南山路店: [
      { id: 'B0FFNANSHAN', name: 'Seesaw Coffee(南山路店)', address: '南山路208号', lng: 120.16, lat: 30.23, rating: '4.5', category: 'food', photo: 'p2' },
      { id: 'B0FFOTHER', name: '别的店', address: 'x', lng: 120.1, lat: 30.2, rating: '4.9', category: 'food', photo: '' },
    ],
  };
  return {
    searchPoi({ city, keywords }) {
      calls.push(keywords + '@' + city);
      if (String(keywords).includes('炸')) throw new Error('USER_DAILY_QUERY_OVER_LIMIT');
      return DB[keywords] || [];
    },
  };
}

async function startApp(opts = {}) {
  const app = createApp({
    authFallbackUser: true,
    config: TEST_CONFIG,
    categories: CATEGORIES,
    db: opts.db || createDb(':memory:'),
    amap: opts.amap || { searchPoi: () => [] },
    // 单测一律注入假 OSM：不许真打外部请求
    osm: opts.osm || { searchOsm: async () => [] },
    collectIntervalMs: 0,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return app;
}

async function req(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test.after(() => {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
});

const DOUYIN_SHARE =
  '7.68 复制打开抖音，看看【郑嘉练的作品】杭州健身房探店：湖滨银泰和吴山广场两家 # 健身 https://v.douyin.com/iJabcDE/ 复制此链接，打开Dou音搜索，直接观看视频！';

test('POST /api/notes/parse：分享文案 → 平台/形态/标题/作者 + 地名候选（零落库）', async () => {
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const r = await req(base, 'POST', '/api/notes/parse', { text: DOUYIN_SHARE });
    assert.strictEqual(r.status, 200);
    const d = r.body.data;
    assert.strictEqual(d.source, '抖音');
    assert.strictEqual(d.source_type, 'douyin');
    assert.strictEqual(d.kind, 'video', '抖音默认是视频');
    assert.strictEqual(d.author, '郑嘉练');
    assert.match(d.title, /杭州健身房探店/);
    assert.ok(d.names.includes('湖滨银泰') || d.names.includes('吴山广场'), JSON.stringify(d.names));
    assert.strictEqual((await req(base, 'GET', '/api/notes')).body.data.length, 0, '解析不落库');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes：只贴分享文案也能建笔记（url/来源/形态/标题自动补全）', async () => {
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const r = await req(base, 'POST', '/api/notes', {
      share_text: DOUYIN_SHARE,
      city: '杭州',
    });
    assert.strictEqual(r.status, 200);
    const d = r.body.data;
    assert.strictEqual(d.url, 'https://v.douyin.com/iJabcDE/');
    assert.strictEqual(d.source, '抖音');
    assert.strictEqual(d.kind, 'video');
    assert.strictEqual(d.author, '郑嘉练');
    assert.match(d.title, /杭州健身房探店/);
    assert.strictEqual(d.share_text, DOUYIN_SHARE, '原文留档');
    // 列表里能按来源过滤（P3 的本地搜索继续可用）
    const onlyDouyin = await req(base, 'GET', '/api/notes/search?source=douyin');
    assert.strictEqual(onlyDouyin.body.data.total, 1);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes：视频笔记（封面落本地、视频只存链接）', async () => {
  const img = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }));
  });
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const r = await req(base, 'POST', '/api/notes', {
      title: '夜爬泰山',
      source: '快手',
      source_type: 'kuaishou',
      kind: 'video',
      city: '泰安',
      video_url: 'https://v.kuaishou.com/abcDEF',
      cover_url: img.base + '/cover.jpg',
      image_urls: [img.base + '/a.jpg'],
    });
    assert.strictEqual(r.status, 200);
    const d = r.body.data;
    assert.strictEqual(d.kind, 'video');
    assert.strictEqual(d.video_url, 'https://v.kuaishou.com/abcDEF');
    assert.match(d.cover_url, /^\/notes-img\/[0-9a-f]{16}\.jpg$/);
    assert.strictEqual(d.images.length, 1, '封面不混进正文图条');
    assert.strictEqual(d.download.cover.saved, true);
    assert.ok(fs.existsSync(path.join(IMG_DIR, path.basename(d.cover_url))), '封面落盘');
    const got = await fetch(base + d.cover_url);
    assert.strictEqual(got.status, 200);
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => img.server.close(r));
  }
});

test('POST /api/notes/:id/places（默认）：只提取地名、零调用、可读回', async () => {
  const calls = [];
  const db = createDb(':memory:');
  const app = await startApp({ db, amap: fakeAmap(calls) });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://www.xiaohongshu.com/explore/abc',
      city: '杭州',
      title: '杭州咖啡地图',
      source: '小红书',
      source_type: 'xhs',
      content: '第一家 Seesaw 南山路店，第二家去西湖边散步',
    });
    const id = created.body.data.id;
    const r = await req(base, 'POST', '/api/notes/' + id + '/places', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.calls, 0, '不补全就不该打高德');
    assert.strictEqual(calls.length, 0);
    assert.ok(r.body.data.names.includes('南山路店'));
    assert.strictEqual(r.body.data.places.length, r.body.data.names.length);
    assert.ok(r.body.data.places.every((p) => p.poi_id === null), '没补全时 poi_id 空着');
    // 读单条：带 places 与条数
    const one = await req(base, 'GET', '/api/notes/' + id);
    assert.strictEqual(one.body.data.places.length, r.body.data.names.length);
    assert.strictEqual(one.body.data.place_count, r.body.data.names.length);
    // 列表带 place_count 角标
    const list = await req(base, 'GET', '/api/notes?city=' + encodeURIComponent('杭州'));
    assert.strictEqual(list.body.data[0].place_count, r.body.data.names.length);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/:id/places（resolve=1）：逐名 1 次调用、挑最贴的一条、失败如实报', async () => {
  const calls = [];
  const app = await startApp({ amap: fakeAmap(calls) });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      city: '杭州',
      title: '杭州两日',
      source: '小红书',
      source_type: 'xhs',
      content: '第一天 Seesaw 南山路店，第二天去西湖，第三家在轰炸大鱿鱼店',
    });
    const id = created.body.data.id;
    const r = await req(base, 'POST', '/api/notes/' + id + '/places', { resolve: true });
    assert.strictEqual(r.status, 200);
    const d = r.body.data;
    assert.strictEqual(d.calls, d.names.length, '每个名字正好 1 次调用');
    assert.strictEqual(calls.length, d.names.length);
    assert.ok(calls.every((c) => c.endsWith('@杭州')), '补全带城市限定：' + JSON.stringify(calls));
    const nan = d.places.find((p) => p.name === '南山路店');
    assert.strictEqual(nan.poi_id, 'B0FFNANSHAN', '名字包含度优先（不是评分更高的「别的店」）');
    assert.strictEqual(nan.poi_name, 'Seesaw Coffee(南山路店)', '真名也存下来（加入选择/地图用）');
    assert.strictEqual(nan.rating, 4.5);
    assert.ok(nan.resolved_at, '补全过的记时间');
    const xihu = d.places.find((p) => p.name === '西湖');
    assert.strictEqual(xihu.lng, 120.15);
    // 失败的名字：不写假点，poi_id 空、有 errors
    const boom = d.places.find((p) => p.name.includes('炸'));
    if (boom) {
      assert.strictEqual(boom.poi_id, null);
      assert.ok(d.errors.some((e) => e.name.includes('炸')), '失败要报出来');
    }
    assert.strictEqual(d.resolved, d.places.filter((p) => p.poi_id).length);
    // 重跑幂等：地点行整批替换，不堆历史
    const again = await req(base, 'POST', '/api/notes/' + id + '/places', { resolve: true });
    assert.strictEqual(again.body.data.places.length, d.places.length, '重跑不累积');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('地名补全兜底：高德没配额时走 OSM（来源如实标 osm）', async () => {
  const osmCalls = [];
  const app = await startApp({
    amap: {
      searchPoi() {
        throw new Error('USER_DAILY_QUERY_OVER_LIMIT');
      },
    },
    osm: {
      searchOsm({ city, keywords }) {
        osmCalls.push({ city, keywords });
        if (keywords !== '西湖') {
          // 兜底源可能返回同名以外的结果：路由要把它筛掉
          return [{ id: 'osm:noise', name: '环城东路', lng: 120.17, lat: 30.24, category: 'sight', source: 'osm' }];
        }
        return [
          {
            id: 'osm:relation2308774',
            name: '西湖',
            address: '苏堤 杭州市 浙江省',
            lng: 120.1445,
            lat: 30.2489,
            category: 'sight',
            rating: '',
            photo: '',
            source: 'osm',
          },
        ];
      },
    },
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      city: '杭州',
      title: 'T',
      content: '去西湖，然后去密渡桥路',
    });
    const id = created.body.data.id;
    const r = await req(base, 'POST', '/api/notes/' + id + '/places', { resolve: true });
    assert.strictEqual(r.status, 200);
    const d = r.body.data;
    assert.ok(d.calls >= 1, '高德被试过');
    assert.ok(d.osm_calls >= 1, 'OSM 兜底被调过');
    const xihu = d.places.find((p) => p.name === '西湖');
    assert.strictEqual(xihu.source, 'osm');
    assert.strictEqual(xihu.poi_id, 'osm:relation2308774');
    assert.strictEqual(xihu.lng, 120.1445);
    assert.ok(xihu.resolved_at, '兜底也算补全成功');
    assert.strictEqual(d.by_source.osm, 1);
    // 两个源都查不到的：不写假点，错因如实报
    const miss = d.places.find((p) => p.name === '密渡桥路');
    assert.strictEqual(miss.poi_id, null);
    assert.ok(d.errors.some((e) => /OVER_LIMIT/.test(e.msg)), '高德的原因要报出来');
    const dup = d.errors.filter((e) => e.name === '密渡桥路');
    assert.strictEqual(dup.length, 1, '同一个地名只报一条（错因合并）');
    assert.match(dup[0].msg, /OSM/, '两个源的原因都要在');
    assert.ok(osmCalls.every((c) => c.city === '杭州'));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('地名补全：显式 geocoder=amap 时不走兜底', async () => {
  const osmCalls = [];
  const app = await startApp({
    amap: { searchPoi: () => [] },
    osm: {
      searchOsm() {
        osmCalls.push(1);
        return [{ id: 'osm:1', name: '西湖', lng: 1, lat: 2, category: 'sight', source: 'osm' }];
      },
    },
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      city: '杭州',
      title: 'T',
      content: '去西湖',
    });
    const r = await req(base, 'POST', '/api/notes/' + created.body.data.id + '/places', {
      resolve: true,
      geocoder: 'amap',
      names: ['西湖'],
    });
    assert.strictEqual(r.body.data.osm_calls, 0);
    assert.strictEqual(osmCalls.length, 0);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/:id/places：names 可覆盖（用户自己挑选/手填）', async () => {
  const calls = [];
  const app = await startApp({ amap: fakeAmap(calls) });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      city: '杭州',
      title: 'T',
      source: '小红书',
      content: '一堆没用的描述',
    });
    const id = created.body.data.id;
    const r = await req(base, 'POST', '/api/notes/' + id + '/places', {
      resolve: true,
      names: ['西湖'],
    });
    assert.deepStrictEqual(r.body.data.names, ['西湖']);
    assert.strictEqual(r.body.data.calls, 1);
    assert.strictEqual(r.body.data.places[0].poi_id, 'B0FFXIHU');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('POST /api/notes/:id/places：resolve 时没有城市 → 400（不瞎猜）', async () => {
  const app = await startApp();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', { url: 'https://x.com/1', title: 'T' });
    const r = await req(base, 'POST', '/api/notes/' + created.body.data.id + '/places', {
      resolve: true,
    });
    assert.strictEqual(r.status, 400);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('DELETE /api/notes/:id：地点候选一起删（不留孤儿行）', async () => {
  const db = createDb(':memory:');
  const app = await startApp({ db });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const created = await req(base, 'POST', '/api/notes', {
      url: 'https://x.com/1',
      city: '杭州',
      title: 'T',
      content: '去西湖',
    });
    const id = created.body.data.id;
    await req(base, 'POST', '/api/notes/' + id + '/places', {});
    assert.ok(db.listNotePlaces(id).length > 0);
    await req(base, 'DELETE', '/api/notes/' + id);
    assert.strictEqual(db.listNotePlaces(id).length, 0);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
