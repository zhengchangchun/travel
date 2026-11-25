'use strict';
/*
 * POI 内存缓存（2026-11-25）
 *
 * 为什么不再落盘：用户口径「不要所有的数据都存在本地，可以做缓存 但是不能持久化到我这，
 * 要不然数据更新了 我们就都是错的」。地点、评分、人均、电话、图片这些都是**上游事实**，
 * 高德那边一改，我们盘上那份就是错的，而且错得没有任何提示。所以：
 *
 *   · 只放内存，带 TTL（默认 30 分钟，POI_CACHE_TTL_MINUTES 可调）
 *   · 进程一重启就没了 —— 这是特性不是缺陷：下次用一定重新问上游
 *   · 采集覆盖账本（哪个格什么时候采过）也一起放内存：POI 没了账本还留着，
 *     就会「以为采过、其实手里没有」，那比不采更糟
 *   · 城市轮廓同理（行政区划会调整）
 *
 * 仍然落盘的只有**用户自己的东西**：账号、行程、点位、笔记、分享、搭子、留言、采集运行日志。
 * 那些不是上游事实，是我们自己的数据。
 *
 * 行结构与原来的 SQLite 行保持一致（photos/tags 是 JSON 字符串），
 * 这样 db.js 里的 mapPoiRow 与所有调用点都不用改。
 */

const { contentHash, setDigest } = require('./poi-hash');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟
const SWEEP_EVERY_WRITES = 500; // 每写这么多次顺手清一遍过期项（不靠定时器，免得拖住进程退出）

function ttlFromEnv() {
  const n = Number(process.env.POI_CACHE_TTL_MINUTES);
  if (Number.isFinite(n) && n > 0) return Math.round(n * 60 * 1000);
  return DEFAULT_TTL_MS;
}

