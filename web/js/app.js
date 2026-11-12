/* 主控：启动 → 取配置 → 初始化地图 → 载入默认城市 → 拉 POI → 渲染；选中/我的选择/行程视图 */
(function () {
  const API = window.TravelAPI;
  const UI = window.TravelUI;
  const MapCtl = window.TravelMap;
  const Cats = window.TravelCategories;
  const Selection = window.TravelSelection;
  const Itinerary = window.TravelItinerary;
  const Route = window.TravelRoute;
  const Geo = window.TravelGeo;
  const Planner = window.TravelPlanner;
  const Notes = window.TravelNotes;
  const CityBox = window.TravelCityBox;

  // 住宿锚点持久化键（localStorage）：支持多个锚点（一个行程可能换几次酒店）
  const BASES_KEY = 'travel.bases'; // [{id,name,lng,lat,...}, ...]
  const BASE_ACTIVE_KEY = 'travel.baseActiveId'; // 当前锚点（看周边/回中/成线用它）
  const BASE_KEY = 'travel.base'; // 旧版单锚点键，只用于迁移
  const BASE_RADIUS_KEY = 'travel.baseRadiusM';

  // 切城市落主城区用的倍率；倍率阈值是「是否加载视野内地点」的唯一门控
  const CITY_ZOOM = 13;
  const MIN_MARKER_ZOOM = 13;
  // 按视野自动采集的最低倍率（默认 13）；与落点阈值同值
  const MIN_COLLECT_ZOOM = 13;

  // 分类筛选：多选，选中的都显示（不再有「全部」这一项；要看全就叠满四个，或直接用关键词搜）

  // 默认评分过滤＝已勾选「≥4.0」（用户 2026-11-02：默认过滤条件勾选 4 分以上）
  // 必须在 state 之前声明：state 初始化时会读取它
  const DEFAULT_RATING_FILTER = '4.0';

  // P8 操作便利：侧栏卡片折叠状态（localStorage）+「筛选 · 结果」分页
  const CARDS_KEY = 'travel.cards';
  const RESULT_PAGE = 300; // 一次渲染多少条（其余用「显示更多」按钮放）

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
    searchKey: '', // 上一个关键词搜索（有值时列表口径 = 搜索结果，不是本视野）
    searchHold: null, // 搜索后地图自己飞过去的那一下：视野不动就不拿「这一片的点」冲掉搜索结果
    bases: [], // 住宿锚点可以有多个（换酒店/多层住宿）
    base: null, // 其中「当前」那个（看周边/回中/自动成线用它）
    baseRadiusM: 1000, // 锚点周边半径（米）
    autoReturn: false, // 自动成线：是否闭环回到住宿
    queriedAt: {}, // 刚查过的视野框（key → 时间戳），TTL 内不重复打接口
    lastLiveBox: null, // 上次真正打了接口的视野（数值对象），用干小位移抑制
    viewSeq: 0,
    cityTotal: 0,
    suppressView: false,
    resultLimit: RESULT_PAGE, // 结果列表当前展示上限（「显示更多」递增）
    zoomTooLow: false, // 倍率不够、没加载地点（空态只提示这一件事）
    markerInfo: null, // 上一次落旗回执（{shown,dropped}）：超上限时要在结果条里说明
    outline: null, // 当前城市的行政轮廓（P21）：整城视野时只画边框不落点
    liveMode: 'driving', // 实时耗时用哪种出行方式
    liveLegs: [], // 相邻两点的耗时（[i] = 第 i+1 → 第 i+2 段）
    liveEstimate: false, // 有没有路段是按直线估的（界面带 ≈）
    liveNote: '', // 估算/失败的一句话说明
    liveKey: '', // 上次算过的签名（城市|方式|点序列），一样就不重算
  };

  // 错误人话化（P9-②）：统一过一层，别把高德/后端的裸 code 用给用户看
  function human(err) {
    return window.TravelErrors
      ? window.TravelErrors.humanize(err)
      : String((err && err.message) || err || '');
  }

  // 评分过滤：一个可拖的滑块（P10）—— 0 = 不限、5 = 只留满分，其余是「≥ N」
  const Rating = window.TravelRating;
  let ratingTimer = null; // 拖动时先看徒标，停下来再重算列表

  // 实时耗时（P11）：选中点的顺序一变就重算，不用先点「规划行程」
  const QuickRoute = window.TravelQuickRoute;
  let liveTimer = null;

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

  // ---------- P8 操作便利：侧栏卡片可折叠（点标题条；状态记 localStorage） ----------
  // 默认：城市 / 笔记收起（低频、占地方），搜索 / 筛选展开；住宿锚点看有没有设锚点
  const cardState = {};

  function loadCardState() {
    try {
      const raw = window.localStorage.getItem(CARDS_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach((k) => {
          cardState[k] = !!obj[k];
        });
      }
    } catch (err) {
      /* 隐私模式 / 配额满：用默认展开策略 */
    }
  }

  function saveCardState() {
    try {
      window.localStorage.setItem(CARDS_KEY, JSON.stringify(cardState));
    } catch (err) {
      /* 存不下不影响使用 */
    }
  }

  // 窄屏（与 CSS 的 1100px 断点同口径）：侧栏被压到 42vh，城市这类入口默认展开，否则入口看不见
  function narrowScreen() {
    return typeof window.innerWidth === 'number' && window.innerWidth <= 1100;
  }

  function cardExpanded(name) {
    if (Object.prototype.hasOwnProperty.call(cardState, name)) return cardState[name];
    if (name === 'base') return state.bases.length > 0;
    if (name === 'city') return narrowScreen(); // 只在窄屏默认展开（宽屏保持收起，侧栏短）
    if (name === 'note') return false;
    return true; // search / filter
  }

  function cardSections() {
    return Array.prototype.slice.call(document.querySelectorAll('section.card[data-card]'));
  }

  function applyCardState() {
    const cards = cardSections();
    cards.forEach((sec) => {
      const open = cardExpanded(sec.dataset.card);
      sec.classList.toggle('collapsed', !open);
      const bar = sec.querySelector('.card-bar');
      if (bar) {
        bar.setAttribute('role', 'button');
        bar.setAttribute('tabindex', '0');
        bar.setAttribute('aria-expanded', String(open));
        bar.title = (open ? '收起' : '展开') + '这一块';
      }
    });
  }

  function toggleCard(name) {
    cardState[name] = !cardExpanded(name);
    saveCardState();
    applyCardState();
  }

  // ---------- P12：左栏整列收起 / 展开（与右栏 onTogglePanel 对称） ----------
  // P11 那个小箭头原来只能折叠卡片，用户以为它是「收起左栏」、点了却没反应 ⇒ 改成整列收起；
  // 单张卡片仍可点自己的标题条折叠。
  const SIDEBAR_COLLAPSED_KEY = 'travel.sidebar-collapsed';

  function saveSidebarCollapsed(collapsed) {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch (err) {
      /* 存不下不影响使用 */
    }
  }

  function loadSidebarCollapsed() {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function applySidebarCollapsed(collapsed) {
    const side = $('sidebar');
    if (side) side.classList.toggle('collapsed', !!collapsed);
    const btn = $('sidebar-toggle');
    if (btn) {
      const label = collapsed ? '展开左栏' : '收起左栏';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  function onToggleSidebar() {
    const side = $('sidebar');
    if (!side) return;
    const collapsed = !side.classList.contains('collapsed');
    applySidebarCollapsed(collapsed);
    saveSidebarCollapsed(collapsed);
    // 收起后地图变宽，AMap 要 resize() 防灰块错位（与右栏同一处理）
    if (MapCtl.resize) {
      requestAnimationFrame(() => MapCtl.resize());
      setTimeout(() => MapCtl.resize(), 240);
    }
  }

  function bindCardBars() {
    Array.prototype.forEach.call(
      document.querySelectorAll('section.card[data-card] > .card-bar'),
      (bar) => {
        const name = () => bar.closest('section.card').dataset.card;
        bar.onclick = () => toggleCard(name());
        bar.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCard(name());
          }
        };
      }
    );
    const sidebarToggle = $('sidebar-toggle');
    if (sidebarToggle) sidebarToggle.onclick = onToggleSidebar;
  }

  // 「i」说明点：悬停/聚焦由 CSS 出气泡；点在它身上别把卡片折叠了（冒泡会碰到标题条）
  function bindTips() {
    Array.prototype.forEach.call(document.querySelectorAll('.tip'), (el) => {
      ['click', 'mousedown', 'keydown'].forEach((type) => {
        el.addEventListener(type, (e) => e.stopPropagation());
      });
    });
  }

  // 筛选口径（人话，给结果条用）
  function filterText() {
    const parts = [];
    if (state.onlySelected) parts.push('只看我选中的');
    else if (!state.activeCats.size) parts.push('未选分类');
    else if (state.activeCats.size >= Cats.all().length) parts.push('全部分类');
    else parts.push(Array.from(state.activeCats).map((k) => Cats.labelOf(k)).join('+'));
    if (state.ratingFilter && state.ratingFilter !== 'all') {
      parts.push(state.ratingFilter === 'top' ? '满分' : '≥' + state.ratingFilter);
    }
    return parts.join(' · ');
  }

  function renderResultSummary(total, shown) {
    const el = $('result-summary');
    if (!el) return;
    // 首屏空态（没选分类）：结果条只写个占位符，不写引导（用户 2026-11-09）
    if (!state.onlySelected && catFilterEmpty()) {
      el.textContent = '—';
      el.title = '先选一个分类（可多选）再看结果';
      return;
    }
    const bits = state.searchKey
      ? ['搜索「' + state.searchKey + '」命中 ' + state.pois.length + ' 条' + (total > shown ? '（先显示 ' + shown + ' 条）' : '')]
      : ['显示 ' + shown + ' / 本视野 ' + state.pois.length + ' 条'];
    bits.push(filterText());
    if (!state.searchKey && total > shown) bits.push('合条件共 ' + total + ' 条');
    // 落旗有上限：地图与列表口径对不上时要说清楚（P9-③）；截断按评分优先（P20）
    const mi = state.markerInfo;
    if (mi && mi.dropped > 0) {
      bits.push('地图每类挑高分的落 ' + mi.shown + ' 个点（放大看更多）');
    }
    el.textContent = bits.join(' · ');
    el.title = el.textContent;
  }

  // 「显示更多」：结果列表只渲染前 N 条，其余按页放（上万条时不再把侧栏撑到几十万像素）
  function renderResultMore(rest) {
    const box = $('result-list');
    if (!box) return;
    const old = box.querySelector('.result-more');
    if (old) old.remove();
    if (rest <= 0) return;
    const li = document.createElement('li');
    li.className = 'result-more';
    const btn = document.createElement('button');
    btn.className = 'ghost more-btn';
    btn.textContent = '显示更多（还有 ' + rest + ' 条）';
    btn.onclick = (e) => {
      e.stopPropagation();
      state.resultLimit += RESULT_PAGE;
      refresh({ markers: false });
    };
    li.appendChild(btn);
    box.appendChild(li);
  }

  function hideInfoCard() {
    state.cardPoi = null;
    const el = $('infocard');
    if (el) el.classList.add('hidden');
  }

  // 点地图：底图自带的 POI 标注（如「湖滨步行街」）点不动 ⇒ 一律问「这里是哪」。
  // 口径：**显示的东西必须对得上你点的那个位置** —— 不再拿附近最近的点冒充点击处。
  // 刚点过旗子时不处理，避免「弹了又立刻被关掉」。
  let lastPickAt = 0;
  function onMapBlankClick(lnglat) {
    if (Date.now() - lastPickAt < 400) return;
    const lng = lnglat ? Number(lnglat.lng) : NaN;
    const lat = lnglat ? Number(lnglat.lat) : NaN;
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      lookupAddress(lng, lat);
      return;
    }
    hideInfoCard();
  }

  // 点地图问「这里是哪」（P19）：主信息一律以点击处为准（库里刚好压着就用它，否则逆地理编码地址），
  // 附近的点只当「这一带还有」列出来，点一下才弹那个点的详情。
  let atSeq = 0;
  function atToPoi(data) {
    if (!data) return null;
    return {
      id: '',
      poi_id: '',
      name: data.name || '这个位置',
      address: data.address || data.street || '',
      lng: data.lng,
      lat: data.lat,
      category: data.category || 'sight',
      rating: '',
      cost: '',
      photos: [],
      nearby: (data.nearby || []).filter((p) => p && p.name),
      atPoint: true,
    };
  }

  async function lookupAddress(lng, lat) {
    const seq = (atSeq += 1);
    state.cardPoi = null;
    hideInfoCard();
    UI.setStatus('正在查这个位置的地址…');
    let data;
    try {
      data = await API.poiAt({ lng, lat });
    } catch (err) {
      if (seq !== atSeq) return;
      UI.setStatus('这个位置查不到：' + human(err));
      return;
    }
    if (seq !== atSeq) return; // 连点好几下：只认最后一次
    // ① 点击处本来就压着我们的点（≤25m）⇒ 直接弹它（与点旗子同一张卡）
    if (data && data.poi) {
      onPickPoi(data.poi, { noFly: true });
      UI.setStatus('这里是 ' + data.poi.name);
      return;
    }
    const poi = atToPoi(data);
    if (!poi) {
      UI.setStatus('这个位置附近没有可显示的地点');
      return;
    }
    state.cardPoi = poi;
    lastPickAt = Date.now(); // 卡片刚弹起：别被随后的一次点击当成「点空白」关掉
    UI.setStatus('这个位置：' + (data.address || poi.name));
    window.TravelDetail.show($('infocard'), poi, state.city, {
      onAddPin,
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
      onSetBase: setBase,
      onNearby: pickNearby,
    });
  }

  // 点「这一带还有」里的某一项：拉它的详情，弹那张点卡（不飞相机：它就在眼前）
  async function pickNearby(item) {
    if (!item || !item.poi_id) return;
    UI.setStatus('正在打开「' + item.name + '」…');
    let poi = null;
    try {
      poi = await API.getPoiDetail(item.poi_id);
    } catch (err) {
      poi = null;
    }
    if (!poi) {
      poi = {
        id: item.poi_id,
        poi_id: item.poi_id,
        name: item.name,
        address: item.address,
        category: item.category,
        lng: item.lng,
        lat: item.lat,
      };
    }
    onPickPoi(poi, { noFly: true });
    UI.setStatus('已打开「' + poi.name + '」');
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

  // 分类过滤：没选就不显示；选了就只看选中的（可多选；不再有「全部」那一项）
  function passesCat(p) {
    if (!state.activeCats.size) return false;
    return state.activeCats.has(p.category);
  }

  // 分类 / 评分过滤（不含「只看选中」）
  function passesFilters(p) {
    if (!passesCat(p)) return false;
    if (state.ratingFilter !== 'all' && !passesRating(p)) return false;
    return true;
  }

  // 未选分类：默认的空筛选态
  function catFilterEmpty() {
    return state.activeCats.size === 0;
  }

  function currentList() {
    // 「只看我选中的」＝显式挑的点，不受分类/评分过滤影响
    if (state.onlySelected) return Selection.list();
    return state.pois.filter(passesFilters);
  }

  // ---------- 住宿锚点（可多个）：先定住宿，再看它周边的美食/景点；锚点常驻显示 ----------

  function normalizeBase(b) {
    const id = baseIdOf(b);
    return {
      id,
      poi_id: id,
      name: b.name || '',
      address: b.address || '',
      lng: Number(b.lng),
      lat: Number(b.lat),
      category: b.category || 'stay',
      rating: b.rating || '',
      city: b.city || '',
    };
  }

  function loadBaseFromStore() {
    try {
      const rawList = window.localStorage.getItem(BASES_KEY);
      let list = rawList ? JSON.parse(rawList) : null;
      if (!Array.isArray(list)) {
        // 迁移：旧版只存了一个 travel.base
        const old = window.localStorage.getItem(BASE_KEY);
        const one = old ? JSON.parse(old) : null;
        list = one && one.id ? [one] : [];
      }
      state.bases = list.filter((b) => b && b.id).map(normalizeBase);
      const activeId = window.localStorage.getItem(BASE_ACTIVE_KEY) || '';
      state.base =
        state.bases.find((b) => String(baseIdOf(b)) === String(activeId)) || state.bases[0] || null;
      const r = Number(window.localStorage.getItem(BASE_RADIUS_KEY));
      if (Number.isFinite(r) && r > 0) state.baseRadiusM = r;
    } catch (err) {
      state.bases = [];
      state.base = null;
    }
  }

  function saveBaseToStore() {
    try {
      if (state.bases.length) window.localStorage.setItem(BASES_KEY, JSON.stringify(state.bases));
      else window.localStorage.removeItem(BASES_KEY);
      if (state.base) window.localStorage.setItem(BASE_ACTIVE_KEY, String(baseIdOf(state.base)));
      else window.localStorage.removeItem(BASE_ACTIVE_KEY);
      window.localStorage.setItem(BASE_RADIUS_KEY, String(state.baseRadiusM));
      window.localStorage.removeItem(BASE_KEY); // 旧键已迁移，不再写
    } catch (err) {
      /* 隐私模式/配额满：不影响主流程 */
    }
  }

  function baseIdOf(poi) {
    return poi ? poi.id || poi.poi_id || null : null;
  }

  function findBaseIndex(id) {
    const key = String(id == null ? '' : id);
    if (!key) return -1;
    return state.bases.findIndex((b) => String(baseIdOf(b)) === key);
  }

  // 是不是锚点之一（地图上打金框 / 列表里标「★住这」）
  function baseIs(poi) {
    return findBaseIndex(baseIdOf(poi)) >= 0;
  }

  // 是不是「当前」那个（看周边/回中/成线只对它生效）
  function baseActiveIs(poi) {
    return !!state.base && String(baseIdOf(state.base)) === String(baseIdOf(poi) || '');
  }

  // 锚点卡：列表（点名字切当前、× 删一个）+ 当前那个的周边摘要 + 半径/看周边/回中/清除
  function renderBase() {
    const nameEl = $('base-name');
    if (!nameEl) return;
    const subEl = $('base-sub');
    const listEl = $('base-list');
    const aroundBtn = $('base-around-btn');
    const clearBtn = $('base-clear-btn');
    const locateBtn = $('base-locate-btn');
    const radiusSel = $('base-radius');
    const n = state.bases.length;
    if (radiusSel) radiusSel.value = String(state.baseRadiusM);

    if (listEl) {
      listEl.innerHTML = '';
      state.bases.forEach((b) => {
        const li = document.createElement('li');
        const isActive = baseActiveIs(b);
        li.className = 'base-row' + (isActive ? ' active' : '');
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'base-row-name';
        nameBtn.textContent = b.name || b.id;
        nameBtn.title =
          (b.address ? b.address + ' · ' : '') + (isActive ? '当前锚点' : '点一下设为当前锚点');
        nameBtn.onclick = () => setActiveBase(b.id);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini-btn base-row-del';
        del.textContent = '×';
        del.title = '删除这个锚点';
        del.onclick = () => removeBase(b.id);
        li.appendChild(nameBtn);
        li.appendChild(del);
        listEl.appendChild(li);
      });
      listEl.classList.toggle('hidden', n === 0);
    }

    if (n === 0) {
      nameEl.textContent = '未设定';
      if (subEl) subEl.textContent = '在住宿结果里点「住这」定锚点';
    } else {
      nameEl.textContent = n > 1 ? n + ' 个' : state.base.name || baseIdOf(state.base);
      const cityNote =
        state.city && state.base.city && state.base.city !== state.city
          ? '（' + state.base.city + '）'
          : '';
      if (subEl) {
        subEl.textContent =
          (n > 1 ? '当前 ' + (state.base.name || baseIdOf(state.base)) + ' · ' : '') +
          '周边 ' +
          Geo.humanDistance(state.baseRadiusM) +
          cityNote;
      }
    }
    const any = n > 0;
    if (aroundBtn) aroundBtn.disabled = !any;
    if (clearBtn) clearBtn.disabled = !any;
    if (locateBtn) locateBtn.disabled = !any;
    if (MapCtl.setBase) MapCtl.setBase(state.bases.map((b) => baseIdOf(b)));
  }

  // 点「住这」：没在锚点里就加上（并设为当前），已经是就取消它
  function setBase(poi) {
    const id = baseIdOf(poi);
    if (!id) return;
    if (findBaseIndex(id) >= 0) {
      removeBase(id);
      return;
    }
    state.bases.push(normalizeBase(Object.assign({}, poi, { id, city: state.city || '' })));
    state.base = state.bases[state.bases.length - 1];
    saveBaseToStore();
    renderBase();
    // 加了锚点就把这张卡展开（否则用户看不到刚加的列表）
    cardState.base = true;
    saveCardState();
    applyCardState();
    refresh();
    UI.setStatus(
      '住宿锚点：' +
        (state.base.name || id) +
        (state.bases.length > 1
          ? '（共 ' + state.bases.length + ' 个，当前这个是）'
          : '（周边 ' + Geo.humanDistance(state.baseRadiusM) + '）')
    );
  }

  function setActiveBase(id) {
    const hit = state.bases[findBaseIndex(id)];
    if (!hit) return;
    state.base = hit;
    saveBaseToStore();
    renderBase();
    refresh();
    UI.setStatus('当前锚点：' + (hit.name || baseIdOf(hit)));
  }

  function removeBase(id) {
    const idx = findBaseIndex(id);
    if (idx < 0) return;
    const removed = state.bases[idx];
    const wasActive = String(baseIdOf(state.base) || '') === String(id == null ? '' : id);
    state.bases.splice(idx, 1);
    if (wasActive) state.base = state.bases[0] || null;
    saveBaseToStore();
    renderBase();
    refresh();
    UI.setStatus(
      '已移除锚点：' +
        ((removed && removed.name) || id) +
        (state.bases.length ? '（还剩 ' + state.bases.length + ' 个）' : '')
    );
  }

  function clearBase() {
    if (!state.bases.length) return;
    state.bases = [];
    state.base = null;
    saveBaseToStore();
    renderBase();
    refresh();
    UI.setStatus('已清除全部住宿锚点');
  }

  // 相机回到住宿锚点（不改变筛选，也不重新打接口）
  function locateBase() {
    const b = baseForPlan();
    if (!b) {
      UI.setStatus('先定一个住宿锚点');
      return;
    }
    flyTo(Number(b.lng), Number(b.lat), 15);
    UI.setStatus('已回中：' + (b.name || '住宿锚点'));
  }

  // 看住宿周边：分类锁到「美食＋景点」，相机落到周边框 ⇒ moveend 会触发视野加载（读缓存＋实时搜索）
  function showAroundBase() {
    if (!state.base) {
      UI.setStatus('先定一个住宿锚点');
      return;
    }
    const bbox = Geo.bboxAround(state.base, state.baseRadiusM);
    if (!bbox) {
      UI.setStatus('锚点坐标无效');
      return;
    }
    state.onlySelected = false;
    state.activeCats = new Set(['food', 'sight']);
    renderCatChips();
    UI.setStatus(
      '看 ' +
        (state.base.name || '锚点') +
        ' 周边 ' +
        Geo.humanDistance(state.baseRadiusM) +
        ' 的美食/景点…'
    );
    if (MapCtl.isReady() && MapCtl.fitBbox && MapCtl.fitBbox(bbox)) {
      return; // 等 moveend 自己加载
    }
    fetchPoisInView();
  }

  function renderCatChips() {
    UI.renderChips($('chips'), Cats.all(), state.activeCats, onToggleChip);
  }

  function renderMap(list, fit) {
    if (!MapCtl.isReady()) return;
    // 增量：只补新增 / 删消失，保留不动的旗子（移动地图时不整屏重画 ⇒ 不闪）
    const isSel = (p) => Selection.has(p);
    if (MapCtl.syncMarkers) state.markerInfo = MapCtl.syncMarkers(list, isSel) || null;
    else {
      MapCtl.setMarkers(list, isSel);
      state.markerInfo = null;
    }
    if (fit) MapCtl.fitView();
  }

  function updateStatus(list) {
    // 倍率不够时的空态：这是唯一的原因，只说这一句
    if (state.zoomTooLow) {
      UI.setStatus('放大地图以加载本区域地点');
      return;
    }
    // 首屏/切城之后的未选分类态：不在状态栏重复引导，留给结果列表那一处 CTA（P9-①）
    if (!state.onlySelected && catFilterEmpty()) {
      UI.setStatus('');
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
    const count = Selection.count();
    $('selection-count').textContent = String(count);
    $('only-selected-btn').classList.toggle('active', state.onlySelected);
    // 0 个点时「规划行程 / 自动成线」不可点（P9-⑦）：else 点了只会弹一句“先去挑点”
    const noPin = count === 0;
    const planBtn = $('plan-btn');
    if (planBtn) {
      planBtn.disabled = noPin;
      planBtn.title = noPin
        ? '先在下方列表里点 ★ 挑几个点，再来规划行程'
        : '规划行程：按已挑的点自动排序并连线';
    }
    const autoBtn = $('auto-plan-btn');
    if (autoBtn) {
      autoBtn.disabled = noPin;
      autoBtn.title = noPin ? '先在下方列表里点 ★ 挑几个点' : '按距离自动排序并连线';
    }
    UI.renderSelectionPanel($('selection-list'), Selection.list(), {
      onLocate(pin) {
        flyTo(pin.lng, pin.lat, 15);
        onPickPoi(pin);
      },
      onRemove: onRemoveSelected,
      onMove: onMoveSelectionPin,
      legs: state.liveLegs,
    });
    renderQuickLegs();
    scheduleLiveLegs();
  }

  // ---------- 实时耗时：选中/排序一变就重算（不用先点「规划行程」） ----------
  function renderQuickLegs() {
    const box = $('quick-legs');
    if (!box) return;
    const pins = Selection.list();
    const show = pins.length >= 2;
    box.classList.toggle('hidden', !show);
    const sum = $('ql-summary');
    if (sum) {
      sum.textContent = show
        ? QuickRoute.summarize(state.liveLegs, state.liveMode, {
            estimate: state.liveEstimate,
            note: state.liveNote,
          })
        : '';
      sum.title = state.liveNote || '选中点的先后顺序一变，这里就重算相邻两地要多久';
    }
    const modes = $('ql-modes');
    if (!modes) return;
    modes.innerHTML = '';
    QuickRoute.MODES.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip mini' + (m.key === state.liveMode ? ' active' : '');
      btn.textContent = m.label;
      btn.title = '按' + m.label + '算耗时';
      btn.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (m.key === state.liveMode) return;
        state.liveMode = m.key;
        state.liveKey = '';
        scheduleLiveLegs(0);
      };
      modes.appendChild(btn);
    });
  }

  function scheduleLiveLegs(delay) {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(
      () => {
        liveTimer = null;
        computeLiveLegs();
      },
      delay == null ? 700 : delay
    );
  }

  // 先用直线估一版立刻上图，再拿真实路线纠正（失败就留着估算值，标 ≈）
  async function computeLiveLegs() {
    const pins = Selection.list();
    const key = [state.city || '', state.liveMode, pins.map((p) => p.id).join(',')].join('|');
    if (key === state.liveKey) return;
    state.liveKey = key;
    if (pins.length < 2) {
      state.liveLegs = [];
      state.liveEstimate = false;
      state.liveNote = '';
      renderSelection();
      return;
    }
    state.liveLegs = QuickRoute.estimateLegs(pins, state.liveMode);
    state.liveEstimate = true;
    state.liveNote = '';
    renderSelection();
    try {
      const data = await API.itineraryRoute(state.city, state.liveMode);
      if (state.liveKey !== key) return; // 等结果期间又变了 ⇒ 这次作废
      const legs = Array.isArray(data && data.legs) ? data.legs : [];
      if (!legs.length) return;
      const est = QuickRoute.estimateLegs(pins, state.liveMode);
      state.liveLegs = legs.map((leg, i) => {
        if (leg && leg.ok) {
          return { ok: true, estimate: false, distance: leg.distance, duration: leg.duration };
        }
        const e = est[i] || { distance: 0, duration: 0 };
        return { ok: false, estimate: true, distance: e.distance, duration: e.duration };
      });
      state.liveEstimate = state.liveLegs.some((l) => l.estimate);
      const bad = state.liveLegs.filter((l) => !l.ok).length;
      state.liveNote = bad ? bad + ' 段没拿到真实路线，按直线估算' : '';
    } catch (err) {
      if (state.liveKey !== key) return;
      state.liveEstimate = true;
      state.liveNote = '真实路线拿不到（' + human(err) + '）· 先按直线估算';
    }
    renderSelection();
  }

  async function onMoveSelectionPin(index, delta) {
    const list = Selection.list();
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    try {
      await Selection.move(index, delta);
    } catch (err) {
      UI.setStatus('调整顺序失败：' + human(err));
    }
  }

  function renderItinerary() {
    const list = Selection.list();
    Itinerary.render($('itinerary-list'), list, {
      onMove: onMovePin,
      onRemove: onRemoveFromItinerary,
    });
    if (!Route) return;
    // 「回到住宿」：把锚点当成最后一段接上（锚点已单独高亮，不写进行程点序）
    const start = baseForPlan();
    Route.draw(state.city, state.autoReturn && start && list.length ? list.concat([start]) : list);
  }

  // 当前城市的住宿锚点（没定/不同城 ⇒ null）
  function baseForPlan() {
    const b = state.base;
    if (!b || !Number.isFinite(Number(b.lng)) || !Number.isFinite(Number(b.lat))) return null;
    if (b.city && state.city && b.city !== state.city) return null;
    return b;
  }

  // 自动成线：锚点（有则当起点） + 已挑的点，按最近邻排序 → 落库顺序 → 切行程视图（连线 + 总里程/耗时）
  async function onAutoPlan() {
    const pins = Selection.list();
    if (!pins.length) {
      UI.setStatus('先在地图上把想去的地方挑进来（点列表里的 ★）');
      return;
    }
    const start = baseForPlan();
    const plan = Planner.planStops({ stops: pins, start, returnToStart: state.autoReturn });
    try {
      await Selection.reorder(plan.order.map((p) => p.id));
    } catch (err) {
      UI.setStatus('自动排序保存失败：' + human(err));
      return;
    }
    setView('itinerary');
    UI.setStatus(
      '自动成线：' +
        plan.order.length +
        ' 个点 · 直线里程 ' +
        Geo.humanDistance(plan.distanceM) +
        (plan.closed ? ' · 含回到住宿' : '') +
        ' · 出行方式在行程视图里切换'
    );
  }

  function refresh(opts) {
    const fit = !!(opts && opts.fit);
    const drawMarkers = !opts || opts.markers !== false;
    // 锚点不再强行常驻：分类/评分过滤说了算（没选住宿就不该冒出住宿旗子）
    const full = currentList();
    // 列表只渲染前 N 条（上万条时 DOM 会把侧栏撑到几十万像素、又卡又难滚）
    const cap = Math.max(RESULT_PAGE, Number(state.resultLimit) || RESULT_PAGE);
    const list = full.length > cap ? full.slice(0, cap) : full;
    // 空态只说「倍率不够」这件事（用户 2026-11-09：未选分类时列表就空着，不要再放那块空态引导）
    const emptyText = state.zoomTooLow ? '放大地图以加载本区域地点' : undefined;
    UI.renderResults($('result-list'), list, onPickPoi, {
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
      isBase: baseIs,
      onSetBase: setBase,
      emptyText,
    });
    renderResultMore(full.length - list.length);
    $('result-count').textContent = String(full.length);
    renderResultSummary(full.length, list.length);
    updateStatus(full);
    updateViewCount();
    if (drawMarkers) renderMap(full, fit);
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
      // 读不到就清空：留着旧选中会在列表里显示误导人的“幽灵星标”
      if (Selection.reset) Selection.reset();
    }
  }

  async function onToggleSelect(poi) {
    try {
      await Selection.toggle(poi);
    } catch (err) {
      UI.setStatus('选中失败：' + human(err));
    }
  }

  async function onRemoveSelected(pin) {
    try {
      // 传整个 pin：没有真高德 poi_id 的点（本地 key 是 pin:<行号>）只能按 pin 行删，否则后端按 poi_id 找不到
      await Selection.remove(pin);
      UI.setStatus('已移除：' + (pin && pin.name ? pin.name : ''));
    } catch (err) {
      UI.setStatus('移除失败：' + human(err));
    }
  }

  // 行程视图删点：没有真 poi_id 时按 pin 行删 → 刷新选中集、地图旗子与计数
  async function onRemoveFromItinerary(pin) {
    if (!(await confirmDialog('从行程中删除「' + pin.name + '」？'))) return;
    try {
      await Selection.remove(pin); // 内部按「有没有真 poi_id」选删法
      await reloadSelection();
      UI.setStatus('已删除：' + pin.name);
    } catch (err) {
      UI.setStatus('删除失败：' + human(err));
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
      UI.setStatus('调序失败：' + human(err));
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
      // P11：按钮只剩一个小箭头（收起态由 CSS 翻向左），文案退到 title / aria-label
      const label = collapsed ? '展开右栏' : '收起右栏';
      btn.title = label;
      btn.setAttribute('aria-label', label);
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
      UI.setStatus('导出失败：' + human(err));
    }
  }

  async function onDownloadItinerary() {
    if (!state.city) return;
    try {
      const text = await API.exportSelection(state.city);
      Itinerary.download(state.city + '-行程.md', text);
      UI.setStatus('行程单已下载');
    } catch (err) {
      UI.setStatus('下载失败：' + human(err));
    }
  }

  // ---------- P13 行程分享：生成「发给别人就能看」的分享包 ----------
  // 三件套 = 自包含 HTML（P14：地图生成的真实路线图 + 免 key 的高德链接）/ 纯文本 / JSON（留档）。
  // 住宿锚点只存在浏览器 localStorage ⇒ 生成时一起带上去，别人的分享页里也能看到「住」。
  // 出行方式（驾车/步行）可以自己选，分享页里对方也能切换。
  const SHARE_MODES = [
    { value: 'both', label: '都带上', modes: ['driving', 'walking'] },
    { value: 'driving', label: '驾车', modes: ['driving'] },
    { value: 'walking', label: '步行', modes: ['walking'] },
  ];
  let lastShareModes = SHARE_MODES[0].modes.slice();

  function shareBase() {
    const b = state.base;
    if (!b || !Number.isFinite(Number(b.lng)) || !Number.isFinite(Number(b.lat))) return null;
    return { name: b.name || '住宿', lng: Number(b.lng), lat: Number(b.lat) };
  }

  function kmText(m) {
    return (Number(m) / 1000).toFixed(1) + ' km';
  }

  function durationText(sec) {
    const s = Number(sec) || 0;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? h + ' h ' + m + ' min' : m + ' min';
  }

  function renderShareResult(res) {
    const box = $('share-result');
    if (!box) return;
    box.classList.remove('hidden');
    box.textContent = '';

    const head = document.createElement('div');
    head.className = 'share-head';
    head.textContent = '已生成 ' + res.count + ' 个点的分享包（' + res.files.length + ' 个文件）';
    box.appendChild(head);

    // P14：真实路线的里程/耗时（地图规划出来的，不是直线估的）
    if (res.maps && res.maps.length) {
      const line = document.createElement('div');
      line.className = 'share-routes';
      line.textContent = res.maps
        .map((m) => m.label + ' ' + kmText(m.distance) + ' · ' + durationText(m.duration))
        .join('　');
      box.appendChild(line);
    }
    if (res.mapErrors && Object.keys(res.mapErrors).length) {
      const warn = document.createElement('div');
      warn.className = 'share-warn';
      warn.textContent = '部分路线图没生成：' + Object.keys(res.mapErrors).map((m) => res.mapErrors[m]).join('；');
      box.appendChild(warn);
    }

    // 出行方式可以自己选：选了就地重新生成（同一行程重复生成不重复消耗配额，逐段结果有缓存）
    const modesRow = document.createElement('div');
    modesRow.className = 'share-modes';
    const tip = document.createElement('span');
    tip.className = 'share-modes-tip';
    tip.textContent = '出行方式：';
    modesRow.appendChild(tip);
    SHARE_MODES.forEach((opt) => {
      const same =
        opt.modes.length === lastShareModes.length && opt.modes.every((m) => lastShareModes.indexOf(m) >= 0);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip toggle' + (same ? ' active' : '');
      btn.textContent = opt.label;
      btn.title = '按「' + opt.label + '」重新生成分享包';
      btn.onclick = () => onShareTrip(opt.modes);
      modesRow.appendChild(btn);
    });
    box.appendChild(modesRow);

    const open = document.createElement('a');
    open.className = 'share-open';
    open.href = res.preview;
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = '先看看长什么样 ↗';
    box.appendChild(open);

    const copy = document.createElement('button');
    copy.className = 'ghost mini-btn';
    copy.textContent = '复制分享文案';
    copy.onclick = async () => {
      const ok = await Itinerary.copyText(res.text);
      UI.setStatus(ok ? '分享文案已复制，粘到微信就能发' : '已弹出复制框');
    };
    box.appendChild(copy);

    const dir = document.createElement('div');
    dir.className = 'share-dir';
    dir.textContent = '文件：' + res.dir + '（' + res.files.map((f) => f.name).join('、') + '）';
    box.appendChild(dir);
  }

  async function onShareTrip(modes) {
    if (!state.city) {
      UI.setStatus('先选城市');
      return;
    }
    if (!Selection.list().length) {
      UI.setStatus('这条行程还没有地点：先在地图上挑几个点，再分享');
      return;
    }
    lastShareModes = (modes && modes.length ? modes : lastShareModes).slice();
    UI.setStatus('正在用地图生成真实路线（逐段规划 + 路线底图），稍等…');
    try {
      const trip = await ensureTrip();
      const res = await API.exportTripShare(trip.id, { base: shareBase(), modes: lastShareModes });
      renderShareResult(res);
      const ok = await Itinerary.copyText(res.text);
      UI.setStatus(ok ? '分享包已生成，分享文案也复制好了' : '分享包已生成（可点「复制分享文案」）');
    } catch (err) {
      UI.setStatus('生成分享包失败：' + human(err));
    }
  }

  function onToggleChip(key) {
    // 全选（搜索结果）下点某一个 = 只看它；其余情况才是 toggle（见 Cats.nextSelection）
    state.activeCats = new Set(
      Cats.nextSelection(state.activeCats, key, Cats.all().map((c) => c.key))
    );
    state.resultLimit = RESULT_PAGE; // 换筛选 ⇒ 分页从头开始
    renderCatChips();
    refresh();
    fetchPoisInView(); // 分类变了 ⇒ 对当前视野重跑一次（先缓存后实时搜索）
  }

  // 回到默认筛选：清掉分类/评分，回到「未选分类 · ≥4.0」的初始态
  function onResetFilters() {
    state.activeCats = new Set(Cats.all().map((c) => c.key));
    state.onlySelected = false;
    state.ratingFilter = DEFAULT_RATING_FILTER;
    state.resultLimit = RESULT_PAGE;
    state.searchKey = '';
    state.searchHold = null;
    renderCatChips();
    renderRatingSlider();
    refresh();
    UI.setStatus('已回到默认（全部类别 · ≥4.0）');
  }

  function onPickPoi(poi, opts) {
    state.cardPoi = poi;
    lastPickAt = Date.now();
    // 从列表点进来要把相机带到那个点；从地图上点则不飞（它就在眼前，飞一下会把视野扯走）
    if (!(opts && opts.noFly)) flyTo(poi.lng, poi.lat, 15);
    window.TravelDetail.show($('infocard'), poi, state.city, {
      onAddPin,
      isSelected: (p) => Selection.has(p),
      onToggleSelect,
      onSetBase: setBase,
      onNearby: pickNearby,
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

  // 只显示当前地图范围内的：把已有点按当前视野框裁剪（左右上下平移时立刻摘掉框外的旗）
  function pruneToViewport(bounds) {
    if (!bounds || !state.pois.length) return;
    const before = state.pois.length;
    const kept = state.pois.filter(
      (p) =>
        Number(p.lng) >= bounds.minLng &&
        Number(p.lng) <= bounds.maxLng &&
        Number(p.lat) >= bounds.minLat &&
        Number(p.lat) <= bounds.maxLat
    );
    if (kept.length === before) return;
    state.pois = kept;
    refresh();
  }

  // 视野加载：缩小时不查不画；放大时先读缓存立即落旗，再对当前地图矩形做一次实时搜索（1–4 次调用）
  async function fetchPoisInView() {
    if (!MapCtl.isReady()) return;
    const zoom = MapCtl.getZoom();
    if (zoom != null && (zoom < MIN_MARKER_ZOOM || zoom < MIN_COLLECT_ZOOM)) {
      // 倍率阈值门控：不请求、不画点、不采集，只提示
      state.zoomTooLow = true;
      state.pois = [];
      MapCtl.clearMarkers();
      UI.showLegend(false);
      UI.setViewHint('放大地图以加载本区域地点');
      refresh();
      return;
    }
    state.zoomTooLow = false;
    const bbox = currentBbox();
    if (!bbox) return;
    const seq = (state.viewSeq += 1);
    UI.setStatus('加载视野内地点…');
    let data;
    try {
      data = await API.listPois({ city: state.city, bbox });
    } catch (err) {
      if (seq !== state.viewSeq) return;
      UI.setStatus('读取视野内地点失败：' + human(err));
      return;
    }
    if (seq !== state.viewSeq) return; // 丢弃过期响应，只应用最后一次
    // ① 先落已有的旗（有多少画多少，不白屏）
    // 走到这里说明口径已经回到「本视野」：搜索结果的标不再适用（搜索锁定也已解除）
    state.searchKey = '';
    state.pois = dedupe(data.items || []);
    state.resultLimit = RESULT_PAGE;
    UI.showLegend(state.pois.length > 0 || state.cityTotal > 0);
    refresh();
    // ② 实时搜索本视野（未选分类则不查高德，省配额）
    liveSearchViewport(bbox, seq);
  }

  // 实时搜索：本次视野查哪个分类。未选分类（默认）⇒ null ⇒ 不打高德（省配额）；
  // 单选某分类 ⇒ 只查它；多选（或关键词搜索的全选）⇒ 一次全类型查（不加关键词，返回后按 typecode 归类）
  function liveCategory() {
    if (!state.activeCats.size) return null;
    if (state.activeCats.size === 1) return Array.from(state.activeCats)[0];
    return 'all';
  }

  // 同一范围重复查看不重复打接口：记住刚查过的框（含分类），TTL 内直接走缓存
  const QUERY_TTL_MS = 10 * 60 * 1000;

  // 视野只挪了一点点（中心 <［300m 且面积变化 <20%）⇒ 没必要再打接口：
  // 后端账本（30 天）本来就会拦住，这里再省一次网络往返
  const TINY_MOVE_DEG = 0.0027; // ≈300m（纬度方向）
  const AREA_CHANGE_RATIO = 0.2;

  // currentBbox() 返回的是 "minLng,minLat,maxLng,maxLat" 字符串；这里转回数值对象
  function parseBbox(str) {
    if (!str) return null;
    if (typeof str === 'object') return str;
    const p = String(str).split(',').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
    return { minLng: p[0], minLat: p[1], maxLng: p[2], maxLat: p[3] };
  }

  function isTinyMove(prev, next) {
    if (!prev || !next) return false;
    const dLat = Math.abs((next.minLat + next.maxLat) / 2 - (prev.minLat + prev.maxLat) / 2);
    const dLng = Math.abs((next.minLng + next.maxLng) / 2 - (prev.minLng + prev.maxLng) / 2);
    if (Math.max(dLat, dLng) >= TINY_MOVE_DEG) return false;
    const aPrev = (prev.maxLng - prev.minLng) * (prev.maxLat - prev.minLat);
    const aNext = (next.maxLng - next.minLng) * (next.maxLat - next.minLat);
    if (!(aPrev > 0)) return false;
    return Math.abs(aNext - aPrev) / aPrev < AREA_CHANGE_RATIO;
  }

  function queryKeyOf(bbox, category) {
    if (!bbox) return null;
    const f = (n) => Number(n).toFixed(5); // 微抖容忍：5 位小数
    return [f(bbox.minLng), f(bbox.minLat), f(bbox.maxLng), f(bbox.maxLat), category].join('|');
  }

  function recentlyQueried(key) {
    if (!key) return 0;
    const at = state.queriedAt[key];
    if (!at) return 0;
    const age = Date.now() - at;
    return age >= 0 && age < QUERY_TTL_MS ? age : 0;
  }

  // 实时搜索当前地图矩形：后端按「格账本」决定发不发高德 ——
  // 本区域 30 天内采过 ⇒ 0 次调用（只读缓存）；没采过才补（≤2 格按格查 1 次/格、≥3 格整框查 ≤4 页）
  async function liveSearchViewport(bbox, seq) {
    if (!state.city || !bbox) return;
    const category = liveCategory();
    if (!category) {
      UI.setViewHint('');
      return; // 默认不选分类：不查高德，只显示缓存里已选中的分类（通常为空）
    }
    const box = parseBbox(bbox);
    // 同一范围刚查过（默认 10 分钟内）⇒ 直接用缓存，不再打接口
    const key = queryKeyOf(box, category);
    const age = recentlyQueried(key);
    if (age) {
      UI.setViewHint('');
      UI.setStatus(
        '本范围 ' + Math.max(1, Math.round(age / 60000)) + ' 分钟前刚查过 ⇒ 走缓存（0 次调用）'
      );
      return;
    }
    // 视野几乎没动 ⇒ 也不用再打（后端账本同判，这里省一次往返）
    if (isTinyMove(state.lastLiveBox, box)) {
      UI.setViewHint('');
      UI.setStatus('视野几乎没动 ⇒ 走缓存（0 次调用）');
      return;
    }
    UI.setViewHint('本区域搜索中…');
    let res;
    try {
      res = await API.liveInView({ city: state.city, bbox, category });
    } catch (err) {
      if (seq !== state.viewSeq) return;
      UI.setViewHint('');
      UI.setStatus(
        '实时搜索没成功' +
          (state.pois.length ? '，先用本地已收录的 ' + state.pois.length + ' 条' : '') +
          '：' +
          human(err)
      );
      return;
    }
    if (seq !== state.viewSeq) return; // 丢弃过期响应
    UI.setViewHint('');
    state.queriedAt[key] = Date.now(); // 记下这个框刚查过
    state.lastLiveBox = box;
    state.pois = dedupe(res.items || []);
    state.resultLimit = RESULT_PAGE;
    UI.showLegend(state.pois.length > 0 || state.cityTotal > 0);
    await loadCityTotals(state.city);
    refresh();
    reportLiveResult(res.live);
  }

  // 把这次实时搜索的结果讲清楚：走账本 0 次调用 / 补采了几格 / 调用次数 / 失败
  function reportLiveResult(live) {
    if (!live) return;
    const mode = live.mode || 'rect';
    const calls = Number(live.calls) || 0;
    const total = Number(live.grids) || 0;
    const errors = Array.isArray(live.errors) ? live.errors : [];
    if (mode === 'cache') {
      UI.setStatus(
        '本区域 ' +
          total +
          ' 格 · 30 天内已采过 ⇒ 走缓存（0 次调用）· 本区域 ' +
          state.pois.length +
          ' 条'
      );
      return;
    }
    if (errors.length && errors.length >= calls) {
      // 列表里已经有东西时别说「失败」——用户明明看得见结果，报失败只会让人以为白搜了
      UI.setStatus(
        '实时搜索没成功' +
          (state.pois.length ? '，先用本地已收录的 ' + state.pois.length + ' 条' : '') +
          '：' +
          human(errors[0])
      );
      return;
    }
    const parts = [
      mode === 'around'
        ? '补采 ' + (Number(live.filled) || 0) + ' 格 · ' + calls + ' 次调用'
        : '补采 ' + (Number(live.filled) || 0) + '/' + total + ' 格 · ' + calls + ' 次调用',
    ];
    // 对拍：远端这批点与本地缓存是否一致（0 额外调用，顺手比出来）
    const d = live.diff;
    if (d && d.checked) {
      parts.push(
        '远端 ' +
          d.checked +
          ' 条 → 新增 ' +
          d.added +
          ' · 有变化 ' +
          d.changed +
          ' · 与缓存一致 ' +
          d.same
      );
      if (live.digest) {
        const rs = String(live.digest).slice(0, 8);
        const cs = String(live.cache_digest || '').slice(0, 8);
        parts.push(live.digest_match ? '指纹 ' + rs + '（一致）' : '指纹 ' + rs + ' ≠ 缓存 ' + cs);
      }
    } else {
      parts.push('新增 ' + (Number(live.inserted) || 0) + ' 条');
    }
    parts.push('本区域 ' + state.pois.length + ' 条');
    if (errors.length) parts.push('失败 ' + errors.length + ' 次：' + human(errors[0]));
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

  // 地图视野变化（拖动/缩放）→ 先按新框裁剪已显示的旗，再防抖加载；定位引发的移动跳过
  function onViewChanged() {
    if (state.suppressView) {
      state.suppressView = false;
      return;
    }
    // 搜索完地图自己飞到了结果那一片：视野没真的动过，就别用「这一片的所有点」把搜索结果冲掉
    // （用户 2026-11-11：搜「湖滨步行街」刚看到结果，三秒后列表变成一屏咖啡店）
    if (state.searchHold) {
      if (viewMatchesHold()) return;
      state.searchHold = null; // 用户真的动了地图 ⇒ 解除锁定，恢复「视野即口径」
    }
    pruneToViewport(MapCtl.getBounds());
    fetchPoisInView();
  }

  // 当前视野是否还停在搜索后飞过去的那个位置（中心 + 比例都没动就蒜）
  function viewMatchesHold() {
    const h = state.searchHold;
    if (!h || !MapCtl.isReady()) return false;
    const zoom = MapCtl.getZoom();
    if (zoom != null && Math.abs(zoom - h.zoom) > 0.05) return false;
    const b = MapCtl.getBounds();
    if (!b) return false;
    // getBounds() 给的是 {minLng,minLat,maxLng,maxLat} 这种普通对象（不是 AMap.Bounds）
    const lng = (b.minLng + b.maxLng) / 2;
    const lat = (b.minLat + b.maxLat) / 2;
    return Math.abs(lng - h.lng) < 0.002 && Math.abs(lat - h.lat) < 0.002;
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
    state.resultLimit = RESULT_PAGE;
    renderRatingSlider();
    refresh();
  }

  // 只动界面（徒标 + 已填充部分），不动 state：拖动过程中先看数字，停下来再重算列表
  function paintRating(value) {
    const filter = Rating.valueToFilter(value);
    const input = $('rating-slider');
    if (input) {
      input.style.setProperty('--rating-pct', Rating.percentOf(value));
      input.setAttribute('aria-valuetext', Rating.ariaOf(filter));
    }
    const badge = $('rating-value');
    if (badge) badge.textContent = Rating.labelOf(filter);
  }

  function renderRatingSlider() {
    const input = $('rating-slider');
    const value = Rating.filterToValue(state.ratingFilter);
    if (input) input.value = String(value);
    paintRating(value);
  }

  // 拖动 / 键盘调分：徒标实时跟手，列表与地图等停下手（140ms）再重算一次
  function onRatingSlide(value) {
    paintRating(value);
    if (ratingTimer) clearTimeout(ratingTimer);
    ratingTimer = setTimeout(() => {
      ratingTimer = null;
      const next = Rating.valueToFilter(value);
      if (next === state.ratingFilter) return;
      onPickRating(next);
    }, 140);
  }


  // 切城市：清旧旗 → 提示「定位中…」→ 落主城区 + CITY_ZOOM → 等 moveend → 才请求 POI
  async function setCity(city) {
    state.city = city.name || city;
    $('current-city').textContent = state.city;
    state.activeCats = new Set(Cats.all().map((c) => c.key));
    state.onlySelected = false;
    state.ratingFilter = DEFAULT_RATING_FILTER;
    state.searchKey = '';
    state.searchHold = null;
    state.pois = [];
    state.cityTotal = 0;
    state.trip = null; // N20：切城市必须重置当前行程，避免残留上一城市的行程
    UI.setViewHint('');
    renderCatChips();
    renderRatingSlider();
    if (MapCtl.isReady()) MapCtl.clearMarkers();
    refresh();
    await refreshTrips();
    if (Notes && Notes.refresh) {
      try {
        await Notes.refresh(state.city);
      } catch (err) {
        /* 笔记读取失败不阻塞主流程 */
      }
    }

    const center =
      typeof city.lng === 'number' && typeof city.lat === 'number'
        ? { lng: city.lng, lat: city.lat }
        : null;

    // 先给「整座城市的轮廓」：画边框 + 把相机收到全城，这一屏不落点。
    // 用户 2026-11-12：刚选一个城市，先看轮廓和范围，再进城慢慢选。
    const outline = await loadCityOutline(state.city);
    if (outline && MapCtl.isReady()) {
      state.suppressView = true; // 收到全城引发的 moveend 不重复触发视野加载
      await MapCtl.fitOutline(outline.bbox); // 等相机落定
      setTimeout(() => {
        state.suppressView = false;
      }, 700);
    } else if (center && MapCtl.isReady()) {
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

  // 城市轮廓（P21）：拿得到就画边框并把相机框到全城；拿不到就退回「主城区 + 点位」的老路径。
  // 轮廓是整座地级市（杭州含淳安/建德）⇒ 首屏倍率远低于落点门槛，地图上不会有点：
  // 「先看范围、放大进城再落点」正是要的效果（用户 2026-11-12）。
  async function loadCityOutline(city) {
    if (!MapCtl.isReady()) return null;
    try {
      const data = await API.cityBoundary(city);
      const bbox = data && Array.isArray(data.bbox) ? data.bbox : null;
      const rings = data && Array.isArray(data.rings) ? data.rings : null;
      if (bbox && bbox.length === 4 && rings && rings.length) {
        state.outline = data;
        MapCtl.drawCityOutline(rings);
        return data;
      }
    } catch (err) {
      UI.setStatus(human(err));
    }
    state.outline = null;
    MapCtl.clearCityOutline();
    return null;
  }

  // ---------- 城市选择：输入框 + 下拉建议合成一个控件（P10） ----------
  // 打字（防抖）→ 下拉出建议 → ↑↓ 选、回车/点一下确认；Esc 或点外面收起。
  // 搜索失败时退化成「只切名字」一项，不让用户卡在死路上。
  let citySeq = 0; // 快打字时先发的请求可能后回：只认最后一次
  let cityTimer = null;
  let cityOptions = [];
  let cityActive = -1;

  function cityComboEl() {
    return $('city-combo');
  }

  function cityListOpen() {
    const box = $('city-results');
    return !!(box && !box.classList.contains('hidden'));
  }

  function closeCityList() {
    const box = $('city-results');
    const input = $('city-input');
    if (cityTimer) {
      clearTimeout(cityTimer);
      cityTimer = null;
    }
    // 在飞的搜索一并作废：否则结果回来会把刚收起（或点了外面）的下拉又弹开
    citySeq += 1;
    cityOptions = [];
    cityActive = -1;
    if (box) {
      box.classList.add('hidden');
      box.innerHTML = '';
    }
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function comboHeadEl(text, cls) {
    const el = document.createElement('div');
    el.className = 'combo-head' + (cls ? ' ' + cls : '');
    el.textContent = text;
    return el;
  }

  function cityItemEl(opt, index) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'city-item' + (index === cityActive ? ' active' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', index === cityActive ? 'true' : 'false');
    btn.setAttribute('tabindex', '-1'); // 用 ↑↓ 选；Tab 直接走出这个控件（否则 Tab 会逐个跳选项）
    const name = document.createElement('b');
    name.textContent = opt.name;
    btn.appendChild(name);
    if (opt.sub) {
      const sub = document.createElement('span');
      sub.className = 'combo-sub';
      sub.textContent = opt.sub;
      btn.appendChild(sub);
    }
    // 别让 input 先 blur（blur 会收起下拉，点就落空了）
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = () => pickCity(index);
    return btn;
  }

  // mode: 'loading' | 'failed' | 'empty' | 'options'
  function renderCityList(mode) {
    const box = $('city-results');
    const input = $('city-input');
    if (!box) return;
    const q = input ? input.value.trim() : '';
    box.innerHTML = '';
    if (mode === 'loading') {
      box.appendChild(comboHeadEl('搜索中…'));
    } else if (mode === 'failed') {
      box.appendChild(comboHeadEl('城市搜索失败 · 你仍可以直接用这个名字'));
      cityOptions.forEach((opt, i) => box.appendChild(cityItemEl(opt, i)));
    } else if (!cityOptions.length) {
      box.appendChild(comboHeadEl(CityBox.emptyText(q), 'combo-empty'));
    } else {
      box.appendChild(comboHeadEl(CityBox.statusText(cityOptions.length, q)));
      cityOptions.forEach((opt, i) => box.appendChild(cityItemEl(opt, i)));
    }
    box.classList.remove('hidden');
    if (input) input.setAttribute('aria-expanded', 'true');
  }

  async function runCitySearch(q) {
    const seq = ++citySeq;
    renderCityList('loading');
    let results = null;
    let failed = null;
    try {
      results = await API.searchCity(q);
    } catch (err) {
      failed = err;
    }
    // 过期响应 / 输入已经变了 ⇒ 丢掉这次结果
    const input = $('city-input');
    if (seq !== citySeq || !input || input.value.trim() !== q) return;
    if (failed) {
      const opt = CityBox.rawOption(q, human(failed).slice(0, 40));
      cityOptions = opt ? [opt] : [];
      cityActive = CityBox.pickIndex(cityOptions, q, -1);
      renderCityList(cityOptions.length ? 'failed' : 'empty');
      return;
    }
    cityOptions = CityBox.buildOptions(q, results).slice(0, 6);
    cityActive = CityBox.pickIndex(cityOptions, q, -1);
    renderCityList(cityOptions.length ? 'options' : 'empty');
  }

  function scheduleCitySearch(delay) {
    const input = $('city-input');
    const q = input ? input.value.trim() : '';
    if (cityTimer) {
      clearTimeout(cityTimer);
      cityTimer = null;
    }
    if (!q) {
      closeCityList();
      return;
    }
    citySeq += 1; // 让在飞的旧请求作废（下面的搜索会再自增一次）
    // 输入一变旧建议立刻作废：否则「防抖 + 在飞」这段窗口里按回车会选中上一条查询的城市
    cityOptions = [];
    cityActive = -1;
    renderCityList('loading');
    cityTimer = setTimeout(() => {
      cityTimer = null;
      runCitySearch(q);
    }, delay == null ? 200 : delay);
  }

  function moveCityActive(delta) {
    if (!cityOptions.length) return;
    cityActive = CityBox.moveActive(cityActive, delta, cityOptions.length);
    renderCityList('options');
  }

  function pickCity(index) {
    const opt = cityOptions[index];
    if (!opt) return;
    const input = $('city-input');
    closeCityList();
    if (input) input.value = '';
    setCity(opt.raw ? { name: opt.name } : opt.city);
    if (opt.raw) {
      UI.setStatus('已切到「' + opt.name + '」（地图没动，先放大到目标区域再采集）');
    } else {
      UI.setStatus('已切到 ' + opt.city.name);
    }
  }

  async function onCityKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!cityListOpen() || !cityOptions.length) scheduleCitySearch(0);
      else moveCityActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      closeCityList();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (cityOptions.length) {
        pickCity(CityBox.pickIndex(cityOptions, $('city-input').value, cityActive));
        return;
      }
      // 结果还没回来就按了回车：等这次查询落地，再用同一套规则选
      const input = $('city-input');
      const q = input ? input.value.trim() : '';
      if (!q) return;
      if (cityTimer) {
        clearTimeout(cityTimer);
        cityTimer = null;
      }
      citySeq += 1; // 在飞的旧查询作废
      await runCitySearch(q);
      if (cityOptions.length) pickCity(CityBox.pickIndex(cityOptions, q, cityActive));
    }
  }

  async function doPoiSearch() {
    const keywords = $('poi-input').value.trim();
    if (!keywords) return;
    UI.setStatus('搜索「' + keywords + '」…');
    try {
      const results = await API.searchPoi({ city: state.city, keywords });
      // 高德不可用/没结果时后端会回退到本地库（每条带 local 标记）—— 结果口径要对用户说清
      const fromLocal = results.length > 0 && results[0].local === true;
      state.pois = dedupe(results);
      state.resultLimit = RESULT_PAGE;
      // 关键词搜索：不过滤分类 ⇒ 四个分类 chip 全选中（列表与 chip 说的是同一件事）
      state.activeCats = new Set(Cats.all().map((c) => c.key));
      // 搜索是「我要找这个东西」，不该再被浏览用的评分过滤挡掉：
      // 搜「湖滨步行街」只回一条 3.7 分的酒店，被默认 ≥4.0 滤成 0 条 ⇒ 看着像点不了（用户 2026-11-11）
      state.ratingFilter = 'all';
      state.searchKey = keywords;
      renderRatingSlider();
      renderCatChips();
      refresh();
      if (state.pois.length && MapCtl.isReady()) {
        flyTo(state.pois[0].lng, state.pois[0].lat, 15);
        // 飞过去之后视野就等于搜索结果那一片：在用户真的动地图之前，不要让视野加载接管列表
        state.searchHold = { lng: state.pois[0].lng, lat: state.pois[0].lat, zoom: 15 };
      }
      UI.setStatus(
        '「' +
          keywords +
          '」找到 ' +
          state.pois.length +
          ' 个结果' +
          (fromLocal ? '（高德暂时不可用，来自本地已收录）' : '')
      );
    } catch (err) {
      UI.setStatus('搜索失败：' + human(err));
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
          // 走 reloadSelection：选中集 / 行程卡 / 地图旗子 / 计数一次对齐（两张清单不再打架）
          await reloadSelection();
          UI.setStatus('已从行程删除：' + pin.name);
        } catch (err) {
          UI.setStatus('删除失败：' + human(err));
        }
      }
    );
  }

  // 删除整个行程：二次确认 → DELETE /api/trips/:id → 踢出守卫并重选/置空
  async function onDeleteTrip() {
    if (!state.city) {
      UI.setStatus('先选城市');
      return;
    }
    const n = Selection.count();
    const title = state.trip ? state.trip.title : state.city + ' 的行程';
    if (
      !(await confirmDialog(
        '删除「' + title + '」及其全部地点（共 ' + n + ' 个）？此操作不可恢复'
      ))
    )
      return;
    try {
      // 按城市删干净（同一城市可能因历史原因有多条行程，只删一条会留“幽灵星标”）
      await API.clearCityTrips(state.city);
      state.trip = null;
      if (Selection.reset) Selection.reset(); // 先本地清星，再跟后端对齐
      if (state.view === 'itinerary') setView('list');
      await reloadSelection();
      await syncTripFromServer();
      refresh();
      UI.setStatus('已删除「' + state.city + '」的全部行程与地点（' + n + ' 个）');
    } catch (err) {
      UI.setStatus('删除行程失败：' + human(err));
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
      await reloadSelection(); // 选中集 / ★ 星标 / 「我的行程」卡一起对齐
      UI.setStatus('已加入行程：' + poi.name);
    } catch (err) {
      UI.setStatus('加入行程失败：' + human(err));
    }
  }

  function bind() {
    const cityInput = $('city-input');
    if (cityInput) {
      cityInput.addEventListener('input', () => scheduleCitySearch());
      cityInput.addEventListener('keydown', onCityKey);
      cityInput.addEventListener('focus', () => {
        if (cityInput.value.trim()) scheduleCitySearch(0); // 回来继续看上次没选完的建议
      });
      cityInput.addEventListener('blur', () => {
        // Tab 走开也要收起（点下拉项时 mousedown 已被 preventDefault，不会走到这里）
        setTimeout(() => {
          const combo = cityComboEl();
          if (combo && combo.contains(document.activeElement)) return;
          if (cityListOpen()) closeCityList();
        }, 120);
      });
    }
    // 点/点到外面收起下拉（下拉项自己的 mousedown 已 preventDefault，不会先触发 blur）
    document.addEventListener('click', (e) => {
      const combo = cityComboEl();
      if (!cityListOpen() || !combo || combo.contains(e.target)) return;
      closeCityList();
    });
    $('poi-search-btn').onclick = doPoiSearch;
    $('poi-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPoiSearch();
    });
    $('only-selected-btn').onclick = onToggleOnlySelected;
    const clearFilterBtn = $('filter-clear-btn');
    // 评分滑块（P10）：拖 = 实时跟手，松手后重算一次；键盘/点轨道也走同一个入口
    const ratingSlider = $('rating-slider');
    if (ratingSlider) {
      ratingSlider.addEventListener('input', () => onRatingSlide(ratingSlider.value));
      ratingSlider.addEventListener('change', () => onRatingSlide(ratingSlider.value));
    }
    if (clearFilterBtn) clearFilterBtn.onclick = onResetFilters;
    bindCardBars();
    bindTips();
    const aroundBtn = $('base-around-btn');
    if (aroundBtn) aroundBtn.onclick = showAroundBase;
    const clearBtn = $('base-clear-btn');
    if (clearBtn) clearBtn.onclick = clearBase;
    const locateBtn = $('base-locate-btn');
    if (locateBtn) locateBtn.onclick = locateBase;
    const radiusSel = $('base-radius');
    if (radiusSel) {
      radiusSel.onchange = () => {
        state.baseRadiusM = Number(radiusSel.value) || 1000;
        saveBaseToStore();
        renderBase();
      };
    }
    $('plan-btn').onclick = onPlan;
    const autoBtn = $('auto-plan-btn');
    if (autoBtn) autoBtn.onclick = onAutoPlan;
    const autoReturn = $('auto-return');
    if (autoReturn) {
      autoReturn.checked = !!state.autoReturn;
      autoReturn.onchange = () => {
        state.autoReturn = !!autoReturn.checked;
        if (state.view === 'itinerary') renderItinerary();
      };
    }
    $('panel-toggle').onclick = onTogglePanel;
    // 左栏收成窄条后，点窄条任意处（除了箭头自己）也能开回来（抽屉惯例，与右栏一致）
    const sideBrand = document.querySelector('#sidebar .brand');
    if (sideBrand) {
      sideBrand.onclick = (e) => {
        const side = $('sidebar');
        if (!side || !side.classList.contains('collapsed')) return;
        if (e.target && e.target.closest && e.target.closest('#sidebar-toggle')) return;
        onToggleSidebar();
      };
    }
    // 窄条时整条「行程规划」都能点开（抽屉惯例）；按钮自己已处理，别翻两次
    const rightHead = document.querySelector('#right-panel .right-head');
    if (rightHead) {
      rightHead.onclick = (e) => {
        if (e.target && e.target.closest && e.target.closest('#panel-toggle')) return;
        onTogglePanel();
      };
    }
    $('itinerary-back').onclick = () => setView('list');
    $('itinerary-copy').onclick = onCopyItinerary;
    $('itinerary-download').onclick = onDownloadItinerary;
    $('itinerary-share').onclick = () => onShareTrip();
    const tripShareBtn = $('trip-share-btn');
    if (tripShareBtn) tripShareBtn.onclick = () => onShareTrip();
    $('trip-new-btn').onclick = async () => {
      // 同一城市只保留一个行程：已有就复用，避免“两条行程的 pin 并集”导致删了还有星标
      if (state.trip) {
        UI.setStatus('已有行程：' + state.trip.title + '（同城只保留一个；要重来请先删除行程）');
        return;
      }
      state.trip = null;
      try {
        await ensureTrip();
        UI.setStatus('已新建行程');
      } catch (err) {
        UI.setStatus('新建行程失败：' + human(err));
      }
    };
    $('trip-delete-btn').onclick = onDeleteTrip;
  }

  async function boot() {
    UI.setStatus('正在获取配置…');
    try {
      state.config = await API.getConfig();
    } catch (err) {
      UI.showMapError(human(err));
      UI.setStatus('后端不可用：' + human(err));
      return;
    }

    Cats.init(state.config.categories);
    // 首先是一个地图：打开就把四类都显示出来，而不是空着等用户去选（用户 2026-11-11）
    state.activeCats = new Set(Cats.all().map((c) => c.key));
    renderCatChips();
    renderRatingSlider();
    loadBaseFromStore();
    renderBase();
    loadCardState(); // 侧栏卡片折叠状态（依赖 base 的默认展开策略）
    applyCardState();
    applySidebarCollapsed(loadSidebarCollapsed()); // 上次把左栏收成窄条的话，刷新后保持

    // Esc 关信息卡；点地图空白也关（不用去够卡片右上角那个 ×）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      hideInfoCard();
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) a.blur();
    });

    Selection.subscribe(() => {
      refresh({ fit: false });
      // P11 修复：原来只在「还没有行程」时才同步 ⇒ 移除一个点之后「我的行程」卡一直是旧清单（像删不掉）
      syncTripFromServer();
    });

    bind();

    // 笔记流（P4）：粘贴分享文案 → 本地库 → 提地名 → 高德补全（看图/加入选择都回主流程）
    if (Notes && Notes.mount) {
      Notes.mount({
        onFlyTo: (lng, lat, name) => {
          if (MapCtl.isReady() && typeof lng === 'number' && typeof lat === 'number') {
            MapCtl.flyTo(lng, lat, 16);
            UI.setStatus('已定位到笔记地点：' + (name || ''));
          }
        },
        onSelect: (poi) => {
          if (!poi || !poi.id || typeof poi.lng !== 'number') return;
          Selection.select(poi)
            .then(() => UI.setStatus('已加入我的选择：' + (poi.name || '')))
            .catch((err) => UI.setStatus('加入失败：' + human(err)));
        },
      });
    }

    try {
      await MapCtl.init('map', {
        jsApiKey: state.config.jsApiKey,
        jsApiSecurityCode: state.config.jsApiSecurityCode,
      });
      MapCtl.onMarkerClick((poi) => onPickPoi(poi));
      if (MapCtl.onMapClick) MapCtl.onMapClick((lnglat) => onMapBlankClick(lnglat));
      // 相机落定 → 立刻按新框裁剪已显示的旗；再防抖后加载（先缓存后实时搜索）
      MapCtl.onViewSettled((bounds) => {
        if (!state.suppressView) pruneToViewport(bounds);
      });
      MapCtl.onMoveEnd(() => onViewChanged());
      UI.hideMapError();
    } catch (err) {
      UI.showMapError(human(err));
      UI.setStatus('地图加载失败：' + human(err));
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
