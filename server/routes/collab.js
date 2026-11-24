'use strict';
/*
 * 一起改（2026-11-24，对标圆周旅迹的多人协作）
 *
 *   POST   /api/trips/:id/invite        建一条邀请链接（owner 或成员都能建；默认 30 天）
 *   GET    /api/trips/:id/invite        看当前有没有有效邀请（给页面显示链接）
 *   DELETE /api/trips/:id/invite        撤销（旧链接立刻失效）
 *   POST   /api/invite/:token/accept    接受邀请（要登录）→ 成为 editor
 *   GET    /api/invite/:token           看这条邀请是哪趟行程（未登录也能看，用于落地页）
 *   GET    /api/trips/:id/members       成员名单
 *   DELETE /api/trips/:id/members/:uid  移除成员（只有 owner 能踢人；成员可以自己退出）
 *   GET    /api/trips/:id/comments      留言（成员/owner 都能看）
 *   POST   /api/trips/:id/comments      留言（成员/owner 都能写）
 *
 * 口径：
 *   · 邀请 token 是 24 字节随机串，库里只存它本身（不是凭证，泄露只影响这一趟）；
 *   · 接受邀请要登录 —— 没账号的人先注册，回来点同一个链接即可；
 *   · 留言 append-only（不删不改），作者名取当时的昵称，之后改名不影响历史。
 */

const crypto = require('node:crypto');
const auth = require('../auth');
const { tripFor } = require('../trip-access');

const INVITE_TTL_DAYS = 30;
const COMMENT_MAX = 500;

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function inviteView(token, trip) {
  return {
    token,
    tripId: trip ? trip.id : null,
    title: trip ? trip.title : '',
    city: trip ? trip.city : '',
    url: '/invite/' + token,
  };
}

function activeInvite(ctx, tripId) {
  // 只认「没撤销、没过期」的那条；有多条时取最新（token 表没有自增 id，用 created_at 排）
  const rows = ctx.db.listInvitesOfTrip ? ctx.db.listInvitesOfTrip(tripId) : [];
  const now = Date.now();
  return (
    rows
      .filter((r) => !r.revoked && (!r.expires_at || Date.parse(r.expires_at) > now))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null
  );
}

module.exports = [
  {
    method: 'POST',
    path: '/api/trips/:id/invite',
    handler(ctx) {
      const { user, trip } = tripFor(ctx, ctx.params.id);
      const token = newToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
      ctx.db.createInvite({ token, tripId: trip.id, createdBy: user.id, expiresAt });
      return inviteView(token, trip);
    },
  },
  {
    method: 'GET',
    path: '/api/trips/:id/invite',
    handler(ctx) {
      const { trip } = tripFor(ctx, ctx.params.id);
      const hit = activeInvite(ctx, trip.id);
      return hit ? inviteView(hit.token, trip) : { token: '', tripId: trip.id, title: trip.title, city: trip.city, url: '' };
    },
  },
  {
    method: 'DELETE',
    path: '/api/trips/:id/invite',
    handler(ctx) {
      const { trip } = tripFor(ctx, ctx.params.id);
      ctx.db.revokeInvites(trip.id);
      return { revoked: true, tripId: trip.id };
    },
  },
  {
    // 未登录也能看「这是哪趟行程」—— 落地页要能先告诉人「你被邀请一起改 XX 行程」
    method: 'GET',
    path: '/api/invite/:token',
    handler(ctx) {
      const inv = ctx.db.getInvite(ctx.params.token);
      if (!inv || inv.revoked) throw new ctx.HttpError(404, 'NOT_FOUND', '这条邀请已失效');
      if (inv.expires_at && Date.parse(inv.expires_at) <= Date.now()) {
        throw new ctx.HttpError(410, 'INVITE_EXPIRED', '这条邀请已过期');
      }
      const trip = ctx.db.getTrip(Number(inv.trip_id));
      if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', '这条邀请对应的行程已删除');
      return {
        token: inv.token,
        tripId: trip.id,
        title: trip.title,
        city: trip.city,
        expiresAt: inv.expires_at,
        // 未登录时前端据此提示「先登录/注册，回来点同一个链接」
        needLogin: !auth.currentUser(ctx.db, ctx.req),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/invite/:token/accept',
    handler(ctx) {
      const user = auth.requireUser(ctx);
      const inv = ctx.db.getInvite(ctx.params.token);
      if (!inv || inv.revoked) throw new ctx.HttpError(404, 'NOT_FOUND', '这条邀请已失效');
      if (inv.expires_at && Date.parse(inv.expires_at) <= Date.now()) {
        throw new ctx.HttpError(410, 'INVITE_EXPIRED', '这条邀请已过期');
      }
      const trip = ctx.db.getTrip(Number(inv.trip_id));
      if (!trip) throw new ctx.HttpError(404, 'NOT_FOUND', '这条邀请对应的行程已删除');
      if (Number(trip.user_id) === Number(user.id)) {
        return { tripId: trip.id, role: 'owner', already: true };
      }
      const before = ctx.db.listMembers(trip.id).some((m) => Number(m.userId) === Number(user.id));
      ctx.db.addMember(trip.id, user.id);
      return { tripId: trip.id, role: 'editor', already: before };
    },
  },
  {
    method: 'GET',
    path: '/api/trips/:id/members',
    handler(ctx) {
      const { trip } = tripFor(ctx, ctx.params.id);
      const owner = ctx.db.getUserById(Number(trip.user_id));
      const members = ctx.db.listMembers(trip.id);
      return {
        tripId: trip.id,
        owner: owner ? { userId: Number(owner.id), nickname: owner.nickname || owner.username } : null,
        members,
      };
    },
  },
  {
    method: 'DELETE',
    path: '/api/trips/:id/members/:uid',
    handler(ctx) {
      const { user, trip, role } = tripFor(ctx, ctx.params.id);
      const target = Number(ctx.params.uid);
      const isSelf = target === Number(user.id);
      if (role !== 'owner' && !isSelf) {
        throw new ctx.HttpError(403, 'FORBIDDEN', '只有建这趟的人能移除别人');
      }
      if (target === Number(trip.user_id)) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '建这趟的人不能被移除');
      }
      ctx.db.removeMember(trip.id, target);
      return { tripId: trip.id, members: ctx.db.listMembers(trip.id) };
    },
  },
  {
    method: 'GET',
    path: '/api/trips/:id/comments',
    handler(ctx) {
      const { trip } = tripFor(ctx, ctx.params.id);
      return { tripId: trip.id, comments: ctx.db.listComments(trip.id) };
    },
  },
  {
    method: 'POST',
    path: '/api/trips/:id/comments',
    handler(ctx) {
      const { user, trip } = tripFor(ctx, ctx.params.id);
      const text = String((ctx.body && ctx.body.text) || '').trim();
      if (!text) throw new ctx.HttpError(400, 'BAD_REQUEST', '留言不能为空');
      if (text.length > COMMENT_MAX) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', `留言最多 ${COMMENT_MAX} 字`);
      }
      const author = user.nickname || user.username || '同行的人';
      const id = ctx.db.addComment({ tripId: trip.id, userId: user.id, author, text });
      return { tripId: trip.id, id, comments: ctx.db.listComments(trip.id) };
    },
  },
];
