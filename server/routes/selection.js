function requireCity(ctx, city) {
  if (!city || !String(city).trim()) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 city');
  }
  return String(city).trim();
}

const auth = require('../auth');
// 选中的点属于「我的行程」：一律要登录，且只看得到自己的
const me = (ctx) => auth.requireUser(ctx);

const { parseOrderCsv } = require('../order');

// 显式点序（「按距离」时前端算出来的那份）：逗号分隔的 poi_id；给了就按它排
const parseOrder = parseOrderCsv;

// 这次操作针对哪一趟：给了 tripId 就验归属；没给就退回「该城第一趟」（没有且允许建就建）
function resolveTrip(ctx, user, rawTripId, city, createIfMissing) {
  if (rawTripId !== undefined && rawTripId !== null && String(rawTripId).trim() !== '') {
    const trip = ctx.db.getTripOfUser(Number(rawTripId), user.id);
    if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${rawTripId} 不存在`);
    return trip;
  }
  if (!city) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少 city 或 tripId');
  const found = ctx.db.getCityTrip(city, user.id);
  if (found) return found;
  return createIfMissing ? ctx.db.getOrCreateCityTrip(city, user.id) : null;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/selection',
    handler(ctx) {
      const user = me(ctx);
      const q = ctx.query || {};
      const city = String(q.city || '').trim();
      const trip = resolveTrip(ctx, user, q.tripId, city, false);
      const pins = trip ? ctx.db.getTripPinsOrdered(trip.id) : [];
      return {
        tripId: trip ? trip.id : null,
        title: trip ? trip.title : null,
        pins,
        count: pins.length,
      };
    },
  },
  {
    method: 'POST',
    path: '/api/selection',
    handler(ctx) {
      const user = me(ctx);
      const b = ctx.body || {};
      const city = String(b.city || '').trim();
      const poi = b.poi || {};
      if (
        poi.id === undefined ||
        poi.name === undefined ||
        poi.lng === undefined ||
        poi.lat === undefined
      ) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 poi.id/name/lng/lat');
      }
      const trip = resolveTrip(ctx, user, b.tripId, city, true);
      const pin = ctx.db.insertPinIntoTrip(trip.id, {
        id: String(poi.id),
        name: poi.name,
        address: poi.address,
        lng: poi.lng,
        lat: poi.lat,
        category: poi.category,
        rating: poi.rating,
        cost: poi.cost,
        tel: poi.tel,
        photo: poi.photo,
        note: poi.note,
      });
      const pins = ctx.db.getTripPinsOrdered(trip.id);
      return { tripId: trip.id, pin, count: pins.length };
    },
  },
  {
    method: 'DELETE',
    path: '/api/selection',
    handler(ctx) {
      const user = me(ctx);
      const q = ctx.query || {};
      const poiId = q.poi_id;
      if (!poiId) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 poi_id');
      }
      const trip = resolveTrip(ctx, user, q.tripId, String(q.city || '').trim(), false);
      if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', `未选中该地点 ${poiId}`);
      const { changes } = ctx.db.deletePinOfTripByPoi(trip.id, poiId);
      if (!changes) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `未选中该地点 ${poiId}`);
      }
      const pins = ctx.db.getTripPinsOrdered(trip.id);
      return { deleted: poiId, tripId: trip.id, pins, count: pins.length };
    },
  },
  {
    method: 'PUT',
    path: '/api/selection/order',
    handler(ctx) {
      const user = me(ctx);
      const b = ctx.body || {};
      if (!Array.isArray(b.poi_ids)) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', 'poi_ids 必须为数组');
      }
      const trip = resolveTrip(ctx, user, b.tripId, String(b.city || '').trim(), false);
      if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', '还没有行程可排序');
      const pins = ctx.db.reorderPinsOfTrip(trip.id, b.poi_ids.map(String));
      return { tripId: trip.id, count: pins.length, pins };
    },
  },
  {
    method: 'GET',
    path: '/api/selection/export',
    handler(ctx) {
      const user = me(ctx);
      const q = ctx.query || {};
      const trip = resolveTrip(ctx, user, q.tripId, String(q.city || '').trim(), false);
      if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', '还没有行程可导出');
      const labels = {};
      (ctx.categories || []).forEach((c) => {
        labels[c.key] = { label: c.label };
      });
      const text = ctx.db.buildTripMarkdown(trip.id, parseOrder(q.order)) + '\n';
      ctx.res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
      });
      ctx.res.end(text);
      return undefined;
    },
  },
];
