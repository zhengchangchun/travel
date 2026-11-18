/* 路线连线与总览：出行方式切换、总里程/耗时、分段明细、地图连线（T3） */
(function () {
  const API = window.TravelAPI;
  const MapCtl = window.TravelMap;

  const ModeIcons = window.TravelModeIcons;

  // 「最快」不是一种线型：它表示「每段各自挑最快的那一种」，所以没有 color/line
  const AUTO_MODE = { key: 'auto', label: '最快', color: '', line: '', lineText: '先按时间最短逐段挑' };
  // 每种方式一个颜色 + 一种线型；地图上那条线就长这样（map.js 的 routeStyle 用同一套色）
  const MODES = [
    { key: 'driving', label: '驾车', color: '#1677ff', line: 'solid', lineText: '实线' },
    { key: 'riding', label: '骑行', color: '#e8760c', line: 'dash-long', lineText: '长虚线' },
    { key: 'walking', label: '步行', color: '#22a06b', line: 'dot', lineText: '细点线' },
    { key: 'transit', label: '公交', color: '#8a6cf0', line: 'dash-mid', lineText: '中虚线' },
  ];
  const CHIPS = [AUTO_MODE].concat(MODES);
  // 用户要的默认：先以时间最短的方式规划
  const DEFAULT_MODE = 'auto';

  let mode = DEFAULT_MODE;
  let perLeg = null; // 每段各自的方式（数组，长度 = 段数）；null = 全段用 mode
  let lastCity = null;
  let lastPins = [];
  let lastData = null;
  let selectedLeg = null; // P15：当前选中的段（地图高亮 + 列表高亮），null=没选
  let lastRouteKey = null; // 路线身份（城市|方式|点序）：变了才清选中态（地图一动就会 refresh 重画）
  let lastFitKey = null; // 上次让地图自动取景的路线身份
  let reqId = 0;
  let handlers = {}; // draw() 传进来的回调（列表由 app.js / itinerary.js 画）
  let lastDataKey = null; // lastData 对应的路线身份（对不上就不能当"眼前这条线"用）
  let pendingKey = null; // 正在规划的那条路线（同一条别再打一遍高德：挑点视图 refresh 很频繁）

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // 错误人话化：路线规划失败可能带高德的裸码（如 QPS_HAS_EXCEEDED_THE_LIMIT），别直接给用户看
  function human(err) {
    return window.TravelErrors
      ? window.TravelErrors.humanize(err)
      : String((err && err.message) || err || '');
  }

  function modeMeta(key) {
    return MODES.find((m) => m.key === key) || MODES[0];
  }

  // 当前状态的人话：全段一种方式，还是每段各自
  function modeSummary() {
    if (perLeg && perLeg.length) {
      if (new Set(perLeg).size === 1) return '全部 ' + modeMeta(perLeg[0]).label;
      return perLeg.map((k, i) => i + 1 + '.' + modeMeta(k).label).join(' ');
    }
    return mode === 'auto' ? '最快（每段各取最快）' : modeMeta(mode).label;
  }

  function fmtDistance(m) {
    const n = Number(m) || 0;
    if (n >= 1000) return (n / 1000).toFixed(1) + ' km';
    return Math.round(n) + ' m';
  }

  function fmtDuration(s) {
    const n = Math.round(Number(s) || 0);
    if (n >= 3600) {
      const h = Math.floor(n / 3600);
      const m = Math.round((n % 3600) / 60);
      return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    }
    if (n >= 60) return Math.round(n / 60) + ' 分钟';
    return (n > 0 ? '<1' : '0') + ' 分钟';
  }

  function renderChips() {
    const box = $('route-modes');
    if (!box) return;
    box.innerHTML = '';
    CHIPS.forEach((m) => {
      const active = !perLeg && m.key === mode;
      const btn = document.createElement('button');
      btn.className = 'chip route-chip' + (active ? ' active' : '');
      btn.dataset.key = m.key;
      btn.style.setProperty('--mode-color', m.color || 'var(--accent)');
      btn.title =
        m.key === 'auto'
          ? '最快：每段各自挑用时最短的方式'
          : m.label + '：所有段都用它（地图上这条线是' + m.lineText + '）';
      btn.setAttribute('aria-pressed', String(active));
      btn.innerHTML =
        (ModeIcons ? ModeIcons.svg(m.key, 14) : '') +
        '<span class="route-chip-label">' + esc(m.label) + '</span>' +
        (m.line ? '<span class="route-chip-line ' + m.line + '"></span>' : '');
      btn.onclick = () => {
        if (!perLeg && m.key === mode) return;
        perLeg = null;
        mode = m.key;
        renderChips();
        draw(lastCity, lastPins);
      };
      box.appendChild(btn);
    });
    // 每段不同的方式时，把方案写一行（不管是「最快」自己选出来的，还是手动改的）
    renderModesNote();
  }

  function renderModesNote() {
    const note = $('route-modes-note');
    if (!note) return;
    const ok = ((lastData && lastData.legs) || []).filter((l) => l.ok);
    const modes = ok.map((l) => l.mode);
    const mixed = modes.length > 1 && new Set(modes).size > 1;
    if (!mixed) {
      note.textContent = '';
      note.classList.add('hidden');
      return;
    }
    const head = mode === 'auto' && !perLeg ? '最快方案：' : '每段各自的方式：';
    note.textContent =
      head +
      ok
        .map((l, i) => i + 1 + '.' + modeMeta(l.mode).label + (Number(l.duration) > 0 ? ' ' + fmtDuration(l.duration) : ''))
        .join(' · ');
    note.classList.remove('hidden');
  }

  // 只换某一段的方式：其余段沿用它现在的方式，一次请求把新组合规划出来（单段结果有缓存）
  function setLegMode(index, key) {
    const legs = (lastData && lastData.legs) || [];
    if (!legs.length || index < 0 || index >= legs.length) return null;
    const current = legs.map((l) => l.mode || (mode === 'auto' ? MODES[0].key : mode));
    current[index] = key;
    if (new Set(current).size === 1) {
      mode = current[0];
      perLeg = null;
    } else {
      perLeg = current;
    }
    selectedLeg = index;
    renderChips();
    draw(lastCity, lastPins);
    return { mode, perLeg };
  }

  function setProgress(text) {
    const el = $('route-progress');
    if (el) el.textContent = text || '';
  }

  function renderTotals() {
    const el = $('route-totals');
    if (!el) return;
    if (!lastData) {
      el.innerHTML = '';
      return;
    }
    const failed = lastData.failed || [];
    // 「出行方式」不再在这行里说一遍：上面那排 route-modes 芯片就是它，选中态一眼看得出
    el.innerHTML =
      '<div class="route-metrics">' +
      '<span class="metric"><b>' + esc(fmtDistance(lastData.totalDistance)) + '</b><small>总里程</small></span>' +
      '<span class="metric"><b>' + esc(fmtDuration(lastData.totalDuration)) + '</b><small>总耗时</small></span>' +
      '</div>' +
      (failed.length
        ? '<div class="route-warn">⚠ ' + failed.length + ' 段无法规划，已用虚线代替</div>'
        : '');
  }

  // 段方式小标（图标 + 名字）：一眼看出这一段是怎么走的
  function legModeBadge(leg) {
    const key = leg.mode || (mode === 'auto' ? '' : mode);
    if (!key) return '';
    const m = modeMeta(key);
    return (
      '<span class="route-leg-mode" style="--mode-color:' + m.color + '" title="这一段的出行方式">' +
      (ModeIcons ? ModeIcons.svg(key, 12) : '') +
      '<span>' + esc(m.label) + '</span>' +
      '</span>'
    );
  }

  // 选择器里的耗时用短写法（「33 分」/「1 时 2 分」），不然四个按钮排不下要多占好几行
  function fmtShort(sec) {
    const n = Math.round(Number(sec) || 0);
    if (n >= 3600) {
      const h = Math.floor(n / 3600);
      const m = Math.round((n % 3600) / 60);
      return h + ' 时' + (m ? ' ' + m + ' 分' : '');
    }
    if (n >= 60) return Math.round(n / 60) + ' 分';
    return n > 0 ? '<1 分' : '—';
  }

  // 段详情里的「换这一段的方式」：四种方式都给一枚（能切）；有耗时就写出来
  function legModePicker(leg) {
    const opts = Array.isArray(leg.modeOptions) ? leg.modeOptions : [];
    const byMode = {};
    opts.forEach((o) => {
      byMode[o.mode] = o;
    });
    const items = MODES.map((m) => {
      const o = byMode[m.key] || null;
      const on = m.key === leg.mode;
      const failed = !!(o && o.ok === false);
      const known = !!(o && o.ok !== false && Number(o.duration) > 0);
      const meta = failed ? '规划不出来' : known ? fmtShort(o.duration) : '—';
      const tip = failed ? m.label + '：' + (o.reason || '规划不出来') : m.label + (known ? ' ' + meta : '');
      return (
        '<button type="button" class="leg-mode-btn' + (on ? ' on' : '') + (failed ? ' off' : '') + '"' +
        ' data-mode="' + esc(m.key) + '" style="--mode-color:' + m.color + '"' +
        ' title="' + esc(tip) + '"' +
        (failed ? ' disabled' : '') + '>' +
        (ModeIcons ? ModeIcons.svg(m.key, 12) : '') +
        '<span>' + esc(m.label) + '</span>' +
        '<b>' + esc(meta) + '</b>' +
        '</button>'
      );
    }).join('');
    return '<div class="leg-modes"><span class="leg-modes-tip">这一段怎么走：</span>' + items + '</div>';
  }

  function detailHtml(leg) {
    if (!leg.ok) {
      return '<p class="route-leg-reason">⚠ 无法规划（' + esc(leg.reason || '未知原因') + '）</p>';
    }
    const parts = [];
    if (leg.transit && Array.isArray(leg.transit.segments) && leg.transit.segments.length) {
      leg.transit.segments.forEach((seg) => {
        const label = seg.type === 'bus' ? '🚌 ' + (seg.name || '公交') : '🚶 步行';
        parts.push(
          '<li>' + esc(label) + ' · ' + esc(fmtDistance(seg.distance)) + ' / ' + esc(fmtDuration(seg.duration)) + '</li>'
        );
      });
    } else if (leg.steps && leg.steps.length) {
      leg.steps.slice(0, 8).forEach((s) => {
        parts.push('<li>' + esc(s.instruction || '继续前行') + ' · ' + esc(fmtDistance(s.distance)) + '</li>');
      });
      if (leg.steps.length > 8) parts.push('<li>…共 ' + leg.steps.length + ' 步</li>');
    } else {
      parts.push('<li>暂无分段指引</li>');
    }
    return legModePicker(leg) + '<ol class="route-steps">' + parts.join('') + '</ol>';
  }

  // 每一段的「到达行」：写在「这一个点」上面，说的是从上一站过来多远/多久/怎么走。
  // 路线不再单独开一张清单 —— 点与段写在同一个列表里（用户 2026-11-17：路线要放在一起看）。
  function legLineHtml(leg, opts) {
    const o = opts || {};
    if (!leg) {
      // 第一个点：写「起点」（定了住宿就说从哪儿出发）
      const base = o.base || null;
      const text = base ? '起点 · 从「' + esc(base.name || '住宿') + '」出发' : '起点';
      return (
        '<div class="route-leg itin-leg origin">' +
        '<div class="route-leg-head plain"><span class="itin-leg-origin">' + text + '</span></div>' +
        '</div>'
      );
    }
    const index = Number.isFinite(Number(o.index)) ? Number(o.index) : Number(leg.index) || 0;
    const ok = !!leg.ok;
    const parts = [];
    if (ok) {
      parts.push(fmtDuration(leg.duration));
      parts.push(fmtDistance(leg.distance));
      if (Number.isFinite(Number(o.cum)) && Number(o.cum) > 0) {
        parts.push('累计 ' + fmtDistance(o.cum));
      }
    }
    const meta = ok ? parts.join(' · ') : '⚠ 这一段没规划出来';
    return (
      '<div class="route-leg itin-leg' +
      (ok ? '' : ' failed') +
      (o.selected ? ' sel' : '') +
      (o.open ? ' open' : '') +
      '" data-index="' + index + '">' +
      '<button class="route-leg-head" type="button" title="点一下在地图上高亮这一段；展开看这一段的路书与换方式">' +
      legModeBadge(leg) +
      '<span class="route-leg-meta">' + esc(meta) + '</span>' +
      '<span class="itin-leg-chev" aria-hidden="true">›</span>' +
      '</button>' +
      '<div class="route-leg-detail">' + detailHtml(leg) + '</div>' +
      '</div>'
    );
  }

  // 分段选中：同一段再点一下取消（传 null/undefined = 直接取消）
  function selectLeg(index) {
    if (index === null || index === undefined) {
      selectedLeg = null;
    } else {
      const n = Number(index);
      selectedLeg = selectedLeg === n ? null : n;
    }
    if (MapCtl.setRouteSelection) MapCtl.setRouteSelection(selectedLeg);
    // 高亮/展开落在行程列表那一行上（原来是 #route-legs 自己那套）
    if (handlers.onSelectLeg) handlers.onSelectLeg(selectedLeg);
  }

  function routeKey(city, pins) {
    // 同一条路线（城市/出行方式/点序都没变）重画时，保留用户选中的那一段
    return [
      city || '',
      mode,
      perLeg ? perLeg.join(',') : '',
      (pins || []).map((p) => p.id || p.poi_id || p.name).join(','),
    ].join('|');
  }

  // 页面上的点序（服务端口径：poi_id，没 poi_id 的用 pin:<行号>）——
  // 「按距离」时页面顺序与库里那份不一样，不带上它，服务端会按库里顺序逐段规划，两边的「第 n 段」就对不上
  function orderKeys(pins) {
    return (pins || []).map((p) => (p && p.id != null ? String(p.id) : '')).filter(Boolean);
  }

  async function draw(city, pins, opts) {
    if (city) lastCity = city;
    if (pins) lastPins = pins || [];
    if (opts) handlers = opts;
    const key = routeKey(lastCity, lastPins);
    const sameRoute = key === lastRouteKey;
    if (!sameRoute) {
      selectedLeg = null; // 换城市/换方式/点序变了 ⇒ 选中态收回
      lastRouteKey = key;
    }
    renderChips();

    if (!lastCity || lastPins.length < 2) {
      MapCtl.clearRoute();
      lastData = null;
      lastDataKey = null;
      renderTotals();
      notifyLegs();
      renderModesNote();
      setProgress(lastPins.length ? '至少需要 2 个地点才能连线' : '');
      return;
    }

    // 同一条路线：不重请求、不重画（地图一动就会 refresh ⇒ 否则路线会闪一下、还白花配额）
    if (sameRoute && lastData) {
      if (MapCtl.setRouteSelection) MapCtl.setRouteSelection(selectedLeg);
      notifyLegs();
      return;
    }

    MapCtl.clearRoute();
    const n = lastPins.length - 1;
    if (key === pendingKey) return; // 同一条还在规划中：别重复打高德
    pendingKey = key;
    const my = (reqId += 1);
    setProgress(
      perLeg
        ? '正在按每段各自的方式规划…'
        : mode === 'auto'
          ? '正在按最快的方式逐段规划（四种方式各试一遍）…'
          : '正在规划 0/' + n + ' 段…'
    );
    let shown = 0;
    const timer = setInterval(() => {
      if (my !== reqId) return;
      if (shown < n - 1) {
        shown += 1;
        setProgress('正在规划 ' + shown + '/' + n + ' 段…');
      }
    }, 250);

    try {
      const data = perLeg
        ? await API.itineraryRoute(lastCity, { modes: perLeg, order: orderKeys(lastPins) })
        : await API.itineraryRoute(lastCity, { mode, order: orderKeys(lastPins) });
      if (my !== reqId) return;
      lastData = data;
      lastDataKey = key;
      renderTotals();
      notifyLegs();
      renderModesNote();
      // 挑点视图里只想看这条线，别把用户的镜头拽走（fit=false 时 lastFitKey 不动，进行程视图还会自动取景）
      const fit = handlers.fit !== false && key !== lastFitKey;
      MapCtl.drawRoute(data.legs, mode, {
        onLegClick: (leg) => selectLeg(leg.index),
        fit,
      });
      if (fit) lastFitKey = key;
      // 重画后把选中态补回去（clearRoute 会把地图那边清掉）
      if (MapCtl.setRouteSelection) MapCtl.setRouteSelection(selectedLeg);
      const okCount = data.legs.filter((l) => l.ok).length;
      const degraded = (data.failed || []).length;
      setProgress('已规划 ' + okCount + '/' + n + ' 段' + (degraded ? '（' + degraded + ' 段降级）' : '') + ' · 点某段在地图上高亮');
    } catch (err) {
      if (my !== reqId) return;
      lastData = null;
      lastDataKey = null;
      renderTotals();
      notifyLegs();
      renderModesNote();
      setProgress('路线规划失败：' + human(err));
      MapCtl.clearRoute();
    } finally {
      if (pendingKey === key) pendingKey = null; // 收工：同一条路线下次真的变了才重规划
      clearInterval(timer);
    }
  }

  // 段数据一变就交给外面重画（列表由 itinerary.js 画，不再单独渲染一张段清单）
  function notifyLegs() {
    if (handlers.onLegs) handlers.onLegs((lastData && lastData.legs) || []);
  }

  // 换全局方式（挑点清单里的芯片与行程视图那排共用这一份状态）
  function setMode(key) {
    if (!key) return;
    if (!perLeg && key === mode) return;
    perLeg = null;
    mode = key;
    renderChips();
    draw(lastCity, lastPins);
  }

  function clear() {
    lastData = null;
    lastDataKey = null;
    pendingKey = null;
    perLeg = null;
    MapCtl.clearRoute();
    notifyLegs();
    renderModesNote();
    setProgress('');
  }

  window.TravelRoute = {
    draw,
    clear,
    renderChips,
    selectLeg,
    setMode,
    legLineHtml,
    detailHtml,
    // 只有"眼前这条路线"的段数据才算（换了城市/方式/点序但还没拿到新结果时给空，别拿旧数字充数）
    getLegs: () => (lastData && lastDataKey === lastRouteKey ? lastData.legs : []) || [],
    isPlanning: () => lastPins.length > 1 && !(lastData && lastDataKey === lastRouteKey),
    getSelectedLeg: () => selectedLeg,
    getMode: () => mode,
    getPerLeg: () => perLeg,
    setLegMode: (index, key) => setLegMode(index, key),
    modeSummary,
    modeMeta,
    fmtDistance,
    fmtDuration,
    fmtShort,
    AUTO_MODE,
    MODES,
    DEFAULT_MODE,
  };
})();
