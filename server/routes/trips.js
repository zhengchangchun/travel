const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const share = require('../share');
const routemap = require('../routemap');
const auth = require('../auth');
const { applyPoiOrder } = require('../order');

// 行程、点位、分享包都是「我的」：一律要登录，且只能碰自己的
const me = (ctx) => auth.requireUser(ctx);

function tripOfUser(ctx, id) {
  const user = me(ctx);
  const trip = ctx.db.getTripOfUser(Number(id), user.id);
  if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${id} 不存在`);
  return { user, trip };
}

// 点属于某趟行程，行程属于某人：别人的点当不存在
function pinOfUser(ctx, id) {
  const user = me(ctx);
  const pin = ctx.db.getPin(Number(id));
  const trip = pin ? ctx.db.getTripOfUser(pin.trip_id, user.id) : null;
  if (!pin || !trip) throw new ctx.HttpError(404, 'NOT_FOUND', `点 ${id} 不存在`);
  return pin;
}

const MODE_KEYS = ['driving', 'riding', 'walking', 'transit'];

// 页面上那条「按我的安排」：每段自己的方式（客户端把段方式随请求带过来）
// 段数对不上、或出现认不出的方式，就当没给（宁可不画，也不能画错）
function parsePlanModes(raw, legCount) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const list = raw.map((m) => String(m || '').trim());
  if (list.length !== legCount) return null;
  if (!list.every((m) => MODE_KEYS.includes(m))) return null;
  return list;
}

const SHARE_DIR = () => process.env.TRAVEL_SHARE_DIR || path.join(__dirname, '..', '..', 'share');

// 在系统的文件管理器里把这个文件「选中」显示出来 —— 生成的分享文件落在仓库目录里，
// 让他自己去翻目录找很别扭；点一下就能直接拖进微信。服务本来就只监听 127.0.0.1，
// 所以这个动作只有本机能触发。
function revealFile(full) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { timeout: 5000 });
    if (r.error) return { ok: false, message: cmd + ': ' + r.error.message };
    if (r.status !== 0) return { ok: false, message: cmd + ' 退出码 ' + r.status };
    return { ok: true };
  };
  if (process.platform === 'darwin') return run('/usr/bin/open', ['-R', full]);
  if (process.platform === 'win32') return run('explorer', ['/select,' + full]);
  return run('xdg-open', [path.dirname(full)]);
}

// 行程分享载荷：库里读行程 + 有序点，住宿锚点在前端（localStorage）⇒ 由请求体带过来
function sharePayload(ctx, tripId) {
  const id = Number(tripId);
  const user = auth.requireUser(ctx);
  const trip = ctx.db.getTripOfUser(id, user.id);
  if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${id} 不存在`);
  const b = (ctx.body && ctx.body.base) || null;
  const base =
    b && Number.isFinite(Number(b.lng)) && Number.isFinite(Number(b.lat))
      ? { name: b.name || '住宿', lng: Number(b.lng), lat: Number(b.lat) }
      : null;
  const labels = {};
  (ctx.categories || []).forEach((c) => {
    labels[c.key] = { label: c.label };
  });
  return share.buildPayload({
    trip,
    city: trip.city,
    // order（可选）：页面上「按距离」排出来的点序随请求带过来，分享包 / 静态路线图跟着它排
    // 按天分段：分享包也按「天 → 顺序」排
    stops: applyPoiOrder(ctx.db.getTripPinsOrdered(id), ctx.body && ctx.body.order),
    base,
    labels,
    when: new Date().toISOString(),
  });
}

