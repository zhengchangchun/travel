/* 评分过滤滑块（P10）：把「最低分」滑块的数值与过滤键来回换算。
   口径：0 ⇒ 不限（'all'）；5 ⇒ 只留满分（'top'，与列表里的星标同一口径）；其余 ⇒ '≥ N' 的 N。
   滑块一档 0.5 分。这里只放纯逻辑（不碰 DOM），方便单测。 */
(function () {
  const MAX = 5;
  const STEP = 0.5;

  function clampValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    const snapped = Math.round(n / STEP) * STEP;
    return Math.min(MAX, Math.max(0, snapped));
  }

  // 滑块位置 → 过滤键
  function valueToFilter(v) {
    const n = clampValue(v);
    if (n <= 0) return 'all';
    if (n >= MAX) return 'top';
    return n.toFixed(1);
  }

  // 过滤键 → 滑块位置（认不出来的键当「不限」）
  function filterToValue(filter) {
    if (!filter || filter === 'all') return 0;
    if (filter === 'top') return MAX;
    const n = Number(filter);
    return Number.isFinite(n) ? clampValue(n) : 0;
  }

  function labelOf(filter) {
    if (!filter || filter === 'all') return '不限';
    if (filter === 'top') return '★ 满分';
    return '≥ ' + filter;
  }

  function ariaOf(filter) {
    if (!filter || filter === 'all') return '不限评分';
    if (filter === 'top') return '只留满分';
    return '只看 ' + filter + ' 分及以上';
  }

  // 滑块已填充部分的百分比（给 CSS 用）
  function percentOf(v) {
    return (clampValue(v) / MAX) * 100 + '%';
  }

  window.TravelRating = { MAX, STEP, clampValue, valueToFilter, filterToValue, labelOf, ariaOf, percentOf };
})();
