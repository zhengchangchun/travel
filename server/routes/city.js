const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../config');

// 行政边界几乎不变：半年刷一次就够（高德行政区查询有日配额）
const BOUNDARY_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// 每个城市「打开时定在哪」：config/city-core.json 是真源（进程内缓存一次，改完重启生效）
let coreCache = null;
function cityCoreConfig() {
  if (coreCache) return coreCache;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config', 'city-core.json'), 'utf8');
    const obj = JSON.parse(raw);
    coreCache = {
      defaultZoom: Number(obj.defaultZoom) || 14,
      cities: (obj && obj.cities) || {},
    };
  } catch (err) {
    coreCache = { defaultZoom: 14, cities: {} };
  }
  return coreCache;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/city/search',
    async handler(ctx) {
      const q = ctx.query.q;
      if (!q || !String(q).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 q');
      }
      return ctx.amap.searchCity(String(q).trim());
    },
  },
  {
    // 城市轮廓（P21）：先看整座城市的范围，再往里慢慢选。
    // 高德行政区查询有日配额 ⇒ 落库缓存；失败时用旧缓存，没有旧的就如实报错（前端退回主城区路径）。
    method: 'GET',
    path: '/api/city/boundary',
    async handler(ctx) {
      const city = String(ctx.query.city || '').trim();
      if (!city) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 city');
      const cached = ctx.db.getCityBoundary(city);
      const fresh =
        cached && cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < BOUNDARY_TTL_MS;
      if (fresh) return cached;
      try {
        const got = await ctx.amap.cityBoundary(city);
        return ctx.db.saveCityBoundary(city, got);
      } catch (err) {
        if (cached) return cached;
        throw new ctx.HttpError(
          502,
          'BOUNDARY_UNAVAILABLE',
          '城市轮廓拿不到：' + (err && err.message ? err.message : String(err))
        );
      }
    },
  },
  {
    // 城市核心点（2026-11-24 用户：「页面进入打开的时候默认每个城市应该定点在核心区域
    // 不是地图上查看整个城市」）。三级来源，越靠前越准：
    //   ① config/city-core.json（精选城市，坐标取自 featured-geo 的推荐站点）
    //   ② 城市轮廓缓存里的行政区中心（任何城市都有，高德 district 给的）
    //   ③ 都没有 ⇒ lng/lat 为 null，前端拿它自己的城市中心兜底
    method: 'GET',
    path: '/api/city/core',
    handler(ctx) {
      const city = String(ctx.query.city || '').trim();
      if (!city) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 city');
      const conf = cityCoreConfig();
      const hit = conf.cities[city];
      if (hit && Number.isFinite(Number(hit.lng)) && Number.isFinite(Number(hit.lat))) {
        return {
          city,
          label: hit.label || city,
          lng: Number(hit.lng),
          lat: Number(hit.lat),
          zoom: Number(hit.zoom) || conf.defaultZoom,
          source: 'curated',
        };
      }
      let cached = null;
      try {
        cached = ctx.db.getCityBoundary(city);
      } catch (err) {
        cached = null;
      }
      const center = cached && Array.isArray(cached.center) ? cached.center : null;
      if (center && Number.isFinite(Number(center[0])) && Number.isFinite(Number(center[1]))) {
        return {
          city,
          label: city + ' 城区',
          lng: Number(center[0]),
          lat: Number(center[1]),
          zoom: conf.defaultZoom,
          source: 'district',
        };
      }
      return { city, label: city, lng: null, lat: null, zoom: conf.defaultZoom, source: 'none' };
    },
  },
];
