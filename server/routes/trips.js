const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const share = require('../share');
const routemap = require('../routemap');
const auth = require('../auth');
const { applyPoiOrder } = require('../order');
const { tripFor } = require('../trip-access');

// 行程、点位、分享包都是「我的」：一律要登录。
// 2026-11-24 起「我的」放宽成「我能碰的」—— owner 或被邀请进来的成员（一起改）。
const me = (ctx) => auth.requireUser(ctx);

// 分享页要回链到应用（「在旅迹里打开 / 一起改」）：从请求 Host 拼一个 origin。
// 只用于渲染按钮，不进 JSON 留档；拿不到 Host（离线/测试）就返回空串。
function originOf(ctx) {
  const host = ctx && ctx.req && ctx.req.headers ? ctx.req.headers.host : '';
  if (!host) return '';
  const proto = String((ctx.req.headers['x-forwarded-proto'] || '') || '').split(',')[0].trim() || 'http';
  return proto + '://' + host;
}

function tripOfUser(ctx, id) {
  const { user, trip, role } = tripFor(ctx, id);
  return { user, trip, role };
}

// 点属于某趟行程，行程得是我能碰的：别人的点当不存在
function pinOfUser(ctx, id) {
  const user = me(ctx);
  const pin = ctx.db.getPin(Number(id));
  const hit = pin ? ctx.db.getTripForMember(pin.trip_id, user.id) : null;
  if (!pin || !hit) throw new ctx.HttpError(404, 'NOT_FOUND', `点 ${id} 不存在`);
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
  const hit = ctx.db.getTripForMember(id, user.id);
  if (!hit) throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${id} 不存在`);
  const trip = hit.trip;
  const b = (ctx.body && ctx.body.base) || null;
  const base =
    b && Number.isFinite(Number(b.lng)) && Number.isFinite(Number(b.lat))
      ? { name: b.name || '住宿', lng: Number(b.lng), lat: Number(b.lat) }
      : null;
  const labels = {};
  (ctx.categories || []).forEach((c) => {
    labels[c.key] = { label: c.label };
  });
  // 同行搭子（只给名字与关系，联系方式/备注不外发）
  const buddies = ctx.db
    .tripBuddyIds(id)
    .map((bid) => ctx.db.getBuddyOfUser(bid, user.id))
    .filter(Boolean)
    .map((b) => ({ name: b.name, relation: b.relation || '' }));
  // 每个点下面的小清单（必去/记事）按点分组，跟着分享包一起走
  const itemsByPin = {};
  ctx.db.listTripItems(trip.id).forEach((it) => {
    if (!itemsByPin[it.pin_id]) itemsByPin[it.pin_id] = [];
    itemsByPin[it.pin_id].push(it);
  });
  return share.buildPayload({
    trip,
    city: trip.city,
    buddies,
    itemsByPin,
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
      // 分享页上的「在旅迹里打开 / 一起改」需要知道服务地址（离线打开文件时没有，就不出按钮）
      payload.origin = originOf(ctx);
      const out = share.writePackage(SHARE_DIR(), payload);
      const text = share.buildText(payload);
      // 记一笔到分享列表（首页/分享列表页要用）；记录失败不影响分享本身。
      // 2026-11-24：同一趟行程只留最新一条 —— 实测同一趟导出 6 次就堆 6 行一模一样的，
      // 分享列表页变成一屏重复项。旧记录对应的旧文件一并清掉（同名 base 的会被覆盖，不用管）。
      let shareRow = null;
      try {
        const user = me(ctx);
        const tripId = payload.tripId != null ? Number(payload.tripId) : Number(ctx.params.id) || null;
        const stale = tripId != null ? ctx.db.listSharesOfTrip(user.id, tripId) : [];
        shareRow = ctx.db.replaceShareOfTrip({
          tripId,
          userId: user.id,
          city: payload.city,
          title: payload.title,
          base: out.base,
          files: out.files,
          text,
          stops: payload.stops.length,
          distanceM: payload.plan && payload.plan.distanceM,
        });
        // 旧记录里那些「这次没再生成」的文件（比如换了日期后缀的旧包）删掉，别在 share/ 里越堆越多。
        // ⚠️ 老记录（认领进来的历史分享）的 files 是个对象 {imported:true,day}，不是数组 ⇒ 必须守卫
        const keep = new Set(out.files.map((f) => f.name));
        const dir = path.resolve(SHARE_DIR());
        stale.forEach((row) => {
          const oldFiles = Array.isArray(row.files) ? row.files : [];
          oldFiles.forEach((f) => {
            if (!f || !f.name || keep.has(f.name)) return;
            const full = path.resolve(dir, path.basename(f.name));
            if (path.dirname(full) !== dir) return;
            try {
              if (fs.existsSync(full)) fs.unlinkSync(full);
            } catch (err) {
              /* 删不掉就留着，记录已经换新了 */
            }
          });
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
      const mine = ctx.db.listTrips(user.id, city ? String(city).trim() : undefined);
      // 2026-11-24：别人邀请我一起改的行程也要列出来（role=editor），否则「一起改」等于看不见
      const shared = ctx.db.listTripsSharedWith(user.id).filter((t) => {
        if (!city) return true;
        return String(t.city) === String(city).trim();
      });
      const seen = new Set(mine.map((t) => Number(t.id)));
      const trips = mine.concat(shared.filter((t) => !seen.has(Number(t.id))));
      // 每趟跟谁一起（一次查完，别一趟一个查询）
      const map = ctx.db.tripBuddiesOfUser(user.id);
      return trips.map((t) => ({
        ...t,
        buddyIds: map[Number(t.id)] || [],
        // 这趟是我建的还是别人拉我一起改的（页面据此显示「一起改」标记、并禁掉删除）
        role: Number(t.user_id) === Number(user.id) ? 'owner' : 'editor',
      }));
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
      const { user, trip: owned } = tripOfUser(ctx, ctx.params.id);
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
      // 同行搭子：整组替换（页面上是多选）；不是自己的搭子直接拒，别静默丢掉
      if (b.buddyIds !== undefined) {
        if (!Array.isArray(b.buddyIds)) throw new ctx.HttpError(400, 'BAD_REQUEST', 'buddyIds 要是数组');
        const ids = [];
        b.buddyIds.forEach((raw) => {
          const bid = Number(raw);
          if (!Number.isInteger(bid) || bid <= 0) throw new ctx.HttpError(400, 'BAD_REQUEST', '搭子 id 不合法');
          if (!ctx.db.getBuddyOfUser(bid, user.id)) {
            throw new ctx.HttpError(400, 'BAD_REQUEST', `搭子 ${bid} 不在你的名单里`);
          }
          if (!ids.includes(bid)) ids.push(bid);
        });
        trip = { ...trip, buddyIds: ctx.db.setTripBuddies(id, ids) };
      }
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
      // 待规划（2026-11-24）：planned ⇄ wish —— 先收着、还没排进日程的点
      if (b.status !== undefined) {
        const next = String(b.status);
        if (next !== 'planned' && next !== 'wish') {
          throw new ctx.HttpError(400, 'BAD_REQUEST', 'status 只能是 planned 或 wish');
        }
        out = ctx.db.updatePinStatus(pin.id, next).pin;
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
