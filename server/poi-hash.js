// POI 内容指纹（hash）：高德不提供 ETag/版本号/更新时间的替代方案
// 口径＝把同一批字段归一化成 canonical 文本（固定字段顺序、null/空串同值、坐标 6 位）后 sha256。
// 唯一定义处：server/db.js（写库时算）、server/collect.js（对拍时算）都从这里引。
const crypto = require('node:crypto');

// 参与指纹的字段（顺序固定，改顺序＝改指纹口径 ⇒ 全库需回填）
const HASH_FIELDS = [
  'name',
  'address',
  'lng',
  'lat',
  'typecode',
  'category',
  'rating',
  'cost',
  'tel',
  'photos',
  'tags',
];

const SEP = '\u0001';

// 单字段归一：远端 POI 与库行都走这里，保证两边可比
function cmpVal(v, field) {
  if (field === 'photos' || field === 'tags') {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v == null || v === '' ? '[]' : String(v);
  }
  if (field === 'lng' || field === 'lat') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(6) : '';
  }
  return v == null ? '' : String(v);
}

// 一条 POI 的 canonical 文本（可读、可对拍；不含 fetched_at 等写入时间）
function canonicalPoi(poi) {
  return HASH_FIELDS.map((f) => cmpVal(poi ? poi[f] : undefined, f)).join(SEP);
}

// 一条 POI 的内容指纹（64 位 hex）
function contentHash(poi) {
  return crypto.createHash('sha256').update(canonicalPoi(poi)).digest('hex');
}

// 一批 POI / 库行的集合指纹：与顺序无关（排序后拼），同内容必同指纹
// items: [{ poi_id, hash }] 或 [{ id, ...poi }]（后者自行算 hash）
function setDigest(items) {
  const lines = (items || [])
    .map((it) => {
      const id = it && (it.poi_id || it.id);
      if (!id) return null;
      const h = it.hash ? String(it.hash) : contentHash(it);
      return `${id}:${h}`;
    })
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// 指纹短显示（状态栏用）
function shortHash(h) {
  return String(h || '').slice(0, 12);
}

module.exports = { HASH_FIELDS, SEP, cmpVal, canonicalPoi, contentHash, setDigest, shortHash };
