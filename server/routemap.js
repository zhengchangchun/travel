'use strict';
/*
 * 行程路线图（P14）：把行程的一串点变成「地图生成的真实路线」——
 *   ① 逐段调高德路径规划（驾车 / 步行），拿到沿道路的真实折线 + 里程/耗时；
 *   ② 用高德静态地图把这条折线画在地图底图上，markers 标出点位序号；
 *   ③ 图片以 base64 内嵌进分享页 —— 分享页里没有 key，但看到的是真地图真路线。
 *
 * 只支持 key 打得通的两种方式：driving / walking。
 * 骑行（bicycling）对个人 key 是 SERVICE_NOT_AVAILABLE，公交（transit）是 INSUFFICIENT_PRIVILEGES，
 * 都不是我们这边能启用的 ⇒ 不假装支持。
 *
 * 约束（踩过的）：
 *   - 静态地图的 paths 必须写满 5 个字段（线宽,线色,线透明度,填充色,填充透明度），少一个就 20003；
 *   - 静态地图与路径规划都有 QPS 上限，连续打太快会 10021 ⇒ 一律串行 + 间隔；
 *   - 静态地图只走 GET，URL 不能太长 ⇒ 折线按等距抽稀到 ≤ MAX_PATH_POINTS 个点。
 */

const MODE_LABEL = { driving: '驾车', walking: '步行' };
const SUPPORTED_MODES = ['driving', 'walking'];
const MAX_PATH_POINTS = 200; // 单条 paths 的抽稀上限（实测 200 点 ≈ 4.5KB URL）
// 高德静态地图最多只吃 **4 条 paths**（第 5 条一律 20003 UNKNOWN_ERROR，实测）⇒ 段数超过就并组
const MAX_PATHS = 4;
const LABELS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 静态地图 marker 标签只支持单个字符

// 分段配色（列表里的色点与地图上的那一段同色 ⇒ 一眼能对上是哪段）
const LEG_PALETTE = ['#1677ff', '#22aa66', '#ff8c42', '#8a6cf0', '#0bb8c4', '#d65a1e', '#e0503a', '#9c6ade'];

function legColor(i) {
  return LEG_PALETTE[Number(i) % LEG_PALETTE.length];
}

function amapColor(hex) {
  return '0x' + String(hex || '#1677ff').replace('#', '').toLowerCase();
}

function modeLabel(mode) {
  return MODE_LABEL[mode] || String(mode);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Douglas-Peucker 抽稀：比等距抽稀保形得多（转弯不会被抹平）
function simplifyPoints(points, tol = 1e-4) {
  const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length <= 4) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstAt = -1;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = pts[i];
      let dist;
      if (len2 === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (dist > worst) {
        worst = dist;
        worstAt = i;
      }
    }
    if (worst > tol && worstAt > 0) {
      keep[worstAt] = true;
      stack.push([a, worstAt], [worstAt, b]);
    }
  }
  const out = pts.filter((p, i) => keep[i]);
  return out.length >= 2 ? out : [pts[0], pts[pts.length - 1]];
}

// 等距抽稀：保留首尾与整体形状（在 DP 之后当兜底用）
function thinPoints(points, target = MAX_PATH_POINTS) {
  const list = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (list.length <= target) return list.slice();
  const step = (list.length - 1) / (target - 1);
  const out = [];
  for (let i = 0; i < target; i += 1) out.push(list[Math.round(i * step)]);
  return out;
}

function fmtCoord(v) {
  return Number(v).toFixed(5);
}

// 静态地图 paths：线宽,线色,线透明度,填充色,填充透明度:lng,lat;lng,lat...
function buildPathsParam(points, opts = {}) {
  const weight = opts.weight || 6;
  const color = opts.color || '0x1677ff';
  const fill = opts.fill || '0x9ecbff';
  const pts = thinPoints(points, opts.maxPoints || MAX_PATH_POINTS);
  if (pts.length < 2) return '';
  const line = pts.map((p) => `${fmtCoord(p[0])},${fmtCoord(p[1])}`).join(';');
  return `${weight},${color},1,${fill},0.45:${line}`;
}

