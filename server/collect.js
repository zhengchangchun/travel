const { classifyType } = require('./amap');

const PAGE_SIZE = 25; // 单页 25 条
const MAX_PAGE = 8; // 25 × 8 = 200（单查询上限）
const SUB_RADIUS_START = 3000; // 二级分片起始半径（米）
const MIN_RADIUS = 100; // 半径下限，小于即停止递归
const MAX_DEPTH = 8; // 递归深度上限，防御死循环

// ---- T8 按视野采集：网格覆盖 ----
const GRID_DEG = 0.01; // 网格边长（度），约 1km
const MAX_VIEWPORT_GRIDS = 400; // 单次视野最多采的格数，防超大 bbox
const GRID_RADIUS_M = 800; // 以格中心周边搜索的起始半径（米），略大于格对角半径
const MIN_GRID_DEG = 0.00125; // 细分到该边长即停（约 140m），防死循环
const DEFAULT_VIEWPORT_RATE_PER_MIN = 60; // 单位时间高德调用上限（默认 60/分钟）
const VIEWPORT_MAX_RETRIES = 2; // 高德瞬时错误（如 QPS 超限）重试次数
const RETRY_BACKOFF_MS = 800; // 重试退避基数（× 次数）

// 正在采集中的格（内存内，防同格重复起）。键：city\0category\0gx,gy
const activeGrids = new Set();
function gridKey(city, category, g) {
  return city + '\u0000' + category + '\u0000' + g.gx + ',' + g.gy;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 0));
}

// 经纬度 → 网格号（floor，含负数）
function gridOf(lng, lat) {
  return {
    gx: Math.floor(Number(lng) / GRID_DEG),
    gy: Math.floor(Number(lat) / GRID_DEG),
  };
}

// 网格号 → 格中心经纬度
function gridCenter(gx, gy) {
  return { lng: (Number(gx) + 0.5) * GRID_DEG, lat: (Number(gy) + 0.5) * GRID_DEG };
}

// bbox（minLng,minLat,maxLng,maxLat）→ 覆盖的格列表（含边界）
function bboxToGrids(bbox) {
  const minGx = Math.floor(Number(bbox.minLng) / GRID_DEG);
  const maxGx = Math.floor(Number(bbox.maxLng) / GRID_DEG);
  const minGy = Math.floor(Number(bbox.minLat) / GRID_DEG);
  const maxGy = Math.floor(Number(bbox.maxLat) / GRID_DEG);
  const out = [];
  for (let gx = minGx; gx <= maxGx; gx += 1) {
    for (let gy = minGy; gy <= maxGy; gy += 1) out.push({ gx, gy });
  }
  return out;
}

