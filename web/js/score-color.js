/* 评分色阶：色相=分类（不变），明度=评分（由浅入深）；满分金标单独一层 */
(function () {
  const TOP_RATING = 5.0; // 满分阈值（一行可改）
  const LIGHT = 72; // 低分/无评分：最浅
  const DARK = 34; // 满分：最深
  const RATING_MIN = 3.0;
  const RATING_MAX = 5.0;

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  function hexToHsl(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let hue = 0;
    let sat = 0;
    if (d !== 0) {
      sat = d / (1 - Math.abs(2 * l - 1));
      if (max === r) hue = ((g - b) / d) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: Math.round(hue), s: Math.round(sat * 100), l: Math.round(l * 100) };
  }

  function parseRating(rating) {
    if (rating === null || rating === undefined || rating === '') return null;
    const n = Number(rating);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // 评分 → 明度：无评分最浅；[3.0,5.0] 线性映射 72% → 34%
  function ratingToLightness(rating) {
    const n = parseRating(rating);
    if (n === null) return LIGHT;
    const t = clamp((n - RATING_MIN) / (RATING_MAX - RATING_MIN), 0, 1);
    return Math.round(LIGHT - t * (LIGHT - DARK));
  }

  function baseColor(categoryKey) {
    const cats = typeof window !== 'undefined' && window.TravelCategories;
    if (cats && typeof cats.colorOf === 'function') return cats.colorOf(categoryKey);
    return '#8A8F99';
  }

  function colorFor(categoryKey, rating) {
    const base = hexToHsl(baseColor(categoryKey));
    return 'hsl(' + base.h + ', ' + base.s + '%, ' + ratingToLightness(rating) + '%)';
  }

  function isTop(rating) {
    const n = parseRating(rating);
    return n !== null && n >= TOP_RATING;
  }

  window.TravelScoreColor = {
    TOP_RATING,
    LIGHT,
    DARK,
    RATING_MIN,
    RATING_MAX,
    hexToHsl,
    colorFor,
    isTop,
    ratingToLightness,
  };
})();
