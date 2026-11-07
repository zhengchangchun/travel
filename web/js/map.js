/* 高德地图封装：动态加载 SDK、按分类着色落旗、飞行定位、清旗 */
(function () {
  let map = null;
  let AMap = null;
  const markers = new Map();
  let baseId = null; // 住宿锚点的 poi_id（旗子单独高亮）
  let clickHandler = null;
  let markerBatch = 0; // 分批落旗的批次号：新批次会取消未画完的旧批次

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function poiKey(poi) {
    return poi.id || poi.name + '@' + poi.lng + ',' + poi.lat;
  }

  // 悬停说明：把「为什么这面旗子不一样」直接写出来（满分？住宿锚点？）
  function flagTitle(poi, top, isBase) {
    const bits = [poi.name];
    if (poi.rating) bits.push('★' + poi.rating + (top ? '（满分）' : ''));
    else bits.push('（高德无评分）');
    if (isBase) bits.push('住宿锚点');
    return bits.join(' · ');
  }

  function flagHtml(poi, selected) {
    const SC = window.TravelScoreColor;
    const color = SC
      ? SC.colorFor(poi.category, poi.rating)
      : window.TravelCategories.colorOf(poi.category);
    const label = window.TravelCategories.labelOf(poi.category);
    const top = SC ? SC.isTop(poi.rating) : false;
    const noRating = !poi.rating;
    const isBase = !!baseId && (poi.id === baseId || poi.poi_id === baseId);
    return (
      '<div class="flag' + (selected ? ' selected' : '') + (top ? ' top' : '') +
      (noRating ? ' no-rating' : '') + (isBase ? ' base' : '') + '" data-category="' +
      esc(poi.category) + '" ' +
      'style="--flag-color:' + esc(color) + '" title="' + esc(flagTitle(poi, top, isBase)) + '">' +
      '<div class="flag-head"><span class="flag-icon">' + esc(label.slice(0, 1)) + '</span></div>' +
      '<div class="flag-tail"></div>' +
      (selected ? '<span class="flag-star">★</span>' : '') +
      (top ? '<span class="flag-crown">★</span>' : '') +
      (isBase ? '<span class="flag-base">住</span>' : '') +
      '</div>'
    );
  }

  function loadSdk(cfg) {
    return new Promise((resolve, reject) => {
      if (window.AMap) {
        resolve(window.AMap);
        return;
      }
      if (cfg.jsApiSecurityCode) {
        window._AMapSecurityConfig = { securityJsCode: cfg.jsApiSecurityCode };
      }
      const script = document.createElement('script');
      script.src =
        'https://webapi.amap.com/maps?v=2.0&key=' +
        encodeURIComponent(cfg.jsApiKey || '') +
        '&plugin=AMap.Geocoder,AMap.PlaceSearch';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled || window.AMap) return;
        settled = true;
        reject(new Error('高德地图 SDK 加载超时，请检查网络或 Key'));
      }, 15000);
      script.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (window.AMap) resolve(window.AMap);
        else reject(new Error('高德 SDK 已加载但未挂载 AMap'));
      };
      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('高德地图 SDK 加载失败（检查网络 / JS API Key）'));
      };
      document.head.appendChild(script);
    });
  }

  async function init(el, cfg) {
    AMap = await loadSdk(cfg);
    map = new AMap.Map(el, {
      zoom: 11,
      center: [120.15507, 30.27415],
      viewMode: '2D',
      // 暗色主题：底图也跟着走暗色（不改的话深色界面里会嵌一块惨白地图）
      mapStyle: 'amap://styles/dark',
    });
    window.addEventListener('resize', onWindowResize);
    return map;
  }

  function isReady() {
    return !!map;
  }

  function getMap() {
    return map;
  }

  // 容器尺寸变化（窗口缩放 / 右栏折叠）后重算画布，避免灰块与错位
  function resize() {
    if (map && typeof map.resize === 'function') map.resize();
  }

  let resizeTimer = null;
  function onWindowResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  }

  function clearMarkers() {
    markerBatch += 1; // 取消未完成的分批渲染
    if (!map) return;
    const all = Array.from(markers.values());
    markers.clear();
    if (!all.length) return;
    try {
      if (typeof map.remove === 'function' && all.length > 1) {
        map.remove(all); // 批量摘旗：逐面 remove 在几千面时会卡住
        return;
      }
    } catch (err) {
      /* 批量失败：退回逐面摘 */
    }
    all.forEach((m) => map.remove(m));
  }

  function addMarker(poi, selected) {
    if (!map) return null;
    const key = poiKey(poi);
    if (markers.has(key)) return markers.get(key);
    const marker = new AMap.Marker({
      position: [poi.lng, poi.lat],
      content: flagHtml(poi, selected),
      offset: new AMap.Pixel(-13, -34),
      extData: { poi },
      zIndex: selected ? 200 : 100,
    });
    marker.on('click', () => {
      if (clickHandler) clickHandler(poi);
    });
    marker.setMap(map);
    markers.set(key, marker);
    return marker;
  }

  // 建旗子但先不上图（批量 append 用：一批一次 map.add，逐面 setMap 会慢一个量级）
  function createMarker(poi, selected) {
    if (!map) return null;
    const key = poiKey(poi);
    if (markers.has(key)) return null;
    const marker = new AMap.Marker({
      position: [poi.lng, poi.lat],
      content: flagHtml(poi, selected),
      offset: new AMap.Pixel(-13, -34),
      extData: { poi },
      zIndex: selected ? 200 : 100,
    });
    marker.on('click', () => {
      if (clickHandler) clickHandler(poi);
    });
    markers.set(key, marker);
    return marker;
  }

  // 一批旗子一起上图：map.add(数组) 只触发一次内部刷新，比一面一面 setMap 快得多
  function addChunk(items, isSelected) {
    if (!map) return 0;
    const batch = [];
    (items || []).forEach((p) => {
      const m = createMarker(p, isSelected ? isSelected(p) : false);
      if (m) batch.push(m);
    });
    if (!batch.length) return 0;
    try {
      if (typeof map.add === 'function') {
        map.add(batch);
        return batch.length;
      }
    } catch (err) {
      /* 批量失败：退回逐面上图 */
    }
    batch.forEach((m) => m.setMap(map));
    return batch.length;
  }

  // 分批落旗：视野内点很多时不抽稀，但分帧 append，避免主线程卡死
  const MARKER_CHUNK = 200;

  // 落旗上限（P9-③）：一个分类动辄几千个点，全画会把地图埋掉（旗子盖满、底图看不清）。
  // 超出后优先保「已选中的点 + 住宿锚点」，其余按传入顺序截断，并回报 dropped 让上层说明。
  const MARKER_LIMIT = 500;

  function poiIdOf(p) {
    return p ? p.id || p.poi_id || null : null;
  }

  function isBasePoi(p) {
    const id = poiIdOf(p);
    return !!baseId && !!id && id === baseId;
  }

  function capList(list, isSelected) {
    const items = Array.isArray(list) ? list : [];
    if (items.length <= MARKER_LIMIT) return { items, dropped: 0 };
    const must = [];
    const rest = [];
    items.forEach((p) => {
      const keep = (isSelected ? !!isSelected(p) : false) || isBasePoi(p);
      (keep ? must : rest).push(p);
    });
    const room = Math.max(0, MARKER_LIMIT - must.length);
    const shown = must.concat(rest.slice(0, room));
    return { items: shown, dropped: items.length - shown.length };
  }

  function markerLimit() {
    return MARKER_LIMIT;
  }

  function setMarkers(list, isSelected) {
    if (!map) return { shown: 0, dropped: 0 };
    clearMarkers();
    const token = markerBatch;
    const capped = capList(list, isSelected);
    const items = capped.items;
    let i = 0;
    const step = () => {
      if (token !== markerBatch) return; // 已被新批次取代，丢弃
      const end = Math.min(i + MARKER_CHUNK, items.length);
      addChunk(items.slice(i, end), isSelected);
      i = end;
      if (i < items.length) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(step, 0);
      }
    };
    step();
    return { shown: items.length, dropped: capped.dropped };
  }

  // 增量同步：只 补新增 / 删消失，保留不动的旗子（移动地图时不整屏重画，避免闪烁）
  // 新增的旗子同样分帧 append（MARKER_CHUNK/帧）：一个分类动辄上千个点，
  // 一次同步建完会把主线程堵死好几秒，界面像卡死。
  // 返回 { added, removed, kept }：added 是本次排队的数量（分帧画完，非瞬时值）
  function syncMarkers(list, isSelected) {
    if (!map) return { added: 0, removed: 0, kept: 0, shown: 0, dropped: 0 };
    const capped = capList(list, isSelected);
    const items = capped.items;
    const wanted = new Map();
    items.forEach((p) => {
      const k = poiKey(p);
      if (!wanted.has(k)) wanted.set(k, p);
    });
    let removed = 0;
    const gone = [];
    Array.from(markers.keys()).forEach((k) => {
      if (wanted.has(k)) return;
      gone.push(markers.get(k));
      markers.delete(k);
      removed += 1;
    });
    if (gone.length) {
      try {
        if (gone.length > 1 && typeof map.remove === 'function') map.remove(gone);
        else gone.forEach((m) => map.remove(m));
      } catch (err) {
        /* 已不在图上：忽略 */
      }
    }
    const toAdd = [];
    wanted.forEach((p, k) => {
      if (!markers.has(k)) toAdd.push(p);
    });
    markerBatch += 1; // 新批次生效：未画完的旧批次停手
    const token = markerBatch;
    let i = 0;
    const step = () => {
      if (token !== markerBatch) return; // 已被新批次取代，丢弃
      const end = Math.min(i + MARKER_CHUNK, toAdd.length);
      addChunk(toAdd.slice(i, end), isSelected);
      i = end;
      if (i < toAdd.length) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(step, 0);
      }
    };
    step();
    return {
      added: toAdd.length,
      removed,
      kept: markers.size,
      shown: items.length,
      dropped: capped.dropped,
    };
  }

  // 增量落旗：只补尚无的旗子（不整体重画，避免闪烁）。返回新增数量。
  function addMarkers(list, isSelected) {
    if (!map) return 0;
    const items = list || [];
    let added = 0;
    for (let i = 0; i < items.length; i += 1) {
      const before = markers.size;
      addMarker(items[i], isSelected ? isSelected(items[i]) : false);
      if (markers.size > before) added += 1;
    }
    return added;
  }

  function markerCount() {
    return markers.size;
  }

  function fitView() {
    if (!map || markers.size === 0) return;
    map.setFitView(Array.from(markers.values()));
  }

  // 把相机落到指定经纬框（住宿周边）：触发 moveend ⇒ 上层会按新视野重新加载
  function fitBbox(bbox) {
    if (!map || !bbox || !AMap) return false;
    try {
      map.setBounds(
        new AMap.Bounds(
          [Number(bbox.minLng), Number(bbox.minLat)],
          [Number(bbox.maxLng), Number(bbox.maxLat)]
        )
      );
      return true;
    } catch (err) {
      return false;
    }
  }

  // 设置住宿锚点（旗子样式随 baseId 变；重画由上层 refresh 负责）
  function setBase(poiId) {
    baseId = poiId || null;
  }

  function flyTo(lng, lat, zoom) {
    if (!map) return;
    if (typeof lng === 'object' && lng !== null) {
      map.setZoomAndCenter(zoom || 15, [lng.lng, lng.lat]);
      return;
    }
    map.setZoomAndCenter(zoom || 15, [lng, lat]);
  }

  // ---------- 视野（T7）：拖动/缩放 → 取当前视野 bbox ----------
  const MOVE_DEBOUNCE_MS = 300;
  let moveCb = null;
  let moveTimer = null;

  function getZoom() {
    if (!map || typeof map.getZoom !== 'function') return null;
    return map.getZoom();
  }

  function getBounds() {
    if (!map || typeof map.getBounds !== 'function') return null;
    const b = map.getBounds();
    if (!b) return null;
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    return {
      minLng: sw.getLng(),
      minLat: sw.getLat(),
      maxLng: ne.getLng(),
      maxLat: ne.getLat(),
    };
  }

  // 飞到指定中心与倍率；返回 Promise，在相机落定（moveend）后 resolve
  function setZoomAndCenter(lng, lat, zoom) {
    return new Promise((resolve) => {
      if (!map) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (typeof map.off === 'function') map.off('moveend', finish);
        resolve();
      };
      map.on('moveend', finish);
      try {
        map.setZoomAndCenter(zoom, [lng, lat]);
      } catch (err) {
        finish();
        return;
      }
      setTimeout(finish, 1500);
    });
  }

  // 视野变化（moveend / zoomend）→ 防抖 300ms → 回调 getBounds()
  function onMoveEnd(cb) {
    moveCb = cb;
    if (!map) return;
    const schedule = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        moveTimer = null;
        if (moveCb) moveCb(getBounds());
      }, MOVE_DEBOUNCE_MS);
    };
    map.on('moveend', schedule);
    map.on('zoomend', schedule);
  }

  // 相机一落定立刻回调（不防抖）：用于「只显示当前地图范围内的」——平移/缩放结束时马上摘掉框外的旗
  function onViewSettled(cb) {
    if (!map) return;
    const fire = () => cb(getBounds());
    map.on('moveend', fire);
    map.on('zoomend', fire);
  }

  function onMarkerClick(cb) {
    clickHandler = cb;
  }

  // 点地图空白（非旗子）——用于关掉信息卡；需要时由 app.js 自行做「刚点过旗子」的去抖
  function onMapClick(cb) {
    if (!map || typeof map.on !== 'function') return;
    map.on('click', () => {
      if (typeof cb === 'function') cb();
    });
  }

  // ---------- 路线连线（T3） ----------
  let routeLines = [];
  let routeLabels = [];

  function routeStyle(mode) {
    if (mode === 'walking') {
      return { strokeColor: '#22A06B', strokeWeight: 5, strokeStyle: 'dashed', strokeDasharray: [2, 6] };
    }
    if (mode === 'transit') {
      return { strokeColor: '#FF6B35', strokeWeight: 5, strokeStyle: 'dashed', strokeDasharray: [12, 8] };
    }
    return { strokeColor: '#1677ff', strokeWeight: 6, strokeStyle: 'solid' };
  }

  const FAILED_STYLE = {
    strokeColor: '#9aa0aa',
    strokeWeight: 4,
    strokeStyle: 'dashed',
    strokeDasharray: [6, 6],
  };

  function clearRoute() {
    if (map) {
      routeLines.forEach((l) => map.remove(l));
      routeLabels.forEach((t) => map.remove(t));
    }
    routeLines = [];
    routeLabels = [];
  }

  function drawRoute(legs, mode, handlers) {
    clearRoute();
    if (!map || !AMap) return;
    const base = routeStyle(mode);
    const all = [];
    (legs || []).forEach((leg) => {
      const failed = !leg.ok || leg.degraded;
      let path = Array.isArray(leg.polyline) ? leg.polyline : [];
      if (failed || path.length < 2) {
        path = [
          [leg.from.lng, leg.from.lat],
          [leg.to.lng, leg.to.lat],
        ];
      }
      const style = failed ? FAILED_STYLE : base;
      const line = new AMap.Polyline({
        path,
        ...style,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: failed ? 40 : 60,
        cursor: 'pointer',
      });
      line.setMap(map);
      line.on('click', () => {
        if (handlers && handlers.onLegClick) handlers.onLegClick(leg);
      });
      routeLines.push(line);
      path.forEach((p) => all.push(p));

      if (failed) {
        const mid = path[Math.floor(path.length / 2)] || path[0];
        const text = new AMap.Text({
          text: '⚠ 无法规划',
          position: mid,
          anchor: 'center',
          zIndex: 120,
          style: {
            'background-color': '#fff2f0',
            border: '1px solid #ffccc7',
            'border-radius': '6px',
            color: '#cf1322',
            'font-size': '12px',
            padding: '2px 6px',
          },
        });
        text.setMap(map);
        routeLabels.push(text);
      }
    });
    if (routeLines.length) map.setFitView(routeLines.concat(Array.from(markers.values())));
  }

  window.TravelMap = {
    init,
    isReady,
    getMap,
    resize,
    clearMarkers,
    addMarker,
    setMarkers,
    addMarkers,
    syncMarkers,
    markerCount,
    markerLimit,
    capMarkers: capList,
    fitView,
    fitBbox,
    setBase,
    flyTo,
    getZoom,
    getBounds,
    setZoomAndCenter,
    onMoveEnd,
    onViewSettled,
    onMarkerClick,
    onMapClick,
    flagHtml,
    routeStyle,
    drawRoute,
    clearRoute,
    MOVE_DEBOUNCE_MS,
  };
})();
