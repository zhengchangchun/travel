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
function buildPayload({ trip, city, stops, base, labels, when }) {
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
    stops: list,
    base: base ? { name: base.name || '住宿', lng: Number(base.lng), lat: Number(base.lat) } : null,
    stats: { count: list.length, byCategory: byCat, hasBase: !!base },
    links,
    sketchPoints: withBase.map((p) => ({ seq: p.seq || 0, name: p.name, lng: p.lng, lat: p.lat, kind: p.kind || 'stop' })),
  };
}

function buildText(payload) {
  const p = payload;
  const day = localDay(p.generatedAt);
  const lines = [`${p.title}（${p.stats.count} 个点${p.base ? ' + 住宿' : ''}）`];
  lines.push(`生成于 ${day} · 由旅迹导出 · 链接可直接跳高德`);
  lines.push('');
  if (p.base) lines.push(`住宿：${p.base.name}（${fmt(p.base.lng, 5)}, ${fmt(p.base.lat, 5)}）\n`);
  p.stops.forEach((s) => {
    const meta = [];
    if (s.categoryLabel) meta.push(s.categoryLabel);
    if (s.rating) meta.push('★' + s.rating);
    if (s.cost) meta.push('¥' + s.cost);
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

function buildHtml(payload) {
  const p = payload;
  const day = localDay(p.generatedAt);
  const svg = sketchSvg(p.sketchPoints);
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
        `<li class="stop">` +
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
  .base { font-size:13px; color:#a86400; margin:6px 0 0; }
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
  <div class="sketch">${svg}</div>
  ${baseLine}
  <ol>${items}</ol>
  <div class="foot">${nav}</div>
  <p class="tip">点「在高德打开 / 全程路线」会唤起手机上的高德地图（电脑上是网页版）。<br/>
  图中的数字就是行程顺序；「住」是住宿锚点。这份文件是离线自包含的，直接转发就能看。</p>
</div>
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
function writePackage(dir, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const base = fileBase(payload);
  const files = [
    { kind: 'html', name: base + '.html', body: buildHtml(payload) },
    { kind: 'text', name: base + '.txt', body: buildText(payload) + '\n' },
    { kind: 'json', name: base + '.json', body: JSON.stringify(payload, null, 2) + '\n' },
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
  sketchSvg,
  markerUrl,
  navUrl,
  fileBase,
  localDay,
};
