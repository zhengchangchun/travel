/* 出行方式的小图标（一套自绘 SVG，14px 下也清楚）——
   驾车 / 骑行 / 步行 / 公交 各一个，颜色跟地图上那条路线一致（stroke 用 currentColor，
   由外面把 color 设成该方式的路线色）⇒ 看图标就知道那条线是哪一种。
   用法：TravelModeIcons.svg('riding', 14) → '<svg …>…</svg>' */
(function () {
  const BODY = {
    // 最快（不指定方式）：闪电
    auto: '<path d="M11.4 2.6 5.4 11h3.9l-.9 6.4 6.2-8.4h-4l.8-6.4Z"/>',
    // 车：车身 + 两个轮子
    driving:
      '<path d="M3 14.2h14"/>' +
      '<path d="M4.6 14.2 6 9.6a1.8 1.8 0 0 1 1.7-1.3h4.6a1.8 1.8 0 0 1 1.7 1.3l1.4 4.6"/>' +
      '<circle cx="6.8" cy="15.5" r="1.4"/>' +
      '<circle cx="13.2" cy="15.5" r="1.4"/>',
    // 骑车：两个轮子 + 车架 + 车座/把手
    riding:
      '<circle cx="4.9" cy="14" r="2.6"/>' +
      '<circle cx="15.1" cy="14" r="2.6"/>' +
      '<path d="M4.9 14 9 7.6h3.6l2.5 6.4"/>' +
      '<path d="M9 7.6H7.1"/>' +
      '<path d="M12.6 7.6h1.9"/>',
    // 步行：小人
    walking:
      '<circle cx="11.4" cy="4" r="1.9"/>' +
      '<path d="M10.8 7.4 9.6 11"/>' +
      '<path d="M9.6 11 8.5 15.7"/>' +
      '<path d="M9.6 11l2.8 1.4"/>' +
      '<path d="M12.4 12.4 13.5 15.7"/>' +
      '<path d="M10.8 8.4 8.3 9.8"/>' +
      '<path d="M10.8 8.4l2.6 1.2"/>',
    // 公交：车厢 + 车窗线 + 两个轮子
    transit:
      '<rect x="4.4" y="3.8" width="11.2" height="10.4" rx="2.2"/>' +
      '<path d="M4.4 9.6h11.2"/>' +
      '<circle cx="7.6" cy="15.5" r="1.2"/>' +
      '<circle cx="12.4" cy="15.5" r="1.2"/>',
  };

  function svg(key, size) {
    const body = BODY[key] || BODY.driving;
    const px = Number(size) > 0 ? Number(size) : 14;
    return (
      '<svg class="mode-icon" viewBox="0 0 20 20" width="' + px + '" height="' + px + '"' +
      ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"' +
      ' stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>'
    );
  }

  window.TravelModeIcons = { svg, keys: Object.keys(BODY) };
})();
