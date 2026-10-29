/* 界面渲染：分类 chip、结果列表、信息卡、状态与错误提示 */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    const el = $('map-status');
    if (el) el.textContent = text;
  }

  // 双口径计数：当前视野 N 条 · 全城已收录 M 条
  function setViewCount(viewN, total) {
    const el = $('view-count');
    if (!el) return;
    el.textContent = '当前视野 ' + viewN + ' 条 · 全城已收录 ' + total + ' 条';
  }

  function showMapError(msg) {
    const el = $('map-error');
    if (!el) return;
    el.textContent = '⚠ ' + msg;
    el.classList.remove('hidden');
  }

  function hideMapError() {
    const el = $('map-error');
    if (el) el.classList.add('hidden');
  }

  function renderChips(container, categories, selected, onToggle) {
    container.innerHTML = '';
    categories.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (selected.has(cat.key) ? ' active' : '');
      btn.dataset.key = cat.key;
      btn.style.setProperty('--chip-color', cat.color);
      btn.innerHTML =
        '<span class="dot" style="background:' + esc(cat.color) + '"></span>' +
        esc(cat.label);
      btn.onclick = () => onToggle(cat.key);
      container.appendChild(btn);
    });
  }

  // 评分过滤 chip：与分类 chip、只看选中可叠加
  function renderRatingChips(container, options, active, onPick) {
    if (!container) return;
    container.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'chip rating-chip' + (active === opt.key ? ' active' : '');
      btn.dataset.key = opt.key;
      btn.textContent = opt.label;
      btn.onclick = () => onPick(opt.key);
      container.appendChild(btn);
    });
  }

  function topStarHtml(poi) {
    const SC = window.TravelScoreColor;
    if (!SC || !SC.isTop(poi.rating)) return '';
    return '<span class="top-star" title="满分 ' + esc(poi.rating) + '">★</span>';
  }

  function showLegend(show) {
    const el = $('score-legend');
    if (el) el.classList.toggle('hidden', !show);
  }

  function starButton(selected, color) {
    return (
      '<button class="star' + (selected ? ' active' : '') + '" ' +
      'title="' + (selected ? '取消选中' : '选中') + '" ' +
      'style="--star-color:' + esc(color) + '">' +
      (selected ? '★' : '☆') +
      '</button>'
    );
  }

  function renderResults(container, pois, onPick, handlers) {
    handlers = handlers || {};
    container.innerHTML = '';
    if (!pois.length) {
      container.innerHTML = '<li class="empty">没有结果</li>';
      return;
    }
    pois.forEach((poi) => {
      const color = window.TravelCategories.colorOf(poi.category);
      const label = window.TravelCategories.labelOf(poi.category);
      const meta = [
        poi.rating ? '★ ' + poi.rating : '',
        poi.cost ? '¥' + poi.cost : '',
      ].filter(Boolean).join(' · ');
      const selected = handlers.isSelected ? handlers.isSelected(poi) : false;

      const li = document.createElement('li');
      li.className = 'poi-item';
      li.innerHTML =
        '<div class="poi-head">' +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(poi.name) + '</b>' +
        topStarHtml(poi) +
        '<span class="poi-tag">' + esc(label) + '</span>' +
        starButton(selected, color) +
        '</div>' +
        '<div class="poi-addr">' + esc(poi.address || '（无详细地址）') + '</div>' +
        (meta ? '<div class="poi-meta">' + esc(meta) + '</div>' : '');
      li.onclick = () => onPick(poi);
      const star = li.querySelector('.star');
      if (star && handlers.onToggleSelect) {
        star.onclick = (e) => {
          e.stopPropagation();
          handlers.onToggleSelect(poi);
        };
      }
      container.appendChild(li);
    });
  }

  function renderSelectionPanel(container, pins, handlers) {
    container.innerHTML = '';
    if (!pins.length) {
      container.innerHTML =
        '<li class="empty">点列表里的 ★ 把想去的地方挑出来</li>';
      return;
    }
    pins.forEach((pin) => {
      const color = window.TravelCategories.colorOf(pin.category);
      const label = window.TravelCategories.labelOf(pin.category);
      const li = document.createElement('li');
      li.className = 'poi-item sel-item';
      li.innerHTML =
        '<div class="poi-head">' +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(pin.name) + '</b>' +
        '<span class="poi-tag">' + esc(label) + '</span>' +
        '</div>' +
        '<div class="poi-addr">' + esc(pin.address || '（无详细地址）') + '</div>' +
        '<div class="sel-actions">' +
        '<button class="locate">定位</button>' +
        '<button class="del">移除</button>' +
        '</div>';
      li.onclick = () => handlers.onLocate(pin);
      const locate = li.querySelector('.locate');
      const del = li.querySelector('.del');
      if (locate) locate.onclick = (e) => { e.stopPropagation(); handlers.onLocate(pin); };
      if (del) del.onclick = (e) => { e.stopPropagation(); handlers.onRemove(pin); };
      container.appendChild(li);
    });
  }

  function renderTripPins(container, pins, onPick, onDelete) {
    container.innerHTML = '';
    if (!pins.length) {
      container.innerHTML = '<li class="empty">还没有加入任何点</li>';
      return;
    }
    pins.forEach((pin) => {
      const color = window.TravelCategories.colorOf(pin.category);
      const li = document.createElement('li');
      li.className = 'poi-item';
      li.innerHTML =
        '<div class="poi-head">' +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(pin.name) + '</b>' +
        '<button class="del" title="删除">×</button>' +
        '</div>' +
        '<div class="poi-addr">' + esc(pin.address || '') + '</div>';
      li.onclick = (e) => {
        if (e.target.classList.contains('del')) return;
        onPick(pin);
      };
      const del = li.querySelector('.del');
      if (del) del.onclick = (e) => {
        e.stopPropagation();
        onDelete(pin);
      };
      container.appendChild(li);
    });
  }

  window.TravelUI = {
    esc,
    setStatus,
    setViewCount,
    showMapError,
    hideMapError,
    renderChips,
    renderRatingChips,
    showLegend,
    renderResults,
    renderSelectionPanel,
    renderTripPins,
  };
})();
