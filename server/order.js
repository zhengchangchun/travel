/* 显式点序：前端把「按距离」算出来的顺序（或手动顺序）随请求带上，
   服务端按它重排 stops —— 分享包 / 行程单 / 静态路线图就与页面上看到的一模一样。

   key 与前端选中态同口径（web/js/selection.js::mapPin）：
   - 有 poi_id → poi_id 字符串
   - 没有（geocode 解析出来的点）→ pin:<pins.id>
   只认这一趟里真有的 key，漏下的按原相对顺序补在末尾（不丢点、不重复）。 */

function keyOfPin(pin) {
  if (!pin) return '';
  if (pin.poi_id != null) return String(pin.poi_id);
  if (pin.id != null) return 'pin:' + pin.id;
  return '';
}

function applyPoiOrder(pins, order) {
  const list = Array.isArray(pins) ? pins.slice() : [];
  if (!Array.isArray(order) || !order.length) return list;
  const byKey = new Map();
  list.forEach((p) => byKey.set(keyOfPin(p), p));
  const out = [];
  const used = new Set();
  order.forEach((raw) => {
    const key = String(raw);
    const hit = byKey.get(key);
    if (!hit || used.has(key)) return;
    used.add(key);
    out.push(hit);
  });
  list.forEach((p) => {
    const key = keyOfPin(p);
    if (used.has(key)) return;
    used.add(key);
    out.push(p);
  });
  return out;
}

// 逗号分隔的点序（query 里传过来）：给了就按它排；空值/全空白 → null（当没给）
function parseOrderCsv(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

module.exports = { applyPoiOrder, keyOfPin, parseOrderCsv };
