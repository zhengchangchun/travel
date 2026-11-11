// 两点间近似距离（米）：给「附近」排序用，精度足够
function metresBetween(lng1, lat1, lng2, lat2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (Number(lat2) - Number(lat1)) * rad;
  const dLng = (Number(lng2) - Number(lng1)) * rad;
  const mid = ((Number(lat1) + Number(lat2)) / 2) * rad;
  const x = dLng * Math.cos(mid);
  return Math.sqrt(x * x + dLat * dLat) * R;
}

// 「这两个名字是不是同一个地方」（去括号、去空白后看是否相等/前缀包含）
// 「驿居酒店」vs「驿居酒店(杭州西湖湖滨步行街音乐喷泉店)」⇒ 是
// 「杭州大剧院」vs「La Lune月光女神西餐厅」⇒ 不是
function looksSamePlace(a, b) {
  const norm = (s) =>
    String(s == null ? '' : s)
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
      .replace(/[\s·,，、\-—]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return shorter.length >= 3 && longer.startsWith(shorter);
}

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
    // 口径：**主信息一定对得上点击处** ——
    //   ① 库里有点就在 25m 内（基本就是点在它上面）⇒ 用它当主名，零调用
    //   ② 否则用逆地理编码（搜索类配额用尽时它通常还有额度）拿这个坐标的地址
    //   ③ 附近的点（我们的 + 高德的）一律只进 nearby 列表、标距离，不冒充点击处
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
      const local =
        typeof ctx.db.poisNearPoint === 'function'
          ? ctx.db
              .poisNearPoint({ lng: x, lat: y, deg: 0.0015, limit: 8 })
              .map((p) => Object.assign({}, p, { distance: metresBetween(x, y, p.lng, p.lat) }))
          : [];
      const onIt = local.find((p) => p.distance <= 25) || null; // 就压在点击处那条

      let at = null;
      let atError = null;
      try {
        at = await cached(ctx, () => ctx.amap.reverseGeocode({ lng: x, lat: y }));
      } catch (err) {
        atError = err;
      }
      if (!at && !onIt) {
        if (atError) throw atError;
        throw new ctx.HttpError(502, 'AMAP_ERROR', '这个位置查不到地址');
      }

      // 主信息先说「这个坐标上是什么」（逆地理编码的最近地名）——
      // 我们库里那条即使坐标重合，名字对不上也不能当主名：
      // 用户点的是底图上写的「杭州大剧院」，不是楼上那家「La Lune 西餐厅」。
      const sameAsOurs = !!(
        onIt &&
        at &&
        looksSamePlace(at.landmark || at.name, onIt.name)
      );
      const useOurs = sameAsOurs || (!at && !!onIt);
      const mainName = useOurs
        ? onIt.name
        : (at && (at.landmark || at.name)) || (onIt && onIt.name) || '';

      const nearby = local
        .filter((p) => !useOurs || !onIt || String(p.poi_id) !== String(onIt.poi_id))
        .map((p) => ({
          name: p.name,
          address: p.address,
          category: p.category,
          poi_id: p.poi_id,
          distance: Math.round(p.distance),
          source: 'local',
        }))
        .concat(
          at && Array.isArray(at.places)
            ? at.places.map((p) => ({
                name: p.name,
                address: p.address,
                category: null,
                poi_id: null,
                distance: Math.round(Number(p.distance) || 0),
                source: 'amap',
              }))
            : []
        )
        .filter((p) => p.name && p.name !== mainName)
        .sort((a, b) => a.distance - b.distance)
        // 同名的只留最近的（同距时保留我们库里那条 —— 它可点开）
        .filter((p, i, arr) => arr.findIndex((q) => q.name === p.name) === i)
        .slice(0, 8);

      return {
        source: useOurs ? 'local' : 'amap',
        lng: x,
        lat: y,
        name: mainName,
        address: (at && at.address) || (onIt && onIt.address) || '',
        category: useOurs ? onIt.category : (at && at.category) || (onIt && onIt.category) || null,
        street: (at && at.street) || '',
        area: (at && at.area) || '',
        // 只有「同一个地方」才把我们的点当成点击处那条，前端据此直接弹它的详情卡
        poi: useOurs ? onIt : null,
        nearby,
      };
    },
  },
];
