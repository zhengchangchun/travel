const { loadConfig, loadCategories } = require('./config');

// 高德 Web 服务入口；可用 AMAP_BASE 环境变量指向本地假服务（联调/离线验收用，默认不变）
const AMAP_BASE = process.env.AMAP_BASE || 'https://restapi.amap.com';

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

// regeo 的 pois[].type 是「商务住宅;楼宇;商务写字楼」这种文本，不是 typecode ⇒ 先换成码再分类
const TYPE_TEXT_CODE = {
  餐饮服务: '05',
  购物服务: '06',
  体育休闲服务: '08',
  医疗保健服务: '09',
  住宿服务: '10',
  风景名胜: '11',
  商务住宅: '12',
  科教文化服务: '14',
  交通设施服务: '15',
};

function classifyTypeText(text) {
  const head = String(text || '').split(';')[0].trim();
  return classifyType(TYPE_TEXT_CODE[head] || '');
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

// ---------- 城市行政边界（P21）：先让用户看清「整座城市有多大」 ----------
// extensions=all 的 districts[0].polyline 才是轮廓；多段用 "|" 分隔（岛屿 / 飞地各成一段）。
const BOUNDARY_MIN_DEG = 0.0015; // 抽稀步长 ≈ 150m（看轮廓不需要 6000 个点）
const BOUNDARY_MAX_PER_RING = 1200;

function parseDistrictRings(text) {
  return String(text || '')
    .split('|')
    .map((part) => parsePolyline(part))
    .filter((ring) => ring.length >= 3);
}

function thinRing(ring) {
  if (ring.length <= 3) return ring;
  const out = [ring[0]];
  let anchor = ring[0];
  for (let i = 1; i < ring.length; i += 1) {
    const p = ring[i];
    if (Math.abs(p[0] - anchor[0]) >= BOUNDARY_MIN_DEG || Math.abs(p[1] - anchor[1]) >= BOUNDARY_MIN_DEG) {
      out.push(p);
      anchor = p;
    }
  }
  const first = ring[0];
  const last = out[out.length - 1];
  if (last[0] !== first[0] || last[1] !== first[1]) out.push(first);
  return out.length >= 3 ? out : ring;
}

function capRing(ring, max = BOUNDARY_MAX_PER_RING) {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out = ring.filter((_, i) => i % step === 0);
  const last = ring[ring.length - 1];
  const tail = out[out.length - 1];
  if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

// 城市轮廓：中心 + 外接矩形 + 抽稀后的环（给前端画「城市边框」并把相机收到全城）
async function cityBoundary(city) {
  const json = await amapGet('/v3/config/district', {
    keywords: city,
    subdistrict: 0,
    extensions: 'all',
  });
  const d = (Array.isArray(json.districts) ? json.districts : [])[0];
  if (!d) throw new AmapError(`高德没找到「${city}」的行政区数据`);
  const rings = parseDistrictRings(d.polyline).map((ring) => capRing(thinRing(ring)));
  const points = rings.reduce((acc, ring) => acc.concat(ring), []);
  let bbox = null;
  if (points.length) {
    const lngs = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    bbox = [
      Math.min.apply(null, lngs),
      Math.min.apply(null, lats),
      Math.max.apply(null, lngs),
      Math.max.apply(null, lats),
    ];
  }
  const center = String(d.center || '')
    .split(',')
    .map(Number);
  return {
    name: d.name || city,
    adcode: d.adcode || '',
    level: d.level || 'city',
    center: Number.isFinite(center[0]) && Number.isFinite(center[1]) ? center : null,
    bbox,
    rings,
    fetchedAt: new Date().toISOString(),
  };
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

// 二进制接口（静态地图）：拿到的是 PNG，不是 JSON。
// 出错时高德也返回 JSON（status!=1），所以要按 content-type 分派，别把错误当图用。
async function amapGetBinary(pathname, params = {}) {
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
  const type = String(res.headers.get('content-type') || '');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !type.startsWith('image/')) {
    let info = 'UNKNOWN';
    let infocode = '';
    try {
      const json = JSON.parse(buf.toString('utf8'));
      info = json.info || info;
      infocode = json.infocode || '';
    } catch (err) {
      /* 既不是图也不是 JSON：保留原始 info */
    }
    throw new AmapError(String(info), { infocode, info, status: res.status });
  }
  return { buffer: buf, contentType: type };
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

async function searchPoiInArea({ polygon, category, keywords, page = 1 } = {}) {
  const cat = categoryOf(category);
  const keyword = (keywords && String(keywords).trim()) || (cat ? cat.label : '');
  const json = await amapGet('/v3/place/polygon', {
    polygon,
    keywords: keyword,
    offset: 25,
    page: clampPage(page),
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

// 逆地理编码：把一个坐标翻译成「这里是哪」（P19）。
// 搜索类接口（place/text|around）配额用尽时，geocode/regeo 通常还有额度 —— 点地图就能用。
async function reverseGeocode({ lng, lat, radius = 200 } = {}) {
  const json = await amapGet('/v3/geocode/regeo', {
    location: Number(lng) + ',' + Number(lat),
    extensions: 'all',
    radius: Number(radius) || 200,
  });
  const r = json && json.regeocode;
  if (!r) return null;
  const ac = r.addressComponent || {};
  const pois = Array.isArray(r.pois) ? r.pois : [];
  const roads = Array.isArray(r.roads) ? r.roads : [];
  const near = pois[0] || null;
  const street = ac.streetNumber || {};
  const building = ac.building || {};
  const neighborhood = ac.neighborhood || {};
  const streetName = firstString(street.street);
  const streetNo = firstString(street.number);
  // 「这里是哪」的地标名：从完整地址里剥掉省/市/区/街道
  // （浙江省杭州市上城区四季青街道杭州大剧院 ⇒ 杭州大剧院）
  // 比 pois[0] 准：近年 POI 可能是旁边一个喷泉，而你点的是那栋楼
  let landmark = firstString(r.formatted_address);
  [ac.province, ac.city, ac.district, ac.township].forEach((part) => {
    const s = firstString(part);
    if (s) landmark = landmark.split(s).join('');
  });
  landmark = landmark.trim();
  return {
    address: firstString(r.formatted_address),
    landmark,
    name:
      firstString(near && near.name) ||
      firstString(building.name) ||
      firstString(neighborhood.name) ||
      streetName,
    category: near ? classifyTypeText(near.type) : classifyTypeText(building.type),
    distance: near ? Number(near.distance) || 0 : 0,
    street: streetName ? streetName + streetNo : '',
    area: [ac.province, ac.city, ac.district, ac.township].map(firstString).filter(Boolean).join(' '),
    building: firstString(building.name),
    neighborhood: firstString(neighborhood.name),
    places: pois.slice(0, 5).map((p) => ({
      name: firstString(p.name),
      type: firstString(p.type).split(';').pop(),
      address: firstString(p.address),
      distance: Number(p.distance) || 0,
    })),
    roads: roads.slice(0, 3).map((x) => ({ name: firstString(x.name), distance: Number(x.distance) || 0 })),
  };
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

// 静态地图（P14 路线图）：参数由 server/routemap.js 拼，这里只管取二进制
async function staticMap(params = {}) {
  return amapGetBinary('/v3/staticmap', params);
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
  amapGetBinary,
  searchCity,
  searchPoi,
  searchPoiInArea,
  nearbyPoi,
  reverseGeocode,
  searchPoiByDistrict,
  searchPoiAround,
  districts,
  cityBoundary,
  parseDistrictRings,
  thinRing,
  capRing,
  poiDetail,
  normalizePoi,
  classifyType,
  parsePolyline,
  planWalking,
  planDriving,
  planTransit,
  staticMap,
  setConfig,
  setCategories,
  AmapError,
  AMAP_BASE,
};
