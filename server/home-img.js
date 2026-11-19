'use strict';
/*
 * 首页配图：给推荐地区 / 推荐路线生成静态地图缩略图，落在 data/home-img/ 里复用。
 *
 *   region-<城市>.png   城市中心俯瞰（zoom 11）
 *   route-<路线id>.png  这条推荐路线的那条折线 + 每站 marker（高德自动取景）
 *
 * 坐标底稿在 config/featured-geo.json（scripts/geo-featured.cjs 生成）——
 * 推荐路线的公开载荷里不带坐标，这份只服务端用。
 * 一张图只生成一次（文件在就直接用）；生成失败返回 null，页面自己退化成渐变底色。
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config');
const routemap = require('./routemap');

const SIZE = '640*320'; // 2:1，正好铺满卡片头图
const SCALE = 2; // 高分屏用
const REGION_ZOOM = 11;

function dir() {
  return process.env.TRAVEL_HOME_IMG_DIR || path.join(ROOT, 'data', 'home-img');
}

function geoFile() {
  return process.env.TRAVEL_FEATURED_GEO || path.join(ROOT, 'config', 'featured-geo.json');
}

let geoCache = null;
function geo() {
  if (!geoCache) {
    try {
      geoCache = JSON.parse(fs.readFileSync(geoFile(), 'utf8'));
    } catch (err) {
      geoCache = { cities: {}, routes: {} };
    }
  }
  return geoCache;
}

function safeName(s) {
  return String(s || '').replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60);
}

// 坐标必须真的存在：null / '' 在 Number() 下会变成 0（0,0 会把取景拉到整张世界地图）
function isValidPoi(p) {
  if (!p) return false;
  const ok = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) !== 0;
  return ok(p.lng) && ok(p.lat);
}

async function writeImage({ amap, file, params }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { buffer, contentType } = await amap.staticMap(params);
  fs.writeFileSync(file, buffer);
  try {
    fs.writeFileSync(
      file + '.meta.json',
      JSON.stringify({ params, contentType, bytes: buffer.length, builtAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    /* 元数据写不了不影响图片 */
  }
  return { file, cached: false, bytes: buffer.length, params };
}

// 城市俯瞰图
async function ensureRegion({ amap, city, force }) {
  const name = String(city || '').trim();
  if (!name) return null;
  const file = path.join(dir(), 'region-' + safeName(name) + '.png');
  if (!force && fs.existsSync(file)) return { file, cached: true };
  const c = (geo().cities || {})[name];
  if (!isValidPoi(c)) return null;
  const params = routemap.staticMapParams({
    size: SIZE,
    scale: SCALE,
    zoom: REGION_ZOOM,
    location: `${Number(c.lng).toFixed(6)},${Number(c.lat).toFixed(6)}`,
    withMarkers: false,
  });
  try {
    return await writeImage({ amap, file, params });
  } catch (err) {
    return null;
  }
}

// 推荐路线的路线图（一站点一个 marker，按顺序连成一条线）
async function ensureRoute({ amap, id, force }) {
  const key = String(id || '').trim();
  if (!key) return null;
  const file = path.join(dir(), 'route-' + safeName(key) + '.png');
  if (!force && fs.existsSync(file)) return { file, cached: true };
  const list = (geo().routes || {})[key] || [];
  const stops = list.filter(isValidPoi).map((s) => ({ name: s.name, lng: Number(s.lng), lat: Number(s.lat) }));
  if (stops.length < 2) return null;
  const params = routemap.staticMapParams({
    stops,
    points: stops.map((s) => [s.lng, s.lat]),
    size: SIZE,
    scale: SCALE,
    withMarkers: true,
  });
  try {
    return await writeImage({ amap, file, params });
  } catch (err) {
    return null;
  }
}

module.exports = { ensureRegion, ensureRoute, dir, SIZE, SCALE };
