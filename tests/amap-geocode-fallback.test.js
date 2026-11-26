/* 搜索池用尽时的兜底：geocode/geo + geocode/regeo（2026-11-25）

   背景（实测 + 官方错误码表）：
     · 10044 USER_DAILY_QUERY_OVER_LIMIT 官方释义＝「账号维度**日**调用量超出限制」
       ⇒ 次日 0 点恢复，**不是**月额度（早先写「下月 1 日」是错的）
     · 高德按**服务大类**分池：place/*（搜索）用尽时，geocode/*（地理编码）通常还有额度
       —— 实测同一天同一个 key：place/text 报 10044，geocode/geo 与 regeo 连续 40 次全成功
     · regeo 的 extensions=all 直接返回坐标周边 30 个 POI（名字/类型/地址/电话/距离）

   所以「按名字找一个地方」这件事，搜索池没了也还能做：
     ① geocode/geo 名字 → 坐标
     ② geocode/regeo 坐标 → 周边 POI，按名字匹配（有 id，能点详情）
     ③ regeo 没匹配上但 level 是「兴趣点/门牌号」⇒ 至少落一个点

   顺带修的真 bug：exhaustedKeys 早先只按 key 记、不分接口族 ⇒ 多 key 时
   place/* 一用尽就把整个 key 标死，连还能用的 geocode/* 一起跳过。
*/
const test = require('node:test');
const assert = require('node:assert');

const amap = require('../server/amap');

// 假 fetch：按 pathname 分派，记录每次请求
function withFetch(handler, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
    const payload = handler(u.pathname, Object.fromEntries(u.searchParams));
    return { ok: true, status: 200, json: async () => payload };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = orig;
    });
}

