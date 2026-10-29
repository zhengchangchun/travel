/* 主控：启动 → 取配置 → 初始化地图 → 载入默认城市 → 拉 POI → 渲染 */
(function () {
  const API = window.TravelAPI;
  const UI = window.TravelUI;
  const MapCtl = window.TravelMap;
  const Cats = window.TravelCategories;

  const state = {
    config: null,
    city: null,
    selected: new Set(),
    pois: [],
    trip: null,
  };

  function $(id) {
    return document.getElementById(id);
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

  function applyView() {
    const filtered = state.selected.size
      ? state.pois.filter((p) => state.selected.has(p.category))
      : state.pois;

    UI.renderResults($('result-list'), filtered, onPickPoi);
    $('result-count').textContent = String(filtered.length);

    if (MapCtl.isReady()) {
      MapCtl.clearMarkers();
      filtered.forEach((p) => MapCtl.addMarker(p));
      MapCtl.fitView();
    }
  }

  function onToggleChip(key) {
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
    UI.renderChips($('chips'), Cats.all(), state.selected, onToggleChip);
    applyView();
  }

  function onPickPoi(poi) {
    if (MapCtl.isReady()) MapCtl.flyTo(poi.lng, poi.lat, 15);
    UI.showInfocard($('infocard'), poi, state.city, { onAddPin: onAddPin });
  }

  async function loadCityPois(city) {
    UI.setStatus('加载 ' + city + ' 推荐地点…');
    const results = await Promise.all(
      Cats.all().map((cat) =>
        API.searchPoi({ city, category: cat.key }).catch(() => [])
      )
    );
    state.pois = dedupe(results.flat());
    applyView();
    UI.setStatus('已加载 ' + state.pois.length + ' 个地点（' + city + '）');
  }

  async function setCity(city) {
    state.city = city.name || city;
    $('current-city').textContent = state.city;
    if (typeof city.lng === 'number' && MapCtl.isReady()) {
      MapCtl.flyTo(city.lng, city.lat, 11);
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
      state.selected.clear();
      UI.renderChips($('chips'), Cats.all(), state.selected, onToggleChip);
      applyView();
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
    UI.renderChips($('chips'), Cats.all(), state.selected, onToggleChip);

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
      const trips = await API.listTrips();
      state.trip = trips[0] || null;
      await refreshTrips();
    } catch (err) {
      /* 行程非关键路径，失败不阻塞 */
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
    $('trip-new-btn').onclick = async () => {
      state.trip = null;
      try {
        await ensureTrip();
        UI.setStatus('已新建行程');
      } catch (err) {
        UI.setStatus('新建行程失败：' + err.message);
      }
    };
  }

  window.addEventListener('DOMContentLoaded', () => {
    bind();
    boot();
  });
})();
