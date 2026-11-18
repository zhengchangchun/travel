function requireCity(ctx, city) {
  if (!city || !String(city).trim()) {
    throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 city');
  }
  return String(city).trim();
}

const { parseOrderCsv } = require('../order');

// 显式点序（「按距离」时前端算出来的那份）：逗号分隔的 poi_id；给了就按它排
const parseOrder = parseOrderCsv;

module.exports = [
  {
    method: 'GET',
    path: '/api/selection',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const trip = ctx.db.getCityTrip(city);
      const pins = ctx.db.getSelectionByCity(city);
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
      });
      const trip = ctx.db.getCityTrip(city);
      const pins = ctx.db.getSelectionByCity(city);
      return { tripId: trip ? trip.id : null, pin, count: pins.length };
    },
  },
  {
    method: 'DELETE',
    path: '/api/selection',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const poiId = ctx.query.poi_id;
      if (!poiId) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 poi_id');
      }
      const { changes } = ctx.db.deletePinByPoi(city, poiId);
      if (!changes) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `未选中该地点 ${poiId}`);
      }
      const pins = ctx.db.getSelectionByCity(city);
      return { deleted: poiId, count: pins.length };
    },
  },
  {
    method: 'PUT',
    path: '/api/selection/order',
    handler(ctx) {
      const b = ctx.body || {};
      const city = requireCity(ctx, b.city);
      if (!Array.isArray(b.poi_ids)) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', 'poi_ids 必须为数组');
      }
      const pins = ctx.db.reorderPins(city, b.poi_ids.map(String));
      return { count: pins.length, pins };
    },
  },
  {
    method: 'GET',
    path: '/api/selection/export',
    handler(ctx) {
      const city = requireCity(ctx, ctx.query.city);
      const labels = {};
      (ctx.categories || []).forEach((c) => {
        labels[c.key] = { label: c.label };
      });
      const text = ctx.db.buildItineraryMarkdown(city, labels, parseOrder(ctx.query.order)) + '\n';
      ctx.res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
      });
      ctx.res.end(text);
      return undefined;
    },
  },
];
