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

// ---- 多 key 轮换（2026-11-25）----
// 高德配额是按 key、按服务大类算的。一个 key 的某个服务用尽就换下一个 key，
// 不用重启、不用改代码。
//
// 口径（2026-11-25 实测 + 官方错误码表）：
//   · 只有「配额类」错误才换 key（USER_DAILY_QUERY_OVER_LIMIT / CALL_LIMIT / QPS 超限）；
//     参数错、key 无效这类换 key 也没用，直接抛。
//   · 用尽状态必须按「接口族」分开记：`place/*`（搜索）与 `geocode/*`（地理编码）
//     是两个独立的池子 —— 搜索用尽时地理编码通常还能用。早先只按 key 记，
//     多 key 时搜索一用尽就把整个 key 标死，连还能用的 geocode 一起跳过（真 bug，已修）。
//   · 换过的 key 记下来（exhausted），下次直接从下一个开始，不每次都撞一遍。
//   · 全部用尽 ⇒ 抛原来的配额错误（调用方照旧能识别）。
//   · 进程重启后 exhausted 清空（重启后重试一次是合理的）。
const QUOTA_INFOS = [
  'USER_DAILY_QUERY_OVER_LIMIT',
  'DAILY_QUERY_OVER_LIMIT',
  'CALL_LIMIT',
  'QPS_HAS_EXCEEDED_THE_LIMIT',
  'USER_QUERY_OVER_LIMIT',
];

// `${key}|${family}` → 用尽时间（毫秒）。只放内存，不落盘。
const exhaustedKeys = new Map();
// 下次从哪个 key 开始（轮询起点）
let keyCursor = 0;

function isQuotaInfo(info) {
  const s = String(info || '');
  return QUOTA_INFOS.some((q) => s.includes(q));
}

// 接口族：高德按「服务大类」分池，同一个池子里的接口共享额度。
// /v3/place/* 与 /v5/place/* 是同一个搜索池；/v3/geocode/* 是地理编码池；以此类推。
function familyOf(pathname) {
  const m = String(pathname || '').match(/^\/v\d+\/([a-z]+)\//i);
  return m ? m[1].toLowerCase() : 'other';
}

function exhaustedId(key, family) {
  return key + '|' + family;
}

function allKeys() {
  const cfg = config();
  const list = Array.isArray(cfg.amap.webServiceKeys) ? cfg.amap.webServiceKeys : [];
  if (list.length) return list;
  return cfg.amap.webServiceKey ? [cfg.amap.webServiceKey] : [];
}

// 按轮询顺序给出候选 key：从 cursor 开始转一圈，跳过这个接口族已用尽的
function candidateKeys(family) {
  const keys = allKeys();
  if (!keys.length) return [];
  const n = keys.length;
  const start = keyCursor % n;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const k = keys[(start + i) % n];
    if (!exhaustedKeys.has(exhaustedId(k, family))) out.push(k);
  }
  // 全用尽了：把全部 key 都返回（让调用方拿到真实的配额错误，而不是「没 key」）
  return out.length ? out : keys.slice();
}

function markExhausted(key, family) {
  exhaustedKeys.set(exhaustedId(key, family), Date.now());
  const keys = allKeys();
  const at = keys.indexOf(key);
  if (at >= 0) keyCursor = (at + 1) % Math.max(1, keys.length);
}

// 给 /api/health 与调试用：每个 key 的状态（不返回 key 本身，只给尾号）
// families 列出这个 key 在哪些接口族上已用尽 —— 搜索用尽不代表地理编码也用尽。
function keyStatus() {
  const keys = allKeys();
  const families = Array.from(
    new Set(Array.from(exhaustedKeys.keys()).map((id) => String(id).split('|')[1]))
  ).sort();
  return {
    total: keys.length,
    available: keys.filter((k) => !families.some((f) => exhaustedKeys.has(exhaustedId(k, f)))).length,
    families,
    keys: keys.map((k) => {
      const out = families.filter((f) => exhaustedKeys.has(exhaustedId(k, f)));
      return {
        tail: String(k).slice(-4),
        exhausted: out.length > 0,
        exhaustedFamilies: out,
        exhaustedAt: out.length
          ? new Date(Math.max(...out.map((f) => exhaustedKeys.get(exhaustedId(k, f))))).toISOString()
          : null,
      };
    }),
  };
}

