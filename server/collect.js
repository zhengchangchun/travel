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
const DEFAULT_VIEWPORT_RATE_PER_MIN = 180; // 单位时间高德调用上限（默认 180/分钟 ≈ 3 次/秒，仍保留限流防封 key）
const VIEWPORT_MAX_RETRIES = 2; // 高德瞬时错误（如 QPS 超限）重试次数
const RETRY_BACKOFF_MS = 800; // 重试退避基数（× 次数）
const MAX_GRID_CALLS = 48; // 单格高德调用预算（含细分），防 QPS 打爆；超预算记 truncated

// 分类轮转顺序（T9 R1）：视野变化时一次只采一个分类，四类轮转，单次调用量降到 1/4
const CATEGORY_ROTATION = ['food', 'stay', 'sight', 'play'];
function nextCategory(prev) {
  const idx = CATEGORY_ROTATION.indexOf(prev);
  if (idx < 0) return CATEGORY_ROTATION[0];
  return CATEGORY_ROTATION[(idx + 1) % CATEGORY_ROTATION.length];
}

// 单飞注册表（T9 R2）：同一 (city, category) 同时只允许 1 个 run；
// 新 run 顶替旧 run 时把旧 run 标 cancelled，旧 run 立即停止（不再抢限流令牌）。
function createViewportRunRegistry() {
  const runs = new Map();
  const keyOf = (city, category) => city + '\u0000' + category;
  return {
    // 起一个 run；返回被顶替的旧 runId（无则 null）
    start(city, category, runId) {
      const k = keyOf(city, category);
      const prev = runs.get(k);
      if (prev) prev.cancelled = true;
      runs.set(k, { runId, cancelled: false });
      return prev ? prev.runId : null;
    },
    isCancelled(city, category, runId) {
      const cur = runs.get(keyOf(city, category));
      return !cur || cur.runId !== runId || cur.cancelled;
    },
    finish(city, category, runId) {
      const k = keyOf(city, category);
      const cur = runs.get(k);
      if (cur && cur.runId === runId) runs.delete(k);
    },
    active(city, category) {
      return runs.get(keyOf(city, category)) || null;
    },
  };
}

// 正在采集中的格（内存内，防同格重复起）。键：city\0category\0gx,gy → 认领令牌
const activeGrids = new Map();
function gridKey(city, category, g) {
  return city + '\u0000' + category + '\u0000' + g.gx + ',' + g.gy;
}