module.exports = [
  {
    method: 'POST',
    path: '/api/trips/:id/share',
    handler(ctx) {
      const payload = sharePayload(ctx, ctx.params.id);
      return { payload, text: share.buildText(payload) };
    },
  },
  {
    method: 'POST',
    path: '/api/trips/:id/share/export',
    async handler(ctx) {
      const payload = sharePayload(ctx, ctx.params.id);
      if (!payload.stops.length) {
        throw new ctx.HttpError(400, 'EMPTY_TRIP', '这条行程还没有地点，先挑几个再分享');
      }
      // P14：用地图生成的真实路线（逐段规划 + 静态地图底图，base64 内嵌，分享页里没有 key）
      const modes = Array.isArray(ctx.body && ctx.body.modes) ? ctx.body.modes : undefined;
      let built = { maps: {}, errors: {} };
      if (payload.stops.length >= 2) {
        // 先画页面上那条「按我的安排」（每段自己的方式）—— 它才是他正在看的那条线
        const planModes = parsePlanModes(ctx.body && ctx.body.planModes, payload.stops.length - 1);
        if (planModes) {
          try {
            built.maps.plan = await routemap.buildPlanMap({
              amap: ctx.amap,
              cache: ctx.cache,
              intervalMs: Number(ctx.routeIntervalMs) || 0,
              stops: payload.stops,
              perLegModes: planModes,
              city: payload.city,
            });
          } catch (err) {
            built.errors.plan = (err && err.message) || '路线图生成失败';
          }
        }
        try {
          const perMode = await routemap.buildShareMaps({
            amap: ctx.amap,
            cache: ctx.cache,
            intervalMs: Number(ctx.routeIntervalMs) || 0,
            stops: payload.stops,
            modes,
            // 公交路线要高德的城市名
            city: payload.city,
          });
          Object.keys(perMode.maps).forEach((k) => {
            built.maps[k] = perMode.maps[k];
          });
          Object.keys(perMode.errors).forEach((k) => {
            built.errors[k] = perMode.errors[k];
          });
        } catch (err) {
          built.errors.all = (err && err.message) || '路线图生成失败';
        }
      }
      payload.maps = built.maps;
      payload.mapErrors = built.errors;
      const out = share.writePackage(SHARE_DIR(), payload);
      const text = share.buildText(payload);
      // 记一笔到分享列表（首页/分享列表页要用）；记录失败不影响分享本身
      let shareRow = null;
      try {
        const user = me(ctx);
        shareRow = ctx.db.addShare({
          tripId: payload.tripId != null ? Number(payload.tripId) : Number(ctx.params.id) || null,
          userId: user.id,
          city: payload.city,
          title: payload.title,
          base: out.base,
          files: out.files,
          text,
          stops: payload.stops.length,
          distanceM: payload.plan && payload.plan.distanceM,
        });
      } catch (err) {
        shareRow = null;
      }
      return {
        dir: out.dir,
        base: out.base,
        shareId: shareRow ? shareRow.id : null,
        files: out.files,
        text,
        count: payload.stops.length,
        maps: Object.keys(built.maps).map((m) => ({
          mode: m,
          label: built.maps[m].modeLabel,
          distance: built.maps[m].distance,
          duration: built.maps[m].duration,
          bytes: built.maps[m].imageBytes,
        })),
        mapErrors: built.errors,
        // 同一个服务里就能打开看（浏览器里的链接，不是本地路径）
        preview: '/share/' + encodeURIComponent(out.base + '.html'),
      };
    },
  },
  {
    // 让分享文件「现身」：在 Finder / 资源管理器里选中它（只认分享目录里的文件）
    method: 'POST',
    path: '/api/share/reveal',
    handler(ctx) {
      const name = String((ctx.body && ctx.body.file) || '').trim();
      if (!name) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少 file');
      const dir = path.resolve(SHARE_DIR());
      const full = path.resolve(dir, path.basename(name)); // basename：不接受任何路径
      if (path.dirname(full) !== dir || !fs.existsSync(full)) {
        throw new ctx.HttpError(404, 'NOT_FOUND', '这个分享文件还没生成');
      }
      const reveal = ctx.reveal || revealFile;
      const r = reveal(full);
      if (!r || r.ok !== true) {
        throw new ctx.HttpError(500, 'REVEAL_FAILED', (r && r.message) || '打开目录失败');
      }
      return { ok: true, file: path.basename(full), dir };
    },
  },
  {
    method: 'GET',
    path: '/api/trips',
    handler(ctx) {
      const user = me(ctx);
      const city = ctx.query && ctx.query.city;
      return ctx.db.listTrips(user.id, city ? String(city).trim() : undefined);
    },
  },
  {
    method: 'POST',
    path: '/api/trips',
    handler(ctx) {
      const user = me(ctx);
      const { city, title, theme } = ctx.body || {};
      if (!city || !String(city).trim() || !title || !String(title).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 city/title');
      }
      return ctx.db.createTrip({
        city: String(city).trim(),
        title: String(title).trim(),
        theme: theme == null ? null : String(theme).trim(),
        userId: user.id,
      });
    },
  },
  {
    method: 'DELETE',
    path: '/api/trips',
    handler(ctx) {
      const user = me(ctx);
      const city = ctx.query && ctx.query.city;
      if (!city || !String(city).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 city');
      }
      const res = ctx.db.deleteCityTrips(String(city).trim(), user.id);
      return { city: res.city, trips: res.trips, pins: res.pins, deleted: true };
    },
  },
  {
    method: 'DELETE',
    path: '/api/trips/:id',
    handler(ctx) {
      const { trip } = tripOfUser(ctx, ctx.params.id);
      ctx.db.deleteTrip(trip.id);
      return { deleted: trip.id };
    },
  },
  {
    // 行程改内容：标题（title）与整条行程的备注（note）；两个都可只传一个
    method: 'PATCH',
    path: '/api/trips/:id',
    handler(ctx) {
      const { trip: owned } = tripOfUser(ctx, ctx.params.id);
      const id = owned.id;
      let trip = owned;
      const b = ctx.body || {};
      if (b.title !== undefined) {
        const title = String(b.title).trim();
        if (!title) throw new ctx.HttpError(400, 'BAD_REQUEST', '标题不能为空');
        trip = ctx.db.updateTripTitle(id, title).trip;
      }
      if (b.note !== undefined) trip = ctx.db.updateTripNote(id, b.note).trip;
      if (b.theme !== undefined) trip = ctx.db.updateTripTheme(id, b.theme);
      return trip;
    },
  },
  {
    method: 'GET',
    path: '/api/trips/:id/pins',
    handler(ctx) {
      const { trip } = tripOfUser(ctx, ctx.params.id);
      return ctx.db.getPinsByTrip(trip.id);
    },
  },
  {
    method: 'POST',
    path: '/api/pins',
    handler(ctx) {
      const user = me(ctx);
      const b = ctx.body || {};
      if (b.name === undefined || b.lng === undefined || b.lat === undefined) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 name/lng/lat');
      }
      // trip_id 仍可传入（向后兼容）；省略时按 city 自动归集到「我的行程」
      let tripId;
      if (b.trip_id !== undefined && b.trip_id !== null) {
        tripId = Number(b.trip_id);
        if (!ctx.db.getTripOfUser(tripId, user.id)) {
          throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${b.trip_id} 不存在`);
        }
      } else {
        if (!b.city || !String(b.city).trim()) {
          throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少 trip_id 时必须提供 city');
        }
        tripId = ctx.db.getOrCreateCityTrip(String(b.city).trim(), user.id).id;
      }
      return ctx.db.addPin({
        trip_id: tripId,
        poi_id: b.poi_id,
        name: b.name,
        address: b.address,
        lng: b.lng,
        lat: b.lat,
        category: b.category,
        rating: b.rating,
        cost: b.cost,
        tel: b.tel,
        photo: b.photo,
        note: b.note,
      });
    },
  },
  {
    method: 'PATCH',
    path: '/api/pins/:id',
    handler(ctx) {
      const pin = pinOfUser(ctx, ctx.params.id);
      const b = ctx.body || {};
      let out = null;
      if (b.note !== undefined) {
        out = ctx.db.updatePinNote(pin.id, b.note).pin;
      }
      // 按天分段：把这一站挪到第 N 天
      if (b.day !== undefined) {
        out = ctx.db.updatePinDay(pin.id, b.day).pin;
      }
      return out || ctx.db.getPin(pin.id);
    },
  },
  {
    method: 'DELETE',
    path: '/api/pins/:id',
    handler(ctx) {
      const pin = pinOfUser(ctx, ctx.params.id);
      ctx.db.deletePin(pin.id);
      return { deleted: pin.id };
    },
  },
];
