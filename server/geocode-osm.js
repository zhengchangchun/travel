// OSM 地名补全兜底（Photon，公开、免 key）
//
// 为什么要有它：高德「基础搜索服务」是账号级月配额（个人 5000 次/月），额度用完时
// 笔记里的地名就补不出坐标 ⇒「按笔记搜地方」整条链断在最后一跳。这里给一个免 key 的兜底，
// 让这条链在没配额的时候也能跑通；**来源如实标注 OSM**，不与高德结果混为一谈。
//
// 礼节：官方要求低频（≤1 请求/秒）、带标识 UA；这里做 1.1s 间隔 + 单次最多 8 个名字。
const PHOTON_BASE = process.env.PHOTON_BASE || 'https://photon.komoot.io';
const UA = 'travel-planner/0.1 (personal trip planning; contact: local user)';
const MIN_INTERVAL_MS = 1100;

let lastCallAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CATEGORY_BY_OSM = {
  restaurant: 'food',
  cafe: 'food',
  fast_food: 'food',
  food_court: 'food',
  ice_cream: 'food',
  bar: 'play',
  pub: 'play',
  nightclub: 'play',
  hotel: 'stay',
  hostel: 'stay',
  guest_house: 'stay',
  motel: 'stay',
  attraction: 'sight',
  viewpoint: 'sight',
  museum: 'sight',
  artwork: 'sight',
  theme_park: 'play',
  park: 'play',
  garden: 'play',
  zoo: 'play',
  cinema: 'play',
  theatre: 'play',
};

function categoryOf(props) {
  return CATEGORY_BY_OSM[props.osm_value] || 'sight';
}

function addressOf(props) {
  const parts = [props.street, props.district, props.city, props.state]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(' ');
}

function normalizeFeature(f) {
  const coords = (f.geometry && f.geometry.coordinates) || [];
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  const props = f.properties || {};
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    id: 'osm:' + (props.osm_type || '') + (props.osm_id || ''),
    name: String(props.name || '').trim() || addressOf(props),
    address: addressOf(props),
    lng,
    lat,
    typecode: props.osm_value || '',
    type: props.osm_key || '',
    category: categoryOf(props),
    rating: '',
    cost: '',
    tel: '',
    photo: '',
    photos: [],
    tags: [props.osm_key, props.osm_value].filter(Boolean),
    source: 'osm',
  };
}

// 一个名字一次调用；失败抛错由调用方如实回报
async function searchOsm({ city, keywords, limit = 5, fetchImpl = globalThis.fetch } = {}) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  const q = city ? kw + ' ' + city : kw;
  const url = PHOTON_BASE + '/api/?q=' + encodeURIComponent(q) + '&limit=' + Math.max(1, Number(limit) || 5);
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('photon HTTP ' + res.status);
  const json = await res.json();
  const features = Array.isArray(json && json.features) ? json.features : [];
  return features.map(normalizeFeature).filter(Boolean);
}

// 名字归一：去空格、去常见标点、小写（中英混排都有）
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[()（）:：·\-_/、,，.。!！?？'"“”‘’「」]/g, '');
}

// OSM 只认「名字对得上」的：像「1% COFFEE」这种它会给一条无关街道，
// 宁可报「查不到」，也不能把乱七八糟的点钉到地图上（旅行规划里错点比没点更坏）。
function matchesName(query, name) {
  const q = normName(query);
  const n = normName(name);
  if (q.length < 2 || !n) return false;
  if (n === q) return true;
  if (n.includes(q) || q.includes(n)) return Math.min(q.length, n.length) >= 2;
  return false;
}

module.exports = {
  searchOsm,
  normalizeFeature,
  categoryOf,
  addressOf,
  matchesName,
  normName,
  PHOTON_BASE,
  MIN_INTERVAL_MS,
};
