/* 单点详情视图：把缓存行 / 高德结构统一成前端要的形状（照片判定 / 标签解析 / 跳转 url） */
const AMAP_DETAIL_BASE = 'https://www.amap.com/detail/';

function isCommentPhoto(url) {
  return String(url == null ? '' : url).includes('aos-comment');
}

function safeParseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// 每张图 → {url, isComment, source:"amap"}；过滤空 url，保持原序
function buildPhotos(urls) {
  return safeParseArray(urls)
    .map((u) => (typeof u === 'string' ? u : (u && u.url) || ''))
    .filter(Boolean)
    .map((url) => ({ url, isComment: isCommentPhoto(url), source: 'amap' }));
}

// 标签：按逗号切、去空、去重、最多 12 个（兼容数组 / 逗号字符串 / JSON 数组字符串）
function parseTags(raw) {
  let list = raw;
  if (!Array.isArray(list)) {
    const s = raw == null ? '' : String(raw).trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        list = Array.isArray(parsed) ? parsed : [s];
      } catch (err) {
        list = [s];
      }
    } else {
      list = [s];
    }
  }
  const seen = new Set();
  const out = [];
  list.forEach((item) => {
    String(item)
      .split(',')
      .forEach((t) => {
        const v = t.trim();
        if (!v || seen.has(v)) return;
        seen.add(v);
        out.push(v);
      });
  });
  return out.slice(0, 12);
}

function amapDetailUrl(poiId) {
  return AMAP_DETAIL_BASE + String(poiId == null ? '' : poiId);
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 统一详情结构：兼容 db 行（photos/tags 为 JSON 字符串）与高德结构（数组）
function toDetail(input, poiId) {
  const src = input || {};
  const id = src.poi_id || src.id || poiId;
  return {
    poi_id: id,
    name: src.name || '',
    category: src.category || '',
    address: src.address || '',
    lng: toNumberOrNull(src.lng),
    lat: toNumberOrNull(src.lat),
    rating: src.rating || '',
    cost: src.cost || '',
    tel: src.tel || '',
    opentime: src.opentime || '',
    photos: buildPhotos(src.photos),
    tags: parseTags(src.tags),
    amapUrl: amapDetailUrl(id),
  };
}

module.exports = {
  AMAP_DETAIL_BASE,
  isCommentPhoto,
  buildPhotos,
  parseTags,
  amapDetailUrl,
  toDetail,
};
