const { classifyType } = require('./amap');

const PAGE_SIZE = 25; // 单页 25 条
const MAX_PAGE = 8; // 25 × 8 = 200（单查询上限）
const SUB_RADIUS_START = 3000; // 二级分片起始半径（米）
const MIN_RADIUS = 100; // 半径下限，小于即停止递归
const MAX_DEPTH = 8; // 递归深度上限，防御死循环

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 0));
}

function isFullPage(pois) {
  return Array.isArray(pois) && pois.length >= PAGE_SIZE;
}

// 分类纯净：typecode 前缀必须匹配目标分类，不匹配直接丢弃
function matchesCategory(typecode, category, classify) {
  const fn = classify || classifyType;
  return fn(typecode) === category;
}

// 入库一批（去重由 poi_id 主键保证），返回新增/更新计数
function storePois(db, city, adcode, category, pois, classify) {
  const list = Array.isArray(pois) ? pois : [];
  let inserted = 0;
  let updated = 0;
  list.forEach((p) => {
    if (!p || !p.id) return;
    if (!matchesCategory(p.typecode, category, classify)) return;
    const photos = Array.isArray(p.photos) ? p.photos : p.photo ? [p.photo] : [];
    const res = db.upsertPoi({
      poi_id: p.id,
      city,
      adcode,
      category,
      name: p.name,
      address: p.address,
      lng: p.lng,
      lat: p.lat,
      typecode: p.typecode,
      rating: p.rating,
      cost: p.cost,
      tel: p.tel,
      photos,
      tags: Array.isArray(p.tags) ? p.tags : [],
    });
    if (res.status === 'inserted') inserted += 1;
    else updated += 1;
  });
  return { inserted, updated };
}

// 半径分片递归：子片仍满 200 → 对半缩半径继续，直到取不出
async function collectByRadius({ amap, db, city, category, lng, lat, radius, depth, intervalMs, classify }) {
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let filled = false;

  for (let page = 1; page <= MAX_PAGE; page += 1) {
    if (intervalMs) await sleep(intervalMs);
    const pois = await amap.searchPoiAround({ lng, lat, category, radius, page });
    fetched += pois.length;
    const r = storePois(db, city, null, category, pois, classify);
    inserted += r.inserted;
    updated += r.updated;
    if (!pois.length) break;
    if (!isFullPage(pois)) break;
    if (page === MAX_PAGE) filled = true;
  }

  const half = Math.floor(radius / 2);
  if (filled && depth < MAX_DEPTH && half >= MIN_RADIUS) {
    const sub = await collectByRadius({
      amap,
      db,
      city,
      category,
      lng,
      lat,
      radius: half,
      depth: depth + 1,
      intervalMs,
      classify,
    });
    fetched += sub.fetched;
    inserted += sub.inserted;
    updated += sub.updated;
  }

  return { fetched, inserted, updated };
}

// 单区采集：逐页翻到没有为止；取满 200 则触发二级分片
async function collectDistrict({ amap, db, city, category, district, intervalMs = 0, classify }) {
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let filled = false;

  for (let page = 1; page <= MAX_PAGE; page += 1) {
    if (intervalMs) await sleep(intervalMs);
    const pois = await amap.searchPoiByDistrict({
      adcode: district.adcode,
      city,
      category,
      page,
    });
    fetched += pois.length;
    const r = storePois(db, city, district.adcode, category, pois, classify);
    inserted += r.inserted;
    updated += r.updated;
    if (!pois.length) break;
    if (!isFullPage(pois)) break;
    if (page === MAX_PAGE) filled = true;
  }

  if (filled && district.lng != null && district.lat != null) {
    const sub = await collectByRadius({
      amap,
      db,
      city,
      category,
      lng: district.lng,
      lat: district.lat,
      radius: SUB_RADIUS_START,
      depth: 0,
      intervalMs,
      classify,
    });
    fetched += sub.fetched;
    inserted += sub.inserted;
    updated += sub.updated;
  }

  return { fetched, inserted, updated, filled };
}

// 整城采集：逐区串行 + 逐区容错，单区失败记 warning 继续，最后 status=partial
async function collectCityCategory({ city, category, amap, db, intervalMs = 0, classify, onProgress }) {
  const list = await amap.districts(city);
  const detail = [];
  let nFetched = 0;
  let nInserted = 0;
  let nUpdated = 0;
  let failed = 0;

  if (typeof onProgress === 'function') {
    onProgress({
      city,
      category,
      done_districts: 0,
      total_districts: list.length,
      n_fetched: 0,
      n_inserted: 0,
      n_updated: 0,
      districts: [],
    });
  }

  for (let i = 0; i < list.length; i += 1) {
    const d = list[i];
    try {
      const res = await collectDistrict({
        amap,
        db,
        city,
        category,
        district: d,
        intervalMs,
        classify,
      });
      nFetched += res.fetched;
      nInserted += res.inserted;
      nUpdated += res.updated;
      detail.push({
        adcode: d.adcode,
        name: d.name,
        ok: true,
        fetched: res.fetched,
        inserted: res.inserted,
        updated: res.updated,
        filled: res.filled,
      });
    } catch (err) {
      failed += 1;
      detail.push({
        adcode: d.adcode,
        name: d.name,
        ok: false,
        error: (err && err.message) || '采集失败',
      });
    }
    if (typeof onProgress === 'function') {
      onProgress({
        city,
        category,
        done_districts: i + 1,
        total_districts: list.length,
        n_fetched: nFetched,
        n_inserted: nInserted,
        n_updated: nUpdated,
        districts: detail.slice(),
      });
    }
  }

  return {
    city,
    category,
    status: failed > 0 ? 'partial' : 'done',
    failed,
    n_fetched: nFetched,
    n_inserted: nInserted,
    n_updated: nUpdated,
    total_districts: list.length,
    done_districts: list.length,
    districts: detail,
  };
}

module.exports = {
  collectCityCategory,
  collectDistrict,
  PAGE_SIZE,
  MAX_PAGE,
  SUB_RADIUS_START,
  MIN_RADIUS,
  MAX_DEPTH,
};