// 作废旧 run 时按 (city,category) 释放其认领的格，避免新 run 被旧认领挡住（T9 R2）
function releaseViewportGrids(city, category) {
  const prefix = city + '\u0000' + category + '\u0000';
  for (const k of Array.from(activeGrids.keys())) {
    if (k.startsWith(prefix)) activeGrids.delete(k);
  }
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
  budget,
  isCancelled,
}) {
  const center = { lng: minLng + size / 2, lat: minLat + size / 2 };
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let saturated = false;
  let errored = 0;
  let truncated = false;
  let cancelled = false;

  for (let page = 1; page <= MAX_PAGE; page += 1) {
    if (isCancelled && isCancelled()) {
      cancelled = true; // 格被作废：立即停，且不标覆盖（留待下次重试）
      break;
    }
    if (budget && budget.left <= 0) {
      truncated = true; // 配额预算耗尽（P4 保护 QPS）
      break;
    }
    // 高德瞬时错误（如 QPS 超限）→ 退避重试；耗尽仍失败才放弃该格
    let pois = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (budget && budget.left <= 0) {
        lastErr = new Error('VIEWPORT_BUDGET');
        break;
      }
      if (budget) budget.left -= 1;
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
      if (lastErr.message === 'VIEWPORT_BUDGET') truncated = true;
      else errored += 1; // 该格放弃，交由上层决定不标覆盖以便下次重试
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

  if (saturated && errored === 0 && !truncated && !cancelled) {
    const halfSize = size / 2;
    const halfRadius = Math.floor(radius / 2);
    const canSplit =
      halfSize >= minGridDeg &&
      depth < maxDepth &&
      halfRadius >= MIN_RADIUS &&
      (!budget || budget.left > 0);
    if (canSplit) {
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        if (isCancelled && isCancelled()) {
          cancelled = true;
          break;
        }
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
          budget,
          isCancelled,
        });
        fetched += sub.fetched;
        inserted += sub.inserted;
        updated += sub.updated;
        errored += sub.errored;
        if (sub.truncated) truncated = true;
        if (sub.cancelled) {
          cancelled = true;
          break;
        }
      }
    } else {
      truncated = true; // 细分到底（或预算耗尽）仍满 200
    }
  } else if (saturated && !cancelled) {
    truncated = true; // 取满但中途报错：无法继续细分，本次截断
  }

  return { fetched, inserted, updated, truncated, errored, cancelled };
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
  maxGridCalls = MAX_GRID_CALLS,
  isCancelled,
} = {}) {
  const grids = bboxToGrids(bbox);
  if (grids.length > MAX_VIEWPORT_GRIDS) {
    const err = new Error(`bbox 过大（${grids.length} 格 > 上限 ${MAX_VIEWPORT_GRIDS}）`);
    err.code = 'VIEWPORT_TOO_LARGE';
    throw err;
  }

  const skipped = [];
  const claimed = [];
  const token = {}; // 本次调用的认领令牌：释放时校验，防误删新 run 的认领
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
    activeGrids.set(key, token);
    claimed.push(g);
  });

  // T9 R5：优先视野中心格（按格中心到 bbox 中心距离升序）
  const centerLng = (Number(bbox.minLng) + Number(bbox.maxLng)) / 2;
  const centerLat = (Number(bbox.minLat) + Number(bbox.maxLat)) / 2;
  claimed.sort((a, b) => {
    const ca = gridCenter(a.gx, a.gy);
    const cb = gridCenter(b.gx, b.gy);
    const da = (ca.lng - centerLng) ** 2 + (ca.lat - centerLat) ** 2;
    const db2 = (cb.lng - centerLng) ** 2 + (cb.lat - centerLat) ** 2;
    return da - db2;
  });

  const collected = [];
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let errored = 0;
  let cancelled = false;

  for (let i = 0; i < claimed.length; i += 1) {
    if (isCancelled && isCancelled()) {
      cancelled = true; // 被新视野顶替：立即停，不再抢限流令牌
      break;
    }
    const g = claimed[i];
    const budget = { left: maxGridCalls }; // 每格独立预算
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
        budget,
        isCancelled,
      });
      fetched += cell.fetched;
      inserted += cell.inserted;
      updated += cell.updated;
      errored += cell.errored;
      if (isCancelled && isCancelled()) {
        cancelled = true;
        break; // 采到一半被作废：该格不标覆盖，留待下次重试
      }
      if (cell.errored === 0) {
        // 覆盖标记：真取完或（细分到底仍满→截断）都标，后者记 truncated 防无限重采
        db.markCovered(city, category, g.gx, g.gy, cell.inserted, cell.truncated);
        collected.push(g);
      }
      // 报错的格不标覆盖 → 下次进入会重试
    } finally {
      if (activeGrids.get(gridKey(city, category, g)) === token) {
        activeGrids.delete(gridKey(city, category, g));
      }
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

  // 提前 break（被作废）时，剩余已认领格必须一并释放，避免泄漏挡住后续 run
  for (const g of claimed) {
    const k = gridKey(city, category, g);
    if (activeGrids.get(k) === token) activeGrids.delete(k);
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
    cancelled,
  };
}

module.exports = {
  collectCityCategory,
  collectDistrict,
  collectViewport,
  createRateLimiter,
  createViewportRunRegistry,
  releaseViewportGrids,
  nextCategory,
  CATEGORY_ROTATION,
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
