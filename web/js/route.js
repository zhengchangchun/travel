/* 路线连线与总览：出行方式切换、总里程/耗时、分段明细、地图连线（T3） */
(function () {
  const API = window.TravelAPI;
  const MapCtl = window.TravelMap;

  const MODES = [
    { key: 'walking', label: '步行', icon: '🚶' },
    { key: 'transit', label: '公交', icon: '🚌' },
    { key: 'driving', label: '驾车', icon: '🚗' },
  ];
  const DEFAULT_MODE = 'driving';

  let mode = DEFAULT_MODE;
  let lastCity = null;
  let lastPins = [];
  let lastData = null;
  let selectedLeg = null; // P15：当前选中的段（地图高亮 + 列表高亮），null=没选
  let lastRouteKey = null; // 路线身份（城市|方式|点序）：变了才清选中态（地图一动就会 refresh 重画）
  let lastFitKey = null; // 上次让地图自动取景的路线身份
  let reqId = 0;

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
    return MODES.find((m) => m.key === key) || MODES[2];
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
    MODES.forEach((m) => {
      const btn = document.createElement('button');
      btn.className = 'chip route-chip' + (m.key === mode ? ' active' : '');
      btn.dataset.key = m.key;
      btn.innerHTML =
        '<span class="route-chip-icon">' + m.icon + '</span>' + m.label;
      btn.onclick = () => {
        if (m.key === mode) return;
        mode = m.key;
        renderChips();
        draw(lastCity, lastPins);
      };
      box.appendChild(btn);
    });
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
    const meta = modeMeta(mode);
    const failed = lastData.failed || [];
    el.innerHTML =
      '<div class="route-mode-line">出行方式：<b>' + meta.icon + ' ' + esc(meta.label) + '</b></div>' +
      '<div class="route-metrics">' +
      '<span class="metric"><b>' + esc(fmtDistance(lastData.totalDistance)) + '</b><small>总里程</small></span>' +
      '<span class="metric"><b>' + esc(fmtDuration(lastData.totalDuration)) + '</b><small>总耗时</small></span>' +
      '</div>' +
      (failed.length
        ? '<div class="route-warn">⚠ ' + failed.length + ' 段无法规划，已用虚线代替</div>'
        : '');
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
    return '<ol class="route-steps">' + parts.join('') + '</ol>';
  }

  function renderLegs() {
    const ul = $('route-legs');
    if (!ul) return;
    ul.innerHTML = '';
    if (!lastData) return;
    (lastData.legs || []).forEach((leg) => {
      const meta = leg.ok
        ? fmtDistance(leg.distance) + ' / ' + fmtDuration(leg.duration)
        : '⚠ 无法规划';
      const li = document.createElement('li');
      li.className = 'route-leg' + (leg.ok ? '' : ' failed');
      li.dataset.index = String(leg.index);
      li.innerHTML =
        '<button class="route-leg-head">' +
        '<span class="route-leg-no">' + (leg.index + 1) + '</span>' +
        '<span class="route-leg-path">' + esc(leg.from.name) + ' → ' + esc(leg.to.name) + '</span>' +
        '<span class="route-leg-meta">' + esc(meta) + '</span>' +
        '</button>' +
        '<div class="route-leg-detail">' + detailHtml(leg) + '</div>';
      li.querySelector('.route-leg-head').onclick = () => selectLeg(leg.index);
      ul.appendChild(li);
    });
    paintSelection();
  }

  // 分段选中：同一段再点一下取消（传 null/undefined = 直接取消）
  function selectLeg(index) {
    if (index === null || index === undefined) {
      selectedLeg = null;
    } else {
      const n = Number(index);
      selectedLeg = selectedLeg === n ? null : n;
    }
    paintSelection();
    if (MapCtl.setRouteSelection) MapCtl.setRouteSelection(selectedLeg);
    if (selectedLeg !== null) focusLeg(selectedLeg);
    else closeAllLegs();
  }

  function paintSelection() {
    const ul = $('route-legs');
    if (!ul) return;
    Array.prototype.forEach.call(ul.querySelectorAll('.route-leg'), (li) => {
      const on = selectedLeg !== null && Number(li.dataset.index) === selectedLeg;
      li.classList.toggle('sel', on);
    });
  }

  function closeAllLegs() {
    const ul = $('route-legs');
    if (!ul) return;
    Array.prototype.forEach.call(ul.querySelectorAll('.route-leg.open'), (x) => x.classList.remove('open'));
  }

  function focusLeg(index) {
    const ul = $('route-legs');
    if (!ul) return;
    const li = ul.querySelector('.route-leg[data-index="' + index + '"]');
    if (!li) return;
    ul.querySelectorAll('.route-leg.open').forEach((x) => {
      if (x !== li) x.classList.remove('open');
    });
    li.classList.add('open');
    if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function routeKey(city, pins) {
    // 同一条路线（城市/出行方式/点序都没变）重画时，保留用户选中的那一段
    return [city || '', mode, (pins || []).map((p) => p.id || p.poi_id || p.name).join(',')].join('|');
  }

  async function draw(city, pins) {
    if (city) lastCity = city;
    if (pins) lastPins = pins || [];
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
      renderTotals();
      renderLegs();
      setProgress(lastPins.length ? '至少需要 2 个地点才能连线' : '');
      return;
    }

    // 同一条路线：不重请求、不重画（地图一动就会 refresh ⇒ 否则路线会闪一下、还白花配额）
    if (sameRoute && lastData) {
      if (MapCtl.setRouteSelection) MapCtl.setRouteSelection(selectedLeg);
      return;
    }

    MapCtl.clearRoute();
    const n = lastPins.length - 1;
    const my = (reqId += 1);
    setProgress('正在规划 0/' + n + ' 段…');
    let shown = 0;
    const timer = setInterval(() => {
      if (my !== reqId) return;
      if (shown < n - 1) {
        shown += 1;
        setProgress('正在规划 ' + shown + '/' + n + ' 段…');
      }
    }, 250);

    try {
      const data = await API.itineraryRoute(lastCity, mode);
      if (my !== reqId) return;
      lastData = data;
      renderTotals();
      renderLegs();
      MapCtl.drawRoute(data.legs, mode, {
        onLegClick: (leg) => selectLeg(leg.index),
        // 同一条路线只是重画（地图动一下就会 refresh 重画）⇒ 别再 setFitView 抢镜头
        fit: key !== lastFitKey,
      });
      lastFitKey = key;
      // 重画后把选中态补回去（clearRoute 会把地图那边清掉）
      if (MapCtl.setRouteSelection) MapCtl.setRouteSelection(selectedLeg);
      const okCount = data.legs.filter((l) => l.ok).length;
      const degraded = (data.failed || []).length;
      setProgress('已规划 ' + okCount + '/' + n + ' 段' + (degraded ? '（' + degraded + ' 段降级）' : '') + ' · 点某段在地图上高亮');
    } catch (err) {
      if (my !== reqId) return;
      lastData = null;
      renderTotals();
      renderLegs();
      setProgress('路线规划失败：' + human(err));
      MapCtl.clearRoute();
    } finally {
      clearInterval(timer);
    }
  }

  function clear() {
    lastData = null;
    MapCtl.clearRoute();
    setProgress('');
  }

  window.TravelRoute = {
    draw,
    clear,
    renderChips,
    focusLeg,
    selectLeg,
    getSelectedLeg: () => selectedLeg,
    getMode: () => mode,
    MODES,
    DEFAULT_MODE,
  };
})();
