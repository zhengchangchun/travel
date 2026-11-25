'use strict';
/*
 * 机票价格 / 「最近适合去哪」（2026-11-25）
 *
 *   GET  /api/fares            拿一批价格 + 推荐排序（有内存缓存，默认 30 分钟）
 *   GET  /api/fares?force=1    强制重抓（页面上的「刷新」按钮）
 *
 * ⚠️ 价格**只放进程内存**，不写库不写文件（用户 2026-11-25 定：
 *    「不能持久化到我这，要不然数据更新了 我们就都是错的」）。
 *    进程重启就没了，下次重新抓。
 */

const fares = require('../fares');
const rank = require('../fare-rank');

module.exports = [
  {
    method: 'GET',
    path: '/api/fares',
    async handler(ctx) {
      const force = ctx.query && (ctx.query.force === '1' || ctx.query.force === 'true');
      const windowDays = Number(ctx.query && ctx.query.windowDays) || rank.DEFAULT_WINDOW_DAYS;
      const span = Number(ctx.query && ctx.query.span) || 3;

      const r = await fares.getFares({ force });
      if (!r.ok) {
        throw new ctx.HttpError(502, 'FARE_FETCH_FAILED', r.error || '抓不到机票价格');
      }
      const ranked = rank.rankDestinations(r.data, { windowDays, span });
      return {
        origin: fares.ORIGIN,
        // 缓存口径如实告诉前端：是不是缓存、多久前抓的、是不是抓失败退回的旧数据
        cached: !!r.cached,
        stale: !!r.stale,
        ageSeconds: r.ageSeconds,
        ttlSeconds: Math.round(fares.ttlMs() / 1000),
        error: r.error || null,
        windowDays,
        span,
        // 价格是「每日最低起价」，不是可订价 —— 页面必须写清
        note: '价格是同程每日最低起价（含税），不等于你要那班的价格；点「去同程看」核对',
        destinations: ranked,
        // 抓不到的目的地（如实列出，不假装有数据）
        missing: Object.keys(r.data || {}).filter((c) => (r.data[c] || {}).error),
      };
    },
  },
];
