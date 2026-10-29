/* 主控：启动 → 取配置 → 初始化地图 → 载入默认城市 → 拉 POI → 渲染；选中/我的选择/行程视图 */
(function () {
  const API = window.TravelAPI;
  const UI = window.TravelUI;
  const MapCtl = window.TravelMap;
  const Cats = window.TravelCategories;
  const Selection = window.TravelSelection;
  const Itinerary = window.TravelItinerary;
  const Route = window.TravelRoute;

  // 切城市落主城区用的倍率；倍率阈值是「是否加载视野内地点」的唯一门控
  const CITY_ZOOM = 13;
  const MIN_MARKER_ZOOM = 13;
  // 按视野自动采集的最低倍率（默认 13）；与落点阈值同值
  const MIN_COLLECT_ZOOM = 13;

  const state = {
    config: null,
    city: null,
    activeCats: new Set(),
    pois: [],
    trip: null,
    onlySelected: false,
    view: 'list',
    cardPoi: null,
    ratingFilter: 'all',
    collecting: false,
    collectTimer: null,
    viewSeq: 0,
    cityTotal: 0,
    suppressView: false,
    gridFlight: new Set(), // 正在采集的格（前端去重，防重复触发）
    viewportTimer: null, // 视野采集轮询定时器
  };

  const RATING_OPTIONS = [
    { key: 'all', label: '全部' },
    { key: '3.5', label: '≥3.5' },
    { key: '4.0', label: '≥4.0' },
    { key: '4.5', label: '≥4.5' },
    { key: 'top', label: '★满分' },
  ];

  function $(id) {
    return document.getElementById(id);
  }

  // 页内二次确认弹层：返回 Promise<boolean>
  function confirmDialog(message) {
    return new Promise((resolve) => {
      const mask = $('confirm-modal');
      const ok = $('confirm-ok');
      const cancel = $('confirm-cancel');
      if (!mask || !ok || !cancel) {
        resolve(window.confirm(message));
        return;
      }
      $('confirm-modal-msg').textContent = message;
      mask.classList.remove('hidden');
      const done = (val) => {
        mask.classList.add('hidden');
        ok.onclick = null;
        cancel.onclick = null;
        mask.onclick = null;
        resolve(val);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      mask.onclick = (e) => { if (e.target === mask) done(false); };
    });
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    list.forEach((p) => {
      const key = p.id || p.name + '@' + p.lng + ',' + p.lat;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    });
    return out;
  }

  function passesRating(p) {
    const f = state.ratingFilter;
    if (!f || f === 'all') return true;
    const SC = window.TravelScoreColor;
    if (f === 'top') return SC ? SC.isTop(p.rating) : false;
    const min = Number(f);
    const n = Number(p.rating);
    return Number.isFinite(n) && n >= min;
  }

  // 分类 / 评分过滤（不含「只看选中」）
  function passesFilters(p) {
    if (state.activeCats.size && !state.activeCats.has(p.category)) return false;
    if (state.ratingFilter !== 'all' && !passesRating(p)) return false;
    return true;
  }

  function currentList() {
    const list = state.onlySelected ? Selection.list() : state.pois;
    return list.filter(passesFilters);
  }

  function renderMap(list, fit) {
    if (!MapCtl.isReady()) return;
    MapCtl.setMarkers(list, (p) => Selection.has(p));
    if (fit) MapCtl.fitView();
  }

  function gridKeyOf(g) {
    return g.gx + ',' + g.gy;
  }

  function updateStatus(list) {
    UI.setStatus(
      '已显示 ' + list.length + ' / ' + state.pois.length + ' 个地点（' + state.city + '）'
    );
  }

  // 双口径计数：当前视野 N 条 · 全城已收录 M 条
  function updateViewCount() {
    UI.setViewCount(state.pois.length, state.cityTotal);
  }

  function renderSelection() {
    $('selection-count').textContent = String(Selection.count());
    $('only-selected-btn').classList.toggle('active', state.onlySelected);
    UI.renderSelectionPanel($('selection-list'), Selection.list(), {
      onLocate(pin) {
        flyTo(pin.lng, pin.lat, 15);
        onPickPoi(pin);
      },
      onRemove: onRemoveSelected,
    });
  }

  function renderItinerary() {
    Itinerary.render($('itinerary-list'), Selection.list(), {
      onMove: onMovePin,
      onRemove: onRemoveFromItinerary,
    });
    if (Route) Route.draw(state.city, Selection.list());
  }

  function refresh(opts) {
    const fit = !!(opts && opts.fit);
    const drawMarkers = !opts || opts.markers !== false;
    const list = currentList();
    UI.renderResults($('result-list'), list, onPickPoi, {
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
    });
    $('result-count').textContent = String(list.length);
    updateStatus(list);
    updateViewCount();
    if (drawMarkers) renderMap(list, fit);
    renderSelection();
    if (state.view === 'itinerary') renderItinerary();
  }

  function setView(view) {
    state.view = view;
    const inItinerary = view === 'itinerary';
    $('itinerary-panel').classList.toggle('hidden', !inItinerary);
    $('selection-list').classList.toggle('hidden', inItinerary);
    if (inItinerary) {
      reloadSelection().then(renderItinerary);
    } else {
      if (Route) Route.clear();
      renderSelection();
    }
  }

  async function reloadSelection() {
    if (!state.city) return;
    try {
      await Selection.load(state.city);
    } catch (err) {
      /* 离线时保留本地视图 */
    }
  }

  async function onToggleSelect(poi) {
    try {
      await Selection.toggle(poi);
    } catch (err) {
      UI.setStatus('选中失败：' + err.message);
    }
  }

  async function onRemoveSelected(pin) {
    try {
      await Selection.remove(pin.id);
    } catch (err) {
      UI.setStatus('移除失败：' + err.message);
    }
  }

  // 行程视图删点：DELETE /api/pins/:id → 刷新选中集、地图旗子与计数
  async function onRemoveFromItinerary(pin) {
    if (!(await confirmDialog('从行程中删除「' + pin.name + '」？'))) return;
    try {
      if (pin.pinId != null) await API.deletePin(pin.pinId);
      else await Selection.remove(pin);
      await reloadSelection();
      UI.setStatus('已删除：' + pin.name);
    } catch (err) {
      UI.setStatus('删除失败：' + err.message);
    }
  }

  async function onMovePin(index, delta) {
    try {
      await Selection.move(index, delta);
      // 顺序需先落库再重算，避免用旧顺序请求路线（乐观刷新可能早于 PUT 完成）
      if (state.view === 'itinerary' && Route) {
        Route.draw(state.city, Selection.list());
      }
    } catch (err) {
      UI.setStatus('调序失败：' + err.message);
    }
  }

  function onToggleOnlySelected() {
    state.onlySelected = !state.onlySelected;
    refresh();
  }

  // 右栏折叠 / 展开：收起后地图变宽，AMap 需 resize() 防灰块错位
  function onTogglePanel() {
    const panel = $('right-panel');
    const collapsed = panel.classList.toggle('collapsed');
    const btn = $('panel-toggle');
    if (btn) {
      btn.textContent = collapsed ? '展开 ›' : '收起 ‹';
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
    if (MapCtl.resize) {
      requestAnimationFrame(() => MapCtl.resize());
      setTimeout(() => MapCtl.resize(), 240);
    }
  }

  function onPlan() {
    setView('itinerary');
  }

  async function onCopyItinerary() {
    if (!state.city) return;
    try {
      const text = await API.exportSelection(state.city);
      const ok = await Itinerary.copyText(text);
      UI.setStatus(ok ? '行程单已复制到剪贴板' : '已弹出复制框');
    } catch (err) {
      UI.setStatus('导出失败：' + err.message);
    }
  }

  async function onDownloadItinerary() {
    if (!state.city) return;
    try {
      const text = await API.exportSelection(state.city);
      Itinerary.download(state.city + '-行程.md', text);
      UI.setStatus('行程单已下载');
    } catch (err) {
      UI.setStatus('下载失败：' + err.message);
    }
  }

  function onToggleChip(key) {
    if (state.activeCats.has(key)) state.activeCats.delete(key);
    else state.activeCats.add(key);
    UI.renderChips($('chips'), Cats.all(), state.activeCats, onToggleChip);
    refresh();
  }

  function onPickPoi(poi) {
    state.cardPoi = poi;
    flyTo(poi.lng, poi.lat, 15);
    window.TravelDetail.show($('infocard'), poi, state.city, {
      onAddPin,
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
    });
  }

  function fmtCoord(n) {
    return Number(n).toFixed(6);
  }

  // 全城已收录条数（M）：读缓存统计，不打高德
  async function loadCityTotals(city) {
    try {
      const stats = await API.poisStats(city);
      state.cityTotal = stats.total || 0;
    } catch (err) {
      state.cityTotal = 0;
    }
    updateViewCount();
  }

  function currentBbox() {
    const bounds = MapCtl.getBounds();
    if (!bounds) return null;
    return [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat]
      .map(fmtCoord)
      .join(',');
  }

  // 视野加载：缩小时不采不画；放大时先读缓存立即落旗，再自动补采缺失格（渐进）
  async function fetchPoisInView() {
    if (!MapCtl.isReady()) return;
    const zoom = MapCtl.getZoom();
    if (zoom != null && (zoom < MIN_MARKER_ZOOM || zoom < MIN_COLLECT_ZOOM)) {
      // 倍率阈值门控：不请求、不画点、不采集，只提示
      state.pois = [];
      MapCtl.clearMarkers();
      UI.showLegend(false);
      UI.setViewHint('放大地图以加载本区域地点');
      refresh();
      UI.setStatus('放大地图以加载本区域地点');
      return;
    }
    const bbox = currentBbox();
    if (!bbox) return;
    const seq = (state.viewSeq += 1);
    UI.setStatus('加载视野内地点…');
    let data;
    try {
      data = await API.listPois({ city: state.city, bbox });
    } catch (err) {
      if (seq !== state.viewSeq) return;
      UI.setStatus('读取视野内地点失败：' + err.message);
      return;
    }
    if (seq !== state.viewSeq) return; // 丢弃过期响应，只应用最后一次
    // ① 先落已有的旗（有多少画多少，不白屏）
    state.pois = dedupe(data.items || []);
    UI.showLegend(state.pois.length > 0 || state.cityTotal > 0);
    refresh();
    // ② 查覆盖 → 自动采缺失格（无需点按钮）
    autoCollectViewport(bbox, seq);
  }

  // 自动按视野采集：查覆盖 → 有未覆盖且未在采的格 → 触发采集 → 轮询 → 增量补旗
  async function autoCollectViewport(bbox, seq) {
    if (!state.city) return;
    let cov;
    try {
      cov = await API.coverage({ city: state.city, bbox, category: 'all' });
    } catch (err) {
      return; // 覆盖查询失败不阻塞已显示的缓存
    }
    if (seq !== state.viewSeq) return;
    const uncovered = (cov.uncovered || []).filter((g) => !state.gridFlight.has(gridKeyOf(g)));
    if (!uncovered.length) return;
    uncovered.forEach((g) => state.gridFlight.add(gridKeyOf(g))); // 认领，防重复触发
    UI.setViewHint('本区域加载中…');
    UI.setStatus('本区域加载中…');
    const release = () => uncovered.forEach((g) => state.gridFlight.delete(gridKeyOf(g)));
    let res;
    try {
      res = await API.collectViewport({ city: state.city, bbox, category: 'all' });
    } catch (err) {
      release();
      UI.setViewHint('');
      UI.setStatus('采集失败：' + err.message);
      return;
    }
    if (seq !== state.viewSeq || !res || !res.runId) {
      release();
      UI.setViewHint('');
      return;
    }
    pollViewportCollect(res.runId, seq, release);
  }

  // 轮询按视野采集进度；完成后重读缓存增量补旗
  function pollViewportCollect(runId, seq, release) {
    if (state.viewportTimer) {
      clearInterval(state.viewportTimer);
      state.viewportTimer = null;
    }
    const tick = async () => {
      let st;
      try {
        st = await API.collectStatus(runId);
      } catch (err) {
        if (state.viewportTimer) clearInterval(state.viewportTimer);
        state.viewportTimer = null;
        release();
        UI.setViewHint('');
        return;
      }
      // 采集进行中也渐进补旗：每轮询重读缓存，采到多少补多少
      if (seq === state.viewSeq) await mergeViewFromCache(seq, false);
      if (st.status === 'running') return;
      if (state.viewportTimer) clearInterval(state.viewportTimer);
      state.viewportTimer = null;
      release();
      UI.setViewHint('');
      if (seq === state.viewSeq) await mergeViewFromCache(seq, true);
    };
    tick();
    state.viewportTimer = setInterval(tick, 700);
  }

  // 重读 bbox 缓存 → 增量补旗（不整体重画）；updateTotals 时同步「全城已收录」
  async function mergeViewFromCache(seq, updateTotals = true) {
    if (!MapCtl.isReady()) return;
    const zoom = MapCtl.getZoom();
    if (zoom != null && zoom < MIN_COLLECT_ZOOM) return;
    const bbox = currentBbox();
    if (!bbox) return;
    let data;
    try {
      data = await API.listPois({ city: state.city, bbox });
    } catch (err) {
      return;
    }
    if (seq !== state.viewSeq) return;
    mergeNewItems(dedupe(data.items || []));
    if (updateTotals) await loadCityTotals(state.city);
  }

  // 把新采到的点并入当前视野：地图只补新旗，列表/计数刷新（不动已有旗）
  function mergeNewItems(fetched) {
    const keyOf = (p) => p.id || p.name + '@' + p.lng + ',' + p.lat;
    const have = new Set(state.pois.map(keyOf));
    const add = [];
    fetched.forEach((p) => {
      const k = keyOf(p);
      if (have.has(k)) return;
      have.add(k);
      add.push(p);
    });
    if (!add.length) return;
    state.pois = state.pois.concat(add);
    const drawable = add.filter(passesFilters);
    if (drawable.length && state.view !== 'itinerary') {
      MapCtl.addMarkers(drawable, (p) => Selection.has(p));
    }
    refresh({ markers: false });
  }

  // 切城 / 刷新按钮：先刷「全城已收录」，再按当前视野加载
  async function loadCityView(city) {
    UI.setStatus('读取 ' + city + ' 已收录地点…');
    await loadCityTotals(city);
    await fetchPoisInView();
    if (!state.cityTotal && !state.pois.length) {
      UI.setStatus('该城市还没采集，点左侧「采集全城（补全）」');
    }
  }

  // 地图视野变化（拖动/缩放）→ 防抖后自动加载；定位引发的移动跳过
  function onViewChanged() {
    if (state.suppressView) {
      state.suppressView = false;
      return;
    }
    fetchPoisInView();
  }

  // 程序化飞行（点列表/定位）：不触发视野重载，避免冲掉当前列表
  function flyTo(lng, lat, zoom) {
    if (!MapCtl.isReady()) return;
    state.suppressView = true;
    MapCtl.flyTo(lng, lat, zoom);
    setTimeout(() => {
      state.suppressView = false;
    }, 800);
  }

  function onPickRating(key) {
    state.ratingFilter = key;
    UI.renderRatingChips($('rating-chips'), RATING_OPTIONS, state.ratingFilter, onPickRating);
    refresh();
  }

  // 采集入口：后台任务 + 轮询进度；完成后自动刷新列表
  async function onCollect() {
    if (state.collecting) return;
    const btn = $('collect-btn');
    try {
      state.collecting = true;
      if (btn) btn.disabled = true;
      $('collect-progress').textContent = '正在提交采集任务…';
      const res = await API.collect({ city: state.city, category: 'all' });
      pollCollect(res.runIds || [res.runId]);
    } catch (err) {
      state.collecting = false;
      if (btn) btn.disabled = false;
      if (err.status === 409) {
        $('collect-progress').textContent = '该城市正在采集中，等待完成…';
        pollCollect();
      } else {
        UI.setStatus('采集失败：' + err.message);
        $('collect-progress').textContent = '采集失败：' + err.message;
      }
    }
  }

  function pollCollect(runIds) {
    if (state.collectTimer) clearInterval(state.collectTimer);
    const btn = $('collect-btn');
    const tick = async () => {
      try {
        let ids = runIds;
        if (!ids || !ids.length) {
          const runs = await API.collectRuns(state.city);
          ids = runs.filter((r) => r.status === 'running').map((r) => r.runId);
          if (!ids.length) {
            finishCollect();
            return;
          }
        }
        const statuses = await Promise.all(ids.map((id) => API.collectStatus(id)));
        const inserted = statuses.reduce((s, x) => s + (x.n_inserted || 0), 0);
        const done = statuses.reduce((s, x) => s + (x.done_districts || 0), 0);
        const total = statuses.reduce((s, x) => s + (x.total_districts || 0), 0);
        const running = statuses.some((x) => x.status === 'running');
        $('collect-progress').textContent = running
          ? '正在采集 ' + done + '/' + total + ' 区，已入库 ' + inserted + ' 条'
          : '采集完成：共入库 ' + inserted + ' 条';
        if (!running) finishCollect();
      } catch (err) {
        clearInterval(state.collectTimer);
        state.collectTimer = null;
        state.collecting = false;
        if (btn) btn.disabled = false;
        UI.setStatus('采集状态查询失败：' + err.message);
      }
    };

    async function finishCollect() {
      if (state.collectTimer) clearInterval(state.collectTimer);
      state.collectTimer = null;
      state.collecting = false;
      if (btn) btn.disabled = false;
      await loadCityView(state.city);
      UI.setStatus('采集完成，已刷新列表');
    }

    tick();
    state.collectTimer = setInterval(tick, 800);
  }

  // 切城市：清旧旗 → 提示「定位中…」→ 落主城区 + CITY_ZOOM → 等 moveend → 才请求 POI
  async function setCity(city) {
    state.city = city.name || city;
    $('current-city').textContent = state.city;
    state.activeCats.clear();
    state.onlySelected = false;
    state.ratingFilter = 'all';
    state.pois = [];
    state.cityTotal = 0;
    state.trip = null; // N20：切城市必须重置当前行程，避免残留上一城市的行程
    state.gridFlight.clear();
    UI.setViewHint('');
    UI.renderChips($('chips'), Cats.all(), state.activeCats, onToggleChip);
    UI.renderRatingChips($('rating-chips'), RATING_OPTIONS, state.ratingFilter, onPickRating);
    if (MapCtl.isReady()) MapCtl.clearMarkers();
    refresh();
    await refreshTrips();

    const center =
      typeof city.lng === 'number' && typeof city.lat === 'number'
        ? { lng: city.lng, lat: city.lat }
        : null;
    if (center && MapCtl.isReady()) {
      UI.setStatus('定位中…');
      state.suppressView = true; // 定位引发的 moveend 不重复触发视野加载
      await MapCtl.setZoomAndCenter(center.lng, center.lat, CITY_ZOOM); // 等相机落定
      setTimeout(() => {
        state.suppressView = false;
      }, 700);
    }

    try {
      await Selection.load(state.city);
    } catch (err) {
      /* 选中加载失败不阻塞主流程 */
    }
    // N20：按新城市重取行程（没有则置空），界面同步刷新
    try {
      const trips = await API.listTrips(state.city);
      state.trip = trips[0] || null;
    } catch (err) {
      state.trip = null;
    }
    await refreshTrips();
    await loadCityView(state.city);
  }

  async function doCitySearch() {
    const q = $('city-input').value.trim();
    if (!q) return;
    const box = $('city-results');
    box.innerHTML = '<div class="hint">搜索中…</div>';
    try {
      const cities = await API.searchCity(q);
      box.innerHTML = '';
      if (!cities.length) {
        box.innerHTML = '<div class="hint">没找到城市「' + UI.esc(q) + '」</div>';
        return;
      }
      cities.slice(0, 6).forEach((city) => {
        const btn = document.createElement('button');
        btn.className = 'city-item';
        btn.textContent = city.name;
        btn.onclick = () => setCity(city);
        box.appendChild(btn);
      });
    } catch (err) {
      box.innerHTML = '<div class="hint">城市搜索失败：' + UI.esc(err.message) + '</div>';
    }
  }

  async function doPoiSearch() {
    const keywords = $('poi-input').value.trim();
    if (!keywords) return;
    UI.setStatus('搜索「' + keywords + '」…');
    try {
      const results = await API.searchPoi({ city: state.city, keywords });
      state.pois = dedupe(results);
      state.activeCats.clear();
      UI.renderChips($('chips'), Cats.all(), state.activeCats, onToggleChip);
      refresh();
      if (state.pois.length && MapCtl.isReady()) {
        flyTo(state.pois[0].lng, state.pois[0].lat, 15);
      }
      UI.setStatus('「' + keywords + '」找到 ' + state.pois.length + ' 个结果');
    } catch (err) {
      UI.setStatus('搜索失败：' + err.message);
    }
  }

  async function ensureTrip() {
    if (state.trip) return state.trip;
    const title = state.city + '行程';
    state.trip = await API.createTrip({ city: state.city, title });
    await refreshTrips();
    return state.trip;
  }

  async function refreshTrips() {
    $('trip-name').textContent = state.trip
      ? '#' + state.trip.id + ' ' + state.trip.title
      : '未创建';
    const pins = state.trip ? await API.listPins(state.trip.id) : [];
    UI.renderTripPins(
      $('trip-list'),
      pins,
      (pin) => {
        flyTo(pin.lng, pin.lat, 15);
      },
      async (pin) => {
        try {
          await API.deletePin(pin.id);
          await refreshTrips();
        } catch (err) {
          UI.setStatus('删除失败：' + err.message);
        }
      }
    );
  }

  // 删除整个行程：二次确认 → DELETE /api/trips/:id → 踢出守卫并重选/置空
  async function onDeleteTrip() {
    if (!state.trip) {
      UI.setStatus('尚未创建行程');
      return;
    }
    if (!(await confirmDialog('删除行程「' + state.trip.title + '」及其全部地点？此操作不可恢复'))) return;
    try {
      await API.deleteTrip(state.trip.id);
      state.trip = null;
      await reloadSelection();
      const trips = await API.listTrips(state.city);
      state.trip = trips[0] || null;
      await refreshTrips();
      UI.setStatus('行程已删除');
    } catch (err) {
      UI.setStatus('删除行程失败：' + err.message);
    }
  }

  // 选中会自动在后端建城市行程；同步守卫 state.trip，保证「删除行程」可用
  async function syncTripFromServer() {
    if (!state.city) return;
    try {
      const trips = await API.listTrips(state.city);
      state.trip = trips[0] || null;
      await refreshTrips();
    } catch (err) {
      /* 行程非关键路径，失败不阻塞 */
    }
  }

  async function onAddPin(poi) {
    try {
      const trip = await ensureTrip();
      await API.addPin({
        trip_id: trip.id,
        poi_id: poi.id,
        name: poi.name,
        address: poi.address,
        lng: poi.lng,
        lat: poi.lat,
        category: poi.category,
        rating: poi.rating,
        cost: poi.cost,
        tel: poi.tel,
        photo: poi.photo,
      });
      await refreshTrips();
      UI.setStatus('已加入行程：' + poi.name);
    } catch (err) {
      UI.setStatus('加入行程失败：' + err.message);
    }
  }

  function bind() {
    $('city-search-btn').onclick = doCitySearch;
    $('city-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCitySearch();
    });
    $('poi-search-btn').onclick = doPoiSearch;
    $('poi-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPoiSearch();
    });
    $('only-selected-btn').onclick = onToggleOnlySelected;
    $('collect-btn').onclick = onCollect;
    $('collect-refresh-btn').onclick = () => loadCityView(state.city);
    $('plan-btn').onclick = onPlan;
    $('panel-toggle').onclick = onTogglePanel;
    $('itinerary-back').onclick = () => setView('list');
    $('itinerary-copy').onclick = onCopyItinerary;
    $('itinerary-download').onclick = onDownloadItinerary;
    $('trip-new-btn').onclick = async () => {
      state.trip = null;
      try {
        await ensureTrip();
        UI.setStatus('已新建行程');
      } catch (err) {
        UI.setStatus('新建行程失败：' + err.message);
      }
    };
    $('trip-delete-btn').onclick = onDeleteTrip;
  }

  async function boot() {
    UI.setStatus('正在获取配置…');
    try {
      state.config = await API.getConfig();
    } catch (err) {
      UI.showMapError(err.message);
      UI.setStatus('后端不可用：' + err.message);
      return;
    }

    Cats.init(state.config.categories);
    UI.renderChips($('chips'), Cats.all(), state.activeCats, onToggleChip);
    UI.renderRatingChips($('rating-chips'), RATING_OPTIONS, state.ratingFilter, onPickRating);

    Selection.subscribe(() => {
      refresh({ fit: false });
      if (!state.trip) syncTripFromServer();
    });

    bind();

    try {
      await MapCtl.init('map', {
        jsApiKey: state.config.jsApiKey,
        jsApiSecurityCode: state.config.jsApiSecurityCode,
      });
      MapCtl.onMarkerClick((poi) => onPickPoi(poi));
      MapCtl.onMoveEnd(() => onViewChanged());
      UI.hideMapError();
    } catch (err) {
      UI.showMapError(err.message);
      UI.setStatus('地图加载失败：' + err.message);
    }

    // 默认城市：用城市搜索拿到主城区 center（高德 city center 就是主城区）；
    // 名字沿用配置里的 defaultCity，保证与已收录缓存的城市键一致
    let bootCity = { name: state.config.defaultCity };
    try {
      const found = await API.searchCity(state.config.defaultCity);
      if (Array.isArray(found) && found.length) {
        bootCity = {
          name: state.config.defaultCity,
          lng: found[0].lng,
          lat: found[0].lat,
        };
      }
    } catch (err) {
      /* 拿不到 center 时退化为仅城市名 */
    }
    await setCity(bootCity); // setCity 内已按城市载入行程
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
