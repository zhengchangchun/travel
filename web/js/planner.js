/* 自动成线：把「住宿锚点 + 已挑的点」按距离排成有序行程（可闭环回住宿）
   纯函数，浏览器与 node 都能跑（geojs 依赖 web/js/geo.js，同目录） */
(function () {
  const Geo = (typeof window !== 'undefined' && window.TravelGeo) || (typeof require === 'function' ? require('./geo') : null);

  function keyOf(p) {
    return String((p && (p.id || p.poi_id)) || '');
  }

  function validPoint(p) {
    return !!(Geo.validLngLat ? Geo.validLngLat(p) : p && Number.isFinite(Number(p.lng)) && Number.isFinite(Number(p.lat)));
  }

  // 最近邻排序：从 start（住宿锚点；没给就用第一个点）出发，每次取剩下的最近点
  // - 坐标无效的点不参与排序，按原相对顺序附在末尾（不丢点）
  // - 平局用 id 字典序兜底，保证同一输入永远同一结果（可测）
  function orderStops(stops, opts) {
    const options = opts || {};
    const list = Array.isArray(stops) ? stops.slice() : [];
    const valid = [];
    const invalid = [];
    list.forEach((p) => (validPoint(p) ? valid.push(p) : invalid.push(p)));
    if (!valid.length) return invalid.slice();

    const start = validPoint(options.start) ? options.start : valid[0];
    const rest = valid.slice();
    const out = [];
    let from = start;
    while (rest.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      let bestKey = '';
      for (let i = 0; i < rest.length; i += 1) {
        const d = Geo.distanceM(from, rest[i]);
        const k = keyOf(rest[i]);
        if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && k < bestKey)) {
          bestIdx = i;
          bestD = d;
          bestKey = k;
        }
      }
      const pick = rest.splice(bestIdx, 1)[0];
      out.push(pick);
      from = pick;
    }
    return out.concat(invalid);
  }

  // 一串点的连线里程（米）；含未知距离的跳数
  function pathDistance(points) {
    const list = Array.isArray(points) ? points : [];
    let distanceM = 0;
    let hops = 0;
    let unknown = 0;
    for (let i = 1; i < list.length; i += 1) {
      const d = Geo.distanceM(list[i - 1], list[i]);
      if (Number.isFinite(d)) {
        distanceM += d;
        hops += 1;
      } else {
        unknown += 1;
      }
    }
    return { distanceM: Math.round(distanceM), hops, unknown };
  }

  // 完整计划：排序 + （可选）回到住宿；返回 waypoints（给路线用，含闭环那一段）
  // 注意：order 里不会重复塞住宿（它是起点，不是挑的点）；闭环只体现在 waypoints 末尾
  function planStops(opts) {
    const options = opts || {};
    const stops = Array.isArray(options.stops) ? options.stops : [];
    const start = validPoint(options.start) ? options.start : null;
    const order = orderStops(stops, { start: start || undefined });
    const startInPath = start && order.some((p) => keyOf(p) === keyOf(start));
    const waypoints = order.slice();
    const closed = !!(options.returnToStart && start && order.length);
    if (closed) waypoints.push(start);
    const dist = pathDistance(waypoints);
    return {
      order,
      waypoints,
      start,
      startInPath,
      closed,
      distanceM: dist.distanceM,
      hops: dist.hops,
      unknown: dist.unknown,
    };
  }

  const api = { orderStops, pathDistance, planStops, validPoint, keyOf };
  if (typeof window !== 'undefined') window.TravelPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
