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
    photo: photos.length ? firstString(photos[0].url) : '',
    tags,
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

async function poiDetail(id) {
  const json = await amapGet('/v3/place/detail', { id, extensions: 'all' });
  const pois = Array.isArray(json.pois) ? json.pois : [];
  return pois.length ? normalizePoi(pois[0]) : null;
}

module.exports = {
  amapGet,
  searchCity,
  searchPoi,
  nearbyPoi,
  poiDetail,
  normalizePoi,
  classifyType,
  setConfig,
  setCategories,
  AmapError,
  AMAP_BASE,
};