const QUOTA = { status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT', infocode: '10044' };

test.beforeEach(() => {
  amap.setConfig({ amap: { webServiceKey: 'TESTKEY' } });
  amap.resetKeyStatus();
});

// ---------- ① 接口族分池 ----------

test('familyOf：按 /vN/<族>/ 取接口族', () => {
  assert.strictEqual(amap.familyOf('/v3/place/text'), 'place');
  assert.strictEqual(amap.familyOf('/v5/place/detail'), 'place');
  assert.strictEqual(amap.familyOf('/v3/geocode/geo'), 'geocode');
  assert.strictEqual(amap.familyOf('/v3/geocode/regeo'), 'geocode');
  assert.strictEqual(amap.familyOf('/v3/direction/driving'), 'direction');
  assert.strictEqual(amap.familyOf('/v3/staticmap'), 'other');
  assert.strictEqual(amap.familyOf(''), 'other');
});

test('搜索池用尽不连累地理编码池（真 bug 回归）', async () => {
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  await withFetch(
    (pathname, params) => {
      // 两个 key 的 place/* 都用尽；geocode/* 都正常
      if (pathname.startsWith('/v3/place/')) return QUOTA;
      return { status: '1', infocode: '10000', geocodes: [{ location: '120.1,30.2', level: '兴趣点' }] };
    },
    async (calls) => {
      // 先把 place 打到两个 key 都标死
      await assert.rejects(() => amap.amapGet('/v3/place/text', { keywords: 'x' }), /OVER_LIMIT/);
      const st1 = amap.keyStatus();
      assert.deepStrictEqual(st1.families, ['place'], '只该记 place 这一族用尽');
      assert.strictEqual(st1.available, 0, '按「任一接口族用尽」算，两个 key 都不可用');

      // 地理编码池还能用 ⇒ 不该被 place 的用尽状态挡住
      calls.length = 0;
      const json = await amap.amapGet('/v3/geocode/geo', { address: '西湖' });
      assert.strictEqual(json.status, '1', 'geocode 应照常成功');
      assert.strictEqual(calls.length, 1, '应一次就成，不该因为 place 用尽而跳过 key');
    }
  );
});

test('keyStatus：families 列出已用尽的接口族，exhaustedFamilies 逐 key 给', async () => {
  amap.setConfig({ amap: { webServiceKeys: ['key-A', 'key-B'] } });
  amap.resetKeyStatus();

  await withFetch(
    (pathname, params) => {
      if (pathname.startsWith('/v3/place/')) return QUOTA;
      return { status: '1', infocode: '10000', geocodes: [] };
    },
    async () => {
      await assert.rejects(() => amap.amapGet('/v3/place/text', {}), /OVER_LIMIT/);
      const st = amap.keyStatus();
      assert.deepStrictEqual(st.families, ['place']);
      const a = st.keys.find((k) => k.tail === 'ey-A');
      const b = st.keys.find((k) => k.tail === 'ey-B');
      assert.deepStrictEqual(a.exhaustedFamilies, ['place']);
      assert.deepStrictEqual(b.exhaustedFamilies, ['place']);
      assert.ok(!JSON.stringify(st).includes('key-A'), '不能把完整 key 吐出去');
    }
  );
});

// ---------- ② 名字匹配 ----------

test('nameMatches / nameMatchRank：相等 > 前缀 > 包含', () => {
  assert.strictEqual(amap.nameMatchRank('灵隐寺', '灵隐寺'), 0, '相等');
  assert.strictEqual(amap.nameMatchRank('灵隐寺', '灵隐寺-东经幢'), 1, '前缀');
  assert.strictEqual(amap.nameMatchRank('河坊街', '河坊街景区'), 1, '前缀');
  // 高德官方名常把地名包在中间：「杭州西湖风景名胜区-断桥残雪」
  assert.strictEqual(amap.nameMatchRank('断桥残雪', '杭州西湖风景名胜区-断桥残雪'), 2, '≥3 字被包含');
  // 餐馆名里带地名 ⇒ 只是包含，不能顶掉景区
  assert.strictEqual(amap.nameMatchRank('河坊街', '景阳观(河坊街店)'), 2, '包含（不是前缀）');
  assert.strictEqual(amap.nameMatchRank('楼外楼', '中山公园'), 3, '不匹配');
  assert.strictEqual(amap.nameMatchRank('', '灵隐寺'), 3, '空查询');
  assert.strictEqual(amap.nameMatchRank('a', 'abc'), 3, '单字太短');
  // 2 字名不做包含匹配，否则「西湖」会把「西湖国宾馆」「西湖文化广场」全命中
  assert.strictEqual(amap.nameMatchRank('西湖', '杭州西湖'), 3, '2 字名不做包含匹配');
  // 旧接口语义不变
  assert.strictEqual(amap.nameMatches('断桥残雪', '杭州西湖风景名胜区-断桥残雪'), true);
  assert.strictEqual(amap.nameMatches('楼外楼', '中山公园'), false);
});

test('normPlaceName：去空格与标点、小写', () => {
  assert.strictEqual(amap.normPlaceName(' 灵隐寺 '), '灵隐寺');
  assert.strictEqual(amap.normPlaceName('外婆家(湖滨店)'), '外婆家湖滨店');
  assert.strictEqual(amap.normPlaceName('A·B'), 'ab');
});

// ---------- ③ 兜底链 ----------

test('searchPoiByGeocode：geocode → regeo，按名字匹配出真 POI', async () => {
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.102352,30.239963', level: '兴趣点', formatted_address: '浙江省杭州市西湖区灵隐寺(7号门)' }],
        };
      }
      if (pathname === '/v3/geocode/regeo') {
        return {
          status: '1',
          infocode: '10000',
          regeocode: {
            formatted_address: '浙江省杭州市西湖区西湖街道灵隐寺',
            pois: [
              { id: 'B1', name: '灵隐寺-天王殿', type: '风景名胜;风景名胜;寺庙道观', location: '120.1020,30.2400', distance: '65.0', tel: '0571-1' },
              { id: 'B2', name: '飞来峰', type: '风景名胜;风景名胜;风景名胜', location: '120.1010,30.2410', distance: '152.5' },
              { id: 'B3', name: '灵隐寺', type: '风景名胜;风景名胜;寺庙道观', location: '120.1023,30.2399', distance: '0' },
            ],
          },
        };
      }
      return QUOTA;
    },
    async (calls) => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '灵隐寺' });
      assert.strictEqual(res.via, 'regeo', '应走 regeo 这一跳');
      assert.strictEqual(res.pois.length, 2, '只留名字对得上的（飞来峰不算）');
      assert.strictEqual(res.pois[0].name, '灵隐寺', '名字完全相等的排第一');
      assert.strictEqual(res.pois[0].id, 'B3', '要带真 POI id（能点详情）');
      assert.strictEqual(res.pois[0].category, 'sight', '分类从 type 文本推');
      assert.strictEqual(res.pois[1].name, '灵隐寺-天王殿');
      assert.deepStrictEqual(
        calls.map((c) => c.path),
        ['/v3/geocode/geo', '/v3/geocode/regeo'],
        '两步：先 geo 再 regeo'
      );
    }
  );
});

