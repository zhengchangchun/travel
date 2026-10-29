/* 高德地图封装：动态加载 SDK、按分类着色落旗、飞行定位、清旗 */
(function () {
  let map = null;
  let AMap = null;
  const markers = new Map();
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

  function flagHtml(poi, selected) {
    const SC = window.TravelScoreColor;
    const color = SC
      ? SC.colorFor(poi.category, poi.rating)
      : window.TravelCategories.colorOf(poi.category);
    const label = window.TravelCategories.labelOf(poi.category);
    const top = SC ? SC.isTop(poi.rating) : false;
    const noRating = !poi.rating;
    return (
      '<div class="flag' + (selected ? ' selected' : '') + (top ? ' top' : '') +
      (noRating ? ' no-rating' : '') + '" data-category="' +
      esc(poi.category) + '" ' +
      'style="--flag-color:' + esc(color) + '" title="' + esc(poi.name) + '">' +
      '<div class="flag-head"><span class="flag-icon">' + esc(label.slice(0, 1)) + '</span></div>' +
      '<div class="flag-tail"></div>' +
      (selected ? '<span class="flag-star">★</span>' : '') +
      (top ? '<span class="flag-crown">★</span>' : '') +
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
    markers.forEach((m) => map.remove(m));
    markers.clear();
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

  // 分批落旗：视野内点很多时不抽稀，但分帧 append，避免主线程卡死
  const MARKER_CHUNK = 200;
  function setMarkers(list, isSelected) {
    if (!map) return;
    clearMarkers();
    const token = markerBatch;
    const items = list || [];
    let i = 0;
    const step = () => {
      if (token !== markerBatch) return; // 已被新批次取代，丢弃
      const end = Math.min(i + MARKER_CHUNK, items.length);
      for (; i < end; i += 1) {
        addMarker(items[i], isSelected ? isSelected(items[i]) : false);
      }
      if (i < items.length) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(step, 0);
      }
    };
    step();
  }

  function fitView() {
    if (!map || markers.size === 0) return;
    map.setFitView(Array.from(markers.values()));
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

  function onMarkerClick(cb) {
    clickHandler = cb;
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
    fitView,
    flyTo,
    getZoom,
    getBounds,
    setZoomAndCenter,
    onMoveEnd,
    onMarkerClick,
    flagHtml,
    routeStyle,
    drawRoute,
    clearRoute,
    MOVE_DEBOUNCE_MS,
  };
})();
