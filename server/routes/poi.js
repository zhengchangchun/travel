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
    async handler(ctx) {
      const { city, category, keywords, page } = ctx.query;
      if (!city || !String(city).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 city');
      }
      const params = { city: String(city).trim(), category, keywords, page };
      // P9-⑥ 本地回退：高德不可用（配额用尽 / 网络 / QPS）或没结果时，
      // 直接查本地已收录的 pois（每条带 local:true），别让「搜索地点」只剩一句报错。
      const localHit = () =>
        ctx.db.searchPoisLocal({
          city: params.city,
          keywords,
          category,
          limit: 60,
        });
      let remote = null;
      let remoteError = null;
      try {
        remote = await cached(ctx, () => ctx.amap.searchPoi(params));
      } catch (err) {
        remoteError = err;
      }
      if (Array.isArray(remote) && remote.length) return remote;
      const hit = localHit();
      if (hit.length) return hit;
      if (remoteError) throw remoteError; // 本地也没有 ⇒ 如实报高德的原因
      return Array.isArray(remote) ? remote : [];
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
  {
    // 点地图任意处问「这里是哪」（P19）。
    // ① 我们库里已经有这一带的点 ⇒ 零调用直接给（用户最想要的也是那个点）
    // ② 没有 ⇒ 逆地理编码（搜索类配额用尽时它通常还有额度），拿地址 + 附近 POI
    method: 'GET',
    path: '/api/poi/at',
    async handler(ctx) {
      const { lng, lat } = ctx.query;
      if (lng === undefined || lat === undefined || lng === '' || lat === '') {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 lng/lat');
      }
      const x = Number(lng);
      const y = Number(lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', 'lng/lat 必须是数字');
      }
      if (typeof ctx.db.poisNearPoint === 'function') {
        const local = ctx.db.poisNearPoint({ lng: x, lat: y, deg: 0.0015, limit: 5 });
        if (local.length) {
          return { source: 'local', lng: x, lat: y, poi: local[0], nearby: local.slice(1) };
        }
      }
      const at = await cached(ctx, () => ctx.amap.reverseGeocode({ lng: x, lat: y }));
      if (!at) throw new ctx.HttpError(502, 'AMAP_ERROR', '这个位置查不到地址');
      return Object.assign({ source: 'amap', lng: x, lat: y }, at);
    },
  },
];
