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
  // label 缺省「当前视野」；轮廓屏传「全城精选」（那时列表口径不是本视野）
  function setViewCount(viewN, total, label) {
    const el = $('view-count');
    if (!el) return;
    el.textContent = (label || '当前视野') + ' ' + viewN + ' 条 · 全城已收录 ' + total + ' 条';
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
        '<span class="chip-label">' + esc(cat.label) + '</span>';
      btn.onclick = () => onToggle(cat.key);
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
      shotHtml(poi, handlers) +
      '<span class="dot" style="background:' + esc(color) + '"></span>' +
      '<b class="poi-name">' + esc(poi.name) + '</b>' +
      topStarHtml(poi) +
      '<span class="poi-tag">' + esc(label) + '</span>' +
      (poi.source === 'osm'
        ? '<span class="poi-tag src" title="这条来自 OpenStreetMap（高德不可用时的兑底）">OSM</span>'
        : '') +
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
      // 空态：只在给了文案时写一句；不再有 CTA（用户 2026-11-09 把空态引导也删了）
      container.replaceChildren
        ? container.replaceChildren()
        : (container.innerHTML = '');
      const text = handlers.emptyText;
      if (text) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = text;
        container.appendChild(empty);
      }
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
            // 实景图是异步拿的：图变了也要重画这一行
            handlers.photoOf ? handlers.photoOf(p) : '',
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

  // 一行的缩略实景图（「我的选择」与行程清单共用同一份图片口径：先看点自己的图，再按名字查）
  function shotHtml(pin, handlers) {
    const fn = handlers && handlers.photoOf;
    const src = typeof fn === 'function' ? fn(pin) : pin && pin.photo ? String(pin.photo) : '';
    if (!src) return '';
    const creditFn = handlers && handlers.photoCreditOf;
    const credit = typeof creditFn === 'function' ? creditFn(pin) : '';
    return (
      '<img class="itin-shot" src="' + esc(src) + '" alt="" loading="lazy" title="' +
      esc(credit ? '图：' + credit : pin.name) + '" onerror="this.remove()" />'
    );
  }

  // 「我的选择」：序号 + 上一站到这里的耗时（实时）+ 上移/下移/定位/移除
  function renderSelectionPanel(container, pins, handlers) {
    container.innerHTML = '';
    if (!pins.length) {
      container.innerHTML =
        '<li class="empty">点列表里的 ★ 把想去的地方挑出来</li>';
      return;
    }
    const QR = window.TravelQuickRoute;
    const legs = Array.isArray(handlers && handlers.legs) ? handlers.legs : [];
    pins.forEach((pin, i) => {
      const color = window.TravelCategories.colorOf(pin.category);
      const label = window.TravelCategories.labelOf(pin.category);
      const li = document.createElement('li');
      li.className = 'poi-item sel-item';
      const leg = i > 0 ? legs[i - 1] : null;
      // 与行程清单同一个读法：「从上一站过来」写在点上面（别再写在行尾，两张清单看着才一致）
      li.innerHTML =
        '<div class="sel-leg' + (leg ? '' : ' start') + '">' +
        esc(i === 0 ? '起点' : QR ? QR.legText(leg) : '') +
        '</div>' +
        '<div class="poi-head">' +
        '<span class="sel-order">' + (i + 1) + '</span>' +
        shotHtml(pin, handlers) +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(pin.name) + '</b>' +
        '<span class="poi-tag">' + esc(label) + '</span>' +
        '</div>' +
        '<div class="poi-addr">' + esc(pin.address || '（无详细地址）') + '</div>' +
        window.TravelNoteBox.html(pin.note) +
        '<div class="sel-actions">' +
        '<button class="up" title="往前挪一位"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="down" title="往后挪一位"' +
        (i === pins.length - 1 ? ' disabled' : '') +
        '>↓</button>' +
        '<button class="locate">定位</button>' +
        '<button class="del">移除</button>' +
        '</div>';
      li.onclick = () => handlers.onLocate(pin);
      const locate = li.querySelector('.locate');
      const del = li.querySelector('.del');
      const up = li.querySelector('.up');
      const down = li.querySelector('.down');
      if (locate) locate.onclick = (e) => { e.stopPropagation(); handlers.onLocate(pin); };
      if (del) del.onclick = (e) => { e.stopPropagation(); handlers.onRemove(pin); };
      if (up && handlers.onMove) {
        up.onclick = (e) => { e.stopPropagation(); handlers.onMove(i, -1); };
      }
      if (down && handlers.onMove) {
        down.onclick = (e) => { e.stopPropagation(); handlers.onMove(i, 1); };
      }
      // 挑点阶段也能写备注（与行程视图同一份数据：pins.note）
      if (handlers && handlers.onNote) {
        window.TravelNoteBox.wire(li, {
          value: pin.note,
          placeholder: '这条的备注：几点去 / 必点菜 / 要带什么',
          onSave: (text) => handlers.onNote(pin, text),
          onDone: handlers.onCancel,
        });
      }
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
    showLegend,
    renderResults,
    renderSelectionPanel,
    renderTripPins,
  };
})();
