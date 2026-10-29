async function cached(ctx, producer) {
  const key = ctx.cacheKey;
  const hit = ctx.cache.get(key);
  if (hit !== undefined) return hit;
  const data = await producer();
  ctx.cache.set(key, data);
  return data;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/poi/search',
    handler(ctx) {
      const { city, category, keywords, page } = ctx.query;
      if (!city || !String(city).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 city');
      }
      return cached(ctx, () =>
        ctx.amap.searchPoi({ city: String(city).trim(), category, keywords, page })
      );
    },
  },
  {
    method: 'GET',
    path: '/api/poi/nearby',
    handler(ctx) {
      const { lng, lat, category, radius } = ctx.query;
      if (lng === undefined || lat === undefined || lng === '' || lat === '') {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 lng/lat');
      }
      return cached(ctx, () =>
        ctx.amap.nearbyPoi({ lng: Number(lng), lat: Number(lat), category, radius })
      );
    },
  },
  {
    method: 'GET',
    path: '/api/poi/detail',
    handler(ctx) {
      const id = ctx.query.id;
      if (!id || !String(id).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 id');
      }
      return cached(ctx, () => ctx.amap.poiDetail(String(id).trim()));
    },
  },
];
