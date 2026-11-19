#!/usr/bin/env node
'use strict';
/*
 * 给推荐路程的每一站配一张实景图（真实照片，不是插画）。
 *
 * 取图路线（比全文搜 Commons 准得多）：
 *   ① 用站点名去中文维基百科查条目（含重定向）→ 取该条目的**首图**（是编辑挑过的、基本对题）
 *   ② 条目名带「·」（如「白堤 · 平湖秋月」）就拆开逐个试
 *   ③ 拿不到条目就退回 Commons 全文搜索，但要过上题与格式两道闸
 *   ④ 无论哪种来源，都去 Commons 查这张图的**许可与作者**：非自由许可一律不要
 *
 * 下载到 data/featured-photos/（不进仓），索引进 config/featured-photos.json（进仓，含出处）。
 * 为什么不用高德 POI 照片：place/* 本月额度已耗尽（约 12/1 恢复），而且那些图多是商家门脸。
 *
 * 用法：node scripts/fetch-featured-photos.cjs [--force]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FEATURED = path.join(ROOT, 'config', 'featured.json');
const INDEX = path.join(ROOT, 'config', 'featured-photos.json');
const OUT_DIR = path.join(ROOT, 'data', 'featured-photos');

const UA = 'travel-local/1.0 (personal travel planner; contact 1056921980@qq.com)';
const WIDTH = 900;
// 许可白名单：只收自由的（CC0 / CC BY / CC BY-SA / 公有领域 / GFDL）
// 注意：Commons 返回的短名形如「CC BY-SA 4.0」——用空格而非连字符，跟着连字符写会全都不匹配
const ALLOW = /^(cc0|cc[ -]by([ -]sa)?([ -]\d(\.\d)?)?|public domain|pd[ -]|gfdl)/i;
const RASTER = /\.(jpe?g|png|webp)$/i;
// 这些标题一看就不是风景照：地铁口、纪念碑、大门、地图……宁可没图也别上错图
const BAD = /metro|station|airport|subway|map|plan|planning|book|magazine|newspaper|scan|djvu|pdf|logo|diagram|chart|poster|stamp|painting|drawing|sketch|banknote|ticket|monument|statue|entrance|einstieg|eingang|satellite|from the air|[站口碑牌坊电梯]/i;
// 人工判定过「维基首图不对题、得靠指名搜索」的站点：先用这些词搜 Commons
const EXTRA = {
  '三亚|蜈支洲岛': ['Wuzhizhou Island', 'Wuzhizhou'],
  '三亚|亚龙湾': ['Yalong Bay beach', 'Yalong Bay Sanya'],
  '三亚|南山文化旅游区': ['Nanshan Temple Sanya', 'Nanshan Buddhism Park'],
  '三亚|鹿回头风景区': ['Luhuitou Park', 'Luhuitou Sanya'],
  '成都|成都大熊猫繁育研究基地': ['Giant panda Chengdu', 'Chengdu panda base'],
  '杭州|曲院风荷': ['曲院风荷 西湖', 'Quyuan Fenghe'],
  '杭州|满觉陇': ['满觉陇 杭州', 'Manjuelong'],
};

// 人工判定过「宁可不放图」的站点（搜出来都是错的，或全是不相关的）
const REJECT = new Set([
  '杭州|孤山 · 西泠印社',
  '三亚|三亚湾',
  '三亚|第一市场',
  '杭州|武林门码头',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();

// 地球两点距离（米）：用来判「这个条目说的确实是这座城的这个地方」
function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 拼参数一律走 URLSearchParams：手动拼 `|` 会被 fetch 弄坏（上一版就是这里静的失败）
function api(base, params) {
  const u = new URL(base);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return fetch(u, { headers: { 'User-Agent': UA } });
}

function slugOf(name, id) {
  const s = String(name).replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return (id ? id + '-' : '') + s;
}

// 中文维基条目的首图（编辑挑过的，基本对题），顺带把条目坐标也拿来验真
async function zhWikiLeadImage(title) {
  const res = await api('https://zh.wikipedia.org/w/api.php', {
    action: 'query',
    format: 'json',
    redirects: 1,
    prop: 'pageimages|coordinates',
    piprop: 'name',
    colimit: 1,
    titles: title,
  });
  if (!res.ok) return null;
  const json = await res.json();
  const page = Object.values((json.query && json.query.pages) || {}).find((p) => p.pageid);
  if (!page) return null;
  const coord = (page.coordinates || [])[0] || null;
  return {
    pageTitle: page.title,
    file: page.pageimage || '',
    coord: coord ? { lng: Number(coord.lon), lat: Number(coord.lat) } : null,
    pageUrl: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(page.title),
  };
}

// 图的地址与许可：在中文维基上查（它会把 Commons 的图一起答出来）
async function wikiFile(name) {
  const res = await api('https://zh.wikipedia.org/w/api.php', {
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: WIDTH,
    titles: String(name).startsWith('File:') ? name : 'File:' + name,
  });
  if (!res.ok) return null;
  const json = await res.json();
  const page = Object.values((json.query && json.query.pages) || {})[0];
  const ii = page && (page.imageinfo || [])[0];
  if (!ii) return null;
  const em = ii.extmetadata || {};
  // GPS 取不到时 Commons 常给空串 —— Number('') 是 0，不当心就把「无坐标」当成 0,0 判成异地
  const gps = (v) => {
    const raw = String((em[v] || {}).value == null ? '' : (em[v] || {}).value).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && Math.abs(n) > 1e-6 ? n : null;
  };
  return {
    title: String((page && page.title) || 'File:' + name),
    thumb: ii.thumburl || '',
    width: ii.width || 0,
    height: ii.height || 0,
    mime: ii.mime || '',
    page: ii.descriptionurl || '',
    license: (em.LicenseShortName && em.LicenseShortName.value) || '',
    author: strip((em.Artist && em.Artist.value) || ''),
    lat: gps('GPSLatitude'),
    lng: gps('GPSLongitude'),
  };
}

// GPS 值解析（共用一个）：空串/0 都当没有
function gpsValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) > 1e-6 ? n : null;
}

async function commonsSearchImage(term) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    '&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=' + encodeURIComponent(term) +
    '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=' + WIDTH;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const json = await res.json();
  return Object.values((json.query && json.query.pages) || {}).map((p) => {
    const ii = (p.imageinfo || [])[0] || {};
    const em = ii.extmetadata || {};
    return {
      title: p.title,
      thumb: ii.thumburl || '',
      width: ii.width || 0,
      height: ii.height || 0,
      mime: ii.mime || '',
      page: ii.descriptionurl || '',
      license: (em.LicenseShortName && em.LicenseShortName.value) || '',
      author: strip((em.Artist && em.Artist.value) || ''),
      lat: gpsValue((em.GPSLatitude || {}).value),
      lng: gpsValue((em.GPSLongitude || {}).value),
    };
  });
}

// 图上题、格式、许可、位置四道闸；过了才要
function acceptable(img, mustMatch, coord) {
  if (!img || !img.thumb) return false;
  if (!RASTER.test(img.title) || !/^image\/(jpeg|png|webp)/.test(img.mime || '')) return false;
  if (BAD.test(img.title)) return false;
  if (!ALLOW.test(String(img.license || ''))) return false;
  if (img.width < 900) return false;
  // 图自带 GPS 就拿来验：离站点 50km 以外一律不要（防同名异地）
  if (coord && Number.isFinite(img.lat) && Number.isFinite(img.lng)) {
    if (distanceM(coord, { lat: img.lat, lng: img.lng }) > 50000) return false;
  }
  if (mustMatch) {
    const zh = mustMatch.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const en = mustMatch.match(/[A-Za-z]{4,}/g) || [];
    const t = img.title.toLowerCase();
    if (!zh.some((z) => img.title.includes(z)) && !en.some((w) => t.includes(w.toLowerCase()))) return false;
  }
  return true;
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

// 一站一张：先维基首图，再退 Commons 搜索
async function findForStop(stop, city, coord) {
  const dbg = (...a) => {
    if (process.env.DBG) console.log('   ' + a.join(' '));
  };
  const key = city + '|' + stop.name;
  const names = String(stop.name)
    .split(/\s*·\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  // ① 有指名搜索词的（维基首图不对题的）先走 Commons，要求文件名真对上搜索词
  const extra = EXTRA[key] || [];
  if (extra.length) {
    const all = [];
    for (const t of extra) {
      const found = await commonsSearchImage(t);
      await sleep(200);
      all.push(...found);
    }
    const ok = all
      .filter((c) => acceptable(c, '', coord))
      .map((c) => ({
        c,
        s:
          extra.reduce((n, t) => n + (acceptable(c, t, coord) ? 3 : 0), 0) +
          (stop.name.includes(String(c.title).replace(/^File:/, '').slice(0, 3)) ? 1 : 0) +
          Math.min(2, c.width / 3000),
      }))
      .sort((a, b) => b.s - a.s)[0];
    if (ok) return { img: ok.c, why: 'Commons 指名搜索（' + extra[0] + '）', source: '' };
    dbg('指名搜索没过闸（候选 ' + all.length + ' 张）');
  }

  // ② 维基条目首图
  for (const n of names) {
    const lead = await zhWikiLeadImage(n);
    await sleep(180);
    if (!lead || !lead.file) {
      dbg('没有可用条目：' + n);
      continue;
    }
    // 验真：条目有坐标就必须在站点 50km 内；没坐标才退而求其次看名字
    const nearOk = !!(coord && lead.coord && distanceM(coord, lead.coord) < 50000);
    const titleOk = lead.pageTitle.includes(n);
    if (lead.coord ? !nearOk : !titleOk) {
      dbg('条目「' + lead.pageTitle + '」跟这一站对不上（坐标 ' + JSON.stringify(lead.coord) + '）');
      continue;
    }
    const img = await wikiFile(lead.file);
    await sleep(180);
    if (acceptable(img, '', coord)) return { img, why: '维基条目首图（' + lead.pageTitle + '）', source: lead.pageUrl };
    dbg(
      '条目「' + lead.pageTitle + '」首图不合格：' +
        (img ? img.title + ' | thumb=' + !!img.thumb + ' | w=' + img.width + ' | mime=' + img.mime + ' | lic=' + img.license + ' | gps=' + img.lat + ',' + img.lng : '取不到图信息')
    );
  }

  // 退路：Commons 全文搜索（要求文件名真含站点名里的中文词）
  const terms = [stop.name, stop.name.replace(/风景区|文化旅游区|开发区|研究基地/g, '').trim()];
  const all = [];
  for (const t of terms) {
    if (!t) continue;
    const found = await commonsSearchImage(t);
    await sleep(200);
    all.push(...found);
  }
  const ok = all.filter((c) => acceptable(c, stop.name, coord)).sort((a, b) => b.width - a.width)[0];
  if (ok) return { img: ok, why: 'Commons 搜索（' + stop.name + '）', source: '' };
  dbg('Commons 搜索也没过闸（候选 ' + all.length + ' 张）');
  return null;
}

async function main() {
  const force = process.argv.includes('--force');
  const featured = JSON.parse(fs.readFileSync(FEATURED, 'utf8'));
  // 站点坐标（scripts/geo-featured.cjs 的产物）：用来验维基条目说的确实是这一站
  let geo = { routes: {} };
  try {
    geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'featured-geo.json'), 'utf8'));
  } catch (err) {
    geo = { routes: {} };
  }
  const coordOf = (city, name) => {
    for (const list of Object.values(geo.routes || {})) {
      const hit = (list || []).find((s) => s.name === name);
      if (hit && Number.isFinite(hit.lng) && Number.isFinite(hit.lat)) return { lng: hit.lng, lat: hit.lat };
    }
    return null;
  };
  const prev = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { entries: [] };
  const have = new Map((prev.entries || []).map((e) => [e.city + '|' + e.name, e]));

  const entries = [];
  let fetched = 0;
  let missed = 0;
  const seenStop = new Set();

  for (const rt of featured.routes || []) {
    for (const stop of rt.stops || []) {
      const key = rt.city + '|' + stop.name;
      if (seenStop.has(key)) {
        const dup = entries.find((e) => e.city === rt.city && e.name === stop.name);
        if (dup) console.log('= ' + key + '（同城同名，复用已有那张）');
        continue;
      }
      seenStop.add(key);
      if (REJECT.has(key)) {
        console.log('- ' + key + ' 人工判定：宁可不放图');
        continue;
      }
      const old = have.get(key);
      if (old && !force && fs.existsSync(path.join(OUT_DIR, old.file))) {
        entries.push({ ...old, routeId: rt.id });
        continue;
      }
      const found = await findForStop(stop, rt.city, coordOf(rt.city, stop.name));
      if (!found) {
        missed += 1;
        console.log('✗ ' + key + ' 没找到合适的实景图');
        continue;
      }
      const file = slugOf(stop.name, rt.id) + '.jpg';
      try {
        const bytes = await download(found.img.thumb, path.join(OUT_DIR, file));
        entries.push({
          city: rt.city,
          name: stop.name,
          routeId: rt.id,
          file,
          bytes,
          source: found.source || found.img.page,
          filePage: found.img.page,
          author: found.img.author,
          license: found.img.license,
          pickedBy: found.why,
        });
        fetched += 1;
        console.log(
          '✓ ' + key + ' ← ' + found.img.title + '（' + found.img.license + '）' +
            Math.round(bytes / 1024) + 'KB · ' + found.why
        );
      } catch (err) {
        missed += 1;
        console.log('✗ ' + key + ' 下载失败：' + (err && err.message));
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'Wikimedia Commons / 中文维基百科',
    note: '推荐路程与行程的实景图：自由许可（CC / 公有领域），作者与许可逐条记在 entries 里；页面上会标出处。',
    credits: '实景图来自 Wikimedia Commons（CC 授权）',
    entries,
  };
  fs.writeFileSync(INDEX, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('完成：这轮取到 ' + fetched + ' 张，没找到 ' + missed + ' 张，索引共 ' + entries.length + ' 条');
}

main().catch((err) => {
  console.error('失败：' + (err && err.message));
  process.exit(1);
});