// 手动清空「用尽」标记（配额恢复后不用重启）
function resetKeyStatus() {
  exhaustedKeys.clear();
  keyCursor = 0;
}

async function amapGet(pathname, params = {}) {
  const family = familyOf(pathname);
  const keys = candidateKeys(family);
  if (!keys.length) {
    throw new AmapError('没有配置高德 Web 服务 key', { infocode: 'NO_KEY', info: 'NO_KEY' });
  }
  let lastErr = null;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const url = new URL(AMAP_BASE + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, v);
    }
    url.searchParams.set('key', key);

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

    if (json.status === '1' && json.infocode === '10000') return json;

    const info = json.info || json.infocode || 'UNKNOWN';
    lastErr = new AmapError(String(info), { infocode: json.infocode, info: json.info });
    // 配额类错误 ⇒ 这个 key 的这个接口族用尽了，换下一个；
    // 其它错误（参数/key 无效）换也没用
    if (isQuotaInfo(info) && keys.length > 1) {
      markExhausted(key, family);
      continue;
    }
    throw lastErr;
  }
  throw lastErr || new AmapError('高德请求失败');
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

// ---------- 搜索池用尽时的兜底：geocode/geo + geocode/regeo（2026-11-25） ----------
//
// 为什么要有它：高德按服务大类分池。`place/*`（搜索）用尽时，`geocode/*`（地理编码）
// 通常还有额度 —— 实测同一天同一个 key：place/text 报 10044，而 geocode/geo 与
// geocode/regeo 连续 40 次全成功。所以「按名字找一个地方」这件事，搜索池没了也还能做。
//
// 两步：
//   ① geocode/geo 把名字换成坐标（level 是「兴趣点/门牌号」时坐标本身就可信）
//   ② geocode/regeo 拿这个坐标周边 30 个 POI（extensions=all），按名字匹配
// ② 比 ① 好：它给的是真 POI（有 id / 电话 / 类型 / 距离），能点开详情；
// ① 只在 ② 没匹配上时当「至少落一个点」的退路。
//
// 代价（必须如实说）：
//   · 只能「按名字找」，不能「按分类浏览」—— regeo 给的是坐标周边，不是全城
//   · 名字对不上就真的没有（不拿别的点凑，错点比没点更坏）
//   · geocode/geo 对部分商户名会返 ENGINE_RESPONSE_DATA_ERROR（实测楼外楼/知味观/外婆家），
//     这是高德自己的数据问题，不是配额，重试无用
const GEOCODE_MIN_INTERVAL_MS = 300;
let lastGeocodeAt = 0;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 名字归一：去空格/标点、小写（与 geocode-osm 的 normName 同口径，但不跨模块 require）
function normPlaceName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[()（）:：·\-_/、,，.。!！?？'"“”‘’「」【】\[\]]/g, '');
}

// 名字匹配等级（0 最好）：给排序用，不只是「匹不匹配」
//   0 = 完全相等
//   1 = 查询词是名字的前缀（「河坊街」vs「河坊街景区」、「灵隐寺」vs「灵隐寺-东经幢」）
//   2 = 查询词被名字包含（「断桥残雪」vs「杭州西湖风景名胜区-断桥残雪」）
//   3 = 不匹配
// 为什么要分前缀与包含：实测搜「河坊街」时，「景阳观(河坊街店)」距离 42m、
// 而「河坊街景区」102m —— 只按「包含 + 距离」会把餐馆顶到景区前面。
function nameMatchRank(query, name) {
  const q = normPlaceName(query);
  const n = normPlaceName(name);
  if (q.length < 2 || !n) return 3;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (q.startsWith(n) && n.length >= 2) return 1;
  // 包含匹配只对 ≥3 字的查询词开放：「西湖」会把「西湖国宾馆」「西湖文化广场」全命中，太宽
  if (q.length >= 3 && n.includes(q)) return 2;
  if (n.length >= 3 && q.includes(n)) return 2;
  return 3;
}