test('searchPoiByGeocode：排序＝匹配等级 > 有分类 > 距离近', async () => {
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.170888,30.240244', level: '道路', formatted_address: '浙江省杭州市上城区河坊街' }],
        };
      }
      return {
        status: '1',
        infocode: '10000',
        regeocode: {
          pois: [
            // 距离最近但只是「包含」匹配（餐馆名里带地名）—— 不该排第一
            { id: 'F1', name: '景阳观(河坊街店)', type: '餐饮服务;中餐厅;中餐厅', location: '120.17,30.24', distance: '42.8' },
            // 距离最近但分类为空（住宅小区）—— 也不该排第一
            { id: 'R1', name: '河坊街89号小区', type: '商务住宅;住宅区;住宅小区', location: '120.17,30.24', distance: '48.4' },
            // 距离远但是前缀匹配 + 有分类（景区）—— 该排第一
            { id: 'S1', name: '河坊街景区', type: '风景名胜;风景名胜;风景名胜', location: '120.17,30.24', distance: '102.6' },
          ],
        },
      };
    },
    async () => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '河坊街' });
      assert.strictEqual(res.pois.length, 3);
      // 「河坊街景区」与「河坊街89号小区」都是前缀匹配（rank 1），但景区有分类 ⇒ 排第一
      assert.strictEqual(res.pois[0].name, '河坊街景区', '前缀匹配 + 有分类的景区要排第一');
      assert.strictEqual(res.pois[0].category, 'sight');
      // 小区也是前缀匹配，但分类空 ⇒ 排第二
      assert.strictEqual(res.pois[1].name, '河坊街89号小区', '前缀匹配但无分类的排第二');
      assert.strictEqual(res.pois[1].category, null, '住宅小区不在四分类里 ⇒ 分类空');
      // 餐馆只是包含匹配（rank 2）⇒ 即使距离最近也排最后
      assert.strictEqual(res.pois[2].name, '景阳观(河坊街店)', '包含匹配的排最后（哪怕距离最近）');
      assert.strictEqual(res.pois[2].category, 'food');
    }
  );
});

test('searchPoiByGeocode：锚点校验 —— 同名异地不落错点', async () => {
  // 实测场景：笔记写「河坊街吃景阳观」，geocode 把「景阳观」解到余杭区（离河坊街 15km）
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.110727,30.374613', level: '兴趣点', formatted_address: '浙江省杭州市余杭区景阳观' }],
        };
      }
      return { status: '1', infocode: '10000', regeocode: { pois: [] } };
    },
    async () => {
      // 锚点＝河坊街（120.170888,30.240244）
      const res = await amap.searchPoiByGeocode({
        city: '杭州',
        keywords: '景阳观',
        anchors: [{ name: '河坊街', lng: 120.170888, lat: 30.240244 }],
      });
      assert.strictEqual(res.via, 'none', '离锚点 15km ⇒ 不落点');
      assert.deepStrictEqual(res.pois, []);
      assert.match(res.rejected, /同名异地/, '要说清为什么没补上');
      assert.match(res.rejected, /河坊街/, '要点名是离哪个锚点太远');
    }
  );
});

