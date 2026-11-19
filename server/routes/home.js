'use strict';
/*
 * 首页要的两件事：
 *   GET /api/whereami   现在在哪（?lng=&lat= 优先；没给就按本机 IP 认）
 *   GET /api/featured   推荐地区 + 推荐路程（?city= 指定当前城市，不给就自己认）
 */

const { ROOT } = require('../config');
const { locate } = require('../geo-locate');
const { loadFeatured, buildFeatured } = require('../featured');

// 精选库是仓里的文件：进程内缓存一次，改完文件重启生效（本地自用够用）
let featuredCache = null;
function featured() {
  if (!featuredCache) featuredCache = loadFeatured(ROOT);
  return featuredCache;
}

function hasCoord(q) {
  return q && q.lng !== undefined && q.lat !== undefined && q.lng !== '' && q.lat !== '';
}

module.exports = [
  {
    method: 'GET',
    path: '/api/whereami',
    async handler(ctx) {
      const q = ctx.query || {};
      const guessed = await locate(hasCoord(q) ? { lng: q.lng, lat: q.lat, client: ctx.amap } : { client: ctx.amap });
      const fallbackCity = (ctx.config && ctx.config.defaultCity) || '杭州';
      return { ...guessed, fallbackCity, used: guessed.city || fallbackCity, fallback: !guessed.city };
    },
  },
  {
    method: 'GET',
    path: '/api/featured',
    async handler(ctx) {
      const q = ctx.query || {};
      const asked = String(q.city || '').trim();
      const defaultCity = (ctx.config && ctx.config.defaultCity) || '杭州';
      let current = null;
      if (asked) {
        current = { city: asked, source: 'query' };
      } else {
        const guessed = await locate(hasCoord(q) ? { lng: q.lng, lat: q.lat, client: ctx.amap } : { client: ctx.amap });
        current = guessed.city
          ? guessed
          : { ...guessed, city: defaultCity, source: guessed.source === 'fallback' ? 'default' : guessed.source };
      }
      return buildFeatured({ featured: featured(), db: ctx.db, city: current.city, current });
    },
  },
];
