'use strict';
/*
 * 营业时间解析 + 时段冲突判定（2026-11-25）
 *
 * 为什么单独一个纯函数模块：高德返回的营业时间是一段**自由文本**，形态极不统一 ——
 *   「07:30-18:00」
 *   「10:30-14:00 16:30-20:30」                      （午休两段）
 *   「24小时营业」
 *   「周一至周日 00:00-24:00」
 *   「周二至周日 09:00-17:00开放 最晚进入16:30； 周一 全天不开放(遇法定节假日正常开放…)；清明节…」
 * 直接拿来做判断必然出错，所以先抽成「时间区间数组」，再和时段窗口求交。
 *
 * 口径（重要）：
 *   - 只判**一天之内的时间重叠**，不判星期几 —— 行程里没有具体日期（`trips` 表没有出发日），
 *     拿不到「这天是周几」就不该假装能判。周一闭馆这类信息单独作为 `closedWeekdays` 提示出来，
 *     由人自己看，不参与冲突判定。
 *   - 解析不出任何区间、也没有「24小时」⇒ 返回 `unknown`，**不报警**（宁可不提示，也不能瞎提示）。
 */

// 时段窗口（分钟，从 0 点算）。四段首尾相接、不重叠，避免同一时刻被判进两个时段。
const SLOT_WINDOWS = {
  morning: { start: 8 * 60, end: 12 * 60, label: '上午' },
  afternoon: { start: 12 * 60, end: 17 * 60, label: '下午' },
  evening: { start: 17 * 60, end: 20 * 60, label: '傍晚' },
  night: { start: 20 * 60, end: 24 * 60, label: '晚上' },
};

const SLOT_KEYS = Object.keys(SLOT_WINDOWS);

// 「HH:MM-HH:MM」；分隔符可能是 - – — ~ 至
const RANGE_RE = /(\d{1,2}):(\d{2})\s*[-–—~～至]\s*(\d{1,2}):(\d{2})/g;

// 「24小时营业」「全天营业」「00:00-24:00」都算全天
const ALL_DAY_RE = /24\s*小时|全天营业|全天开放/;

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function toMinutes(h, m) {
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

// 从一段自由文本里抽出所有时间区间（分钟）。跨零点的（22:00-02:00）拆成两段。
// 同时把「原始写法」记在 raw 上 —— 文案要用原文，不能拿拆开后的边界拼（会拼成 00:00–24:00）。
function parseRanges(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  RANGE_RE.lastIndex = 0;
  let m = RANGE_RE.exec(s);
  while (m) {
    const start = toMinutes(m[1], m[2]);
    const end = toMinutes(m[3], m[4]);
    if (start !== null && end !== null) {
      const raw = m[1].padStart(2, '0') + ':' + m[2] + '–' + m[3].padStart(2, '0') + ':' + m[4];
      if (end > start) {
        out.push({ start, end, raw });
      } else if (end < start) {
        // 跨零点：22:00-02:00 ⇒ [22:00,24:00] + [00:00,02:00]，两段共用同一个 raw
        out.push({ start, end: 24 * 60, raw });
        out.push({ start: 0, end, raw });
      }
      // end === start 视为无效（0 长度），丢掉
    }
    m = RANGE_RE.exec(s);
  }
  // 去重 + 按开始时间排（同一段可能被重复匹配到）
  const seen = new Set();
  return out
    .filter((r) => {
      const k = r.start + '-' + r.end;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.start - b.start);
}

// 文本里提到「周一…不开放 / 闭馆」的星期几（1=周一 … 7=周日）
function parseClosedWeekdays(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  WEEKDAY_NAMES.forEach((name, i) => {
    // 同一句里既有这个星期几、又有「不开放/闭馆/休息」才算
    const re = new RegExp(name + '[^；;。]{0,24}(不开放|闭馆|休息|停业)');
    if (re.test(s)) out.push(i + 1);
  });
  return out;
}

function isAllDay(text) {
  const s = String(text == null ? '' : text);
  if (ALL_DAY_RE.test(s)) return true;
  const ranges = parseRanges(s);
  return ranges.some((r) => r.start === 0 && r.end >= 24 * 60);
}

function overlaps(a, b) {
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/*
 * 判一个时段能不能去。
 * 返回：
 *   { status: 'ok' | 'conflict' | 'unknown', reason, ranges, allDay }
 *   - ok：这个时段与营业时间有重叠
 *   - conflict：完全没重叠（reason 里说清「几点关门」）
 *   - unknown：解析不出营业时间 ⇒ 不提示
 */
function checkSlot(slot, hoursText) {
  const key = String(slot || '');
  const win = SLOT_WINDOWS[key];
  if (!win) return { status: 'unknown', reason: '', ranges: [], allDay: false };
  const text = String(hoursText == null ? '' : hoursText);
  if (!text.trim()) return { status: 'unknown', reason: '', ranges: [], allDay: false };
  const allDay = isAllDay(text);
  const ranges = parseRanges(text);
  if (allDay) {
    return { status: 'ok', reason: '', ranges, allDay: true };
  }
  if (!ranges.length) {
    return { status: 'unknown', reason: '', ranges: [], allDay: false };
  }
  const hit = ranges.some((r) => overlaps(r, win));
  if (hit) return { status: 'ok', reason: '', ranges, allDay: false };
  // 没重叠：说清「这个时段关门」+ 它到底几点开。
  // 文案用**原文**（raw），不能拿拆开后的边界拼 —— 跨零点会被拼成 00:00–24:00。
  const raws = [];
  ranges.forEach((r) => {
    if (r.raw && !raws.includes(r.raw)) raws.push(r.raw);
  });
  const span = raws.length ? raws.join('、') : fmtMinutes(ranges[0].start) + '–' + fmtMinutes(ranges[ranges.length - 1].end);
  return {
    status: 'conflict',
    reason: win.label + '不开门（营业 ' + span + '）',
    ranges,
    allDay: false,
  };
}

// 一次算四个时段（服务端返回给前端用，省得前端再解析一遍）
function slotVerdicts(hoursText) {
  const out = {};
  SLOT_KEYS.forEach((k) => {
    const r = checkSlot(k, hoursText);
    out[k] = { status: r.status, reason: r.reason };
  });
  return out;
}

module.exports = {
  SLOT_WINDOWS,
  SLOT_KEYS,
  parseRanges,
  parseClosedWeekdays,
  isAllDay,
  checkSlot,
  slotVerdicts,
  fmtMinutes,
};