test('searchPoiByGeocode：锚点校验 —— 离得近就正常落点', async () => {
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.168,30.248', level: '兴趣点', formatted_address: '浙江省杭州市上城区知味观' }],
        };
      }
      return { status: '1', infocode: '10000', regeocode: { pois: [] } };
    },
    async () => {
      const res = await amap.searchPoiByGeocode({
        city: '杭州',
        keywords: '知味观',
        anchors: [{ name: '河坊街', lng: 120.170888, lat: 30.240244 }],
      });
      assert.strictEqual(res.via, 'geocode', '离锚点 1km ⇒ 正常落点');
      assert.strictEqual(res.pois.length, 1);
      assert.strictEqual(res.pois[0].name, '知味观');
    }
  );
});

test('searchPoiByGeocode：没传锚点时不校验（单点搜索场景）', async () => {
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.110727,30.374613', level: '兴趣点', formatted_address: '浙江省杭州市余杭区景阳观' }],
        };
      }
      return { status: '1', infocode: '10000', regeocode: { pois: [] } };
    },
    async () => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '景阳观' });
      assert.strictEqual(res.via, 'geocode', '没锚点就无从判同名异地，照常落点');
      assert.strictEqual(res.pois.length, 1);
    }
  );
});

test('kmBetween：两点距离（杭州西湖 → 余杭区约 16km）', () => {
  const km = amap.kmBetween(120.170888, 30.240244, 120.110727, 30.374613);
  assert.ok(km > 15 && km < 17, `应约 16km，实际 ${km.toFixed(1)}`);
  assert.strictEqual(amap.kmBetween(120.1, 30.2, 120.1, 30.2), 0);
});

test('anchorRadiusKm：默认 10km，锚点越散阈值越宽', () => {
  // 单锚点 ⇒ 10km
  assert.strictEqual(amap.anchorRadiusKm([{ lng: 120.17, lat: 30.24 }]), 10);
  // 两个锚点相距 1km ⇒ 仍 10km（1×1.5 < 10）
  assert.strictEqual(amap.anchorRadiusKm([{ lng: 120.17, lat: 30.24 }, { lng: 120.18, lat: 30.24 }]), 10);
  // 跨城：杭州→乌镇约 63km ⇒ 阈值放宽到约 95km
  const wide = amap.anchorRadiusKm([{ lng: 120.17, lat: 30.24 }, { lng: 120.49, lat: 30.74 }]);
  assert.ok(wide > 60, `跨城行程阈值应放宽，实际 ${wide.toFixed(0)}km`);
  assert.strictEqual(amap.anchorRadiusKm([]), 10, '空锚点也给默认值');
});

test('searchPoiByGeocode：regeo 没匹配上但 level 可信 ⇒ 至少落一个点', async () => {
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.15,30.25', level: '门牌号', formatted_address: '浙江省杭州市西湖区某路1号' }],
        };
      }
      return {
        status: '1',
        infocode: '10000',
        regeocode: { pois: [{ id: 'X', name: '完全无关的店', type: '餐饮服务', location: '120.15,30.25', distance: '10' }] },
      };
    },
    async () => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '某路1号' });
      assert.strictEqual(res.via, 'geocode', 'regeo 没匹配上 ⇒ 退回 geocode 坐标');
      assert.strictEqual(res.pois.length, 1);
      assert.strictEqual(res.pois[0].name, '某路1号', '用查询词当名字');
      assert.strictEqual(res.pois[0].id, '', '没有 POI id（点不了详情，如实留空）');
      assert.strictEqual(res.pois[0].lng, 120.15);
    }
  );
});

