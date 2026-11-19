'use strict';
/*
 * 账号路由（真登录：账号 + 密码）
 *   POST   /api/auth/register  注册并直接登录（下发会话 Cookie）
 *   POST   /api/auth/login     登录
 *   POST   /api/auth/logout    退出（清 Cookie + 删会话）
 *   GET    /api/auth/me        当前登录状态（未登录返回 user:null，不报 401）
 *   PATCH  /api/auth/me        改昵称/头像/默认城市/默认出行方式
 */

const auth = require('../auth');

function setSessionCookie(ctx, token, maxAgeSec) {
  ctx.res.setHeader('Set-Cookie', auth.cookieHeader(token, maxAgeSec));
}

function cleanAvatar(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.length > 300) return s.slice(0, 300);
  // 只收 http(s) 链接或 data:image（头像就先这样，不做上传）
  if (!/^(https?:\/\/|data:image\/)/i.test(s)) return '';
  return s;
}

module.exports = [
  {
    method: 'POST',
    path: '/api/auth/register',
    handler(ctx) {
      const b = ctx.body || {};
      const out = auth.register(ctx.db, {
        username: b.username,
        password: b.password,
        nickname: b.nickname,
      });
      if (out.error) throw new ctx.HttpError(400, 'AUTH_INVALID', out.error);
      const session = auth.issueSession(ctx.db, out.user.id);
      setSessionCookie(ctx, session.token, session.maxAgeSec);
      return { user: auth.publicUser(out.user), expiresAt: session.expiresAt };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    handler(ctx) {
      const b = ctx.body || {};
      const out = auth.login(ctx.db, { username: b.username, password: b.password });
      if (out.error) throw new ctx.HttpError(401, 'AUTH_FAILED', out.error);
      const session = auth.issueSession(ctx.db, out.user.id);
      setSessionCookie(ctx, session.token, session.maxAgeSec);
      return { user: auth.publicUser(out.user), expiresAt: session.expiresAt };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    handler(ctx) {
      const cookies = auth.parseCookies(ctx.req.headers.cookie);
      const token = cookies[auth.COOKIE_NAME];
      if (token) ctx.db.deleteSession(auth.tokenHash(token));
      ctx.res.setHeader('Set-Cookie', auth.clearCookieHeader());
      return { loggedOut: true };
    },
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    handler(ctx) {
      const row = auth.currentUser(ctx.db, ctx.req);
      return { user: auth.publicUser(row) };
    },
  },
  {
    method: 'PATCH',
    path: '/api/auth/me',
    handler(ctx) {
      const row = auth.currentUser(ctx.db, ctx.req);
      if (!row) throw new ctx.HttpError(401, 'AUTH_REQUIRED', '先登录再改个人设置');
      const b = ctx.body || {};
      const fields = {};
      if (b.nickname !== undefined) {
        const nick = String(b.nickname == null ? '' : b.nickname).trim();
        if (nick.length > 24) throw new ctx.HttpError(400, 'AUTH_INVALID', '昵称最多 24 个字');
        fields.nickname = nick || row.username;
      }
      if (b.avatar !== undefined) fields.avatar = cleanAvatar(b.avatar);
      if (b.defaultCity !== undefined) {
        fields.defaultCity = String(b.defaultCity == null ? '' : b.defaultCity).trim().slice(0, 24);
      }
      if (b.defaultMode !== undefined) {
        const mode = String(b.defaultMode == null ? '' : b.defaultMode).trim();
        if (mode && !['auto', 'driving', 'riding', 'walking', 'transit'].includes(mode)) {
          throw new ctx.HttpError(400, 'AUTH_INVALID', '默认出行方式只能是 最快/驾车/骑行/步行/公交');
        }
        fields.defaultMode = mode;
      }
      const updated = ctx.db.updateUser(row.id, fields);
      return { user: auth.publicUser(updated) };
    },
  },
];
