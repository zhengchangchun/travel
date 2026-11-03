const {
  collectCityCategory,
  collectViewport,
  bboxToGrids,
  releaseViewportGrids,
  liveRect,
  MAX_VIEWPORT_GRIDS,
} = require('../collect');
const { toDetail } = require('../poi-detail');

function requireCity(ctx, value) {
  if (!value || !String(value).trim()) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 city');
  }
  return String(value).trim();
}

function num(v) {
  return typeof v === 'bigint' ? Number(v) : Number(v) || 0;
}

// bbox=minLng,minLat,maxLng,maxLat → {minLng,minLat,maxLng,maxLat}；非法（缺段/非数字/min>=max）→ 400
function parseBbox(ctx, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const parts = String(raw).split(',');
  if (parts.length !== 4) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', 'bbox 需为 minLng,minLat,maxLng,maxLat 四段');
  }
  const nums = parts.map((p) => (String(p).trim() === '' ? NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n))) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', 'bbox 四段必须都是数字');
  }
  const [minLng, minLat, maxLng, maxLat] = nums;
  if (!(minLng < maxLng) || !(minLat < maxLat)) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', 'bbox 需满足 minLng<maxLng 且 minLat<maxLat');
  }
  return { minLng, minLat, maxLng, maxLat };
}

// 视野 bbox → 网格列表（含上限校验）；缺 bbox / 非法 / 过大 → 400
function requireViewportGrids(ctx, raw) {
  const bbox = parseBbox(ctx, raw);
  if (!bbox) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 bbox');
  const grids = bboxToGrids(bbox);
  if (grids.length > MAX_VIEWPORT_GRIDS) {
    throw new ctx.HttpError(
      400,
      'BAD_REQUEST',
      `bbox 过大（${grids.length} 格 > 上限 ${MAX_VIEWPORT_GRIDS}），请放大地图后重试`
    );
  }
  return { bbox, grids };
}

function parseDetail(detail) {
  if (!detail) return {};
  if (typeof detail === 'object') return detail;
  try {
    return JSON.parse(detail);
  } catch (err) {
    return {};
  }
}

// 后台跑采集：进度逐区写入 run.detail，结束写终态
function startCollect(ctx, { city, category }) {
  const run = ctx.db.createRun({ city, category });
  const safeUpdate = (fields) => {
    try {
      ctx.db.updateRun(run.id, fields);
    } catch (err) {
      /* 库已关闭等场景：不影响主流程 */
    }
  };
  const job = (async () => {
    try {
      const res = await collectCityCategory({
        city,
        category,
        amap: ctx.amap,
        db: ctx.db,
        intervalMs: ctx.collectIntervalMs,
        onProgress: (p) =>
          safeUpdate({
            n_fetched: p.n_fetched,
            n_inserted: p.n_inserted,
            n_updated: p.n_updated,
            detail: {
              done_districts: p.done_districts,
              total_districts: p.total_districts,
              districts: p.districts,
            },
          }),
      });
      safeUpdate({
        status: res.status,
        finished_at: new Date().toISOString(),
        n_fetched: res.n_fetched,
        n_inserted: res.n_inserted,
        n_updated: res.n_updated,
        detail: {
          done_districts: res.done_districts,
          total_districts: res.total_districts,
          districts: res.districts,
        },
      });
    } catch (err) {
      safeUpdate({
        status: 'failed',
        finished_at: new Date().toISOString(),
        detail: { error: (err && err.message) || '采集失败' },
      });
    }
  })();
  return { run, job };
}

