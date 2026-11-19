const MODES = ['walking', 'riding', 'driving', 'transit'];
const { applyPoiOrder, parseOrderCsv } = require('../order');
const MODE_LABEL = { walking: '步行', riding: '骑行', driving: '驾车', transit: '公交' };
const AUTO_MODE = 'auto';
// 自动（取最快）时的尝试顺序：先试平时最常用的，拿不到的跳过
const AUTO_ORDER = ['driving', 'riding', 'transit', 'walking'];
const COORD_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

function modeLabel(key) {
  return MODE_LABEL[key] || String(key || '');
}

function assertMode(ctx, mode) {
  const value = mode && String(mode).trim();
  if (!value || (!MODES.includes(value) && value !== AUTO_MODE)) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', `mode 非法，应为 ${MODES.join(' / ')} / ${AUTO_MODE}`);
  }
  return value;
}

// 每段一个方式："driving,walking" —— 个数要与段数一致，名字要认得
function parsePerLegModes(ctx, value, legCount) {
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  list.forEach((m) => {
    if (!MODES.includes(m)) {
      throw new ctx.HttpError(400, 'BAD_REQUEST', `modes 里有认不出的方式：${m}（应为 ${MODES.join(' / ')}）`);
    }
  });
  if (list.length !== legCount) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', `modes 要给 ${legCount} 个（每段一个），现在给了 ${list.length} 个`);
  }
  return list;
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
  else if (mode === 'riding') data = await ctx.amap.planRiding(origin, destination);
  else if (mode === 'driving') data = await ctx.amap.planDriving(origin, destination);
  else data = await ctx.amap.planTransit(origin, destination, city);
  ctx.cache.set(key, data);
  return data;
}

// 这一段「先按时间最短」：四种方式各规划一次（结果进缓存，之后切方式不用再打高德），
// 取耗时最短的那条；某种方式失败只记在 options 里，不影响别的
async function planLegAuto(ctx, { origin, destination, city }) {
  const options = [];
  let best = null;
  for (const m of AUTO_ORDER) {
    try {
      const r = await planLeg(ctx, { mode: m, origin, destination, city });
      options.push({
        mode: m,
        label: modeLabel(m),
        ok: true,
        distance: Number(r.distance) || 0,
        duration: Number(r.duration) || 0,
      });
      if (!best || (Number(r.duration) || 0) < (Number(best.data.duration) || 0)) best = { data: r, mode: m };
    } catch (err) {
      options.push({ mode: m, label: modeLabel(m), ok: false, reason: (err && err.message) || '规划失败' });
    }
  }
  if (!best) throw new ctx.HttpError(502, 'AMAP_ERROR', '四种出行方式都没能规划出来');
  return Object.assign({}, best.data, { mode: best.mode, modeOptions: options });
}

// 这一段各方式的耗时：能在缓存里捞到就都列上（auto 规划过之后，切方式不用再打高德）
function cachedModeOptions(ctx, { origin, destination }) {
  const out = [];
  AUTO_ORDER.forEach((m) => {
    const hit = ctx.cache.get(planKey(m, origin, destination));
    if (hit && hit.duration !== undefined) {
      out.push({
        mode: m,
        label: modeLabel(m),
        ok: true,
        distance: Number(hit.distance) || 0,
        duration: Number(hit.duration) || 0,
      });
    }
  });
  return out;
}

// 单一方式那一段：也把 modeOptions 填上（只有它自己），前端那套每段选择器不用分两种情况
function withMode(data, key) {
  return Object.assign({}, data, {
    mode: key,
    modeOptions: [
      {
        mode: key,
        label: modeLabel(key),
        ok: true,
        distance: Number(data.distance) || 0,
        duration: Number(data.duration) || 0,
      },
    ],
  });
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
      if (mode === 'transit' || mode === AUTO_MODE) {
        city = requireCity(ctx, ctx.query.city);
      }
      if (mode === AUTO_MODE) {
        const auto = await planLegAuto(ctx, { origin, destination, city });
        return { ...auto, auto: true, degraded: false };
      }
      const data = await planLeg(ctx, { mode, origin, destination, city });
      return { ...withMode(data, mode), auto: false, degraded: false };
    },
  },
  {
    method: 'GET',
    path: '/api/itinerary/route',
    async handler(ctx) {
      const user = require('../auth').requireUser(ctx);
      const city = requireCity(ctx, ctx.query.city);
      // order（可选）= 页面上的点序（默认「按距离」算出来的那份）：逐段规划就按它走，
      // 否则页面上是距离序、服务端按库里的顺序规划，两边的「第 n 段」会对不上
      const pins = applyPoiOrder(
        ctx.db.getSelectionByCity(city, user.id),
        parseOrderCsv(ctx.query.order)
      );
      if (pins.length < 2) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '行程点数不足 2，无法连线');
      }
      const legCount = pins.length - 1;
      // 三种请求方式：① mode=<key> 全段一个方式 ② mode=auto 每段各取最快 ③ modes=a,b,c 每段指定
      const perLeg = ctx.query.modes ? parsePerLegModes(ctx, ctx.query.modes, legCount) : null;
      const rawMode = perLeg ? null : assertMode(ctx, ctx.query.mode);
      const auto = rawMode === AUTO_MODE;
      const globalMode = auto || perLeg ? null : rawMode;

      const interval = Number(ctx.routeIntervalMs) || 0;
      const legs = [];
      const failed = [];
      let totalDistance = 0;
      let totalDuration = 0;

      for (let i = 0; i < legCount; i += 1) {
        if (i > 0 && interval > 0) await sleep(interval);
        const a = pins[i];
        const b = pins[i + 1];
        const origin = `${a.lng},${a.lat}`;
        const destination = `${b.lng},${b.lat}`;
        const from = { name: a.name, poi_id: a.poi_id, lng: a.lng, lat: a.lat };
        const to = { name: b.name, poi_id: b.poi_id, lng: b.lng, lat: b.lat };
        try {
          let r;
          if (perLeg) r = await planLeg(ctx, { mode: perLeg[i], origin, destination, city });
          else if (auto) r = await planLegAuto(ctx, { origin, destination, city });
          else r = await planLeg(ctx, { mode: globalMode, origin, destination, city });
          const key = perLeg ? perLeg[i] : auto ? r.mode : globalMode;
          const options = perLeg ? cachedModeOptions(ctx, { origin, destination }) : r.modeOptions || [];
          legs.push({
            index: i,
            from,
            to,
            mode: key,
            modeLabel: modeLabel(key),
            modeOptions: options,
            distance: r.distance,
            duration: r.duration,
            polyline: r.polyline,
            steps: r.steps,
            transit: r.transit,
            ok: true,
            degraded: false,
          });
          totalDistance += Number(r.distance) || 0;
          totalDuration += Number(r.duration) || 0;
        } catch (err) {
          const reason = (err && err.message) || '规划失败';
          legs.push({
            index: i,
            from,
            to,
            mode: perLeg ? perLeg[i] : auto ? null : globalMode,
            modeLabel: modeLabel(perLeg ? perLeg[i] : globalMode),
            modeOptions: [],
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

      const usedModes = Array.from(new Set(legs.filter((l) => l.ok).map((l) => l.mode)));
      return {
        mode: perLeg ? (usedModes.length === 1 ? usedModes[0] : 'mixed') : auto ? AUTO_MODE : globalMode,
        auto,
        perLeg: perLeg || null,
        mixed: perLeg ? usedModes.length > 1 : false,
        legs,
        totalDistance,
        totalDuration,
        failed,
      };
    },
  },
];