// 分段画：paths 之间用 | 分隔，各自颜色；最多 MAX_PATHS 条 ⇒ 段多了先并组
function buildPathsParamForGroups(groups, opts = {}) {
  const cap = opts.maxPointsPerGroup || 120;
  return (groups || [])
    .filter((g) => g && Array.isArray(g.points) && g.points.length >= 2)
    .slice(0, MAX_PATHS)
    .map((g) => {
      const color = amapColor(g.color);
      const line = thinPoints(simplifyPoints(g.points, opts.tol || 1e-4), cap)
        .map((p) => `${fmtCoord(p[0])},${fmtCoord(p[1])}`)
        .join(';');
      return `${opts.weight || 6},${color},1,${color},0.25:${line}`;
    })
    .join('|');
}

// 把成功规划的段并成 ≤4 组（每组一个颜色），并回写给每一段（列表色点与地图同色）
function groupLegs(legs, maxGroups = MAX_PATHS) {
  const ok = (legs || []).filter((l) => l && l.ok !== false);
  if (!ok.length) return [];
  const groupCount = Math.max(1, Math.min(maxGroups, ok.length));
  const per = Math.ceil(ok.length / groupCount);
  const groups = [];
  for (let i = 0; i < ok.length; i += per) {
    const slice = ok.slice(i, i + per);
    const points = [];
    slice.forEach((l) => {
      (l.polyline || []).forEach((p) => {
        const last = points[points.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) return;
        points.push(p);
      });
    });
    const color = legColor(groups.length);
    groups.push({ color, legs: slice.map((l) => l.index), points });
    slice.forEach((l) => {
      l.color = color;
      l.groupColor = color;
    });
  }
  return groups;
}

// markers：起点绿 / 终点红 / 中间点蓝，标签用 1..9 再 A..Z
function buildMarkersParam(stops) {
  const list = (stops || []).filter((s) => Number.isFinite(Number(s.lng)) && Number.isFinite(Number(s.lat)));
  if (!list.length) return '';
  const last = list.length - 1;
  return list
    .map((s, i) => {
      const color = i === 0 ? '0x22aa66' : i === last ? '0xe0503a' : '0x1677ff';
      const label = LABELS[i] || String((i + 1) % 10);
      return `mid,${color},${label}:${fmtCoord(s.lng)},${fmtCoord(s.lat)}`;
    })
    .join('|');
}

// 静态地图尺寸：760×430（scale=1）在手机上就是 2 倍像素（390 CSS × DPR2）⇒ 够清且不臃肿
// 实测：scale=2 的 700×400 每张 226KB，base64 后两张就要 600KB 页面；scale=1 每张 ~80KB
function staticMapParams({ stops, points, groups, size = '760*430', scale = 1, zoom }) {
  const params = { size, scale, markers: buildMarkersParam(stops) };
  const paths = groups && groups.length ? buildPathsParamForGroups(groups) : buildPathsParam(points);
  if (paths) params.paths = paths;
  if (zoom) params.zoom = String(zoom);
  return params;
}