function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function createPoiStore({ ttlMs = ttlFromEnv(), now = () => Date.now() } = {}) {
  // poi_id → { row, at }
  const pois = new Map();
  // "city|category|gx|gy" → { city, category, gx, gy, collected_at, n_inserted, truncated, at }
  const coverage = new Map();
  // city → { name, adcode, center, bbox, rings, fetchedAt, at }
  const boundaries = new Map();
  let writes = 0;
  let hits = 0;
  let misses = 0;

  function alive(entry) {
    return !!entry && now() - entry.at <= ttlMs;
  }

  function sweep() {
    const t = now();
    pois.forEach((entry, key) => {
      if (t - entry.at > ttlMs) pois.delete(key);
    });
    coverage.forEach((entry, key) => {
      if (t - entry.at > ttlMs) coverage.delete(key);
    });
    boundaries.forEach((entry, key) => {
      if (t - entry.at > ttlMs) boundaries.delete(key);
    });
  }

  function bumpWrite() {
    writes += 1;
    if (writes % SWEEP_EVERY_WRITES === 0) sweep();
  }

  // ---------- POI ----------

  function upsertPoi(poi) {
    const photos = JSON.stringify(Array.isArray(poi.photos) ? poi.photos : []);
    const tags = JSON.stringify(Array.isArray(poi.tags) ? poi.tags : []);
    const fetchedAt = poi.fetched_at || new Date().toISOString();
    const hash = contentHash({ ...poi, photos, tags: JSON.parse(tags) });
    const row = {
      poi_id: poi.poi_id,
      city: poi.city,
      adcode: poi.adcode || null,
      category: poi.category,
      name: poi.name,
      address: poi.address || '',
      lng: Number(poi.lng),
      lat: Number(poi.lat),
      typecode: poi.typecode || null,
      rating: poi.rating || null,
      cost: poi.cost || null,
      tel: poi.tel || null,
      photos,
      tags,
      fetched_at: fetchedAt,
      content_sha256: hash,
    };
    const existed = alive(pois.get(poi.poi_id));
    pois.set(poi.poi_id, { row, at: now() });
    bumpWrite();
    return { status: existed ? 'updated' : 'inserted', row };
  }

  function getPoi(poiId) {
    const entry = pois.get(String(poiId));
    if (!alive(entry)) {
      if (entry) pois.delete(String(poiId));
      misses += 1;
      return null;
    }
    hits += 1;
    return entry.row;
  }

  function poiContentHash(poiId) {
    const row = getPoi(poiId);
    return row ? row.content_sha256 : null;
  }

  function allRows() {
    const out = [];
    const t = now();
    pois.forEach((entry, key) => {
      if (t - entry.at > ttlMs) {
        pois.delete(key);
        return;
      }
      out.push(entry.row);
    });
    return out;
  }

  function rowsOfCity(city) {
    return allRows().filter((r) => r.city === city);
  }

  function poiDigest(city) {
    const rows = rowsOfCity(city);
    const withHash = rows.filter((r) => r.content_sha256);
    return {
      total: rows.length,
      hashed: withHash.length,
      digest: setDigest(withHash.map((r) => ({ poi_id: r.poi_id, hash: r.content_sha256 }))),
    };
  }

  function countPois(city, category) {
    const rows = rowsOfCity(city);
    if (!category) return rows.length;
    return rows.filter((r) => r.category === category).length;
  }

  function countPoisByCity(city) {
    return rowsOfCity(String(city)).length;
  }

  function listPois({ city, category, minRating, sort, limit, offset, bbox } = {}) {
    if (!city) return { total: 0, rows: [] };
    let rows = rowsOfCity(city);
    if (category) rows = rows.filter((r) => r.category === category);
    if (minRating !== undefined && minRating !== null && minRating !== '') {
      const min = Number(minRating);
      rows = rows.filter((r) => {
        const v = Number(r.rating);
        return r.rating !== null && r.rating !== '' && Number.isFinite(v) && v >= min;
      });
    }
    if (bbox) {
      const { minLng, maxLng, minLat, maxLat } = bbox;
      rows = rows.filter(
        (r) =>
          Number(r.lng) >= Number(minLng) &&
          Number(r.lng) <= Number(maxLng) &&
          Number(r.lat) >= Number(minLat) &&
          Number(r.lat) <= Number(maxLat)
      );
    }
    const byRating = (a, b) => {
      const av = a.rating === null || a.rating === '' ? -1 : Number(a.rating);
      const bv = b.rating === null || b.rating === '' ? -1 : Number(b.rating);
      if (bv !== av) return bv - av;
      return String(a.name).localeCompare(String(b.name), 'zh');
    };
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh');
    rows.sort(sort === 'rating' ? byRating : byName);

    const total = rows.length;
    const off = Math.max(0, Number(offset) || 0);
    const hasLimit = limit !== undefined && limit !== null && limit !== '';
    const lim = hasLimit ? Math.max(0, Number(limit) || 0) || 200 : bbox ? null : 200;
    const page = lim === null ? rows.slice(off) : rows.slice(off, off + lim);
    return { total, rows: page };
  }

  // 本地关键词搜索（高德不可用时的回退）：多词 AND，名字命中优先于只有地址命中
  function searchPoisLocal({ city, keywords, category, limit = 60 } = {}) {
    const kw = String(keywords == null ? '' : keywords).trim();
    if (!city || !kw) return [];
    const terms = kw
      .split(/\s+/)
      .filter((t) => t)
      .slice(0, 4);
    let rows = rowsOfCity(city);
    if (category) rows = rows.filter((r) => r.category === category);
    rows = rows.filter((r) => {
      const name = String(r.name || '');
      const addr = String(r.address || '');
      return terms.every((t) => name.includes(t) || addr.includes(t));
    });
    const rank = (r) => {
      const name = String(r.name || '');
      if (name === kw) return 0;
      if (name.startsWith(kw)) return 1;
      if (name.includes(kw)) return 2;
      return 3;
    };
    rows.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const av = a.rating === null || a.rating === '' ? -1 : Number(a.rating);
      const bv = b.rating === null || b.rating === '' ? -1 : Number(b.rating);
      if (bv !== av) return bv - av;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    const lim = Math.max(1, Math.min(200, Number(limit) || 60));
    return rows.slice(0, lim);
  }

  // 点地图任意处：这一带我们手里真有的点（deg 是粗筛方框半径，0.0015 ≈ 150m）
  function poisNearPoint({ lng, lat, deg = 0.0015, limit = 5 } = {}) {
    const x = Number(lng);
    const y = Number(lat);
    const d = Number(deg) > 0 ? Number(deg) : 0.0015;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const lim = Math.max(1, Math.min(50, Number(limit) || 5));
    const rows = allRows().filter(
      (r) =>
        Number(r.lng) >= x - d &&
        Number(r.lng) <= x + d &&
        Number(r.lat) >= y - d &&
        Number(r.lat) <= y + d
    );
    // 经度方向乘 cos(纬度)² ≈ 0.75（杭州一带）—— 只用于排序，够用
    rows.sort((a, b) => {
      const da = (Number(a.lng) - x) ** 2 * 0.75 + (Number(a.lat) - y) ** 2;
      const db2 = (Number(b.lng) - x) ** 2 * 0.75 + (Number(b.lat) - y) ** 2;
      return da - db2;
    });
    return rows.slice(0, lim);
  }

  function poisStats(city) {
    const rows = rowsOfCity(city);
    const byCat = new Map();
    rows.forEach((r) => byCat.set(r.category, (byCat.get(r.category) || 0) + 1));
    const num = (r) => (r.rating === null || r.rating === '' ? null : Number(r.rating));
    const bucket = (fn) => rows.filter((r) => fn(num(r))).length;
    return {
      total: rows.length,
      categories: Array.from(byCat.entries()).map(([key, count]) => ({ key, count })),
      ratingBuckets: [
        { label: '≥4.5', count: bucket((v) => v !== null && v >= 4.5) },
        { label: '4.0–4.5', count: bucket((v) => v !== null && v >= 4.0 && v < 4.5) },
        { label: '3.5–4.0', count: bucket((v) => v !== null && v >= 3.5 && v < 4.0) },
        { label: '<3.5', count: bucket((v) => v !== null && v < 3.5) },
        { label: '无评分', count: bucket((v) => v === null) },
      ],
    };
  }

  // ---------- 采集覆盖账本（与 POI 同寿命：POI 没了账本留着就会「以为采过其实没有」）----------

  function covKey(city, category, gx, gy) {
    return `${city}|${category}|${gx}|${gy}`;
  }

  function isCovered(city, category, gx, gy) {
    const entry = coverage.get(covKey(city, category, gx, gy));
    if (!alive(entry)) {
      if (entry) coverage.delete(covKey(city, category, gx, gy));
      return false;
    }
    return true;
  }

  function markCovered(city, category, gx, gy, nInserted = 0, truncated = false) {
    coverage.set(covKey(city, category, gx, gy), {
      city,
      category,
      gx: Number(gx),
      gy: Number(gy),
      collected_at: new Date(now()).toISOString(),
      n_inserted: Number(nInserted) || 0,
      truncated: truncated ? 1 : 0,
      at: now(),
    });
    bumpWrite();
  }

  function coverageRows(city, category) {
    const t = now();
    const out = [];
    coverage.forEach((entry, key) => {
      if (t - entry.at > ttlMs) {
        coverage.delete(key);
        return;
      }
      if (entry.city !== city) return;
      if (category && entry.category !== category) return;
      out.push({
        city: entry.city,
        category: entry.category,
        gx: entry.gx,
        gy: entry.gy,
        collected_at: entry.collected_at,
        n_inserted: entry.n_inserted,
        truncated: entry.truncated,
      });
    });
    out.sort((a, b) => a.gx - b.gx || a.gy - b.gy);
    return out;
  }

  function listCoverage(city, category) {
    return coverageRows(city, category);
  }

  function listCoverageRange(city, category, minGx, maxGx, minGy, maxGy) {
    return coverageRows(city, category).filter(
      (r) => r.gx >= minGx && r.gx <= maxGx && r.gy >= minGy && r.gy <= maxGy
    );
  }

  // ---------- 城市轮廓（行政区划会调整，同样不落盘）----------

  function getCityBoundary(city) {
    const entry = boundaries.get(String(city));
    if (!alive(entry)) {
      if (entry) boundaries.delete(String(city));
      return null;
    }
    const b = entry.value;
    if (!Array.isArray(b.rings) || !b.rings.length) return null;
    return { ...b, cached: true };
  }

  function saveCityBoundary(city, b) {
    const data = b || {};
    boundaries.set(String(city), {
      value: {
        name: data.name || city,
        adcode: data.adcode || '',
        center: data.center || null,
        bbox: data.bbox || null,
        rings: Array.isArray(data.rings) ? data.rings : [],
        fetchedAt: data.fetchedAt || new Date(now()).toISOString(),
      },
      at: now(),
    });
    bumpWrite();
    return getCityBoundary(city);
  }

  function stats() {
    return {
      ttlMs,
      pois: pois.size,
      coverage: coverage.size,
      boundaries: boundaries.size,
      hits,
      misses,
      writes,
    };
  }

  function clear() {
    pois.clear();
    coverage.clear();
    boundaries.clear();
  }

  return {
    ttlMs,
    upsertPoi,
    getPoi,
    poiContentHash,
    poiDigest,
    countPois,
    countPoisByCity,
    listPois,
    searchPoisLocal,
    poisNearPoint,
    poisStats,
    isCovered,
    markCovered,
    listCoverage,
    listCoverageRange,
    getCityBoundary,
    saveCityBoundary,
    stats,
    clear,
    sweep,
  };
}

module.exports = { createPoiStore, ttlFromEnv, DEFAULT_TTL_MS, parseJsonArray, toNumber };
