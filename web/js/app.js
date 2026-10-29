/* 主控：启动 → 取配置 → 初始化地图 → 载入默认城市 → 拉 POI → 渲染；选中/我的选择/行程视图 */
(function () {
  const API = window.TravelAPI;
  const UI = window.TravelUI;
  const MapCtl = window.TravelMap;
  const Cats = window.TravelCategories;
  const Selection = window.TravelSelection;
  const Itinerary = window.TravelItinerary;
  const Route = window.TravelRoute;

  const state = {
    config: null,
    city: null,
    activeCats: new Set(),
    pois: [],
    trip: null,
    onlySelected: false,
    view: 'list',
    cardPoi: null,
  };

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

  function currentList() {
    let list = state.onlySelected ? Selection.list() : state.pois;
    if (state.activeCats.size) {
      list = list.filter((p) => state.activeCats.has(p.category));
    }
    return list;
  }

  function renderMap(list, fit) {
    if (!MapCtl.isReady()) return;
    MapCtl.clearMarkers();
    list.forEach((p) => MapCtl.addMarker(p, Selection.has(p)));
    if (fit) MapCtl.fitView();
  }

  function updateStatus(list) {
    UI.setStatus(
      '已显示 ' + list.length + ' / ' + state.pois.length + ' 个地点（' + state.city + '）'
    );
  }

  function renderSelection() {
    $('selection-count').textContent = String(Selection.count());
    $('only-selected-btn').classList.toggle('active', state.onlySelected);
    UI.renderSelectionPanel($('selection-list'), Selection.list(), {
      onLocate(pin) {
        if (MapCtl.isReady()) MapCtl.flyTo(pin.lng, pin.lat, 15);
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
    const fit = !opts || opts.fit !== false;
    const list = currentList();
    UI.renderResults($('result-list'), list, onPickPoi, {
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
    });
    $('result-count').textContent = String(list.length);
    updateStatus(list);
    renderMap(list, fit);
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
    if (MapCtl.isReady()) MapCtl.flyTo(poi.lng, poi.lat, 15);
    UI.showInfocard($('infocard'), poi, state.city, {
      onAddPin,
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
    });
  }

  async function loadCityPois(city) {
    UI.setStatus('加载 ' + city + ' 推荐地点…');
    const results = await Promise.all(
      Cats.all().map((cat) =>
        API.searchPoi({ city, category: cat.key }).catch(() => [])
      )
    );
    state.pois = dedupe(results.flat());
    refresh();
  }

  async function setCity(city) {
    state.city = city.name || city;
    $('current-city').textContent = state.city;
    state.activeCats.clear();
    state.onlySelected = false;
    if (typeof city.lng === 'number' && MapCtl.isReady()) {
      MapCtl.flyTo(city.lng, city.lat, 11);
    }
    try {
      await Selection.load(state.city);
    } catch (err) {
      /* 选中加载失败不阻塞主流程 */
    }
    await loadCityPois(state.city);
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
        MapCtl.flyTo(state.pois[0].lng, state.pois[0].lat, 15);
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
        if (MapCtl.isReady()) MapCtl.flyTo(pin.lng, pin.lat, 15);
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
    UI.renderChips($('chips'), Cats.all(), state.activeCats, onToggleChip);

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
      UI.hideMapError();
    } catch (err) {
      UI.showMapError(err.message);
      UI.setStatus('地图加载失败：' + err.message);
    }

    await setCity({ name: state.config.defaultCity });

    try {
      const trips = await API.listTrips(state.city);
      state.trip = trips[0] || null;
      await refreshTrips();
    } catch (err) {
      /* 行程非关键路径，失败不阻塞 */
    }
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
