/* 高德地图封装：动态加载 SDK、按分类着色落旗、飞行定位、清旗 */
(function () {
  let map = null;
  let AMap = null;
  const markers = new Map();
  let baseIds = []; // 住宿锚点（可多个）的 poi_id：旗子单独高亮
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
    const no = orderNo(poi);
    if (no) bits.unshift('第 ' + no + ' 站');
    if (isBase) bits.push('住宿锚点');
    return bits.join(' · ');
  }

  // 当前这条路线（第 1 站…第 N 站）的序号表：地图上的点要能一眼看出先后顺序
  let orderNos = new Map();
  let orderSig = '';

  function orderNo(poi) {
    if (!orderNos.size || !poi) return 0;
    return orderNos.get(poiKey(poi)) || 0;
  }

  function flagHtml(poi, selected) {
    const SC = window.TravelScoreColor;
    const color = SC
      ? SC.colorFor(poi.category, poi.rating)
      : window.TravelCategories.colorOf(poi.category);
    const label = window.TravelCategories.labelOf(poi.category);
    const top = SC ? SC.isTop(poi.rating) : false;
    const noRating = !poi.rating;
    const isBase = isBaseId(poi.id) || isBaseId(poi.poi_id);
    const no = orderNo(poi);
    return (
      '<div class="flag' + (selected ? ' selected' : '') + (top ? ' top' : '') +
      (noRating ? ' no-rating' : '') + (isBase ? ' base' : '') + (no ? ' has-no' : '') +
      '" data-category="' +
      esc(poi.category) + '" ' +
      'style="--flag-color:' + esc(color) + '" title="' + esc(flagTitle(poi, top, isBase)) + '">' +
      '<div class="flag-head"><span class="flag-icon">' + esc(label.slice(0, 1)) + '</span></div>' +
      '<div class="flag-tail"></div>' +
      (no ? '<span class="flag-no">' + no + '</span>' : '') +
      (selected ? '<span class="flag-star">★</span>' : '') +
      (top ? '<span class="flag-crown">★</span>' : '') +
      (isBase ? '<span class="flag-base">住</span>' : '') +
      '</div>'
    );
  }

  // 远看的小圆点：色相认分类、明暗认评分（与旗子同一套色阶），悬停仍报名字与评分
  // 在路线里的点带站号（圆点稍大一圈装得下数字）——远看一眼就知道先到哪儿、后到哪儿
  function dotHtml(poi, selected) {
    const SC = window.TravelScoreColor;
    const color = SC
      ? SC.colorFor(poi.category, poi.rating)
      : window.TravelCategories.colorOf(poi.category);
    const top = SC ? SC.isTop(poi.rating) : false;
    const noRating = !poi.rating;
    const isBase = isBaseId(poi.id) || isBaseId(poi.poi_id);
    const no = orderNo(poi);
    return (
      '<div class="poi-dot' + (selected ? ' selected' : '') + (top ? ' top' : '') +
      (noRating ? ' no-rating' : '') + (isBase ? ' base' : '') + (no ? ' has-no' : '') +
      '" data-category="' +
      esc(poi.category) + '" ' +
      'style="--flag-color:' + esc(color) + '" title="' + esc(flagTitle(poi, top, isBase)) + '">' +
      (no ? '<span class="poi-dot-no">' + no + '</span>' : '') +
      '</div>'
    );
  }

  // 路线上的点：白卡片 + 蓝色编号徽标（2026-11-24 对齐圆周旅迹）。
  // 只有「在路线里」的点才用卡片（通常几个到十几个）；其余仍是小圆点/旗子，不然几百个卡片会糊成一片。
  function routeCardHtml(poi, selected) {
    const no = orderNo(poi);
    const isBase = isBaseId(poi.id) || isBaseId(poi.poi_id);
    const SC = window.TravelScoreColor;
    const top = SC ? SC.isTop(poi.rating) : false;
    return (
      '<div class="route-card' + (selected ? ' selected' : '') + (isBase ? ' base' : '') + '" ' +
      'title="' + esc(flagTitle(poi, top, isBase)) + '">' +
      '<span class="rc-name">' + esc(poi.name) + '</span>' +
      '<span class="rc-no">' + no + '</span>' +
      '</div>'
    );
  }

  // 当前呈现档该给什么内容/锚点（圆点以自己为中心，旗子钉在自己的尖端）
  function contentFor(poi, selected, mode) {
    if (orderNo(poi)) return routeCardHtml(poi, selected); // 路线上的点：卡片
    return mode === 'dot' ? dotHtml(poi, selected) : flagHtml(poi, selected);
  }

  function offsetFor(mode, poi) {
    if (orderNo(poi)) return new AMap.Pixel(-13, -13); // 卡片：编号徽标压在坐标上
    if (mode === 'dot') {
      // 带站号的圆点大一圈（20px），锚点跟着挪，别让它偏出真实坐标
      return orderNo(poi) ? new AMap.Pixel(-10, -10) : new AMap.Pixel(-6, -6);
    }
    return new AMap.Pixel(-13, -34);
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
      // 底图用亮色（用户 2026-11-09 定的「地图底板要亮色」）。
      // 2026-11-24 对齐圆周旅迹：换成高德官方的「清新」样式（薄荷绿地块 + 白路 + 淡蓝水），
      // 与它截图里的地图观感一致；样式名是高德内置的，不依赖自定义样式 id。
      mapStyle: 'amap://styles/fresh',
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
      content: contentFor(poi, selected, renderMode),
      offset: offsetFor(renderMode, poi),
      extData: { poi, selected },
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
      content: contentFor(poi, selected, renderMode),
      offset: offsetFor(renderMode, poi),
      extData: { poi, selected },
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

  // 缩得小时少画几面：500 面旗在 zoom 13 会糊成一片（用户 2026-11-11「首先是一个地图」）
  function limitForZoom(zoom) {
    if (zoom === null || zoom === undefined) return MARKER_LIMIT;
    const z = Number(zoom);
    if (!Number.isFinite(z)) return MARKER_LIMIT;
    if (z <= 11) return 40;
    if (z <= 12) return 60;
    if (z <= 13) return 90;
    if (z <= 14) return 160;
    return MARKER_LIMIT;
  }

  // 远看用小圆点、近看才是旗子（用户 2026-11-12「上来就一堆点，很影响看东西」）：
  // 旗是 26×34 的方块 + 旗杆，铺一片就把底图盖住；圆点只报「这一带有什么、大概多好」。
  // 旗与点不是同一套 DOM ⇒ 跨档时整批重画（见 syncMarkers）。
  const DOT_MAX_ZOOM = 13;
  let renderMode = 'flag';

  function modeForZoom(zoom) {
    // 注意 Number(null) === 0：拿不到倍率要先判掉，否则会被当成「缩到最小」
    if (zoom === null || zoom === undefined) return 'flag';
    const z = Number(zoom);
    if (!Number.isFinite(z)) return 'flag';
    return z <= DOT_MAX_ZOOM ? 'dot' : 'flag';
  }

  function poiIdOf(p) {
    return p ? p.id || p.poi_id || null : null;
  }

  function isBaseId(id) {
    return !!id && baseIds.indexOf(String(id)) >= 0;
  }

  function isBasePoi(p) {
    const id = poiIdOf(p);
    return isBaseId(id) || (!!p && isBaseId(p.poi_id));
  }

  // 截断时留「更值得看」的：评分高的先上（无评分排最后），同分按名字稳定排序。
  // 之前是按传入顺序切 —— 屏幕上那 90 个点是「先返回的」而不是「最好的」。
  function preferRank(a, b) {
    const ra = Number(a && a.rating) || 0;
    const rb = Number(b && b.rating) || 0;
    if (rb !== ra) return rb - ra;
    const na = String((a && a.name) || '');
    const nb = String((b && b.name) || '');
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  }

  // 名额按分类轮转发：只按评分全局排会被高分扎堆的类别吃掉整屏
  // （实测杭州 z13：90 个点里 85 个是住宿，地图变成「酒店图」）。
  // 每个分类内部仍是评分高的先上；轮到自己那类没点了就跳过，名额自然留给别类。
  function pickBalanced(rest, room) {
    const cats = window.TravelCategories && typeof window.TravelCategories.all === 'function'
      ? window.TravelCategories.all()
      : [];
    const buckets = new Map();
    cats.forEach((c) => {
      if (c && c.key != null) buckets.set(String(c.key), []);
    });
    rest.forEach((p) => {
      const k = String((p && p.category) || '');
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    });
    buckets.forEach((list) => list.sort(preferRank));
    const keys = Array.from(buckets.keys());
    const out = [];
    for (let round = 0; out.length < room; round += 1) {
      let took = false;
      for (let i = 0; i < keys.length && out.length < room; i += 1) {
        const list = buckets.get(keys[i]);
        if (list.length > round) {
          out.push(list[round]);
          took = true;
        }
      }
      if (!took) break;
    }
    return out;
  }

  function capList(list, isSelected) {
    const items = Array.isArray(list) ? list : [];
    const lim = limitForZoom(map && map.getZoom ? map.getZoom() : null);
    if (items.length <= lim) return { items, dropped: 0 };
    const must = [];
    const rest = [];
    items.forEach((p) => {
      const keep = (isSelected ? !!isSelected(p) : false) || isBasePoi(p);
      (keep ? must : rest).push(p);
    });
    const room = Math.max(0, lim - must.length);
    const shown = must.concat(pickBalanced(rest, room));
    return { items: shown, dropped: items.length - shown.length };
  }

  function markerLimit() {
    return limitForZoom(map && map.getZoom ? map.getZoom() : null);
  }

  function setMarkers(list, isSelected) {
    if (!map) return { shown: 0, dropped: 0 };
    clearMarkers();
    renderMode = modeForZoom(getZoom()); // 整批重画：顺便跟上远/近呈现档
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
    let removed = 0;
    const mode = modeForZoom(getZoom());
    if (mode !== renderMode) {
      // 放大/缩小跨过阈值：圆点 ↔ 旗子不是同一套 DOM，整批重画
      renderMode = mode;
      removed += markers.size;
      clearMarkers();
    }
    const capped = capList(list, isSelected);
    const items = capped.items;
    const wanted = new Map();
    items.forEach((p) => {
      const k = poiKey(p);
      if (!wanted.has(k)) wanted.set(k, p);
    });
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

  // 当前路线的站号（第 1 站…第 N 站）：把这份顺序交给地图编号。
  // 只做两件事：记下序号表；已经在图上的点就地换个内容（不整屏重画 ⇒ 不闪）。
  // 返回这轮真的重画了几个点（0 = 顺序没变，什么也没做）。
  function setOrder(pins) {
    const list = Array.isArray(pins) ? pins : [];
    const keys = list.map(poiKey);
    const sig = keys.join('|');
    if (sig === orderSig) return 0;
    orderSig = sig;
    orderNos = new Map();
    keys.forEach((k, i) => {
      if (!orderNos.has(k)) orderNos.set(k, i + 1);
    });
    let touched = 0;
    markers.forEach((m) => {
      const ext = (typeof m.getExtData === 'function' && m.getExtData()) || {};
      const poi = ext.poi;
      if (!poi || typeof m.setContent !== 'function') return;
      m.setContent(contentFor(poi, !!ext.selected, renderMode));
      if (typeof m.setOffset === 'function') m.setOffset(offsetFor(renderMode, poi));
      touched += 1;
    });
    return touched;
  }

  // 现在地图上有几个点带着站号（给页面/测试看的读数）
  function orderCount() {
    return orderNos.size;
  }

  // ---------- 城市外轮廓（P21）：先看清整座城市有多大，再往里慢选 ----------
  // 用户 2026-11-12：「刚选一个城市，肯定要大概先看下整个城市的轮廓和范围，城市边缘最好加个边框」
  const CITY_LINE = '#35d0c0'; // 与暗色主题的第二个强调色同源
  let cityShapes = [];

  // 边界淡填充：描边才是主角，填充只用来「一眼看出哪块是这座城市」
  function drawCityOutline(rings) {
    if (!map || !Array.isArray(rings) || !rings.length) return 0;
    clearCityOutline();
    const drawn = [];
    rings.forEach((ring) => {
      const path = (Array.isArray(ring) ? ring : [])
        .map((p) => [Number(p[0]), Number(p[1])])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (path.length < 3) return;
      const shape = new AMap.Polygon({
        path,
        strokeColor: CITY_LINE,
        strokeWeight: 2,
        strokeOpacity: 0.9,
        fillColor: CITY_LINE,
        fillOpacity: 0.07,
        bubble: true, // 轮廓盖住整座城：点击要能冒泡到地图（「点地图查地址」照旧）
        zIndex: 20,
      });
      shape.setMap(map);
      drawn.push(shape);
    });
    cityShapes = drawn;
    return drawn.length;
  }

  function clearCityOutline() {
    if (!cityShapes.length) return;
    const shapes = cityShapes;
    cityShapes = [];
    if (!map) return;
    try {
      if (typeof map.remove === 'function' && shapes.length > 1) {
        map.remove(shapes);
        return;
      }
    } catch (err) {
      /* 批量失败：逐面摘 */
    }
    shapes.forEach((s) => {
      try {
        map.remove(s);
      } catch (err) {
        /* 已不在图上：忽略 */
      }
    });
  }

  function cityOutlineCount() {
    return cityShapes.length;
  }

  // 把相机收到城市外接矩形（bbox = [minLng,minLat,maxLng,maxLat]），较为落定后 resolve
  function fitOutline(bbox, padding) {
    return new Promise((resolve) => {
      const box = Array.isArray(bbox) ? bbox.map(Number) : [];
      if (!map || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
        resolve(false);
        return;
      }
      const pad = Number(padding) || 48;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (typeof map.off === 'function') map.off('moveend', onEnd);
        resolve(ok);
      };
      const onEnd = () => finish(true);
      map.on('moveend', onEnd);
      try {
        map.setBounds(new AMap.Bounds([box[0], box[1]], [box[2], box[3]]), false, [pad, pad, pad, pad]);
      } catch (err) {
        finish(false);
        return;
      }
      setTimeout(() => finish(true), 1500);
    });
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

  // 设置住宿锚点（可传数组）。已落图的旗子不会重建 ⇒ 这里主动把「刚变成锚点 / 不再是锚点」那几面重画一遍，
  // 否则金框和「住」角标要等下次重建才生效。
  function setBase(ids) {
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    const next = list.filter((x) => x != null && x !== '').map(String);
    const before = baseIds;
    baseIds = next;
    if (!map || before.join('\u0000') === next.join('\u0000')) return;
    markers.forEach((marker) => {
      const data = (typeof marker.getExtData === 'function' && marker.getExtData()) || {};
      const poi = data.poi;
      if (!poi) return;
      const id = String(poiIdOf(poi) || '');
      const wasBase = before.indexOf(id) >= 0;
      if (!wasBase && !isBaseId(id) && !isBaseId(poi.poi_id)) return; // 前后都不是锚点 ⇒ 样子没变
      try {
        marker.setContent(contentFor(poi, !!data.selected, renderMode));
      } catch (err) {
        /* 单面重画失败不影响其他 */
      }
    });
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
  // 回调带上点击处的经纬度：底图自带的 POI 标注点不动，app.js 要靠它就近接管到库里真有的点
  function onMapClick(cb) {
    if (!map || typeof map.on !== 'function') return;
    map.on('click', (e) => {
      if (typeof cb === 'function') cb(e && e.lnglat ? e.lnglat : null);
    });
  }

  // 点地图任意处 → 找附近（屏幕 maxPx 像素内）我们库里真有的那条点：
  // 「湖滨步行街」这种底图地名不归我们管，但站在它上面的那条酒店是我们的 ⇒ 接管它
  // ---------- 路线连线（T3） ----------
  let routeLines = [];
  let routeLabels = [];
  let routeLegBaseStyles = [];
  let routeLegFailed = [];
  let routeCasings = []; // 白边（垫在彩线下面）：单独一份，不混进 routeLines 的 index
  let routeSelected = null;

  // 每种出行方式在地图上一个色 + 一种线型（与右栏芯片的图标/小线段同一套，route.js 的 MODES）
  // 2026-11-24 对齐圆周旅迹：线要「粗、圆头、带一圈白边」——白边是它在浅色地图上不糊的关键。
  // 颜色仍按出行方式区分（那是图例语义），只是整体加粗一档、圆头圆角。
  // 颜色必须与 route.js / quickroute.js 那套一致（图例语义，有测试钉住）；
  // 对齐对标产品靠的是「加粗 + 圆头 + 白边」，不是换色。
  const MODE_STYLES = {
    driving: { strokeColor: '#2aa9e0', strokeWeight: 8, strokeStyle: 'solid' },
    riding: { strokeColor: '#e8760c', strokeWeight: 7, strokeStyle: 'dashed', strokeDasharray: [7, 5] },
    walking: { strokeColor: '#22a06b', strokeWeight: 7, strokeStyle: 'dashed', strokeDasharray: [2, 6] },
    transit: { strokeColor: '#8a6cf0', strokeWeight: 7, strokeStyle: 'dashed', strokeDasharray: [12, 8] },
  };

  // 白边（casing）：垫在彩色线下面的一条更粗的白线，让线在浅色底图上「浮」起来
  const CASING_STYLE = { strokeColor: '#ffffff', strokeWeight: 13, strokeOpacity: 0.95, strokeStyle: 'solid' };

  function routeStyle(mode) {
    return Object.assign({}, MODE_STYLES[mode] || MODE_STYLES.driving);
  }

  const FAILED_STYLE = {
    strokeColor: '#9aa0aa',
    strokeWeight: 4,
    strokeStyle: 'dashed',
    strokeDasharray: [6, 6],
  };

  // P15 选中高亮：选中的那一段加粗 + 金色描边，其余段变淡 —— 一眼能看出选的是哪段
  const LEG_SELECTED_EXTRA = {
    strokeWeight: 4,
    isOutline: true,
    outlineColor: '#ffd666',
    borderWeight: 2,
    zIndex: 95,
  };
  const LEG_DIM = { strokeOpacity: 0.4, zIndex: 45 };

  function applyRouteSelection() {
    // 白边跟着彩线一起变淡/加粗（它没有自己的选中语义，只是垫底）
    routeCasings.forEach((line, i) => {
      const dim = routeSelected !== null && routeSelected !== undefined && i !== routeSelected;
      line.setOptions({ strokeOpacity: dim ? 0.35 : 0.95 });
    });
    routeLines.forEach((line, i) => {
      const base = routeLegBaseStyles[i] || {};
      if (routeSelected === null || routeSelected === undefined) {
        // 收回选中态时要把描边一并关掉（AMap 的 setOptions 是合并，不清就残留金色边）
        line.setOptions(
          Object.assign({}, base, {
            strokeOpacity: 1,
            isOutline: false,
            borderWeight: 0,
            outlineColor: 'transparent',
            zIndex: routeLegFailed[i] ? 40 : 60,
          })
        );
        return;
      }
      if (i === routeSelected) {
        const weight = (Number(base.strokeWeight) || 6) + LEG_SELECTED_EXTRA.strokeWeight;
        line.setOptions(Object.assign({}, base, LEG_SELECTED_EXTRA, { strokeWeight: weight, strokeOpacity: 1 }));
      } else {
        const weight = Math.max(4, (Number(base.strokeWeight) || 6) - 1);
        line.setOptions(Object.assign({}, base, LEG_DIM, { strokeWeight: weight }));
      }
    });
  }

  // 选中某段（index=null 收回选中态）；地图连线与分段列表两边都靠它对齐
  function setRouteSelection(index) {
    routeSelected = index === null || index === undefined ? null : Number(index);
    if (!Number.isFinite(routeSelected)) routeSelected = null;
    applyRouteSelection();
    return routeSelected;
  }

  function clearRoute() {
    if (map) {
      routeLines.forEach((l) => map.remove(l));
      routeCasings.forEach((l) => map.remove(l));
      routeLabels.forEach((t) => map.remove(t));
    }
    routeLines = [];
    routeCasings = [];
    routeLabels = [];
    routeLegBaseStyles = [];
    routeLegFailed = [];
    routeSelected = null;
  }

  // 按天配色（2026-11-24，对标圆周旅迹）：多天行程每天一种颜色，一眼看出「今天走哪条」。
  // 单天行程不启用（保持按出行方式配色，那套颜色是图例语义）。
  const DAY_COLORS = ['#1677ff', '#e8760c', '#22a06b', '#8a6cf0', '#d4380d', '#08979c', '#c41d7f', '#7cb305'];

  function dayStyle(day) {
    const i = Math.max(0, (Number(day) || 1) - 1) % DAY_COLORS.length;
    return { strokeColor: DAY_COLORS[i], strokeWeight: 6, strokeStyle: 'solid' };
  }

  function drawRoute(legs, mode, handlers) {
    clearRoute();
    if (!map || !AMap) return;
    const all = [];
    const days = handlers && Array.isArray(handlers.days) ? handlers.days : null;
    (legs || []).forEach((leg) => {
      const failed = !leg.ok || leg.degraded;
      let path = Array.isArray(leg.polyline) ? leg.polyline : [];
      if (failed || path.length < 2) {
        path = [
          [leg.from.lng, leg.from.lat],
          [leg.to.lng, leg.to.lat],
        ];
      }
      const legMode = leg.mode || mode;
      const day = days ? days[leg.index] : null;
      const style = failed ? FAILED_STYLE : day ? dayStyle(day) : routeStyle(legMode);
      // 先垫一条白边（失败段不垫：虚线本来就要看得出「这段没规划成」）
      if (!failed) {
        const casing = new AMap.Polyline({
          path,
          ...CASING_STYLE,
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: 55,
          bubble: true,
        });
        casing.setMap(map);
        routeCasings.push(casing);
      }
      const line = new AMap.Polyline({
        path,
        ...style,
        // 方向箭头保留：地图上要能看出先到哪儿、后到哪儿（对标产品没有，但这是我们的信息量）
        showDir: !failed,
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
      routeLegBaseStyles.push(Object.assign({}, style));
      routeLegFailed.push(!!failed);
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
    // fit=false：只是重画（例如地图动一下触发的 refresh）⇒ 别把镜头再拉回去
    if (routeLines.length && (!handlers || handlers.fit !== false)) {
      map.setFitView(routeLines.concat(Array.from(markers.values())));
    }
    applyRouteSelection();
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
    setOrder,
    orderCount,
    markerLimit,
    limitForZoom,
    modeForZoom,
    renderMode: () => renderMode,
    capMarkers: capList,
    drawCityOutline,
    clearCityOutline,
    cityOutlineCount,
    fitOutline,
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
    setRouteSelection,
    MOVE_DEBOUNCE_MS,
  };
})();
