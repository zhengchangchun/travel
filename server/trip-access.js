'use strict';
/*
 * 一趟行程「谁能看 / 谁能改」（2026-11-24，对标圆周旅迹的多人协作）
 *
 * 原来所有接口都写死 `getTripOfUser(id, user.id)` —— 只有建的人能碰。
 * 现在多一层成员表：owner 之外，被邀请进来的人是 editor，同样能看能改。
 * 这里只做一件事：把「按 id 取一趟我能碰的行程」收口，免得每个路由各写一遍。
 */

const auth = require('./auth');

// 取一趟「我能碰」的行程：owner 或成员；碰不到一律 404（不泄露「存在但不是你的」）
function tripFor(ctx, id) {
  const user = auth.requireUser(ctx);
  const hit = ctx.db.getTripForMember(Number(id), user.id);
  if (!hit) throw new ctx.HttpError(404, 'NOT_FOUND', `行程 ${id} 不存在`);
  return { user, trip: hit.trip, role: hit.role };
}

// 只读场景（分享页/协作页）用：给 userId 可能为 null 的情况
function tripForMaybe(ctx, id, userId) {
  if (userId == null) return null;
  return ctx.db.getTripForMember(Number(id), Number(userId));
}

module.exports = { tripFor, tripForMaybe };
