module.exports = [
  {
    method: 'GET',
    path: '/api/trips',
    handler(ctx) {
      const city = ctx.query && ctx.query.city;
      return ctx.db.listTrips(city ? String(city).trim() : undefined);
    },
  },
  {
    method: 'POST',
    path: '/api/trips',
    handler(ctx) {
      const { city, title } = ctx.body || {};
      if (!city || !String(city).trim() || !title || !String(title).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 city/title');
      }
      return ctx.db.createTrip({ city: String(city).trim(), title: String(title).trim() });
    },
  },
  {
    method: 'DELETE',
    path: '/api/trips/:id',
    handler(ctx) {
      const id = Number(ctx.params.id);
      if (!ctx.db.getTrip(id)) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${id} 不存在`);
      }
      ctx.db.deleteTrip(id);
      return { deleted: id };
    },
  },
  {
    method: 'GET',
    path: '/api/trips/:id/pins',
    handler(ctx) {
      const id = Number(ctx.params.id);
      if (!ctx.db.getTrip(id)) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${id} 不存在`);
      }
      return ctx.db.getPinsByTrip(id);
    },
  },
  {
    method: 'POST',
    path: '/api/pins',
    handler(ctx) {
      const b = ctx.body || {};
      if (b.name === undefined || b.lng === undefined || b.lat === undefined) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 name/lng/lat');
      }
      // trip_id 仍可传入（向后兼容）；省略时按 city 自动归集到「我的行程」
      let tripId;
      if (b.trip_id !== undefined && b.trip_id !== null) {
        tripId = Number(b.trip_id);
        if (!ctx.db.getTrip(tripId)) {
          throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${b.trip_id} 不存在`);
        }
      } else {
        if (!b.city || !String(b.city).trim()) {
          throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少 trip_id 时必须提供 city');
        }
        tripId = ctx.db.getOrCreateCityTrip(String(b.city).trim()).id;
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
      const id = Number(ctx.params.id);
      if (!ctx.db.getPin(id)) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `点 ${id} 不存在`);
      }
      const { note } = ctx.body || {};
      return ctx.db.updatePinNote(id, note === undefined ? null : note).pin;
    },
  },
  {
    method: 'DELETE',
    path: '/api/pins/:id',
    handler(ctx) {
      const id = Number(ctx.params.id);
      if (!ctx.db.getPin(id)) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `点 ${id} 不存在`);
      }
      ctx.db.deletePin(id);
      return { deleted: id };
    },
  },
];
