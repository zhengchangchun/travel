const { collectCityCategory } = require('../collect');
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
      const { category, minRating, sort, limit, offset } = ctx.query;
      return ctx.db.listPois({
        city,
        category: category || undefined,
        minRating,
        sort,
        limit,
        offset,
      });
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
      const percent = total ? Math.round((done / total) * 100) : run.status === 'running' ? 0 : 100;
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
