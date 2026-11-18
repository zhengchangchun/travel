/* 实时耗时估算（P11）：选中点的顺序一变，就按出行方式算相邻两点之间要多久。
   两条路：
     ① 立刻用「直线距离 × 绕行系数 ÷ 平均速度」给一版估计（带 ≈），界面不等网络；
     ② 真路线（服务端 /api/itinerary/route）回来后再替换成实测值（去掉 ≈）。
   这里只放纯计算，不碰 DOM、不发请求，方便单测。 */
(function () {
  // 绕行系数与平均速度都按「城市内日常出行」取值，只用于估算；颜色与 route.js / map.js 同一套
  const MODES = [
    { key: 'driving', label: '驾车', detour: 1.35, kmh: 26, color: '#1677ff' },
    { key: 'riding', label: '骑行', detour: 1.25, kmh: 15, color: '#e8760c' },
    { key: 'walking', label: '步行', detour: 1.18, kmh: 4.8, color: '#22a06b' },
    { key: 'transit', label: '公交', detour: 1.55, kmh: 16, color: '#8a6cf0' },
  ];

  function modeMeta(key) {
    for (let i = 0; i < MODES.length; i += 1) {
      if (MODES[i].key === key) return MODES[i];
    }
    return MODES[0];
  }

  function minutes(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s) || s <= 0) return 0;
    return Math.max(1, Math.round(s / 60));
  }

  function fmtDistance(m) {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1000) return Math.round(n) + ' m';
    return (n / 1000).toFixed(1) + ' km';
  }

  // 一段：两点直线距离 → 该出行方式的里程与用时
  function estimateLeg(a, b, mode) {
    const Geo = window.TravelGeo;
    const meta = modeMeta(mode);
    const straight = Geo && typeof Geo.distanceM === 'function' ? Geo.distanceM(a, b) : NaN;
    if (!Number.isFinite(straight) || straight <= 0) {
      return { ok: false, estimate: true, distance: 0, duration: 0 };
    }
    const distance = Math.round(straight * meta.detour);
    const duration = Math.round(distance / ((meta.kmh * 1000) / 3600));
    return { ok: false, estimate: true, distance, duration };
  }

  // 相邻点逐段估（legs[i] 对应「第 i+1 个点 → 第 i+2 个点」，所以 n 个点有 n-1 段）
  function estimateLegs(pins, mode) {
    const list = Array.isArray(pins) ? pins : [];
    const legs = [];
    for (let i = 1; i < list.length; i += 1) legs.push(estimateLeg(list[i - 1], list[i], mode));
    return legs;
  }

  // 单段文案：「≈ 12 分 · 3.2 km」（估算带 ≈；拿不到用时就说不知道）
  function legText(leg) {
    if (!leg) return '';
    const mins = minutes(leg.duration);
    if (!mins) return '耗时未知';
    return (leg.estimate ? '≈ ' : '') + mins + ' 分 · ' + fmtDistance(leg.distance);
  }

  // 汇总文案：「驾车 ≈ 38 分 · 15.4 km · 5 段」（o.label 可覆盖方式名，如「最快」）
  function summarize(legs, mode, opts) {
    const list = Array.isArray(legs) ? legs : [];
    const o = opts || {};
    const meta = modeMeta(mode);
    if (!list.length) return '';
    let dist = 0;
    let dur = 0;
    let unknown = 0;
    let estimated = false;
    list.forEach((leg) => {
      if (!leg) return;
      dist += Number(leg.distance) || 0;
      dur += Number(leg.duration) || 0;
      if (!leg.duration) unknown += 1;
      if (leg.estimate) estimated = true;
    });
    const bits = [o.label || meta.label];
    if (estimated || o.estimate) bits.push('≈');
    bits.push(minutes(dur) ? minutes(dur) + ' 分' : '耗时未知');
    if (dist > 0) bits.push(fmtDistance(dist));
    bits.push(list.length + ' 段');
    if (unknown) bits.push(unknown + ' 段没算出来');
    return bits.join(' ');
  }

  window.TravelQuickRoute = {
    MODES,
    modeMeta,
    estimateLeg,
    estimateLegs,
    legText,
    summarize,
    minutes,
    fmtDistance,
  };
})();
