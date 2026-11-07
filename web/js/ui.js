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

  // 视野提示（「本区域加载中…」「放大地图以加载」）：空串则隐藏
  function setViewHint(text) {
    const el = $('view-hint');
    if (!el) return;
    if (!text) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
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

  // 住宿锚点按钮（只给住宿项）：定为「住这」
  function baseButton(isBase) {
    return (
      '<button class="base-pick' + (isBase ? ' active' : '') + '" ' +
      'title="' + (isBase ? '已是住宿锚点' : '定为住宿锚点') + '">' +
      (isBase ? '★住这' : '住这') +
      '</button>'
    );
  }

  // 单条渲染（抽出来供增量复用）
  function buildItem(poi, key, sig, handlers, onPick) {
    const color = window.TravelCategories.colorOf(poi.category);
    const label = window.TravelCategories.labelOf(poi.category);
    const meta = [
      poi.rating ? '★ ' + poi.rating : '',
      poi.cost ? '¥' + poi.cost : '',
    ].filter(Boolean).join(' · ');
    const selected = handlers.isSelected ? handlers.isSelected(poi) : false;
    const isBase = handlers.isBase ? handlers.isBase(poi) : false;

    const li = document.createElement('li');
    li.className = 'poi-item';
    li.dataset.key = key;
    li.dataset.sig = sig;
    li.innerHTML =
      '<div class="poi-head">' +
      '<span class="dot" style="background:' + esc(color) + '"></span>' +
      '<b class="poi-name">' + esc(poi.name) + '</b>' +
      topStarHtml(poi) +
      '<span class="poi-tag">' + esc(label) + '</span>' +
      (poi.category === 'stay' ? baseButton(isBase) : '') +
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
    const basePick = li.querySelector('.base-pick');
    if (basePick && handlers.onSetBase) {
      basePick.onclick = (e) => {
        e.stopPropagation();
        handlers.onSetBase(poi);
      };
    }
    return li;
  }

  // 结果列表：增量渲染（键 + 内容签名）——移动地图时只改动变化的行，不再整屏清空重建
  function renderResults(container, pois, onPick, handlers) {
    handlers = handlers || {};
    const list = Array.isArray(pois) ? pois : [];
    if (!list.length) {
      container.replaceChildren
        ? container.replaceChildren()
        : (container.innerHTML = '');
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = handlers.emptyText || '没有结果';
      // 空态 CTA：首屏只说一次引导，并且给一个能点的动作（P9-①）
      const action = handlers.emptyAction;
      if (action && action.label) {
        const btn = document.createElement('button');
        btn.className = 'primary empty-cta';
        btn.textContent = action.label;
        if (action.title) btn.title = action.title;
        btn.onclick = (e) => {
          e.stopPropagation();
          if (typeof action.onClick === 'function') action.onClick();
        };
        empty.appendChild(btn);
      }
      container.appendChild(empty);
      return;
    }
    const DIFF = window.TravelDiff;
    const keyOf = (p) => String(p.id || p.poi_id || p.name + '@' + p.lng + ',' + p.lat);
    const sigOf = (p) =>
      DIFF
        ? DIFF.signatureOf([
            p.name,
            p.address,
            p.category,
            p.rating,
            p.cost,
            handlers.isSelected ? handlers.isSelected(p) : false,
            handlers.isBase ? handlers.isBase(p) : false,
          ])
        : '';

    const existing = new Map();
    Array.from(container.querySelectorAll('li.poi-item')).forEach((li) => {
      existing.set(li.dataset.key, { node: li, sig: li.dataset.sig || '' });
    });

    const out = [];
    list.forEach((poi) => {
      const k = keyOf(poi);
      const sig = sigOf(poi);
      const hit = existing.get(k);
      if (hit) existing.delete(k);
      if (hit && hit.sig === sig) {
        out.push(hit.node); // 签名一致：复用原节点（不重建、不闪）
        return;
      }
      out.push(buildItem(poi, k, sig, handlers, onPick));
    });
    existing.forEach((v) => {
      if (v.node && v.node.parentNode) v.node.parentNode.removeChild(v.node);
    });
    if (typeof container.replaceChildren === 'function') container.replaceChildren(...out);
    else {
      container.innerHTML = '';
      out.forEach((n) => container.appendChild(n));
    }
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
    setViewHint,
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
