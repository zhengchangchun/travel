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

  function renderResults(container, pois, onPick) {
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

      const li = document.createElement('li');
      li.className = 'poi-item';
      li.innerHTML =
        '<div class="poi-head">' +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(poi.name) + '</b>' +
        '<span class="poi-tag">' + esc(label) + '</span>' +
        '</div>' +
        '<div class="poi-addr">' + esc(poi.address || '（无详细地址）') + '</div>' +
        (meta ? '<div class="poi-meta">' + esc(meta) + '</div>' : '');
      li.onclick = () => onPick(poi);
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

  function showInfocard(card, poi, currentCity, handlers) {
    const color = window.TravelCategories.colorOf(poi.category);
    const label = window.TravelCategories.labelOf(poi.category);
    const navUrl =
      'https://uri.amap.com/marker?position=' +
      poi.lng + ',' + poi.lat + '&name=' + encodeURIComponent(poi.name);
    const xhsUrl =
      'https://www.xiaohongshu.com/search_result?keyword=' +
      encodeURIComponent((currentCity || '') + poi.name);

    const rows = [];
    if (poi.rating) rows.push(['评分', '★ ' + poi.rating]);
    if (poi.cost) rows.push(['人均', '¥' + poi.cost]);
    if (poi.tel) rows.push(['电话', poi.tel]);
    if (poi.opentime) rows.push(['营业时间', poi.opentime]);

    card.innerHTML =
      (poi.photo ? '<img class="card-photo" src="' + esc(poi.photo) + '" alt="" />' : '') +
      '<div class="card-head">' +
      '<span class="dot" style="background:' + esc(color) + '"></span>' +
      '<b>' + esc(poi.name) + '</b>' +
      '<span class="poi-tag">' + esc(label) + '</span>' +
      '<button class="card-close" title="关闭">×</button>' +
      '</div>' +
      '<div class="card-addr">' +
      '<span class="addr-text">' + esc(poi.address || '（无详细地址）') + '</span>' +
      '<button class="copy-addr" title="复制地址">复制</button>' +
      '</div>' +
      (rows.length
        ? '<dl class="card-rows">' +
          rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') +
          '</dl>'
        : '') +
      '<div class="card-actions">' +
      '<a class="btn" href="' + esc(navUrl) + '" target="_blank" rel="noopener">导航</a>' +
      '<a class="btn xhs" href="' + esc(xhsUrl) + '" target="_blank" rel="noopener">去小红书看笔记</a>' +
      '<button class="btn primary add-pin">加入行程</button>' +
      '</div>';
    card.classList.remove('hidden');

    const close = card.querySelector('.card-close');
    if (close) close.onclick = () => card.classList.add('hidden');

    const copy = card.querySelector('.copy-addr');
    if (copy) copy.onclick = async () => {
      const text = poi.address || '';
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = '已复制';
      } catch (err) {
        window.prompt('复制地址：', text);
      }
      setTimeout(() => (copy.textContent = '复制'), 1500);
    };

    const add = card.querySelector('.add-pin');
    if (add && handlers && handlers.onAddPin) {
      add.onclick = () => handlers.onAddPin(poi);
    }
  }

  window.TravelUI = {
    esc,
    setStatus,
    showMapError,
    hideMapError,
    renderChips,
    renderResults,
    renderTripPins,
    showInfocard,
  };
})();
