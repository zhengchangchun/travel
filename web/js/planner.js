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

  // 2-opt 改进：把「先往东跑到最远、再掉头横穿回西边」这种折返拆掉。
  // - 起点固定（用户定的出发地不动），只试「把 i..j 这一段倒过来」
  // - 只接受严格变短的交换（> 1e-9）⇒ 结果单调不反弹，同一输入永远同一结果
  // - 点很少（用户挑的点通常 <20），一遍遍扫到没有改进为止，代价可忽略
  function twoOpt(path, maxPass) {
    const n = path.length;
    if (n < 4) return path.slice(); // 3 个点以内，最近邻已经是最短的
    const out = path.slice();
    const passes = Math.max(1, Number(maxPass) || 8);
    for (let pass = 0; pass < passes; pass += 1) {
      let improved = false;
      for (let i = 1; i < n - 1; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const prev = out[i - 1];
          const head = out[i];
          const tail = out[j];
          const next = j + 1 < n ? out[j + 1] : null;
          const before = Geo.distanceM(prev, head) + (next ? Geo.distanceM(tail, next) : 0);
          const after = Geo.distanceM(prev, tail) + (next ? Geo.distanceM(head, next) : 0);
          if (!(after < before - 1e-9)) continue;
          for (let lo = i, hi = j; lo < hi; lo += 1, hi -= 1) {
            const tmp = out[lo];
            out[lo] = out[hi];
            out[hi] = tmp;
          }
          improved = true;
        }
      }
      if (!improved) break;
    }
    return out;
  }

  // 排序：从 start（住宿锚点；没给就用第一个点）出发的最近邻，再走一轮 2-opt 把折返拆掉
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
    return twoOpt(out, 8).concat(invalid);
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

  const api = { orderStops, twoOpt, pathDistance, planStops, validPoint, keyOf };
  if (typeof window !== 'undefined') window.TravelPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
