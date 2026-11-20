'use strict';
/*
 * 旅游搭子（同行的人）：一个人的小通讯录，出发前想得起来「跟谁能玩到一起」。
 *   GET    /api/buddies          我的搭子（带「一起走过 N 趟」）
 *   POST   /api/buddies          新建
 *   PATCH  /api/buddies/:id      改（只传要改的字段）
 *   DELETE /api/buddies/:id      删（顺手从各趟行程里移掉）
 *
 * 一律要登录，且只能碰自己的（别人的当不存在 ⇒ 404）。
 * 口径：name 必填、1–24 字；relation ≤ 20；contact ≤ 60；note ≤ 300；
 *      tags 最多 8 个、每个 ≤ 12 字（页面上是「早起 / 吃辣 / 会开车」这类标签）。
 */

const auth = require('../auth');

const NAME_MAX = 24;
const RELATION_MAX = 20;
const CONTACT_MAX = 60;
const NOTE_MAX = 300;
const TAG_MAX = 12;
const TAGS_MAX = 8;

function bad(ctx, msg) {
  throw new ctx.HttpError(400, 'BAD_REQUEST', msg);
}

// 字符串字段：允许缺省（undefined）；给了就 trim，超长直接拒（不偷偷截断）
function text(ctx, value, label, max) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) bad(ctx, label + '最多 ' + max + ' 个字');
  return s;
}

function tagList(ctx, raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) bad(ctx, 'tags 要是数组');
  const out = [];
  raw.forEach((t) => {
    const s = String(t == null ? '' : t).trim();
    if (!s) return;
    if (s.length > TAG_MAX) bad(ctx, '标签「' + s + '」太长（每个 ≤ ' + TAG_MAX + ' 字）');
    if (!out.includes(s)) out.push(s);
  });
  if (out.length > TAGS_MAX) bad(ctx, '标签最多 ' + TAGS_MAX + ' 个');
  return out;
}

function buddyOfUser(ctx, id) {
  const user = auth.requireUser(ctx);
  const buddy = ctx.db.getBuddyOfUser(Number(id), user.id);
  if (!buddy) throw new ctx.HttpError(404, 'NOT_FOUND', '搭子 ' + id + ' 不存在');
  return { user, buddy };
}

module.exports = [
  {
    method: 'GET',
    path: '/api/buddies',
    handler(ctx) {
      const user = auth.requireUser(ctx);
      return { buddies: ctx.db.listBuddies(user.id) };
    },
  },
  {
    method: 'POST',
    path: '/api/buddies',
    handler(ctx) {
      const user = auth.requireUser(ctx);
      const b = ctx.body || {};
      const name = String(b.name == null ? '' : b.name).trim();
      if (!name) bad(ctx, '先写个名字');
      if (name.length > NAME_MAX) bad(ctx, '名字最多 ' + NAME_MAX + ' 个字');
      const already = ctx.db.listBuddies(user.id).find((x) => x.name === name);
      if (already) bad(ctx, '已经有一个叫「' + name + '」的搭子了');
      return ctx.db.createBuddy({
        userId: user.id,
        name,
        relation: text(ctx, b.relation, '关系', RELATION_MAX),
        tags: tagList(ctx, b.tags),
        contact: text(ctx, b.contact, '联系方式', CONTACT_MAX),
        note: text(ctx, b.note, '备注', NOTE_MAX),
      });
    },
  },
  {
    method: 'PATCH',
    path: '/api/buddies/:id',
    handler(ctx) {
      const { user } = buddyOfUser(ctx, ctx.params.id);
      const b = ctx.body || {};
      const fields = {};
      if (b.name !== undefined) {
        const name = String(b.name == null ? '' : b.name).trim();
        if (!name) bad(ctx, '名字不能为空');
        if (name.length > NAME_MAX) bad(ctx, '名字最多 ' + NAME_MAX + ' 个字');
        const dup = ctx.db.listBuddies(user.id).find((x) => x.name === name && Number(x.id) !== Number(ctx.params.id));
        if (dup) bad(ctx, '已经有一个叫「' + name + '」的搭子了');
        fields.name = name;
      }
      const rel = text(ctx, b.relation, '关系', RELATION_MAX);
      if (rel !== undefined) fields.relation = rel;
      const contact = text(ctx, b.contact, '联系方式', CONTACT_MAX);
      if (contact !== undefined) fields.contact = contact;
      const note = text(ctx, b.note, '备注', NOTE_MAX);
      if (note !== undefined) fields.note = note;
      const tags = tagList(ctx, b.tags);
      if (tags !== undefined) fields.tags = tags;
      return ctx.db.updateBuddyOfUser(Number(ctx.params.id), user.id, fields);
    },
  },
  {
    method: 'DELETE',
    path: '/api/buddies/:id',
    handler(ctx) {
      const { user, buddy } = buddyOfUser(ctx, ctx.params.id);
      const res = ctx.db.deleteBuddyOfUser(buddy.id, user.id);
      return { deleted: res.deleted };
    },
  },
];