// 逐段规划（与 /api/itinerary/route 同一套口径：串行 + 间隔 + 缓存），拼成一条完整折线
async function routeForStops({ amap, cache, intervalMs = 300, mode, stops, city }) {
  const list = (stops || []).filter((s) => Number.isFinite(Number(s.lng)) && Number.isFinite(Number(s.lat)));
  if (list.length < 2) throw new Error('点数不足 2，无法规划路线');
  const legs = [];
  const failed = [];
  let distance = 0;
  let duration = 0;
  const points = [];

  for (let i = 0; i < list.length - 1; i += 1) {
    if (i > 0 && intervalMs > 0) await sleep(intervalMs);
    const a = list[i];
    const b = list[i + 1];
    const origin = `${a.lng},${a.lat}`;
    const destination = `${b.lng},${b.lat}`;
    const key = `route:${mode}:${origin}:${destination}`;
    let data = cache && cache.get ? cache.get(key) : undefined;
    try {
      if (data === undefined) {
        if (mode === 'walking') data = await amap.planWalking(origin, destination);
        else data = await amap.planDriving(origin, destination);
        if (cache && cache.set) cache.set(key, data);
      }
      const poly = Array.isArray(data.polyline) ? data.polyline : [];
      poly.forEach((p) => {
        const last = points[points.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) return;
        points.push(p);
      });
      distance += Number(data.distance) || 0;
      duration += Number(data.duration) || 0;
      legs.push({
        index: i,
        from: { name: a.name, lng: Number(a.lng), lat: Number(a.lat) },
        to: { name: b.name, lng: Number(b.lng), lat: Number(b.lat) },
        distance: Number(data.distance) || 0,
        duration: Number(data.duration) || 0,
        color: legColor(i),
        polyline: poly,
        ok: true,
      });
    } catch (err) {
      const reason = (err && err.message) || '规划失败';
      failed.push({ index: i, reason });
      legs.push({
        index: i,
        from: { name: a.name, lng: Number(a.lng), lat: Number(a.lat) },
        to: { name: b.name, lng: Number(b.lng), lat: Number(b.lat) },
        distance: 0,
        duration: 0,
        color: legColor(i),
        polyline: [],
        ok: false,
        reason,
      });
    }
  }

  if (!legs.some((l) => l.ok)) throw new Error('所有路段均规划失败：' + (failed[0] ? failed[0].reason : '未知原因'));
  const groups = groupLegs(legs);
  return { mode, modeLabel: modeLabel(mode), distance, duration, legs, groups, failed, points };
}

// 路线 → 静态地图 PNG（Buffer）。失败就往抛（由调用方决定降级）
async function mapForRoute({ amap, stops, points, groups, size, scale, zoom, sleepMs = 0 }) {
  const params = staticMapParams({ stops, points, groups, size, scale, zoom });
  if (sleepMs > 0) await sleep(sleepMs); // 与上一张错开，避开静态地图 QPS
  const { buffer, contentType } = await amap.staticMap(params);
  return { buffer, contentType, params };
}

// 生成一整套：{ maps: {mode: {...}}, errors: {mode: msg} }
async function buildShareMaps({ amap, cache, intervalMs, stops, modes, size, scale, mapGapMs = 1200 }) {
  const maps = {};
  const errors = {};
  const wanted = (modes && modes.length ? modes : SUPPORTED_MODES).filter((m) => SUPPORTED_MODES.includes(m));
  let first = true;
  for (const mode of wanted) {
    try {
      const route = await routeForStops({ amap, cache, intervalMs, mode, stops });
      const map = await mapForRoute({
        amap,
        stops,
        points: route.points,
        groups: route.groups,
        size,
        scale,
        sleepMs: first ? 0 : mapGapMs,
      });
      maps[mode] = {
        mode,
        modeLabel: modeLabel(mode),
        distance: route.distance,
        duration: route.duration,
        legs: route.legs.map((l) => ({
          index: l.index,
          from: l.from,
          to: l.to,
          fromSeq: l.index + 1,
          toSeq: l.index + 2,
          distance: l.distance,
          duration: l.duration,
          color: l.color,
          ok: l.ok,
          reason: l.reason,
        })),
        groupCount: (route.groups || []).length,
        failedLegs: route.failed,
        points: route.points.length,
        image: `data:${map.contentType};base64,${map.buffer.toString('base64')}`,
        imageBytes: map.buffer.length,
      };
    } catch (err) {
      errors[mode] = (err && err.message) || '路线图生成失败';
    }
    first = false;
  }
  return { maps, errors };
}

module.exports = {
  SUPPORTED_MODES,
  MODE_LABEL,
  MAX_PATH_POINTS,
  MAX_PATHS,
  LEG_PALETTE,
  legColor,
  amapColor,
  modeLabel,
  thinPoints,
  simplifyPoints,
  buildPathsParam,
  buildPathsParamForGroups,
  groupLegs,
  buildMarkersParam,
  staticMapParams,
  routeForStops,
  mapForRoute,
  buildShareMaps,
};