module.exports = [
  {
    method: 'GET',
    path: '/api/pois',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const { category, minRating, sort, limit, offset, bbox } = ctx.query;
      return ctx.db.listPois({
        city,
        category: category || undefined,
        minRating,
        sort,
        limit,
        offset,
        bbox: parseBbox(ctx, bbox),
      });
    },
  },
  // 实时搜索（不是收录）：按当前地图矩形向高德查（place/polygon，1–4 次调用）→
  // 框内的结果落库当缓存 → 立刻返回该视野的完整结果（缓存 + 刚搜到的）。
  // 框外的一律不存不显；失败不阻断，原因在 live.errors 里回报。
  {
    method: 'GET',
    path: '/api/poi/inview',
    async handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const bbox = parseBbox(ctx, ctx.query.bbox);
      if (!bbox) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 bbox');
      const category =
        (ctx.query.category && String(ctx.query.category).trim()) || 'all';
      const live = await liveRect({
        amap: ctx.amap,
        db: ctx.db,
        city,
        category,
        bbox,
        rateLimiter: ctx.viewportRateLimiter,
      });
      const result = ctx.db.listPois({ city, bbox });
      return {
        city,
        category,
        total: result.total,
        items: result.items,
        live,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/pois/stats',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const stats = ctx.db.poisStats(city);
      const categories = ctx.categories.map((c) => {
        const hit = stats.categories.find((s) => s.key === c.key);
        return { key: c.key, label: c.label, color: c.color, count: hit ? hit.count : 0 };
      });
      return { city, total: stats.total, categories, ratingBuckets: stats.ratingBuckets };
    },
  },
  {
    method: 'POST',
    path: '/api/collect',
    handler(ctx) {
      const body = ctx.body || {};
      const city = requireCity(ctx, body.city || ctx.query.city);
      const known = ctx.categories.map((c) => c.key);
      const raw = body.category;
      let targets;
      if (!raw || raw === 'all') {
        targets = known.slice();
      } else {
        const value = String(raw).trim();
        if (!known.includes(value)) {
          throw new ctx.HttpError(400, 'BAD_REQUEST', `category 非法：${value}`);
        }
        targets = [value];
      }

      // 同一 (城市,分类) 已在跑 → 409
      targets.forEach((t) => {
        if (ctx.db.findRunningRun(city, t)) {
          throw new ctx.HttpError(409, 'CONFLICT', `${city} 的「${t}」采集正在进行中`);
        }
      });

      const started = targets.map((t) => startCollect(ctx, { city, category: t }));
      return {
        city,
        category: raw || 'all',
        runId: started[0].run.id,
        runIds: started.map((s) => s.run.id),
        categories: targets,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/collect/status',
    handler(ctx) {
      const id = Number(ctx.query.runId);
      if (!id) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 runId');
      const run = ctx.db.getRun(id);
      if (!run) throw new ctx.HttpError(404, 'NOT_FOUND', '未找到该采集任务');
      const detail = parseDetail(run.detail);
      const total = num(detail.total_districts);
      const done = num(detail.done_districts);
      // T9 R4：视野采集进度以「格」为单位暴露（本区域已采 x / y 格）
      const totalGrids = num(detail.total_grids != null ? detail.total_grids : detail.total_districts);
      const doneGrids = num(detail.done_grids != null ? detail.done_grids : detail.done_districts);
      const percentBase = totalGrids || total;
      const percentDone = totalGrids ? doneGrids : done;
      const percent = percentBase
        ? Math.round((percentDone / percentBase) * 100)
        : run.status === 'running'
          ? 0
          : 100;
      return {
        runId: run.id,
        city: run.city,
        category: run.category,
        status: run.status,
        started_at: run.started_at,
        finished_at: run.finished_at,
        n_fetched: num(run.n_fetched),
        n_inserted: num(run.n_inserted),
        n_updated: num(run.n_updated),
        done_districts: done,
        total_districts: total,
        done_grids: doneGrids,
        total_grids: totalGrids,
        percent,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/collect/runs',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      return ctx.db.listRuns(city).map((r) => ({
        runId: r.id,
        city: r.city,
        category: r.category,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        n_fetched: num(r.n_fetched),
        n_inserted: num(r.n_inserted),
        n_updated: num(r.n_updated),
      }));
    },
  },
  // 采集覆盖查询（T8）：返回 bbox 内已覆盖 / 未覆盖的格
  {
    method: 'GET',
    path: '/api/coverage',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const category = (ctx.query.category && String(ctx.query.category).trim()) || 'all';
      const { grids } = requireViewportGrids(ctx, ctx.query.bbox);
      const gxs = grids.map((g) => g.gx);
      const gys = grids.map((g) => g.gy);
      const rows = ctx.db.listCoverageRange(
        city,
        category,
        Math.min(...gxs),
        Math.max(...gxs),
        Math.min(...gys),
        Math.max(...gys)
      );
      const coveredSet = new Set(rows.map((r) => r.gx + ',' + r.gy));
      const covered = grids.filter((g) => coveredSet.has(g.gx + ',' + g.gy));
      const uncovered = grids.filter((g) => !coveredSet.has(g.gx + ',' + g.gy));
      return { city, category, grids, covered, uncovered };
    },
  },
  // 按视野采集（T8）：只采未覆盖格；异步，进度走 /api/collect/status
  {
    method: 'POST',
    path: '/api/collect/viewport',
    handler(ctx) {
      const body = ctx.body || {};
      const city = requireCity(ctx, body.city || ctx.query.city);
      const category = (body.category && String(body.category).trim()) || 'all';
      const { bbox, grids } = requireViewportGrids(ctx, body.bbox);
      const uncovered = grids.filter(
        (g) => !ctx.db.isCovered(city, category, g.gx, g.gy)
      );
      const skipped = grids.length - uncovered.length;
      if (!uncovered.length) {
        return { city, category, runId: null, grids: [], total_grids: 0, skipped };
      }
      const run = ctx.db.createRun({ city, category });
      const safeUpdate = (fields) => {
        try {
          ctx.db.updateRun(run.id, fields);
        } catch (err) {
          /* 库已关闭等场景：不影响主流程 */
        }
      };
      // T9 R2 单飞：同 (city,category) 新视野顶替旧 run；旧 run 标 superseded 并立即停
      const supersededRunId = ctx.viewportRuns.start(city, category, run.id);
      if (supersededRunId != null) {
        releaseViewportGrids(city, category); // 释放旧 run 认领的格，交由新 run 接管
        try {
          ctx.db.updateRun(supersededRunId, {
            status: 'superseded',
            finished_at: new Date().toISOString(),
          });
        } catch (err) {
          /* 旧 run 更新失败不影响新 run */
        }
      }
      const isCancelled = () => ctx.viewportRuns.isCancelled(city, category, run.id);
      (async () => {
        try {
          const res = await collectViewport({
            city,
            category,
            bbox,
            amap: ctx.amap,
            db: ctx.db,
            intervalMs: ctx.collectIntervalMs,
            rateLimiter: ctx.viewportRateLimiter,
            isCancelled,
            onProgress: (p) =>
              safeUpdate({
                n_fetched: p.n_fetched,
                n_inserted: p.n_inserted,
                n_updated: p.n_updated,
                detail: {
                  total_grids: p.total_grids,
                  done_grids: p.done_grids,
                },
              }),
          });
          const cancelled = !!res.cancelled || isCancelled();
          safeUpdate({
            status: cancelled ? 'superseded' : 'done',
            finished_at: new Date().toISOString(),
            n_fetched: res.n_fetched,
            n_inserted: res.n_inserted,
            n_updated: res.n_updated,
            detail: {
              total_grids: uncovered.length,
              done_grids: res.collected.length,
            },
          });
        } catch (err) {
          if (isCancelled()) {
            safeUpdate({ status: 'superseded', finished_at: new Date().toISOString() });
          } else {
            safeUpdate({
              status: 'failed',
              finished_at: new Date().toISOString(),
              detail: { error: (err && err.message) || '采集失败' },
            });
          }
        } finally {
          ctx.viewportRuns.finish(city, category, run.id);
        }
      })();
      return {
        city,
        category,
        runId: run.id,
        grids: uncovered,
        total_grids: uncovered.length,
        skipped,
      };
    },
  },
  // 单点详情（T5）：优先读缓存；缓存没有 → 高德现取一次（不落库）；都没有 → 404
  // 注意：注册在 /api/pois/stats 之后，避免 stats 被 :poiId 抢先匹配
  {
    method: 'GET',
    path: '/api/pois/:poiId',
    async handler(ctx) {
      const poiId = String(ctx.params.poiId || '').trim();
      if (!poiId) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 poiId');
      const row = ctx.db.getPoi(poiId);
      if (row) return toDetail(row, poiId);
      let live = null;
      try {
        live = await ctx.amap.poiDetail(poiId);
      } catch (err) {
        live = null;
      }
      if (!live) throw new ctx.HttpError(404, 'NOT_FOUND', '未找到该地点');
      return toDetail(live, poiId);
    },
  },
];
