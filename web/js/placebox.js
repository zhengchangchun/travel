/* 右栏「加地点」输入框的纯逻辑（与 citybox.js 同型，但语义是「加进我的选择」，不是切城市）。
   只放纯逻辑（不碰 DOM），方便单测：
     buildOptions(results, {limit, isSelected})  搜索结果 → 下拉项
     moveActive(active, delta, len)              上下键高亮（首尾循环）
     pickIndex(options, active)                  回车确认时选哪一项
     statusText / emptyText                      下拉顶部 / 空态那一行
   下拉项形状：{ key, poi, name, sub, selected }
   key 与 Selection 同口径（id / poi_id / 名字@坐标），点一次就知道这段路有没有加过。 */
(function () {
  const SUB_MAX = 34;

  function trim(v) {
    return String(v == null ? '' : v).trim();
  }

  function clip(s, n) {
    const t = trim(s);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function keyOf(poi) {
    if (!poi) return '';
    if (poi.id != null) return String(poi.id);
    if (poi.poi_id != null) return String(poi.poi_id);
    return trim(poi.name) + '@' + poi.lng + ',' + poi.lat;
  }

  // 分类中文名从 TravelCategories 拿（页面里一定有；单测里没有就退回原 key）
  function categoryLabel(key) {
    const cats = typeof window !== 'undefined' && window.TravelCategories;
    if (cats && typeof cats.labelOf === 'function') return trim(cats.labelOf(key));
    return trim(key);
  }

  // 副标题：分类 · 评分 · 人均 · 地址（地址最常见也最长，放最后并截断）
  function subOf(poi) {
    const parts = [
      categoryLabel(poi && poi.category),
      poi && poi.rating ? '★ ' + poi.rating : '',
      poi && poi.cost ? '¥' + poi.cost : '',
    ].filter(Boolean);
    const addr = clip(poi && poi.address, SUB_MAX);
    const head = parts.join(' · ');
    if (!addr) return head;
    return head ? head + ' · ' + addr : addr;
  }

  function buildOptions(results, opts) {
    const o = opts || {};
    const limit = Math.max(1, Number(o.limit) || 6);
    const isSelected = typeof o.isSelected === 'function' ? o.isSelected : () => false;
    const out = [];
    const seen = {};
    (Array.isArray(results) ? results : []).forEach((p) => {
      if (!p || !trim(p.name)) return;
      const key = keyOf(p);
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({
        key,
        poi: p,
        name: trim(p.name),
        sub: subOf(p),
        selected: !!isSelected(p),
      });
    });
    return out.slice(0, limit);
  }

  function moveActive(active, delta, len) {
    const n = Number(len) || 0;
    if (n <= 0) return -1;
    let cur = Number(active);
    if (!Number.isFinite(cur) || cur < 0) cur = delta >= 0 ? -1 : 0;
    let next = cur + (Number(delta) || 0);
    if (next < 0) next = n - 1;
    if (next >= n) next = 0;
    return next;
  }

  // 回车：有高亮就用它，否则用第一条（省一次上下键）
  function pickIndex(options, active) {
    const opts = Array.isArray(options) ? options : [];
    if (!opts.length) return -1;
    const a = Number(active);
    if (Number.isInteger(a) && a >= 0 && a < opts.length) return a;
    return 0;
  }

  function statusText(count, query) {
    const n = Number(count) || 0;
    if (!n) return '';
    const q = trim(query);
    return (q ? '找到 ' + n + ' 个地点' : n + ' 个地点') + ' · ↑↓ 选，回车加入';
  }

  function emptyText(query) {
    const q = trim(query);
    return q
      ? '没找到「' + clip(q, 20) + '」· 换个写法（如 西湖 / 之江实验室）'
      : '输入地点名，回车加入「我的选择」';
  }

  window.TravelPlaceBox = {
    keyOf,
    subOf,
    buildOptions,
    moveActive,
    pickIndex,
    statusText,
    emptyText,
  };
})();
