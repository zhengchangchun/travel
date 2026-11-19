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

module.exports = [
  {
    method: 'GET',
    path: '/api/selection',
    handler(ctx) {
      const user = me(ctx);
      const city = requireCity(ctx, ctx.query.city);
      const trip = ctx.db.getCityTrip(city, user.id);
      const pins = ctx.db.getSelectionByCity(city, user.id);
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
      const city = requireCity(ctx, b.city);
      const poi = b.poi || {};
      if (
        poi.id === undefined ||
        poi.name === undefined ||
        poi.lng === undefined ||
        poi.lat === undefined
      ) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 poi.id/name/lng/lat');
      }
      const pin = ctx.db.insertPinIfAbsent(city, {
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
      }, user.id);
      const trip = ctx.db.getCityTrip(city, user.id);
      const pins = ctx.db.getSelectionByCity(city, user.id);
      return { tripId: trip ? trip.id : null, pin, count: pins.length };
    },
  },
  {
    method: 'DELETE',
    path: '/api/selection',
    handler(ctx) {
      const user = me(ctx);
      const city = requireCity(ctx, ctx.query.city);
      const poiId = ctx.query.poi_id;
      if (!poiId) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 poi_id');
      }
      const { changes } = ctx.db.deletePinByPoi(city, poiId, user.id);
      if (!changes) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `未选中该地点 ${poiId}`);
      }
      const pins = ctx.db.getSelectionByCity(city, user.id);
      return { deleted: poiId, count: pins.length };
    },
  },
  {
    method: 'PUT',
    path: '/api/selection/order',
    handler(ctx) {
      const user = me(ctx);
      const b = ctx.body || {};
      const city = requireCity(ctx, b.city);
      if (!Array.isArray(b.poi_ids)) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', 'poi_ids 必须为数组');
      }
      const pins = ctx.db.reorderPins(city, b.poi_ids.map(String), user.id);
      return { count: pins.length, pins };
    },
  },
  {
    method: 'GET',
    path: '/api/selection/export',
    handler(ctx) {
      const user = me(ctx);
      const city = requireCity(ctx, ctx.query.city);
      const labels = {};
      (ctx.categories || []).forEach((c) => {
        labels[c.key] = { label: c.label };
      });
      const text = ctx.db.buildItineraryMarkdown(city, labels, parseOrder(ctx.query.order), user.id) + '\n';
      ctx.res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
      });
      ctx.res.end(text);
      return undefined;
    },
  },
];
