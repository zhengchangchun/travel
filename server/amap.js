const { loadConfig, loadCategories } = require('./config');

const AMAP_BASE = 'https://restapi.amap.com';

let _config = null;
let _categories = null;

function setConfig(cfg) {
  _config = cfg;
}

function config() {
  if (!_config) _config = loadConfig();
  return _config;
}

function categories() {
  if (!_categories) _categories = loadCategories();
  return _categories;
}

function setCategories(list) {
  _categories = list;
}

class AmapError extends Error {
  constructor(msg, info = {}) {
    super(msg);
    this.name = 'AmapError';
    this.code = 'AMAP_ERROR';
    this.info = info;
  }
}

function firstString(value) {
  if (Array.isArray(value)) {
    const found = value.find((v) => v != null && String(v).trim() !== '');
    return found == null ? '' : String(found);
  }
  return value == null ? '' : String(value);
}

function categoryOf(key) {
  return categories().find((c) => c.key === key) || null;
}

function classifyType(typecode) {
  const code = String(typecode || '');
  if (!code) return null;
  for (const cat of categories()) {
    const prefix = String(cat.amapCode || '').slice(0, 2);
    if (prefix && code.startsWith(prefix)) return cat.key;
  }
  return null;
}

function pickAddress(raw) {
  const direct = firstString(raw.address);
  if (direct.trim()) return direct;
  return [raw.pname, raw.cityname, raw.adname, raw.business_area]
    .map(firstString)
    .filter((s) => s.trim())
    .join('');
}

function normalizePoi(raw = {}) {
  const location = String(raw.location || '');
  const [lngStr, latStr] = location.split(',');
  const lng = Number(lngStr);
  const lat = Number(latStr);
  const biz = raw.biz_ext || {};
  const photos = Array.isArray(raw.photos) ? raw.photos : [];
  const tags = firstString(raw.tag)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const photoUrls = photos.map((p) => firstString(p && p.url)).filter(Boolean);
  const typecode = firstString(raw.typecode);
  return {
    id: firstString(raw.id),
    name: firstString(raw.name),
    address: pickAddress(raw),
    lng: Number.isFinite(lng) ? lng : null,
    lat: Number.isFinite(lat) ? lat : null,
    typecode,
    type: firstString(raw.type),
    category: classifyType(typecode),
    rating: firstString(biz.rating),
    cost: firstString(biz.cost),
    tel: firstString(raw.tel),
    opentime: firstString(biz.opentime2) || firstString(biz.opentime),
    photo: photoUrls[0] || '',
    photos: photoUrls,
    tags,
  };
}

function clampPage(page) {
  return Math.min(Math.max(1, Number(page) || 1), 25);
}

function mapDistrict(d) {
  const [lng, lat] = String(d.center || '').split(',').map(Number);
  return {
    name: d.name,
    adcode: d.adcode || '',
    lng: Number.isFinite(lng) ? lng : null,
    lat: Number.isFinite(lat) ? lat : null,
  };
}

// 城市下辖区县：keywords=<城市> & subdistrict=1，递归收集 level=district 的项
async function districts(city) {
  const json = await amapGet('/v3/config/district', {
    keywords: city,
    subdistrict: 1,
    extensions: 'base',
  });
  const top = Array.isArray(json.districts) ? json.districts : [];
  const out = [];
  const walk = (list) => {
    list.forEach((d) => {
      const subs = Array.isArray(d.districts) ? d.districts : [];
      if (d.level === 'district') {
        out.push(mapDistrict(d));
        return;
      }
      if (subs.length) {
        walk(subs);
        return;
      }
      if (d.adcode && d.level !== 'province') out.push(mapDistrict(d));
    });
  };
  walk(top);
  if (!out.length) {
    top.forEach((d) => {
      if (d.adcode) out.push(mapDistrict(d));
    });
  }
  return out;
}

async function amapGet(pathname, params = {}) {
  const url = new URL(AMAP_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, v);
  }
  url.searchParams.set('key', config().amap.webServiceKey);

  let res;
  try {
    res = await globalThis.fetch(url.toString());
  } catch (err) {
    throw new AmapError(`高德请求失败: ${err.message}`, { cause: String(err) });
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new AmapError('高德返回内容不是 JSON');
  }

  if (json.status !== '1' || json.infocode !== '10000') {
    const info = json.info || json.infocode || 'UNKNOWN';
    throw new AmapError(String(info), { infocode: json.infocode, info: json.info });
  }
  return json;
}

