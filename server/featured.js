'use strict';
/*
 * 首页的「推荐地区 / 推荐路程」。
 * 数据源 = 仓里的人工精选库 config/featured.json（可手改，真源就是它），
 * 运行期只补两件真实读数：该城在我们库里已收录多少点、该城现在有几条行程。
 *
 * 口径：地区按「当前城市优先 → 有彩页的在前 → 已收录点数多的在前」排；
 *      路线按「当前城市优先 → 精选库里的顺序」排，不做评分（没有依据就别编）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { shortCity } = require('./geo-locate');

function emptyFeatured() {
  return { updatedAt: null, note: '', regions: [], routes: [] };
}

function loadFeatured(root) {
  const file = path.join(root || path.join(__dirname, '..'), 'config', 'featured.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const regions = Array.isArray(raw.regions) ? raw.regions : [];
    const routes = Array.isArray(raw.routes) ? raw.routes : [];
    return {
      updatedAt: raw.updatedAt || null,
      note: raw.note || '',
      regions: regions.filter((r) => r && r.city).map((r) => ({ ...r, city: shortCity(r.city) })),
      routes: routes
        .filter((r) => r && r.city && r.title)
        .map((r) => ({
          ...r,
          city: shortCity(r.city),
          stops: Array.isArray(r.stops) ? r.stops : [],
          highlights: Array.isArray(r.highlights) ? r.highlights : [],
        })),
    };
  } catch (err) {
    return emptyFeatured();
  }
}

// 首页缩略图（静态地图，服务端生成缓存）：推荐地区一张城市俯瞰图，推荐路线一张路线图
function coverFor(kind, key) {
  return '/home-img/' + kind + '-' + encodeURIComponent(String(key)) + '.png';
}

// 一条路线给前端的形状（列表/详情共用；不吐坐标，详情里的点靠高德搜索链接）
function routeCard(route, extra) {
  return {
    id: route.id,
    city: route.city,
    title: route.title,
    theme: route.theme || '',
    days: Number(route.days) || 1,
    note: route.note || '',
    highlights: route.highlights,
    stops: route.stops.map((s) => ({ day: Number(s.day) || 1, name: s.name, note: s.note || '' })),
    stopCount: route.stops.length,
    cover: coverFor('route', route.id),
    ...(extra || {}),
  };
}

function buildFeatured({ featured, db, city, current }) {
  const cur = shortCity(city);
  const regions = (featured.regions || []).map((r) => {
    let collected = 0;
    let trips = 0;
    try {
      collected = db ? db.countPoisByCity(r.city) : 0;
      trips = db ? db.listTrips(r.city).length : 0;
    } catch (err) {
      collected = 0;
    }
    return {
      city: r.city,
      district: r.district || '',
      tagline: r.tagline || '',
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
      featured: !!r.featured,
      collected,
      trips,
      cover: coverFor('region', r.city),
      current: !!cur && r.city === cur,
    };
  });
  regions.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (b.collected !== a.collected) return b.collected - a.collected;
    return a.city.localeCompare(b.city, 'zh');
  });

  const routes = (featured.routes || []).map((r) =>
    routeCard(r, { current: !!cur && r.city === cur })
  );
  routes.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return 0; // 其余保持精选库里的顺序
  });

  return {
    updatedAt: featured.updatedAt,
    current: current || null,
    regions,
    routes,
  };
}

module.exports = { loadFeatured, buildFeatured, routeCard, coverFor, emptyFeatured };
