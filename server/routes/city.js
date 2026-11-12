// 行政边界几乎不变：半年刷一次就够（高德行政区查询有日配额）
const BOUNDARY_TTL_MS = 180 * 24 * 60 * 60 * 1000;

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
];
