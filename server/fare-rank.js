'use strict';
/*
 * 「最近适合去哪旅游」的推荐逻辑（2026-11-25）
 *
 * 输入：同程日历抓回来的原始数据 { 城市名: { days: [{md:'11-28', price:367}, ...] } }
 * 输出：按「值不值得去」排好序的目的地列表 + 每个目的地的最佳出行窗口。
 *
 * 口径（重要，别自己发明）：
 *   1. **只比同一时间窗内的价格**。不同目的地的最低价出现在不同日期，直接比「全期最低」
 *      等于拿三亚的淡季比成都的旺季，没有意义。所以先定一个共同窗口（默认未来 30 天），
 *      在窗口内各取最低。
 *   2. **便宜 ≠ 值得去**。价格只是线索，页面必须同时给出「哪天去」和「去几天合适」，
 *      让人自己判断。所以每个目的地都带 bestDays（最便宜的连续几天）。
 *   3. **不编造**。抓不到的目的地直接不出现，不拿「暂无」占位；价格是「起价」不是可订价，
 *      页面要写清。
 *   4. 日期只有「月-日」，没有年份 —— 跨年时（12 月看 1 月）要按「下一个该月」补年份，
 *      否则 01-05 会被算成今年 1 月（过去）。
 */

const DEFAULT_WINDOW_DAYS = 30;

// '11-28' + 今天 ⇒ 'YYYY-MM-DD'。跨年：月份小于当前月 ⇒ 明年。
function toFullDate(md, today) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(md || '').trim());
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
  const base = today instanceof Date ? today : new Date();
  let year = base.getFullYear();
  // 跨年：日历里出现比当前月小的月份（12 月看到 01-05）⇒ 明年
  if (mm < base.getMonth() + 1) year += 1;
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(mm)}-${p(dd)}`;
}

function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime();
  return Math.round(ms / 86400000);
}

function todayStr(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/*
 * 在一个目的地里找「最便宜的连续 N 天」。
 * 为什么是连续：出去玩是连着走的，单看某一天最便宜没意义（前后两天贵得离谱就白搭）。
 * 返回 { start, end, days, total, avg } 或 null。
 */
function bestWindow(days, span = 3) {
  const list = (Array.isArray(days) ? days : []).filter((d) => d && d.date && Number.isFinite(d.price));
  if (list.length < span) return null;
  let best = null;
  for (let i = 0; i + span <= list.length; i += 1) {
    const slice = list.slice(i, i + span);
    // 必须是连续日期（中间断档就不算一个窗口）
    let contiguous = true;
    for (let k = 1; k < slice.length; k += 1) {
      if (daysBetween(slice[k - 1].date, slice[k].date) !== 1) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const total = slice.reduce((s, d) => s + d.price, 0);
    if (!best || total < best.total) {
      best = {
        start: slice[0].date,
        end: slice[slice.length - 1].date,
        days: span,
        total,
        avg: Math.round(total / span),
      };
    }
  }
  return best;
}

/*
 * 主函数：把原始抓取结果整理成「推荐列表」。
 *   raw: { 城市名: { days: [{md, price}], flightLow, error } }
 *   opts: { windowDays, span, now }
 */
function rankDestinations(raw, opts = {}) {
  const windowDays = Number(opts.windowDays) || DEFAULT_WINDOW_DAYS;
  const span = Number(opts.span) || 3;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const today = todayStr(now);
  const horizon = new Date(now.getTime() + windowDays * 86400000);
  const horizonStr = todayStr(horizon);

  const out = [];
  Object.keys(raw || {}).forEach((city) => {
    const item = raw[city] || {};
    if (item.error) return; // 抓失败的直接不出现
    const days = (Array.isArray(item.days) ? item.days : [])
      .map((d) => {
        const date = toFullDate(d.md, now);
        return date ? { date, md: d.md, price: Number(d.price) } : null;
      })
      .filter((d) => d && Number.isFinite(d.price) && d.price > 0)
      // 只留窗口内、且不是过去的
      .filter((d) => d.date >= today && d.date <= horizonStr)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!days.length) return;

    const cheapest = days.reduce((m, d) => (d.price < m.price ? d : m), days[0]);
    const win = bestWindow(days, span);
    const prices = days.map((d) => d.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];

    out.push({
      city,
      // 窗口内最低单日价
      low: cheapest.price,
      lowDate: cheapest.date,
      // 最便宜的连续 N 天（这才是「什么时候去」的答案）
      best: win,
      // 中位价：用来判断「这个低价是不是异常便宜」
      median,
      // 比中位价便宜多少（%）：越大越值得挑这个日子
      savingPct: median > 0 ? Math.round(((median - cheapest.price) / median) * 100) : 0,
      days: days.length,
      // 当天航班最低（同程列表里的「¥xxx起」），可能为 null
      flightLow: Number.isFinite(item.flightLow) ? item.flightLow : null,
    });
  });

  // 排序：先按「连续 N 天的均价」升序（这才是真出行成本），没有窗口的排后面
  out.sort((a, b) => {
    const av = a.best ? a.best.avg : a.low;
    const bv = b.best ? b.best.avg : b.low;
    return av - bv;
  });
  return out;
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  toFullDate,
  todayStr,
  daysBetween,
  bestWindow,
  rankDestinations,
};
