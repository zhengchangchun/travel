'use strict';
/*
 * 账号与会话（真登录：账号 + 密码）
 *
 * 零依赖口径（与全仓一致：只用 node 内置模块）：
 *   - 口令哈希用它自己：crypto.scryptSync + 每用户 16 字节随机盐，存 hex；
 *     校验走 timingSafeEqual，长度不一致直接 false。
 *   - 会话 = 32 字节随机 token（base64url）放 HttpOnly Cookie，库里只存 token 的 sha256。
 *     这样即使库被读走，也拿不到能直接用的会话串。
 *
 * 只做三件事：口令校验、开会话/查会话、读写 Cookie 头。HTTP 语义（状态码/错误码）留在路由里。
 */

const crypto = require('node:crypto');

const COOKIE_NAME = 'travel_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto
    .scryptSync(String(password), String(salt), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString('hex');
}

function verifyPassword(password, salt, hash) {
  const want = Buffer.from(String(hash || ''), 'hex');
  if (!want.length) return false;
  const got = Buffer.from(hashPassword(password, salt), 'hex');
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// 账号：3–32 位，字母数字与 _ - . @（不许空格与中文，免得和昵称混）
function usernameProblem(username) {
  const u = String(username == null ? '' : username).trim();
  if (!u) return '请填账号';
  if (u.length < 3 || u.length > 32) return '账号要 3–32 位';
  if (!/^[A-Za-z0-9_.@-]+$/.test(u)) return '账号只能用字母、数字和 _ - . @';
  return null;
}

// 口令：至少 8 位（本地自用，不做复杂度门禁，只拦太短）
function passwordProblem(password) {
  const p = String(password == null ? '' : password);
  if (!p) return '请填密码';
  if (p.length < 8) return '密码至少 8 位';
  if (p.length > 128) return '密码太长（≤128 位）';
  return null;
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (!k) return;
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function cookieHeader(token, maxAgeSec) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Number(maxAgeSec) || SESSION_DAYS * 86400}`,
  ].join('; ');
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    nickname: row.nickname || row.username,
    avatar: row.avatar || '',
    defaultCity: row.default_city || '',
    defaultMode: row.default_mode || '',
    createdAt: row.created_at || null,
  };
}

function issueSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.createSession({ tokenHash: tokenHash(token), userId, expiresAt: expires });
  return { token, expiresAt: expires, maxAgeSec: SESSION_DAYS * 86400 };
}

// 从请求里认出当前用户（没登录就是 null；不抛错——个人设置页要能显示「未登录」）
function currentUser(db, req) {
  const cookies = parseCookies(req && req.headers ? req.headers.cookie : '');
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = db.getSession(tokenHash(token));
  if (!session) return null;
  const user = db.getUserById(session.user_id);
  return user || null;
}

// 供路由用：没登录就 401（HttpError 由 index.js 注到 ctx 上）
// ctx.fallbackUser 只给已有的老测试用（createApp({ authFallbackUser: true })），生产不会设
function requireUser(ctx) {
  const row = currentUser(ctx.db, ctx.req);
  if (row) return row;
  if (ctx.fallbackUser) return ctx.fallbackUser;
  throw new ctx.HttpError(401, 'AUTH_REQUIRED', '先登录');
}

function register(db, { username, password, nickname }) {
  const user = String(username == null ? '' : username).trim();
  const up = usernameProblem(user);
  if (up) return { error: up };
  const pp = passwordProblem(password);
  if (pp) return { error: pp };
  if (db.getUserByName(user)) return { error: '这个账号已经注册过了' };
  const salt = newSalt();
  const row = db.createUser({
    username: user,
    passwordHash: hashPassword(password, salt),
    salt,
    nickname: String(nickname == null ? '' : nickname).trim() || user,
  });
  return { user: row };
}

function login(db, { username, password }) {
  const row = db.getUserByName(String(username == null ? '' : username).trim());
  // 账号不存在与口令错给同一句文案（别帮人枚举账号）
  const bad = { error: '账号或密码不对' };
  if (!row) return bad;
  if (!verifyPassword(password, row.salt, row.password_hash)) return bad;
  return { user: row };
}

module.exports = {
  COOKIE_NAME,
  SESSION_DAYS,
  newSalt,
  hashPassword,
  verifyPassword,
  tokenHash,
  usernameProblem,
  passwordProblem,
  parseCookies,
  cookieHeader,
  clearCookieHeader,
  publicUser,
  issueSession,
  currentUser,
  requireUser,
  register,
  login,
};
