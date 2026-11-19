'use strict';
/*
 * 旧数据认领（账号上线之前的行程 / 分享没有归属，user_id 是 NULL）
 *   GET  /api/legacy/pending  还有多少条没归属（我的行程页用来提示）
 *   POST /api/legacy/claim    把没归属的归给当前账号（幂等：认领完就没有了）
 *
 * 单机场景：这台机器上的旧数据本来就是他自己的，所以允许登录后一键认领。
 */

const auth = require('../auth');

module.exports = [
  {
    method: 'GET',
    path: '/api/legacy/pending',
    handler(ctx) {
      auth.requireUser(ctx);
      return ctx.db.countUnowned();
    },
  },
  {
    method: 'POST',
    path: '/api/legacy/claim',
    handler(ctx) {
      const user = auth.requireUser(ctx);
      const claimed = ctx.db.claimUnowned(user.id);
      return { ...claimed, claimedTo: user.username };
    },
  },
];
