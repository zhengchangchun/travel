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
        legModeBadge(leg) +
        '<span class="route-leg-path">' + esc(leg.from.name) + ' → ' + esc(leg.to.name) + '</span>' +
        '<span class="route-leg-meta">' + esc(meta) + '</span>' +
        '</button>' +
        '<div class="route-leg-detail">' + detailHtml(leg) + '</div>';
      li.querySelector('.route-leg-head').onclick = () => selectLeg(leg.index);
      // 点「换这一段的方式」：只改这一段，其余段照旧
      Array.prototype.forEach.call(li.querySelectorAll('.leg-mode-btn'), (btn) => {
        btn.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (btn.disabled) return;
          setLegMode(leg.index, btn.dataset.mode);
        };
      });
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
    return [
      city || '',
      mode,
      perLeg ? perLeg.join(',') : '',
      (pins || []).map((p) => p.id || p.poi_id || p.name).join(','),
    ].join('|');
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
      renderModesNote();
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
        ? await API.itineraryRoute(lastCity, { modes: perLeg })
        : await API.itineraryRoute(lastCity, mode);
      if (my !== reqId) return;
      lastData = data;
      renderTotals();
      renderLegs();
      renderModesNote();
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
      renderModesNote();
      setProgress('路线规划失败：' + human(err));
      MapCtl.clearRoute();
    } finally {
      clearInterval(timer);
    }
  }

  function clear() {
    lastData = null;
    perLeg = null;
    MapCtl.clearRoute();
    renderLegs();
    renderModesNote();
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
    getPerLeg: () => perLeg,
    setLegMode: (index, key) => setLegMode(index, key),
    modeSummary,
    modeMeta,
    AUTO_MODE,
    MODES,
    DEFAULT_MODE,
  };
})();