// 「这两个名字是不是同一个地方」（保留旧接口，语义＝等级 < 3）
function nameMatches(query, name) {
  return nameMatchRank(query, name) < 3;
}

// regeo 的 pois[] → 内部 POI 形状。注意它没有 typecode，只有 type 文本
// （「风景名胜;风景名胜;寺庙道观」）⇒ 分类走 classifyTypeText。
function normalizeRegeoPoi(raw = {}) {
  const location = String(raw.location || '');
  const [lngStr, latStr] = location.split(',');
  const lng = Number(lngStr);
  const lat = Number(latStr);
  return {
    id: firstString(raw.id),
    name: firstString(raw.name),
    address: firstString(raw.address),
    lng: Number.isFinite(lng) ? lng : null,
    lat: Number.isFinite(lat) ? lat : null,
    typecode: '',
    type: firstString(raw.type),
    category: classifyTypeText(raw.type),
    rating: '',
    cost: '',
    tel: firstString(raw.tel),
    opentime: '',
    photo: '',
    photos: [],
    tags: [],
    distance: Number(raw.distance) || 0,
    businessArea: firstString(raw.businessarea),
  };
}

// 按名字找地方（搜索池用尽时的兜底）。返回 { pois, via, geocode, rejected } 或抛错。
//   via='regeo'   ⇒ 来自周边 POI（有 id，可点详情）
//   via='geocode' ⇒ 只有坐标（regeo 没匹配上，但 geocode 的 level 可信）
//   via='none'    ⇒ 没找到（rejected 说明为什么被丢）
//
// anchors（可选）：同一条笔记里已经确认的点 [{lng,lat,name}]。
// 为什么需要它：geocode/geo 只按字面匹配、不知道上下文 —— 实测笔记里写「河坊街吃景阳观」，
// geocode 把「景阳观」解到了余杭区（同名 POI，离河坊街 15km）。
// 所以「level 可信就落点」这条退路必须加一道距离校验：离锚点太远就判可疑、不落点。
// 用户 2026-11-16 定的口径：错点比没点更坏。
//
// 阈值（2026-11-25 实测调过）：默认 10km —— 一趟行程里的点通常都在同一个城区。
// 实测「景阳观」被解到余杭区，离河坊街 16km，10km 能拦住。
// 但跨城行程（杭州→乌镇 80km）不能一律拒 ⇒ 阈值自适应：
// 取「锚点两两最大距离 × 1.5」，且不低于 10km。
const ANCHOR_BASE_KM = 10;
const ANCHOR_SPREAD_FACTOR = 1.5;

function kmBetween(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (Number(lat2) - Number(lat1)) * rad;
  const dLng = (Number(lng2) - Number(lng1)) * rad;
  const mid = ((Number(lat1) + Number(lat2)) / 2) * rad;
  const x = dLng * Math.cos(mid);
  return Math.sqrt(x * x + dLat * dLat) * R;
}

// 锚点允许半径：锚点越散（跨城行程）阈值越宽，但不低于 ANCHOR_BASE_KM
function anchorRadiusKm(anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  let spread = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const d = kmBetween(list[i].lng, list[i].lat, list[j].lng, list[j].lat);
      if (d > spread) spread = d;
    }
  }
  return Math.max(ANCHOR_BASE_KM, spread * ANCHOR_SPREAD_FACTOR);
}