test('searchPoiByGeocode：level 不可信且 regeo 没匹配 ⇒ 空结果（不拿别的点凑）', async () => {
  await withFetch(
    (pathname) => {
      if (pathname === '/v3/geocode/geo') {
        return {
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '120.15,30.25', level: '区县', formatted_address: '浙江省杭州市西湖区' }],
        };
      }
      return {
        status: '1',
        infocode: '10000',
        regeocode: { pois: [{ id: 'X', name: '完全无关的店', type: '餐饮服务', location: '120.15,30.25', distance: '10' }] },
      };
    },
    async () => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '西湖' });
      assert.strictEqual(res.via, 'none');
      assert.deepStrictEqual(res.pois, [], '错点比没点更坏');
    }
  );
});

test('searchPoiByGeocode：geocode 查不到 ⇒ 空结果，不抛错', async () => {
  await withFetch(
    () => ({ status: '1', infocode: '10000', geocodes: [] }),
    async () => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '不存在的地方' });
      assert.strictEqual(res.via, 'none');
      assert.deepStrictEqual(res.pois, []);
    }
  );
});

test('searchPoiByGeocode：空关键词直接返回空（不打接口）', async () => {
  await withFetch(
    () => {
      throw new Error('不该打接口');
    },
    async (calls) => {
      const res = await amap.searchPoiByGeocode({ city: '杭州', keywords: '   ' });
      assert.deepStrictEqual(res.pois, []);
      assert.strictEqual(calls.length, 0);
    }
  );
});

test('searchPoiByGeocode：geocode 报配额错时如实抛（调用方继续降级）', async () => {
  await withFetch(
    () => QUOTA,
    async () => {
      await assert.rejects(
        () => amap.searchPoiByGeocode({ city: '杭州', keywords: '西湖' }),
        /OVER_LIMIT/,
        '地理编码也没额度时要抛，不能假装查到了'
      );
    }
  );
});

// ---------- ④ 路由接线 ----------

test('路由：搜索池用尽时先走 geocode 兜底，再走网页版/OSM', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'poi.js'), 'utf8');
  const posGeocode = src.indexOf('searchPoiByGeocode');
  const posWeb = src.indexOf('searchByWeb');
  const posOsm = src.indexOf('searchOsm');
  assert.ok(posGeocode > 0, '缺 geocode 兜底');
  assert.ok(posGeocode < posWeb, 'geocode 兜底要排在网页版之前（快得多）');
  assert.ok(posWeb < posOsm, '网页版仍排在 OSM 之前');
  assert.match(src, /source:\s*res\.via === 'regeo' \? 'amap-regeo' : 'amap-geocode'/, '要如实标来源');
});

test('路由：笔记地名补全也接了 geocode 兜底', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'notes.js'), 'utf8');
  assert.match(src, /searchPoiByGeocode/, '笔记补全缺 geocode 兜底');
  assert.match(src, /geocode_calls/, '要回报地理编码调用次数');
  assert.match(src, /amap_regeo/, 'by_source 要分开报');
});

test('文案：10044 是日额度，说「明天」不说「下月」', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const errors = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'errors.js'), 'utf8');
  const poi = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'poi.js'), 'utf8');
  assert.match(errors, /USER_DAILY_QUERY_OVER_LIMIT:\s*\n?\s*'高德今天的搜索额度用完了（明天 0 点恢复）/, 'errors.js 文案要改');
  assert.ok(!/下月 1 日恢复/.test(errors), 'errors.js 不该再说下月');
  assert.match(poi, /明天 0 点恢复/, 'poi.js 营业时间文案要改');
  assert.ok(!/下月 1 日恢复/.test(poi), 'poi.js 不该再说下月');
});