async function searchCity(q) {
  const json = await amapGet('/v3/config/district', {
    keywords: q,
    subdistrict: 0,
    extensions: 'base',
  });
  const districts = Array.isArray(json.districts) ? json.districts : [];
  return districts
    .filter((d) => d.level === 'city')
    .map((d) => {
      const [lng, lat] = String(d.center || '').split(',').map(Number);
      return {
        name: d.name,
        adcode: d.adcode || '',
        citycode: d.citycode || '',
        center: d.center || '',
        lng: Number.isFinite(lng) ? lng : null,
        lat: Number.isFinite(lat) ? lat : null,
      };
    });
}

async function searchPoi({ city, category, keywords, page = 1 } = {}) {
  const cat = categoryOf(category);
  const keyword = (keywords && String(keywords).trim()) || (cat ? cat.label : '');
  const safePage = Math.min(Math.max(1, Number(page) || 1), 25);
  const json = await amapGet('/v3/place/text', {
    keywords: keyword,
    city,
    citylimit: 'true',
    offset: 25,
    page: safePage,
    extensions: 'all',
  });
  const pois = Array.isArray(json.pois) ? json.pois : [];
  return pois.map(normalizePoi);
}

async function nearbyPoi({ lng, lat, category, radius = 3000 } = {}) {
  const cat = categoryOf(category);
  const json = await amapGet('/v3/place/around', {
    location: `${lng},${lat}`,
    radius: Number(radius) || 3000,
    keywords: cat ? cat.label : '',
    offset: 25,
    page: 1,
    extensions: 'all',
  });
  const pois = Array.isArray(json.pois) ? json.pois : [];
  return pois.map(normalizePoi);
}

// 按行政区（adcode）翻页搜索：分期采集主力接口
async function searchPoiByDistrict({ adcode, city, category, keywords, page = 1 } = {}) {
  const cat = categoryOf(category);
  const keyword = (keywords && String(keywords).trim()) || (cat ? cat.label : '');
  const json = await amapGet('/v3/place/text', {
    keywords: keyword,
    city: adcode || city,
    citylimit: 'true',
    offset: 25,
    page: clampPage(page),
    extensions: 'all',
  });
  const pois = Array.isArray(json.pois) ? json.pois : [];
  return pois.map(normalizePoi);
}

// 周边分片搜索：二级分片用（可按 radius/page 递归缩小）
async function searchPoiAround({ lng, lat, category, keywords, radius = 3000, page = 1 } = {}) {
  const cat = categoryOf(category);
  const keyword = (keywords && String(keywords).trim()) || (cat ? cat.label : '');
  const json = await amapGet('/v3/place/around', {
    location: `${lng},${lat}`,
    radius: Number(radius) || 3000,
    keywords: keyword,
    offset: 25,
    page: clampPage(page),
    extensions: 'all',
  });
  const pois = Array.isArray(json.pois) ? json.pois : [];
  return pois.map(normalizePoi);
}

async function poiDetail(id) {
  const json = await amapGet('/v3/place/detail', { id, extensions: 'all' });
  const pois = Array.isArray(json.pois) ? json.pois : [];
  return pois.length ? normalizePoi(pois[0]) : null;
}

// ---------- 路径规划（T3） ----------

function parsePolyline(str) {
  if (str == null || str === '') return [];
  return String(str)
    .split(';')
    .map((pair) => pair.split(',').map(Number))
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
}

function parseSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list
    .map((s) => ({
      instruction: firstString(s.instruction),
      distance: Number(s.distance) || 0,
      duration: Number(s.duration) || 0,
      polyline: parsePolyline(s.polyline),
    }))
    .filter((s) => s.polyline.length > 0 || s.instruction);
}

function joinPolylines(polylines) {
  const out = [];
  polylines.forEach((line) => {
    line.forEach((pt) => {
      const last = out[out.length - 1];
      if (last && last[0] === pt[0] && last[1] === pt[1]) return;
      out.push(pt);
    });
  });
  return out;
}