// 滑动窗口速率限制：60s 内最多 maxPerMin 次；<=0 表示不限速
function createRateLimiter({ maxPerMin = DEFAULT_VIEWPORT_RATE_PER_MIN, now = Date.now, sleep: sleepFn } = {}) {
  const windowMs = 60000;
  const stamps = [];
  const doSleep = sleepFn || sleep;
  return {
    maxPerMin,
    async acquire() {
      if (!maxPerMin || maxPerMin <= 0) return 0;
      let waited = 0;
      for (;;) {
        const t = now();
        while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
        if (stamps.length < maxPerMin) {
          stamps.push(t);
          return waited;
        }
        const wait = windowMs - (t - stamps[0]) + 1;
        await doSleep(wait);
        waited += wait;
      }
    },
    reset() {
      stamps.length = 0;
    },
  };
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
// category === 'all'：不做关键字过滤，按 typecode 归类到已知分类（不属四类的丢弃）
function storePois(db, city, adcode, category, pois, classify) {
  const list = Array.isArray(pois) ? pois : [];
  const fn = classify || classifyType;
  let inserted = 0;
  let updated = 0;
  list.forEach((p) => {
    if (!p || !p.id) return;
    const resolved = category === 'all' ? fn(p.typecode) : matchesCategory(p.typecode, category, classify) ? category : null;
    if (!resolved) return;
    const photos = Array.isArray(p.photos) ? p.photos : p.photo ? [p.photo] : [];
    const res = db.upsertPoi({
      poi_id: p.id,
      city,
      adcode,
      category: resolved,
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

// 单元格采集（递归）：格内翻页到某页不满 25 条为止；若取满 200 则对半切 4 子格递归（半径对半）。
// 返回 truncated=true 表示「细分到底仍满 200」（防无限重采，仍标覆盖）。
async function collectCell({
  amap,
  db,
  city,
  category,
  minLng,
  minLat,
  size,
  radius,
  depth,
  intervalMs,
  rateLimiter,
  classify,
  minGridDeg,
  maxDepth,
  maxRetries,
}) {
  const center = { lng: minLng + size / 2, lat: minLat + size / 2 };
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let saturated = false;
  let errored = 0;

  for (let page = 1; page <= MAX_PAGE; page += 1) {
    // 高德瞬时错误（如 QPS 超限）→ 退避重试；耗尽仍失败才放弃该格
    let pois = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (rateLimiter && typeof rateLimiter.acquire === 'function') await rateLimiter.acquire();
      if (intervalMs) await sleep(intervalMs);
      try {
        pois = await amap.searchPoiAround({ lng: center.lng, lat: center.lat, category, radius, page });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    if (lastErr) {
      errored += 1; // 该格放弃，交由上层决定不标覆盖以便下次重试
      break;
    }
    fetched += pois.length;
    const r = storePois(db, city, null, category, pois, classify);
    inserted += r.inserted;
    updated += r.updated;
    if (!pois.length) break;
    if (!isFullPage(pois)) break; // 最后一页不满 25 → 真取完
    if (page === MAX_PAGE) saturated = true;
  }

  let truncated = false;
  if (saturated && errored === 0) {
    const halfSize = size / 2;
    const halfRadius = Math.floor(radius / 2);
    if (halfSize >= minGridDeg && depth < maxDepth && halfRadius >= MIN_RADIUS) {
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const sub = await collectCell({
          amap,
          db,
          city,
          category,
          minLng: minLng + dx * halfSize,
          minLat: minLat + dy * halfSize,
          size: halfSize,
          radius: halfRadius,
          depth: depth + 1,
          intervalMs,
          rateLimiter,
          classify,
          minGridDeg,
          maxDepth,
          maxRetries,
        });
        fetched += sub.fetched;
        inserted += sub.inserted;
        updated += sub.updated;
        errored += sub.errored;
        if (sub.truncated) truncated = true;
      }
    } else {
      truncated = true; // 细分到底仍满 200
    }
  } else if (saturated) {
    truncated = true; // 取满但中途报错：无法继续细分，本次截断
  }

  return { fetched, inserted, updated, truncated, errored };
}

// 按视野采集：只采 bbox 内【未覆盖】的格；逐格取全（格内翻页 + 超额细分），采完标覆盖。
// 同格并发调用会被合并（activeGrids），不重复起高德请求。
async function collectViewport({
  city,
  category = 'all',
  bbox,
  amap,
  db,
  intervalMs = 0,
  rateLimiter,
  classify,
  onProgress,
  minGridDeg = MIN_GRID_DEG,
  maxDepth = MAX_DEPTH,
  maxRetries = VIEWPORT_MAX_RETRIES,
} = {}) {
  const grids = bboxToGrids(bbox);
  if (grids.length > MAX_VIEWPORT_GRIDS) {
    const err = new Error(`bbox 过大（${grids.length} 格 > 上限 ${MAX_VIEWPORT_GRIDS}）`);
    err.code = 'VIEWPORT_TOO_LARGE';
    throw err;
  }

  const skipped = [];
  const claimed = [];
  // 同步认领阶段：覆盖判定 + 同格合并，全部在首个 await 之前完成（并发安全）
  grids.forEach((g) => {
    if (db.isCovered(city, category, g.gx, g.gy)) {
      skipped.push(g);
      return;
    }
    const key = gridKey(city, category, g);
    if (activeGrids.has(key)) {
      skipped.push(g);
      return;
    }
    activeGrids.add(key);
    claimed.push(g);
  });

  const collected = [];
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let errored = 0;

  for (let i = 0; i < claimed.length; i += 1) {
    const g = claimed[i];
    try {
      const cell = await collectCell({
        amap,
        db,
        city,
        category,
        minLng: g.gx * GRID_DEG,
        minLat: g.gy * GRID_DEG,
        size: GRID_DEG,
        radius: GRID_RADIUS_M,
        depth: 0,
        intervalMs,
        rateLimiter,
        classify,
        minGridDeg,
        maxDepth,
        maxRetries,
      });
      fetched += cell.fetched;
      inserted += cell.inserted;
      updated += cell.updated;
      errored += cell.errored;
      if (cell.errored === 0) {
        // 覆盖标记：真取完或（细分到底仍满→截断）都标，后者记 truncated 防无限重采
        db.markCovered(city, category, g.gx, g.gy, cell.inserted, cell.truncated);
        collected.push(g);
      }
      // 报错的格不标覆盖 → 下次进入会重试
    } finally {
      activeGrids.delete(gridKey(city, category, g));
    }
    if (typeof onProgress === 'function') {
      onProgress({
        done_grids: i + 1,
        total_grids: claimed.length,
        n_fetched: fetched,
        n_inserted: inserted,
        n_updated: updated,
      });
    }
  }

  return {
    city,
    category,
    grids,
    collected,
    skipped,
    n_fetched: fetched,
    n_inserted: inserted,
    n_updated: updated,
    errored,
  };
}

module.exports = {
  collectCityCategory,
  collectDistrict,
  collectViewport,
  createRateLimiter,
  gridOf,
  gridCenter,
  bboxToGrids,
  GRID_DEG,
  MAX_VIEWPORT_GRIDS,
  GRID_RADIUS_M,
  DEFAULT_VIEWPORT_RATE_PER_MIN,
  PAGE_SIZE,
  MAX_PAGE,
  SUB_RADIUS_START,
  MIN_RADIUS,
  MAX_DEPTH,
};
