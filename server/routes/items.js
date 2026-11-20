'use strict';
/*
 * 每个点下面的小清单：到了这个地方「必须去/要做的事」，或者随手记一句。
 *   GET    /api/trips/:id/items   这趟全部小清单（按点分组由前端做，一次拿完）
 *   POST   /api/pins/:id/items    在某个点下加一条
 *   PATCH  /api/items/:id         改文字 / 勾「去过了」
 *   DELETE /api/items/:id         删一条
 *
 * 一律要登录，且只能碰自己行程里的点（别人的当不存在 ⇒ 404）。
 * 口径：文字 1–80 字；一个点最多 30 条；整组按 sort_order 排（新加的排最后）。
 */

const auth = require('../auth');

const TEXT_MAX = 80;
const PER_PIN_MAX = 30;

function bad(ctx, msg) {
  throw new ctx.HttpError(400, 'BAD_REQUEST', msg);
}

function readText(ctx, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) bad(ctx, '写点内容再存');
  if (s.length > TEXT_MAX) bad(ctx, '一条最多 ' + TEXT_MAX + ' 个字');
  return s;
}

// 点属于自己行程里的点：不是就 404
function ownedPin(ctx, id) {
  const user = auth.requireUser(ctx);
  const pin = ctx.db.getPin(Number(id));
  const trip = pin ? ctx.db.getTripOfUser(pin.trip_id, user.id) : null;
  if (!pin || !trip) throw new ctx.HttpError(404, 'NOT_FOUND', '地点 ' + id + ' 不存在');
  return { user, pin, trip };
}

function ownedItem(ctx, id) {
  const user = auth.requireUser(ctx);
  const item = ctx.db.getItemOfUser(Number(id), user.id);
  if (!item) throw new ctx.HttpError(404, 'NOT_FOUND', '这一条 ' + id + ' 不存在');
  return { user, item };
}

module.exports = [
  {
    method: 'GET',
    path: '/api/trips/:id/items',
    handler(ctx) {
      const user = auth.requireUser(ctx);
      const trip = ctx.db.getTripOfUser(Number(ctx.params.id), user.id);
      if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', '行程 ' + ctx.params.id + ' 不存在');
      const items = ctx.db.listTripItems(trip.id);
      const byPin = {};
      items.forEach((it) => {
        const k = Number(it.pin_id);
        if (!byPin[k]) byPin[k] = [];
        byPin[k].push(it);
      });
      return { tripId: trip.id, items, byPin };
    },
  },
  {
    method: 'POST',
    path: '/api/pins/:id/items',
    handler(ctx) {
      const { user, pin } = ownedPin(ctx, ctx.params.id);
      if (ctx.db.countItemsOfPin(pin.id) >= PER_PIN_MAX) {
        bad(ctx, '这个点下面已经 ' + PER_PIN_MAX + ' 条了，先清几条');
      }
      const text = readText(ctx, (ctx.body || {}).text);
      return ctx.db.createItem({ pinId: pin.id, userId: user.id, text });
    },
  },
  {
    method: 'PATCH',
    path: '/api/items/:id',
    handler(ctx) {
      const { user, item } = ownedItem(ctx, ctx.params.id);
      const b = ctx.body || {};
      const fields = {};
      if (b.text !== undefined) fields.text = readText(ctx, b.text);
      if (b.done !== undefined) fields.done = !!b.done;
      if (!Object.keys(fields).length) bad(ctx, '没有要改的内容');
      return ctx.db.updateItemOfUser(item.id, user.id, fields);
    },
  },
  {
    method: 'DELETE',
    path: '/api/items/:id',
    handler(ctx) {
      const { user, item } = ownedItem(ctx, ctx.params.id);
      return ctx.db.deleteItemOfUser(item.id, user.id);
    },
  },
];
