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
];
