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

  // 分类 chip 里的「全部」（不是真实分类 key，仅 UI 用）
  const ALL_CAT_KEY = '__all__';

  // 默认评分过滤＝已勾选「≥4.0」（用户 2026-11-02：默认过滤条件勾选 4 分以上）
  // 必须在 state 之前声明：state 初始化时会读取它
  const DEFAULT_RATING_FILTER = '4.0';

  const state = {
    config: null,
    city: null,
    activeCats: new Set(),
    pois: [],
    trip: null,
    onlySelected: false,
    view: 'list',
    cardPoi: null,
    ratingFilter: DEFAULT_RATING_FILTER,
    showAll: false, // 是否勾了「全部」分类；未勾且没选具体分类 ⇒ 不显示地点
    viewSeq: 0,
    cityTotal: 0,
    suppressView: false,
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

  // 分类过滤：默认不选中＝不显示；勾「全部」＝全部显示；否则只看选中的分类（可多选）
  function passesCat(p) {
    if (state.showAll) return true;
    if (!state.activeCats.size) return false;
    return state.activeCats.has(p.category);
  }

  // 分类 / 评分过滤（不含「只看选中」）
  function passesFilters(p) {
    if (!passesCat(p)) return false;
    if (state.ratingFilter !== 'all' && !passesRating(p)) return false;
    return true;
  }

  // 未勾「全部」且未选具体分类：默认的空筛选态
  function catFilterEmpty() {
    return !state.showAll && state.activeCats.size === 0;
  }

  function currentList() {
    // 「只看我选中的」＝显式挑的点，不受分类/评分过滤影响
    if (state.onlySelected) return Selection.list();
    return state.pois.filter(passesFilters);
  }

  // 分类 chip：“全部”首位 + 真实分类；选中态由 showAll / activeCats 决定
  function renderCatChips() {
    const chips = [{ key: ALL_CAT_KEY, label: '全部', color: '#8a9099' }].concat(Cats.all());
    const selected = state.showAll ? new Set([ALL_CAT_KEY]) : state.activeCats;
    UI.renderChips($('chips'), chips, selected, onToggleChip);
  }

  function renderMap(list, fit) {
    if (!MapCtl.isReady()) return;
    MapCtl.setMarkers(list, (p) => Selection.has(p));
    if (fit) MapCtl.fitView();
  }

  function updateStatus(list) {
    if (!state.onlySelected && catFilterEmpty()) {
      UI.setStatus('未选分类：点一个分类（如 住宿）查看地点');
      return;
    }
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
    const emptyText =
      !state.onlySelected && catFilterEmpty()
        ? '先点上面的分类（如 住宿），或勾「全部」'
        : undefined;
    UI.renderResults($('result-list'), list, onPickPoi, {
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
      emptyText,
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
    if (key === ALL_CAT_KEY) {
      state.showAll = !state.showAll;
      if (state.showAll) state.activeCats.clear();
    } else {
      state.showAll = false;
      if (state.activeCats.has(key)) state.activeCats.delete(key);
      else state.activeCats.add(key);
    }
    renderCatChips();
    refresh();
    fetchPoisInView(); // 分类变了 ⇒ 对当前视野重跑一次（先缓存后实时搜索）
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

  // 视野加载：缩小时不查不画；放大时先读缓存立即落旗，再对当前视野做一次实时搜索（≤ 9 次调用）
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
    // ② 实时搜索本视野（未选分类则不查高德，省配额）
    liveSearchViewport(bbox, seq);
  }

  // 实时搜索：本次视野查哪个分类。未选分类（默认）⇒ null ⇒ 不打高德（省配额）；
  // 单选某分类 ⇒ 只查它；多选 / 勾「全部」⇒ 一次全类型查（不加关键词，返回后按 typecode 归类）
  function liveCategory() {
    if (!state.activeCats.size && !state.showAll) return null;
    if (state.activeCats.size === 1) return Array.from(state.activeCats)[0];
    return 'all';
  }

  // 实时搜索当前视野：直接打高德（≤ 9 次调用，服务端切粗格）→ 结果落库当缓存 → 立刻整屏刷新
  async function liveSearchViewport(bbox, seq) {
    if (!state.city || !bbox) return;
    const category = liveCategory();
    if (!category) {
      UI.setViewHint('');
      return; // 默认不选分类：不查高德，只显示缓存里已选中的分类（通常为空）
    }
    UI.setViewHint('本区域搜索中…');
    let res;
    try {
      res = await API.liveInView({ city: state.city, bbox, category });
    } catch (err) {
      if (seq !== state.viewSeq) return;
      UI.setViewHint('');
      UI.setStatus('实时搜索失败：' + err.message);
      return;
    }
    if (seq !== state.viewSeq) return; // 丢弃过期响应
    UI.setViewHint('');
    state.pois = dedupe(res.items || []);
    UI.showLegend(state.pois.length > 0 || state.cityTotal > 0);
    await loadCityTotals(state.city);
    refresh();
    reportLiveResult(res.live);
  }

  // 把这次实时搜索的结果讲清楚：调用次数 / 新增 / 失败（配额用尽是常见失败）
  function reportLiveResult(live) {
    if (!live) return;
    const calls = Number(live.calls) || 0;
    const errors = Array.isArray(live.errors) ? live.errors : [];
    if (errors.length && errors.length >= calls) {
      UI.setStatus('实时搜索失败（高德调用 ' + calls + ' 次全失败）：' + errors[0]);
      return;
    }
    const parts = [
      '实时搜索 ' + calls + ' 次调用',
      '新增 ' + (Number(live.inserted) || 0) + ' 条',
      '本区域 ' + state.pois.length + ' 条',
    ];
    if (errors.length) parts.push('失败 ' + errors.length + ' 次：' + errors[0]);
    UI.setStatus(parts.join(' · '));
  }

  // 切城：先刷「全城已收录」，再按当前视野加载
  async function loadCityView(city) {
    UI.setStatus('读取 ' + city + ' 已收录地点…');
    await loadCityTotals(city);
    await fetchPoisInView();
    if (!state.cityTotal && !state.pois.length) {
      UI.setStatus('该城市还没采到数据：把地图放大到街道级，会自动采集本区域');
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


  // 切城市：清旧旗 → 提示「定位中…」→ 落主城区 + CITY_ZOOM → 等 moveend → 才请求 POI
  async function setCity(city) {
    state.city = city.name || city;
    $('current-city').textContent = state.city;
    state.activeCats.clear();
    state.showAll = false; // 新城市回到「先不选中」
    state.onlySelected = false;
    state.ratingFilter = DEFAULT_RATING_FILTER;
    state.pois = [];
    state.cityTotal = 0;
    state.trip = null; // N20：切城市必须重置当前行程，避免残留上一城市的行程
    UI.setViewHint('');
    renderCatChips();
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
      state.showAll = true; // 关键词搜索：不过滤分类
      renderCatChips();
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
    renderCatChips();
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