async function searchPoiByGeocode({ city, keywords, radius = 1000, anchors = null } = {}) {
  const name = String(keywords == null ? '' : keywords).trim();
  if (!name) return { pois: [], via: 'none', geocode: null };

  // ① 名字 → 坐标
  const wait = GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastGeocodeAt);
  if (wait > 0) await sleepMs(wait);
  lastGeocodeAt = Date.now();
  const geoJson = await amapGet('/v3/geocode/geo', {
    address: name,
    city: city || '',
  });
  const geocodes = Array.isArray(geoJson.geocodes) ? geoJson.geocodes : [];
  if (!geocodes.length) return { pois: [], via: 'none', geocode: null };

  // 同名优先：geocode 可能给多条（灵隐寺在西湖区与富阳区各一个）
  const exact = geocodes.filter((g) => nameMatches(name, g.formatted_address));
  const g = (exact.length ? exact : geocodes)[0];
  const [lngStr, latStr] = String(g.location || '').split(',');
  const lng = Number(lngStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return { pois: [], via: 'none', geocode: null };
  }
  const geocode = {
    lng,
    lat,
    level: firstString(g.level),
    address: firstString(g.formatted_address),
    adcode: firstString(g.adcode),
  };

  // ② 坐标 → 周边 POI，按名字匹配
  const wait2 = GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastGeocodeAt);
  if (wait2 > 0) await sleepMs(wait2);
  lastGeocodeAt = Date.now();
  const reJson = await amapGet('/v3/geocode/regeo', {
    location: lng + ',' + lat,
    extensions: 'all',
    radius: Number(radius) || 1000,
  });
  const r = reJson && reJson.regeocode;
  const rawPois = r && Array.isArray(r.pois) ? r.pois : [];
  const matched = rawPois
    .filter((p) => nameMatches(name, p.name))
    .map(normalizeRegeoPoi)
    // 排序（2026-11-25 实测调过）：
    //   ① 名字匹配等级（相等 > 前缀 > 包含）—— 搜「河坊街」时「景阳观(河坊街店)」
    //      距离 42m 但只是包含匹配，不该顶掉 102m 的「河坊街景区」
    //   ② 有分类的优先 —— 分类空的是「临街院门」「住宅小区」这类，不是用户要找的地方
    //   ③ 最后才按距离近
    .sort((a, b) => {
      const ra = nameMatchRank(name, a.name);
      const rb = nameMatchRank(name, b.name);
      if (ra !== rb) return ra - rb;
      const ca = a.category ? 0 : 1;
      const cb = b.category ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return a.distance - b.distance;
    });

  if (matched.length) return { pois: matched, via: 'regeo', geocode };

  // ③ regeo 没匹配上：level 是「兴趣点/门牌号」时坐标本身可信，至少落一个点。
  //    但必须过锚点校验 —— 否则会把「景阳观」落到 15km 外的余杭区同名 POI。
  const TRUSTED_LEVELS = ['兴趣点', '门牌号'];
  if (TRUSTED_LEVELS.includes(geocode.level)) {
    const list = Array.isArray(anchors)
      ? anchors.filter((a) => a && Number.isFinite(a.lng) && Number.isFinite(a.lat))
      : [];
    if (list.length) {
      const nearest = list
        .map((a) => ({ name: a.name, km: kmBetween(lng, lat, a.lng, a.lat) }))
        .sort((x, y) => x.km - y.km)[0];
      const limit = anchorRadiusKm(list);
      if (nearest.km > limit) {
        return {
          pois: [],
          via: 'none',
          geocode,
          rejected: `离「${nearest.name}」${nearest.km.toFixed(0)}km（超过 ${limit.toFixed(0)}km），判为同名异地（不落错点）`,
        };
      }
    }
    return {
      pois: [
        {
          id: '',
          name,
          address: geocode.address,
          lng,
          lat,
          typecode: '',
          type: '',
          category: null,
          rating: '',
          cost: '',
          tel: '',
          opentime: '',
          photo: '',
          photos: [],
          tags: [],
          distance: 0,
          businessArea: '',
        },
      ],
      via: 'geocode',
      geocode,
    };
  }
  return { pois: [], via: 'none', geocode };
}

