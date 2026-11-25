'use strict';
/*
 * 导出到导航（2026-11-25，P0-3）：把一趟行程写成 GPX / KML 两种通用地理文件。
 *
 * 为什么是这两种：
 *   · GPX 1.1 —— 苹果地图（Mac 双击直接导入「指南」）、两步路、六只脚、Garmin、OruxMaps 都认；
 *   · KML 2.2 —— Google Earth / Google 我的地图、奥维互动地图认。
 *   ⚠️ 高德地图**没有**公开的 KML/GPX 导入入口（它的「路书」只能站内建），所以高德那条腿
 *      仍然走免 key 的 uri.amap.com 链接（分享页/信息卡上已有），这里不假装能导进去。
 *
 * 设计约束：
 *   - 纯函数（不联网、不读库），便于单测；
 *   - 只写点位与顺序，不写任何 key / 账号信息；
 *   - 按天分段：多天时 KML 用 Folder 分组、GPX 用多个 trk（名字带「第 N 天」）；
 *   - 坐标一律 WGS84 之外的坑：高德给的是 GCJ-02，直接写进 GPX 在苹果地图上会偏 300~500m。
 *     这里**不做**坐标纠偏（没有可靠离线算法），而是在文件里如实标注坐标系，并在页面上说清。
 */

const GCJ_NOTE = '坐标来自高德（GCJ-02），在只认 WGS84 的软件里会有几百米偏移';

function escXml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(v, d = 6) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '';
}

// 把 stops 按天分组（保持传入顺序；单天时只有一个组）
function groupByDay(stops) {
  const list = Array.isArray(stops) ? stops : [];
  const groups = [];
  list.forEach((s) => {
    const day = Number(s.day) || 1;
    let g = groups.find((x) => x.day === day);
    if (!g) {
      g = { day, stops: [] };
      groups.push(g);
    }
    g.stops.push(s);
  });
  return groups;
}

// 坐标必须真的是数字：Number(null) === 0、Number('') === 0，不挡住就会把点写到 (0,0)（几内亚湾）
function hasLngLat(s) {
  if (!s) return false;
  const ok = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  return ok(s.lng) && ok(s.lat);
}

function validStops(stops) {
  return (Array.isArray(stops) ? stops : []).filter(hasLngLat);
}

function descOf(s) {
  const bits = [];
  if (s.categoryLabel) bits.push(s.categoryLabel);
  if (s.rating) bits.push('★' + s.rating);
  if (s.cost) bits.push('¥' + s.cost);
  if (s.address) bits.push(s.address);
  if (s.note) bits.push(s.note);
  return bits.join(' · ');
}

// ---------- GPX 1.1 ----------
function buildGpx(payload) {
  const p = payload || {};
  const stops = validStops(p.stops);
  const groups = groupByDay(stops);
  const multiDay = groups.length > 1;
  const title = String(p.title || '我的行程');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="旅迹" xmlns="http://www.topografix.com/GPX/1/1"',
    '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    `    <name>${escXml(title)}</name>`,
    `    <desc>${escXml(GCJ_NOTE)}</desc>`,
    `    <time>${escXml(p.generatedAt || new Date().toISOString())}</time>`,
    '  </metadata>',
  ];
  // 住宿锚点也写成一个 waypoint（名字前加「住」），导航软件里能直接当起点
  if (p.base && hasLngLat(p.base)) {
    lines.push(
      `  <wpt lat="${num(p.base.lat)}" lon="${num(p.base.lng)}">`,
      `    <name>${escXml('住 · ' + (p.base.name || '住宿'))}</name>`,
      '    <sym>Lodging</sym>',
      '  </wpt>'
    );
  }
  stops.forEach((s) => {
    lines.push(
      `  <wpt lat="${num(s.lat)}" lon="${num(s.lng)}">`,
      `    <name>${escXml((s.seq ? s.seq + '. ' : '') + (s.name || '地点'))}</name>`,
      descOf(s) ? `    <desc>${escXml(descOf(s))}</desc>` : '',
      '  </wpt>'
    );
  });
  groups.forEach((g) => {
    const name = multiDay ? `${title} · 第 ${g.day} 天` : title;
    lines.push('  <trk>', `    <name>${escXml(name)}</name>`, '    <trkseg>');
    g.stops.forEach((s) => {
      lines.push(`      <trkpt lat="${num(s.lat)}" lon="${num(s.lng)}"></trkpt>`);
    });
    lines.push('    </trkseg>', '  </trk>');
  });
  lines.push('</gpx>', '');
  return lines.filter((l) => l !== '').join('\n');
}

// ---------- KML 2.2 ----------
function buildKml(payload) {
  const p = payload || {};
  const stops = validStops(p.stops);
  const groups = groupByDay(stops);
  const multiDay = groups.length > 1;
  const title = String(p.title || '我的行程');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `  <name>${escXml(title)}</name>`,
    `  <description>${escXml(GCJ_NOTE)}</description>`,
    '  <Style id="stop"><IconStyle><color>ff2f8cff</color><scale>1.1</scale></IconStyle></Style>',
    '  <Style id="base"><IconStyle><color>ff3dffc6</color><scale>1.1</scale></IconStyle></Style>',
    '  <Style id="line"><LineStyle><color>ff2f8cff</color><width>3</width></LineStyle></Style>',
  ];
  if (p.base && hasLngLat(p.base)) {
    lines.push(
      '  <Placemark>',
      `    <name>${escXml('住 · ' + (p.base.name || '住宿'))}</name>`,
      '    <styleUrl>#base</styleUrl>',
      `    <Point><coordinates>${num(p.base.lng)},${num(p.base.lat)},0</coordinates></Point>`,
      '  </Placemark>'
    );
  }
  groups.forEach((g) => {
    const folderName = multiDay ? `第 ${g.day} 天` : title;
    lines.push('  <Folder>', `    <name>${escXml(folderName)}</name>`);
    g.stops.forEach((s) => {
      lines.push(
        '    <Placemark>',
        `      <name>${escXml((s.seq ? s.seq + '. ' : '') + (s.name || '地点'))}</name>`,
        descOf(s) ? `      <description>${escXml(descOf(s))}</description>` : '',
        '      <styleUrl>#stop</styleUrl>',
        `      <Point><coordinates>${num(s.lng)},${num(s.lat)},0</coordinates></Point>`,
        '    </Placemark>'
      );
    });
    if (g.stops.length > 1) {
      const coords = g.stops.map((s) => `${num(s.lng)},${num(s.lat)},0`).join(' ');
      lines.push(
        '    <Placemark>',
        `      <name>${escXml(folderName + ' 路线')}</name>`,
        '      <styleUrl>#line</styleUrl>',
        `      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`,
        '    </Placemark>'
      );
    }
    lines.push('  </Folder>');
  });
  lines.push('</Document>', '</kml>', '');
  return lines.filter((l) => l !== '').join('\n');
}

// 文件名：<城市>-<行程名>-<日期>.gpx（与分享包同一套命名，方便一起找）
function fileBase(payload, ext) {
  const p = payload || {};
  const day = String(p.generatedAt || new Date().toISOString()).slice(0, 10);
  const city = String(p.city || '').trim();
  const title = String(p.title || '').trim();
  const head = city && title && title.indexOf(city) < 0 ? `${city}-${title}` : title || city || '行程';
  const safe = head.replace(/[\\/:*?"<>|\s·]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || '行程';
  return `${safe}-${day}.${ext}`;
}

module.exports = { buildGpx, buildKml, fileBase, groupByDay, hasLngLat, GCJ_NOTE };
