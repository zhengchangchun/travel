/* 地理小工具：以「住宿锚点」为中心的周边框/距离/方位（前后端共用口径，可单测） */
(function () {
  const EARTH_R = 6371008.8; // 平均地球半径（米）
  const DEG_LAT_M = 111320; // 1 度纬度 ≈ 米

  function toRad(d) {
    return (Number(d) * Math.PI) / 180;
  }

  // 严格数值解析：null/undefined/空串/非数字一律 NaN（注意 Number(null)===0 会误判成 (0,0)）
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  // 坐标是否可用
  function validLngLat(p) {
    if (!p) return false;
    return Number.isFinite(num(p.lng)) && Number.isFinite(num(p.lat));
  }

  // 两点球面距离（米）——haversine
  function distanceM(a, b) {
    if (!a || !b) return null;
    const lng1 = num(a.lng);
    const lat1 = num(a.lat);
    const lng2 = num(b.lng);
    const lat2 = num(b.lat);
    if (![lng1, lat1, lng2, lat2].every((n) => Number.isFinite(n))) return null;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // 以中心点 + 半径（米）算一个经纬矩形：周边搜索就按这个框查（正好命中后端 bbox 口径）
  function bboxAround(center, radiusM) {
    if (!center) return null;
    const lng = num(center.lng);
    const lat = num(center.lat);
    const r = Math.max(1, Number(radiusM) || 1000);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const dLat = r / DEG_LAT_M;
    const cos = Math.max(0.01, Math.cos(toRad(lat)));
    const dLng = r / (DEG_LAT_M * cos);
    return {
      minLng: Number((lng - dLng).toFixed(6)),
      minLat: Number((lat - dLat).toFixed(6)),
      maxLng: Number((lng + dLng).toFixed(6)),
      maxLat: Number((lat + dLat).toFixed(6)),
    };
  }

  // bbox → 查询串（后端 /api/poi/inview 的口径：minLng,minLat,maxLng,maxLat）
  function bboxQuery(bbox) {
    if (!bbox) return null;
    return [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat].join(',');
  }

  // 点是否在框内（前端本地裁剪用）
  function inBbox(p, bbox) {
    if (!p || !bbox) return false;
    const lng = num(p.lng);
    const lat = num(p.lat);
    return (
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lng >= bbox.minLng &&
      lng <= bbox.maxLng &&
      lat >= bbox.minLat &&
      lat <= bbox.maxLat
    );
  }

  // 距离人话（列表里显示「距住宿 320m / 1.2km」）
  function humanDistance(m) {
    const n = Number(m);
    if (!Number.isFinite(n)) return '';
    if (n < 1000) return Math.round(n) + ' m';
    return (n / 1000).toFixed(1) + ' km';
  }

  const api = { EARTH_R, DEG_LAT_M, num, validLngLat, distanceM, bboxAround, bboxQuery, inBbox, humanDistance };
  if (typeof window !== 'undefined') window.TravelGeo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