// 驾车 / 步行：route.paths[0] → 统一形状
function normalizePathRoute(json, mode) {
  const route = json.route || {};
  const paths = Array.isArray(route.paths) ? route.paths : [];
  if (!paths.length) throw new AmapError(`未找到${mode}路径`);
  const path = paths[0] || {};
  const steps = parseSteps(path.steps);
  const polyline = steps.length
    ? joinPolylines(steps.map((s) => s.polyline))
    : parsePolyline(path.polyline);
  return {
    mode,
    distance: Number(path.distance) || 0,
    duration: Number(path.duration) || 0,
    polyline,
    steps,
    transit: null,
    degraded: false,
  };
}

// 公交：route.transits[0].segments[] 把 walking / bus 折线按序拼成一条完整折线
function normalizeTransitRoute(json) {
  const route = json.route || {};
  const transits = Array.isArray(route.transits) ? route.transits : [];
  if (!transits.length) throw new AmapError('未找到公交方案');
  const transit = transits[0] || {};
  const segments = Array.isArray(transit.segments) ? transit.segments : [];
  const summary = [];
  const lines = [];

  segments.forEach((seg) => {
    if (seg.walking) {
      const walkSteps = Array.isArray(seg.walking.steps) ? seg.walking.steps : [];
      const line = walkSteps.map((s) => parsePolyline(s.polyline));
      lines.push(...line);
      summary.push({
        type: 'walking',
        distance: Number(seg.walking.distance) || 0,
        duration: Number(seg.walking.duration) || 0,
        name: '步行',
        instruction: `步行 ${Number(seg.walking.distance) || 0} 米`,
        polyline: joinPolylines(line),
      });
    }
    if (seg.bus) {
      const buslines = Array.isArray(seg.bus.buslines) ? seg.bus.buslines : [];
      buslines.forEach((b) => {
        const line = parsePolyline(b.polyline);
        lines.push(line);
        summary.push({
          type: 'bus',
          name: firstString(b.name) || '公交',
          distance: Number(b.distance) || 0,
          duration: Number(b.duration) || 0,
          via_num: firstString(b.via_num),
          instruction: `乘坐${firstString(b.name) || '公交'}`,
          polyline: line,
        });
      });
    }
  });

  const polyline = joinPolylines(lines);
  const totalDistance =
    Number(transit.distance) || summary.reduce((sum, s) => sum + s.distance, 0);
  const totalDuration =
    Number(transit.duration) || summary.reduce((sum, s) => sum + s.duration, 0);

  return {
    mode: 'transit',
    distance: totalDistance,
    duration: totalDuration,
    polyline,
    steps: summary.map((s) => ({
      instruction: s.instruction,
      distance: s.distance,
      duration: s.duration,
      polyline: s.polyline,
    })),
    transit: {
      distance: totalDistance,
      duration: totalDuration,
      cost: Number(transit.cost) || 0,
      segments: summary.map((s) => ({
        type: s.type,
        name: s.name,
        distance: s.distance,
        duration: s.duration,
        via_num: s.via_num,
      })),
    },
    degraded: false,
  };
}

async function planWalking(origin, destination) {
  const json = await amapGet('/v3/direction/walking', { origin, destination });
  return normalizePathRoute(json, 'walking');
}

async function planDriving(origin, destination, strategy) {
  const json = await amapGet('/v3/direction/driving', {
    origin,
    destination,
    strategy: strategy === undefined || strategy === null ? 0 : strategy,
    extensions: 'all',
  });
  return normalizePathRoute(json, 'driving');
}

async function planTransit(origin, destination, city) {
  const json = await amapGet('/v3/direction/transit/integrated', {
    origin,
    destination,
    city,
    cityd: city,
    strategy: 0,
    extensions: 'all',
  });
  return normalizeTransitRoute(json);
}

module.exports = {
  amapGet,
  searchCity,
  searchPoi,
  nearbyPoi,
  searchPoiByDistrict,
  searchPoiAround,
  districts,
  poiDetail,
  normalizePoi,
  classifyType,
  parsePolyline,
  planWalking,
  planDriving,
  planTransit,
  setConfig,
  setCategories,
  AmapError,
  AMAP_BASE,
};
