'use strict';
/*
 * 行程分享包（P13）：把一条行程渲染成「发给别人就能看」的三件套 ——
 *   ① <名字>.html  自包含单文件：自绘示意图（不依赖任何 key/网络）+ 逐点清单 + 可点的高德链接
 *   ② <名字>.txt   纯文本：直接粘到微信/短信就能看
 *   ③ <名字>.json  原始载荷：留档，将来可以再导回
 *
 * 设计约束：
 *   - 只读行程与点位，不碰任何业务数据；
 *   - 不内嵌高德 key（分享页可以发给任何人的手机，key 不能外泄）；
 *     地图链接一律用免 key 的高德 URI（uri.amap.com），点了会唤起高德 App / 网页；
 *   - 纯函数 + 一次落盘，便于单测（不联网、不起服务）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DIST = 111.32; // 每度纬度的公里数（近似的等距圆柱投影）

function escHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 分享包按本地日期落名（ISO 是 UTC，深夜生成会差一天）
function localDay(iso) {
  const d = iso ? new Date(iso) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function fmt(n, d = 6) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(d) : '';
}

// 高德 URI（免 key）：单点定位 / 两点导航
function markerUrl(stop) {
  const p = `${fmt(stop.lng)},${fmt(stop.lat)}`;
  return (
    'https://uri.amap.com/marker?position=' +
    p +
    '&name=' +
    encodeURIComponent(stop.name || '地点') +
    '&coordinate=gaode&callnative=0'
  );
}

function navUrl(from, to, mode) {
  const p1 = `${fmt(from.lng)},${fmt(from.lat)}`;
  const p2 = `${fmt(to.lng)},${fmt(to.lat)}`;
  const m = mode === 'walk' ? 'walk' : mode === 'bus' ? 'bus' : 'car';
  return (
    'https://uri.amap.com/navigation?from=' +
    p1 +
    ',' +
    encodeURIComponent(from.name || '起点') +
    '&to=' +
    p2 +
    ',' +
    encodeURIComponent(to.name || '终点') +
    '&mode=' +
    m +
    '&policy=1&coordinate=gaode&callnative=0'
  );
}

// 自绘示意图：等距圆柱投影 + 纬度余弦修正，把点铺进 box，顺序连线 + 编号
function sketchSvg(points, opts = {}) {
  const W = opts.width || 720;
  const H = opts.height || 420;
  const PAD = 46;
  const pts = points.filter((p) => Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat)));
  if (!pts.length) return '';
  const lngs = pts.map((p) => Number(p.lng));
  const lats = pts.map((p) => Number(p.lat));
  const midLat = (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180) || 1; // 经度按纬度收缩，别把东西向拉长
  const spanX = (Math.max.apply(null, lngs) - Math.min.apply(null, lngs)) * kx;
  const spanY = Math.max.apply(null, lats) - Math.min.apply(null, lats);
  const scaleX = spanX > 0 ? (W - PAD * 2) / spanX : 0;
  const scaleY = spanY > 0 ? (H - PAD * 2) / spanY : 0;
  const scale = Math.min(scaleX || scaleY, scaleY || scaleX) || 0;
  const cx = (Math.min.apply(null, lngs) + Math.max.apply(null, lngs)) / 2;
  const cy = (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2;
  const project = (p) => {
    const x = W / 2 + (Number(p.lng) - cx) * kx * scale;
    const y = H / 2 - (Number(p.lat) - cy) * scale;
    return { x: spanX || spanY ? x : W / 2, y: spanX || spanY ? y : H / 2 };
  };
  const pos = pts.map(project);
  const line = pos.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const dots = pts
    .map((p, i) => {
      const base = p.kind === 'base';
      const fill = base ? '#f0a020' : '#1677ff';
      const label = base ? '住' : String(p.seq || i + 1);
      const r = base ? 11 : 12;
      return (
        `<circle cx="${pos[i].x.toFixed(1)}" cy="${pos[i].y.toFixed(1)}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="2.5"/>` +
        `<text x="${pos[i].x.toFixed(1)}" y="${(pos[i].y + 4).toFixed(1)}" text-anchor="middle" font-size="${base ? 12 : 11}" fill="#fff" font-family="-apple-system,PingFang SC,sans-serif">${escHtml(label)}</text>`
      );
    })
    .join('');
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="行程点顺序示意图" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${W}" height="${H}" rx="14" fill="#eef3f8"/>` +
    `<path d="${line}" fill="none" stroke="#8fb8e8" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"${pts.length > 1 ? '' : ' style="display:none"'}/>` +
    dots +
    `</svg>`
  );
}

function categoryLabel(labels, key) {
  if (!key) return '';
  const hit = labels && labels[key];
  if (hit && typeof hit === 'object' && hit.label) return hit.label;
  if (typeof hit === 'string') return hit;
  return String(key);
}

// 载荷：路由从库里读出行程 + 有序点，再补上统计与链接；这里只做纯变换
function buildPayload({ trip, city, stops, base, labels, when, maps, mapErrors }) {
  const list = (stops || []).map((s, i) => ({
    seq: i + 1,
    name: s.name || '',
    address: s.address || '',
    lng: Number(s.lng),
    lat: Number(s.lat),
    category: s.category || '',
    categoryLabel: categoryLabel(labels, s.category),
    rating: s.rating || '',
    cost: s.cost || '',
    tel: s.tel || '',
    photo: s.photo || '',
    note: s.note || '',
    url: markerUrl(s),
  }));
  const withBase = list.slice();
  if (base && Number.isFinite(Number(base.lng)) && Number.isFinite(Number(base.lat))) {
    withBase.push({ seq: 0, kind: 'base', name: base.name || '住宿', lng: Number(base.lng), lat: Number(base.lat) });
  }
  const byCat = {};
  list.forEach((s) => {
    const k = s.categoryLabel || '未分类';
    byCat[k] = (byCat[k] || 0) + 1;
  });
  const title = (trip && trip.title) || `${city} · 我的行程`;
  const tripNote = trip && trip.note ? String(trip.note) : '';
  const links = {
    firstToLast: list.length > 1 ? navUrl(list[0], list[list.length - 1], 'car') : '',
    walkFirstToLast: list.length > 1 ? navUrl(list[0], list[list.length - 1], 'walk') : '',
  };
  return {
    version: 1,
    kind: 'travel-share',
    generatedAt: when || new Date().toISOString(),
    city: city || '',
    tripId: trip ? trip.id : null,
    title,
    // 整条行程的备注（「周三到，先吃饭再逛」这类）—— 每条地点的备注在 stops[].note
    tripNote,
    stops: list,
    base: base ? { name: base.name || '住宿', lng: Number(base.lng), lat: Number(base.lat) } : null,
    stats: { count: list.length, byCategory: byCat, hasBase: !!base },
    links,
    // P14：地图生成的真实路线图（驾车/步行各一张，base64 内嵌）
    maps: maps || {},
    mapErrors: mapErrors || {},
    sketchPoints: withBase.map((p) => ({ seq: p.seq || 0, name: p.name, lng: p.lng, lat: p.lat, kind: p.kind || 'stop' })),
  };
}

function buildText(payload) {
  const p = payload;
  const day = localDay(p.generatedAt);
  const lines = [`${p.title}（${p.stats.count} 个点${p.base ? ' + 住宿' : ''}）`];
  lines.push(`生成于 ${day} · 由旅迹导出 · 链接可直接跳高德`);
  if (p.tripNote) lines.push(`行程备注：${p.tripNote}`);
  const modes = Object.keys(p.maps || {}).filter((m) => p.maps[m]);
  if (modes.length) {
    lines.push('');
    modes.forEach((m) => {
      const r = p.maps[m];
      lines.push(`${r.modeLabel || m}全程：${(r.distance / 1000).toFixed(1)} km · ${fmtDuration(r.duration)}`);
    });
  }
  // 每段一行：分享出去的文案里也看得到「点和点之间怎么走」（与页面上每个点上面那条一致）
  const route = p.maps && (p.maps.plan || p.maps.driving || (modes.length ? p.maps[modes[0]] : null));
  const legOf = (i) => ((route && route.legs) || []).find((l) => Number(l.index) === i) || null;
  lines.push('');
  if (p.base) lines.push(`住宿：${p.base.name}（${fmt(p.base.lng, 5)}, ${fmt(p.base.lat, 5)}）\n`);
  p.stops.forEach((s) => {
    const meta = [];
    if (s.categoryLabel) meta.push(s.categoryLabel);
    if (s.rating) meta.push('★' + s.rating);
    if (s.cost) meta.push('¥' + s.cost);
    // 从上一站过来那一段（写在点上面，跟页面上一个读法）
    if (s.seq > 1) {
      const leg = legOf(s.seq - 2);
      if (leg && leg.ok !== false) {
        const how = leg.modeLabel ? leg.modeLabel + ' ' : '';
        lines.push(`   ↑ 从第 ${s.seq - 1} 站：${how}${(Number(leg.distance) / 1000).toFixed(1)} km · ${fmtDuration(leg.duration)}`);
      }
    }
    lines.push(`${s.seq}. ${s.name}${meta.length ? '（' + meta.join(' · ') + '）' : ''}`);
    if (s.address) lines.push(`   ${s.address}`);
    if (s.tel) lines.push(`   ☎ ${s.tel}`);
    if (s.note) lines.push(`   备注：${s.note}`);
    lines.push(`   高德：${s.url}`);
  });
  if (p.links.firstToLast) {
    lines.push('');
    lines.push(`全程路线（首 → 尾，驾车）：${p.links.firstToLast}`);
  }
  lines.push('');
  lines.push('—— 由旅迹生成，点位顺序就是我打算去的顺序 ——');
  return lines.join('\n');
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

// 图上的点位（P16）：序号团是分享页自己画的（位置由经纬度→像素算出来），既是标记也是可点区域
function pinsHtml(route) {
  const pins = (route.pins || []).filter(
    (p) => Number.isFinite(p.left) && Number.isFinite(p.top) && p.left > -1 && p.left < 101 && p.top > -1 && p.top < 101
  );
  if (!pins.length) return '';
  const last = pins.length - 1;
  return pins
    .map((p, i) => {
      const cls = i === 0 ? ' start' : i === last ? ' end' : '';
      return (
        `<button type="button" class="pin${cls}" data-seq="${Number(p.seq)}" title="${escHtml(p.name)}" ` +
        `aria-label="跳到地点卡：${escHtml(p.name)}" style="left:${p.left}%;top:${p.top}%">` +
        `<i>${Number(p.seq)}</i></button>`
      );
    })
    .join('');
}

// 分段列表：色点与地图上那段同色；点一下高亮（一次只能选一段）
// 段号的写法用「点序号」：2→3 就是地图上 ② 到 ③ 那一段
function legRowsHtml(route) {
  const legs = (route.legs || []).filter((l) => l.ok !== false);
  if (!legs.length) return '';
  const rows = legs
    .map((l) => {
      const meta = `${(Number(l.distance) / 1000).toFixed(1)} km · ${fmtDuration(l.duration)}`;
      const seq = (l.fromSeq || Number(l.index) + 1) + '→' + (l.toSeq || Number(l.index) + 2);
      // 「按我的安排」那一屏：每段自己的方式写出来（与页面上的小标一致）
      const mode = l.modeLabel ? `<span class="leg-mode">${escHtml(l.modeLabel)}</span>` : '';
      return (
        `<li class="leg" data-leg="${Number(l.index) + 1}">` +
        `<span class="leg-dot" style="background:${escHtml(l.color || '#1677ff')}"></span>` +
        `<span class="leg-no">${escHtml(seq)}</span>` +
        mode +
        `<span class="leg-path">${escHtml((l.from && l.from.name) || '起点')} → ${escHtml((l.to && l.to.name) || '终点')}</span>` +
        `<span class="leg-meta">${escHtml(meta)}</span>` +
        `</li>`
      );
    })
    .join('');
  const groups = Number(route.groupCount) || 0;
  const dup =
    groups && groups < legs.length
      ? `<div class="rnote">共 ${legs.length} 段、地图上分了 ${groups} 组颜色（每 2 段同色），对上点序号即可。</div>`
      : '';
  return `<ol class="legs">${rows}</ol>${dup}`;
}

// 分享页路线块：有真实路线图就 tab 切换（每个方式一屏：图 + 分段），没图退回自绘示意图
function routeBlockHtml(p) {
  const modes = Object.keys(p.maps || {}).filter((m) => p.maps[m] && p.maps[m].image);
  if (!modes.length) {
    return `<div class="sketch">${sketchSvg(p.sketchPoints)}</div>`;
  }
  const tabs = modes
    .map((m, i) => {
      const r = p.maps[m];
      const meta = `${(r.distance / 1000).toFixed(1)} km · ${fmtDuration(r.duration)}`;
      return (
        `<button class="tab${i === 0 ? ' on' : ''}" data-mode="${escHtml(m)}" aria-pressed="${i === 0}">` +
        `<span class="tab-label">${escHtml(r.modeLabel || m)}</span>` +
        `<span class="tab-meta">${escHtml(meta)}</span></button>`
      );
    })
    .join('');
  const panels = modes
    .map((m, i) => {
      const r = p.maps[m];
      return (
        `<div class="rpanel${i === 0 ? ' on' : ''}" data-mode="${escHtml(m)}">` +
        `<div class="mapwrap">` +
        `<img class="routemap" src="${escHtml(r.image)}" alt="${escHtml((r.modeLabel || m) + ' 路线图')}" />` +
        pinsHtml(r) +
        `</div>` +
        legRowsHtml(r) +
        `</div>`
      );
    })
    .join('');
  const failed = Object.keys(p.mapErrors || {});
  const note = failed.length
    ? `<div class="rnote">${escHtml(failed.map((m) => modeLabelOf(m) + '路线图没生成：' + p.mapErrors[m]).join('；'))}</div>`
    : '';
  return (
    `<div class="route">` +
    `<div class="tabs">${tabs}</div>` +
    `<div class="panels">${panels}</div>` +
    note +
    `<div class="rnote">路线是高德按${escHtml(
      modes.map((m) => (p.maps[m].modeLabel || m)).join(' / ')
    )}规划的真实路线（沿线道路）；图上数字是点位序号，分段列表的「2→3」就是图上 ② 到 ③ 那一段。图片已内嵌，不联网也能看。</div>` +
    `</div>`
  );
}

function modeLabelOf(m) {
  if (m === 'plan') return '按我的安排';
  return m === 'driving' ? '驾车' : m === 'riding' ? '骑行' : m === 'walking' ? '步行' : m === 'transit' ? '公交' : String(m);
}

function buildHtml(payload) {
  const p = payload;
  const day = localDay(p.generatedAt);
  const svg = routeBlockHtml(p);
  const items = p.stops
    .map((s) => {
      const meta = [];
      if (s.categoryLabel) meta.push(escHtml(s.categoryLabel));
      if (s.rating) meta.push('★' + escHtml(s.rating));
      if (s.cost) meta.push('¥' + escHtml(s.cost));
      const thumb = s.photo
        ? `<img class="thumb" src="${escHtml(s.photo)}" alt="" loading="lazy" onerror="this.remove()"/>`
        : '';
      return (
        `<li class="stop" data-seq="${s.seq}">` +
        `<div class="idx">${s.seq}</div>` +
        `<div class="body">` +
        `<div class="name">${escHtml(s.name)}</div>` +
        (meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : '') +
        (s.address ? `<div class="addr">${escHtml(s.address)}</div>` : '') +
        (s.tel ? `<div class="addr">☎ ${escHtml(s.tel)}</div>` : '') +
        (s.note ? `<div class="note">${escHtml(s.note)}</div>` : '') +
        `<div class="acts"><a href="${escHtml(s.url)}" target="_blank" rel="noreferrer">在高德打开 ↗</a></div>` +
        `</div>${thumb}` +
        `</li>`
      );
    })
    .join('');
  const baseLine = p.base
    ? `<div class="base">住：${escHtml(p.base.name)}</div>`
    : '';
  const tripNoteLine = p.tripNote
    ? `<div class="tripnote"><b>行程备注</b> ${escHtml(p.tripNote)}</div>`
    : '';
  const nav = p.links.firstToLast
    ? `<a class="btn" href="${escHtml(p.links.firstToLast)}" target="_blank" rel="noreferrer">全程驾车路线 ↗</a>` +
      (p.links.walkFirstToLast
        ? `<a class="btn ghost" href="${escHtml(p.links.walkFirstToLast)}" target="_blank" rel="noreferrer">全程步行路线 ↗</a>`
        : '')
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(p.title)}</title>
<style>
  :root { --ink:#1b1f27; --ink2:#5b6472; --ink3:#8b93a1; --line:#e6e9ef; --accent:#1677ff; --bg:#f5f6f8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:20px 16px 48px; }
  header h1 { font-size:22px; margin:0 0 6px; }
  header .sub { color:var(--ink2); font-size:13px; }
  .chips { margin:10px 0 0; display:flex; flex-wrap:wrap; gap:6px; }
  .chip { background:#fff; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; color:var(--ink2); }
  .sketch { margin:14px 0 6px; }
  .route { margin:14px 0 6px; }
  .tabs { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
  .tab { background:#fff; border:1px solid var(--line); border-radius:10px; padding:6px 12px;
         font-size:13px; color:var(--ink2); cursor:pointer; }
  .tab.on { background:var(--accent); border-color:var(--accent); color:#fff; box-shadow:0 2px 8px rgba(22,119,255,.35); }
  .tab.on .tab-meta { color:rgba(255,255,255,.85); }
  .tab .tab-label { font-weight:600; }
  .tab .tab-meta { color:var(--ink3); font-weight:400; font-size:12px; margin-left:6px; }
  .rpanel { display:none; }
  .rpanel.on { display:block; }
  .mapwrap { position:relative; }
  .routemap { display:block; width:100%; border-radius:12px; border:1px solid var(--line); }
  /* 图上的点：位置按经纬度算出来；序号团既是标记也是可点区域（按钮 44px 方便手指） */
  .pin { position:absolute; width:44px; height:44px; padding:0; transform:translate(-50%,-50%);
         border:0; background:transparent; cursor:pointer;
         display:flex; align-items:center; justify-content:center; }
  .pin i { width:26px; height:26px; border-radius:50%; border:2px solid #fff; background:#1677ff; color:#fff;
           font:600 12px/1 -apple-system,"PingFang SC",sans-serif; font-style:normal;
           display:flex; align-items:center; justify-content:center;
           box-shadow:0 1px 4px rgba(0,0,0,.35); }
  .pin.start i { background:#22aa66; }
  .pin.end i { background:#e0503a; }
  .pin:hover i, .pin:focus i { transform:scale(1.18); box-shadow:0 0 0 4px rgba(22,119,255,.35); }
  .pin:focus { outline:none; }
  .stop.hl { border-color:var(--accent); box-shadow:0 0 0 3px rgba(22,119,255,.18); }
  .legs { list-style:none; margin:10px 0 0; padding:0; }
  .leg { display:flex; align-items:center; gap:8px; padding:7px 10px; border:1px solid var(--line);
         border-radius:10px; background:#fff; margin-bottom:6px; font-size:13px; cursor:pointer; }
  .leg.on { border-color:var(--accent); background:rgba(22,119,255,.08); }
  .leg-dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .leg-no { flex:none; min-width:14px; color:var(--ink3); font-variant-numeric:tabular-nums; }
  .leg-mode { flex:none; font-size:11px; color:var(--accent); background:rgba(22,119,255,.10);
              border-radius:6px; padding:1px 5px; }
  .leg-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .leg-meta { flex:none; color:var(--ink2); font-variant-numeric:tabular-nums; }
  .leg.on .leg-meta { color:var(--accent); font-weight:600; }
  .rnote { color:var(--ink3); font-size:12px; margin-top:6px; line-height:1.6; }
  .base { font-size:13px; color:#a86400; margin:6px 0 0; }
  .tripnote { font-size:13px; color:var(--ink); background:#fffdf3; border:1px solid #f0e2b8;
              border-radius:10px; padding:8px 12px; margin:10px 0 0; line-height:1.7; }
  .tripnote b { color:#a86400; margin-right:4px; }
  ol { list-style:none; margin:14px 0 0; padding:0; }
  .stop { display:flex; gap:10px; align-items:flex-start; background:#fff; border:1px solid var(--line);
          border-radius:12px; padding:12px; margin:0 0 10px; }
  .idx { flex:none; width:26px; height:26px; border-radius:50%; background:var(--accent); color:#fff;
         font-size:13px; display:flex; align-items:center; justify-content:center; font-weight:600; }
  .body { flex:1; min-width:0; }
  .name { font-size:15px; font-weight:600; }
  .meta { color:var(--ink2); font-size:12px; margin-top:2px; }
  .addr { color:var(--ink2); font-size:12.5px; margin-top:4px; }
  .note { color:var(--ink3); font-size:12.5px; margin-top:4px; }
  .acts { margin-top:6px; }
  .acts a { color:var(--accent); font-size:12.5px; text-decoration:none; }
  .thumb { flex:none; width:76px; height:76px; border-radius:8px; object-fit:cover; background:#eceef2; }
  .foot { margin-top:18px; display:flex; flex-wrap:wrap; gap:8px; }
  .btn { display:inline-block; background:var(--accent); color:#fff; border-radius:10px;
         padding:8px 14px; font-size:13px; text-decoration:none; }
  .btn.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .tip { color:var(--ink3); font-size:12px; margin-top:16px; line-height:1.7; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escHtml(p.title)}</h1>
    <div class="sub">${p.stats.count} 个点${p.base ? ' · 含住宿' : ''} · 生成于 ${escHtml(day)} · 由旅迹导出</div>
    <div class="chips">${Object.keys(p.stats.byCategory)
      .map((k) => `<span class="chip">${escHtml(k)} × ${p.stats.byCategory[k]}</span>`)
      .join('')}</div>
  </header>
  ${tripNoteLine}
  <div class="sketch">${svg}</div>
  ${baseLine}
  <ol>${items}</ol>
  <div class="foot">${nav}</div>
  <p class="tip">点「在高德打开 / 全程路线」会唤起手机上的高德地图（电脑上是网页版）。<br/>
  图上绿点是出发点、红点是终点，其它按 1/2/3… 标序号；<b>点图上那个序号团会跳到下面那张地点卡</b>；路线按分段上色（段数多时每 2 段同色），与分段列表的色点一一对应。这份文件是离线自包含的，直接转发就能看。</p>
</div>
<script>
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.rpanel'));
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var mode = t.getAttribute('data-mode');
      tabs.forEach(function (x) {
        x.classList.toggle('on', x === t);
        x.setAttribute('aria-pressed', String(x === t));
      });
      panels.forEach(function (p) { p.classList.toggle('on', p.getAttribute('data-mode') === mode); });
    });
  });
  // 分段高亮：一次只亮一段
  Array.prototype.forEach.call(document.querySelectorAll('.rpanel'), function (panel) {
    var legs = Array.prototype.slice.call(panel.querySelectorAll('.leg'));
    legs.forEach(function (li) {
      li.addEventListener('click', function () {
        var on = !li.classList.contains('on');
        legs.forEach(function (x) { x.classList.remove('on'); });
        if (on) li.classList.add('on');
      });
    });
  });
  // 图上的点：跳到对应地点卡并高亮一下
  Array.prototype.forEach.call(document.querySelectorAll('.pin'), function (pin) {
    pin.addEventListener('click', function () {
      var seq = pin.getAttribute('data-seq');
      var card = document.querySelector('.stop[data-seq="' + seq + '"]');
      if (!card) return;
      Array.prototype.forEach.call(document.querySelectorAll('.stop.hl'), function (x) { x.classList.remove('hl'); });
      card.classList.add('hl');
      if (card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(function () { card.classList.remove('hl'); }, 2600);
    });
  });
})();
</script>
</body>
</html>
`;
}

// 文件名：城市 + 行程名 + 日期（去掉文件系统不友好字符；标题里已有城市就不重复）
function safeName(s, fallback) {
  const t = String(s || '')
    .replace(/[\\/:*?"<>|\s·]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return t || fallback;
}

function fileBase(payload) {
  const day = localDay(payload.generatedAt);
  const city = String(payload.city || '').trim();
  const title = String(payload.title || '').trim();
  const head = city && title && title.indexOf(city) < 0 ? `${city}-${title}` : title || city;
  return safeName(`${head}-${day}`, '行程') + '';
}

// 落盘：三个文件一起写；返回写出的绝对路径（目录不存在就建）
// 注意：图片（base64）只进 HTML —— 否则 JSON 会被撑到几百 KB，而且 PNG 也不适合放在 JSON 里
function payloadForJson(payload) {
  const maps = {};
  Object.keys(payload.maps || {}).forEach((m) => {
    const r = payload.maps[m] || {};
    maps[m] = Object.assign({}, r, { image: undefined });
    delete maps[m].image;
  });
  return Object.assign({}, payload, { maps });
}

function writePackage(dir, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const base = fileBase(payload);
  const files = [
    { kind: 'html', name: base + '.html', body: buildHtml(payload) },
    { kind: 'text', name: base + '.txt', body: buildText(payload) + '\n' },
    { kind: 'json', name: base + '.json', body: JSON.stringify(payloadForJson(payload), null, 2) + '\n' },
  ].map((f) => {
    const full = path.join(dir, f.name);
    fs.writeFileSync(full, f.body, 'utf8');
    return { kind: f.kind, name: f.name, path: full, bytes: Buffer.byteLength(f.body) };
  });
  return { dir, base, files };
}

module.exports = {
  buildPayload,
  buildText,
  buildHtml,
  writePackage,
  payloadForJson,
  sketchSvg,
  markerUrl,
  navUrl,
  fileBase,
  localDay,
};
