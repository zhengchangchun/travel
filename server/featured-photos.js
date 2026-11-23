'use strict';
/*
 * 实景图索引（推荐路程与行程里的照片）
 * 真源：config/featured-photos.json（scripts/fetch-featured-photos.cjs 生成，含作者与许可）
 * 图片文件：data/featured-photos/（不进仓，按需下载），由 /photo/<文件名> 提供
 *
 * 只做三件事：按「城市 + 名称」查一张图、确认文件在不在、把出处拼好（页面上要标）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config');

function dir() {
  return process.env.TRAVEL_FEATURED_PHOTO_DIR || path.join(ROOT, 'data', 'featured-photos');
}

function indexPath() {
  return process.env.TRAVEL_FEATURED_PHOTO_INDEX || path.join(ROOT, 'config', 'featured-photos.json');
}

let cache = null;
let cacheKey = '';

function load() {
  const file = indexPath();
  let stamp = '';
  try {
    const st = fs.statSync(file);
    stamp = String(st.mtimeMs) + ':' + st.size;
  } catch (err) {
    stamp = 'missing';
  }
  if (cache && cacheKey === stamp) return cache;
  let raw = { entries: [] };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    raw = { entries: [] };
  }
  const byKey = new Map();
  (raw.entries || []).forEach((e) => {
    if (e && e.city && e.name && e.file) byKey.set(e.city + '|' + e.name, e);
  });
  cache = { credits: raw.credits || '实景图来自 Wikimedia Commons（CC 授权）', source: raw.source || '', byKey };
  cacheKey = stamp;
  return cache;
}

// 一张图给页面用的形状：地址 + 出处（作者 / 许可 / 原页面）
function photoOf(entry) {
  if (!entry) return null;
  // 有的条目把「作者」写成了网页地址或邮箱（Commons 偶见）：这种不往页面上放，只留许可
  const rawAuthor = String(entry.author || '').trim();
  const author = /https?:\/\//i.test(rawAuthor) || rawAuthor.includes('@') ? '' : rawAuthor;
  return {
    url: '/photo/' + encodeURIComponent(entry.file),
    author,
    license: entry.license || '',
    source: entry.filePage || entry.source || '',
    credit: [author, entry.license].filter(Boolean).join(' · '),
  };
}

function photoFor(city, name) {
  const data = load();
  const entry = data.byKey.get(String(city) + '|' + String(name));
  if (!entry) return null;
  // 文件不在（还没跑脚本 / 被删了）就当没有：页面自动不显示
  try {
    if (!fs.existsSync(path.join(dir(), entry.file))) return null;
  } catch (err) {
    return null;
  }
  return photoOf(entry);
}

// 一座城的全部实景图（给规划页的行程清单用：按点位名字查）
// 点位名叫「鹿回头」、索引里叫「鹿回头风景区」这种情况要能对上，所以顺手做几个别名
const SUFFIX = /(风景区|文化旅游区|旅游度假区|度假区|开发区|研究基地|景区|公园)$/;

function photosForCity(city) {
  const data = load();
  const out = {};
  data.byKey.forEach((entry) => {
    if (entry.city !== String(city)) return;
    const p = photoFor(entry.city, entry.name);
    if (!p) return;
    out[entry.name] = p;
    const short = entry.name.replace(SUFFIX, '').trim();
    if (short && short !== entry.name && !out[short]) out[short] = p;
  });
  return out;
}

function credits() {
  return load().credits;
}

// 一座城的第一张实景图（首页地区卡的封面用；按索引顺序＝人工挑过的那张）
function firstForCity(city) {
  const all = photosForCity(city);
  const first = Object.keys(all)[0];
  return first ? all[first] : null;
}

module.exports = { photoFor, photosForCity, firstForCity, credits, dir, indexPath };