// 营业时间（2026-11-25）：只实时取、不落库。
// 为什么单独一个函数：营业时间会变（换季、临时闭馆、节假日调整），存进库里第二天就是错的；
// 而且用户明确要求「每个人上来都能实时读取」。所以这条链不经过任何缓存层。
//
// 优先 v5（show_fields=business 给 opentime_today / opentime_week，比 v3 的 biz_ext 全），
// v5 不可用（额度/权限）时退回 v3 的 biz_ext.opentime2。两边都拿不到就返回 null，
// 由调用方决定「不显示」而不是显示一个空壳。
async function poiBusiness(id) {
  const poiId = String(id == null ? '' : id).trim();
  if (!poiId) return null;
  // 两个失败原因必须分开报（2026-11-25 实测踩到）：
  //   「额度用尽」≠「这个地点没有营业时间」—— 前者明天就有了，后者永远没有。
  // 混在一起会让用户以为这个地点没营业时间，实际只是今天查不了。
  let lastErr = null;
  try {
    const json = await amapGet('/v5/place/detail', { id: poiId, show_fields: 'business' });
    const pois = Array.isArray(json.pois) ? json.pois : [];
    if (pois.length) {
      const p = pois[0] || {};
      const b = p.business || {};
      const today = firstString(b.opentime_today);
      const week = firstString(b.opentime_week);
      if (today || week) {
        return {
          id: firstString(p.id) || poiId,
          name: firstString(p.name),
          opentimeToday: today,
          opentimeWeek: week,
          tel: firstString(b.tel),
          rating: firstString(b.rating),
          cost: firstString(b.cost),
          keytag: firstString(b.keytag),
          source: 'amap-v5',
        };
      }
      // v5 通了但没这两个字段 ⇒ 这个地点确实没营业时间（住宿类常见）
      return null;
    }
  } catch (err) {
    lastErr = err;
  }
  try {
    const json = await amapGet('/v3/place/detail', { id: poiId, extensions: 'all' });
    const pois = Array.isArray(json.pois) ? json.pois : [];
    if (!pois.length) return null;
    const p = pois[0] || {};
    const biz = p.biz_ext || {};
    const week = firstString(biz.opentime2) || firstString(biz.opentime);
    if (!week) return null;
    return {
      id: firstString(p.id) || poiId,
      name: firstString(p.name),
      opentimeToday: '',
      opentimeWeek: week,
      tel: firstString(p.tel),
      rating: firstString(biz.rating),
      cost: firstString(biz.cost),
      keytag: '',
      source: 'amap-v3',
    };
  } catch (err) {
    lastErr = lastErr || err;
  }
  // 两边都失败：把原因抛出去（额度用尽 / 网络 / 权限），让路由如实报
  if (lastErr) throw lastErr;
  return null;
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
      // v3：distance / duration；v5：step_distance / cost.duration
      distance: Number(s.distance) || Number(s.step_distance) || 0,
      duration: Number(s.duration) || Number((s.cost && s.cost.duration) || 0) || 0,
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

// 骑行：v3 的 /direction/bicycling 对个人 key 是 SERVICE_NOT_AVAILABLE，
// v5（返回结构同 v3 的 route.paths[0]）打得通 —— 2026-11-17 实测，别再按老笔记当它不可用。
async function planRiding(origin, destination) {
  const json = await amapGet('/v5/direction/bicycling', {
    origin,
    destination,
    show_fields: 'cost,polyline',
  });
  return normalizePathRoute(json, 'riding');
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
  // 多 key 轮换（2026-11-25）
  keyStatus,
  resetKeyStatus,
  isQuotaInfo,
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
  poiBusiness,
  searchPoiByGeocode,
  normalizeRegeoPoi,
  nameMatches,
  nameMatchRank,
  normPlaceName,
  kmBetween,
  anchorRadiusKm,
  ANCHOR_BASE_KM,
  familyOf,
  normalizePoi,
  classifyType,
  parsePolyline,
  planWalking,
  planRiding,
  planDriving,
  planTransit,
  staticMap,
  setConfig,
  setCategories,
  AmapError,
  AMAP_BASE,
};
