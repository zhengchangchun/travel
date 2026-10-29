const MODES = ['walking', 'driving', 'transit'];
const COORD_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

function assertMode(ctx, mode) {
  const value = mode && String(mode).trim();
  if (!value || !MODES.includes(value)) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', `mode 非法，应为 ${MODES.join(' / ')}`);
  }
  return value;
}

function assertCoord(ctx, name, value) {
  const v = value == null ? '' : String(value).trim();
  if (!COORD_RE.test(v)) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', `${name} 格式应为 lng,lat`);
  }
  return v;
}

function requireCity(ctx, value) {
  if (!value || !String(value).trim()) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 city');
  }
  return String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function planKey(mode, origin, destination) {
  return `route:${mode}:${origin}:${destination}`;
}

// 走缓存（键：mode + origin + destination），命中即不消耗高德配额
async function planLeg(ctx, { mode, origin, destination, city }) {
  const key = planKey(mode, origin, destination);
  const hit = ctx.cache.get(key);
  if (hit !== undefined) return hit;
  let data;
  if (mode === 'walking') data = await ctx.amap.planWalking(origin, destination);
  else if (mode === 'driving') data = await ctx.amap.planDriving(origin, destination);
  else data = await ctx.amap.planTransit(origin, destination, city);
  ctx.cache.set(key, data);
  return data;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/route',
    async handler(ctx) {
      const mode = assertMode(ctx, ctx.query.mode);
      const origin = assertCoord(ctx, 'origin', ctx.query.origin);
      const destination = assertCoord(ctx, 'destination', ctx.query.destination);
      let city;
      if (mode === 'transit') {
        city = requireCity(ctx, ctx.query.city);
      }
      const data = await planLeg(ctx, { mode, origin, destination, city });
      return { ...data, degraded: false };
    },
  },
  {
    method: 'GET',
    path: '/api/itinerary/route',
    async handler(ctx) {
      const mode = assertMode(ctx, ctx.query.mode);
      const city = requireCity(ctx, ctx.query.city);
      const pins = ctx.db.getSelectionByCity(city);
      if (pins.length < 2) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '行程点数不足 2，无法连线');
      }

      const interval = Number(ctx.routeIntervalMs) || 0;
      const legs = [];
      const failed = [];
      let totalDistance = 0;
      let totalDuration = 0;

      for (let i = 0; i < pins.length - 1; i += 1) {
        if (i > 0 && interval > 0) await sleep(interval);
        const a = pins[i];
        const b = pins[i + 1];
        const origin = `${a.lng},${a.lat}`;
        const destination = `${b.lng},${b.lat}`;
        const from = { name: a.name, poi_id: a.poi_id, lng: a.lng, lat: a.lat };
        const to = { name: b.name, poi_id: b.poi_id, lng: b.lng, lat: b.lat };
        try {
          const r = await planLeg(ctx, { mode, origin, destination, city });
          legs.push({
            index: i,
            from,
            to,
            distance: r.distance,
            duration: r.duration,
            polyline: r.polyline,
            steps: r.steps,
            transit: r.transit,
            ok: true,
            degraded: false,
          });
          totalDistance += r.distance;
          totalDuration += r.duration;
        } catch (err) {
          const reason = (err && err.message) || '规划失败';
          legs.push({
            index: i,
            from,
            to,
            distance: 0,
            duration: 0,
            polyline: [],
            steps: [],
            transit: null,
            ok: false,
            degraded: true,
            reason,
          });
          failed.push({ index: i, reason });
        }
      }

      if (legs.every((l) => !l.ok)) {
        throw new ctx.HttpError(502, 'AMAP_ERROR', '所有路段均规划失败');
      }

      return { mode, legs, totalDistance, totalDuration, failed };
    },
  },
];
