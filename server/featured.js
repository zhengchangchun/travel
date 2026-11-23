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
const photos = require('./featured-photos');

function emptyFeatured() {
  return { updatedAt: null, note: '', regions: [], routes: [], showcase: emptyShowcase() };
}

function emptyShowcase() {
  return { updatedAt: null, note: '', marks: [], quotes: [] };
}

// 「用过的人怎么说」那块：**示意数据**（config/showcase.json，页面上标明了）
function loadShowcase(root) {
  const file = path.join(root || path.join(__dirname, '..'), 'config', 'showcase.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      updatedAt: raw.updatedAt || null,
      note: raw.note || '',
      marks: Array.isArray(raw.marks) ? raw.marks.filter((m) => m && m.n && m.l) : [],
      quotes: Array.isArray(raw.quotes) ? raw.quotes.filter((q) => q && q.text) : [],
    };
  } catch (err) {
    return emptyShowcase();
  }
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

// 首页缩略图（静态地图，服务端生成缓存）：2026-11-23 起首页不再展示地图
// （用户：「地图的…在首页都不要展示」）—— 地区封面改成实景照片，路线封面直接不发。
// 这个接口与 server/home-img.js 仍保留（静态地图缩略图本身是个有用能力，单测也钉着它）。
function coverFor(kind, key) {
  return '/home-img/' + kind + '-' + encodeURIComponent(String(key)) + '.png';
}

// 一条路线给前端的形状（列表/详情共用；不吐坐标，详情里的点靠高德搜索链接）
function routeCard(route, extra) {
  const stops = route.stops.map((s) => {
    const photo = photos.photoFor(route.city, s.name);
    return {
      day: Number(s.day) || 1,
      name: s.name,
      note: s.note || '',
      photo: photo ? photo.url : '',
      photoCredit: photo ? photo.credit : '',
      photoSource: photo ? photo.source : '',
    };
  });
  return {
    id: route.id,
    city: route.city,
    title: route.title,
    theme: route.theme || '',
    days: Number(route.days) || 1,
    note: route.note || '',
    hot: route.hot || '',   // 「本周 N 人收藏」这类热度：精选库里写的是示意值，页面会标明
    highlights: route.highlights,
    stops,
    stopCount: route.stops.length,
    photoCount: stops.filter((s) => s.photo).length,
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
      trips = db ? db.countTripsByCity(r.city) : 0;
    } catch (err) {
      collected = 0;
    }
    // 封面用该城的实景照片（不再用静态地图缩略图），可指名（coverPhoto）；
    // 没指名就用该城第一张（按索引顺序＝人工挑过的那张）；都没有就空着，页面露出深色底板
    const photo = (r.coverPhoto && photos.photoFor(r.city, r.coverPhoto)) || photos.firstForCity(r.city);
    return {
      city: r.city,
      district: r.district || '',
      tagline: r.tagline || '',
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
      featured: !!r.featured,
      collected,
      trips,
      cover: photo ? photo.url : '',
      coverCredit: photo ? photo.credit : '',
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
    showcase: loadShowcase(),
    photoCredits: photos.credits(),
  };
}

module.exports = { loadFeatured, buildFeatured, loadShowcase, routeCard, coverFor, emptyFeatured };
