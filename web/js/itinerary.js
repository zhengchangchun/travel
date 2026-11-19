/* 行程视图（一条路线就是这一张清单）：
   - 每个点自带「从上一站过来多远 / 多久 / 怎么走」（原来的 #route-legs 已并入这里）
   - 点这一行上方那条到达行 = 在地图上高亮这一段；展开 = 路书 + 「这一段怎么走」四选一
   - 按 sort_order 列出、拖拽或 ↑↓ 调序（「按距离」时拖一下就切成我自己的顺序）
   - 每条写备注，一键复制 / 下载 .md */
(function () {
  const Cats = window.TravelCategories;
  const NoteBox = window.TravelNoteBox;

  // 正在拖的行号（同一次拖拽里共用；放下/结束时清掉）
  let dragFrom = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function Route() {
    return window.TravelRoute || null;
  }

  // 第 i 个点的「从第 1 个点走到这里的累计直线距离」——只累加规划成功的那几段
  function cumulative(legs, pinCount) {
    const out = [];
    let run = 0;
    for (let i = 0; i < pinCount; i += 1) {
      if (i > 0) {
        const leg = legs[i - 1];
        if (leg && leg.ok) run += Number(leg.distance) || 0;
      }
      out.push(run);
    }
    return out;
  }

  // 拖拽：按住行内把手拖动 → 落到目标行上（源行移到目标行的位置），一次 PUT 落库
  function wireDrag(li, index, container, handlers) {
    li.addEventListener('dragstart', (e) => {
      dragFrom = index;
      li.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(index)); } catch (err) { /* 忽略 */ }
      }
    });
    li.addEventListener('dragend', () => {
      dragFrom = null;
      li.classList.remove('dragging', 'drop-on');
      Array.from(container.querySelectorAll('.drop-on')).forEach((n) => n.classList.remove('drop-on'));
    });
    li.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (index !== dragFrom) li.classList.add('drop-on');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-on'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drop-on');
      const raw = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
      const from = dragFrom === null ? Number(raw) : dragFrom;
      dragFrom = null;
      if (Number.isFinite(from) && from !== index && handlers.onReorder) handlers.onReorder(from, index);
    });
  }

  // 一条到达行（含路书与「这一段怎么走」）：HTML 由 route.js 给，这里只负责接线
  function wireLeg(el, index, handlers) {
    const head = el.querySelector('.route-leg-head');
    if (head && handlers.onLegSelect) {
      head.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        handlers.onLegSelect(index);
      };
    }
    if (!handlers.onLegMode) return;
    Array.prototype.forEach.call(el.querySelectorAll('.leg-mode-btn'), (btn) => {
      btn.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (btn.disabled) return;
        handlers.onLegMode(index, btn.dataset.mode);
      };
    });
  }

  // 一行的缩略实景图（拿不到图就不占位）
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

  function render(container, pins, handlers) {
    handlers = handlers || {};
    if (!container) return;
    const R = Route();
    const legs = Array.isArray(handlers.legs) ? handlers.legs : [];
    const selectedLeg = handlers.selectedLeg;
    container.innerHTML = '';
    if (!pins.length) {
      container.innerHTML = '<li class="empty">还没有选中的地点，先去挑几个吧</li>';
      return;
    }
    const cums = cumulative(legs, pins.length);
    const dayCount = pins.reduce((m, p) => Math.max(m, Number(p.day) || 1), 1);
    // 多天时，每天开头插一条标题：第 N 天 · k 个点 · 直线 ≈ x km
    const dayStats = {};
    let prevPin = null;
    let prevDayNo = null;
    pins.forEach((pin) => {
      const d = Number(pin.day) || 1;
      if (!dayStats[d]) dayStats[d] = { n: 0, m: 0 };
      dayStats[d].n += 1;
      const Geo = window.TravelGeo;
      if (prevPin && prevDayNo === d && Geo && Geo.distanceM) {
        const dist = Geo.distanceM(prevPin, pin);
        if (Number.isFinite(dist)) dayStats[d].m += dist;
      }
      prevPin = pin;
      prevDayNo = d;
    });
    let curDay = null;

    pins.forEach((pin, index) => {
      const dayNo = Number(pin.day) || 1;
      if (dayCount > 1 && dayNo !== curDay) {
        curDay = dayNo;
        const head = document.createElement('li');
        head.className = 'itin-day';
        const st = dayStats[dayNo] || { n: 0, m: 0 };
        const Geo = window.TravelGeo;
        const km = st.m >= 1000 ? (st.m / 1000).toFixed(1) + ' km' : Math.round(st.m) + ' m';
        head.innerHTML =
          '<span class="itin-day-title">第 ' + dayNo + ' 天</span>' +
          '<span class="itin-day-meta">' + st.n + ' 个点' +
          (st.m > 0 ? ' · 直线 ≈ ' + (Geo && Geo.humanDistance ? Geo.humanDistance(st.m) : km) : '') +
          '</span>';
        container.appendChild(head);
      }
      const color = Cats.colorOf(pin.category);
      const label = Cats.labelOf(pin.category);
      const meta = [];
      if (pin.rating) meta.push('★' + pin.rating);
      if (pin.cost) meta.push('¥' + pin.cost);
      const note = pin.note ? String(pin.note) : '';
      const leg = index > 0 ? legs[index - 1] : null;
      const legIndex = index - 1;

      const li = document.createElement('li');
      li.className = 'poi-item itin-item';
      li.dataset.index = String(index);
      // 有 onReorder 才让行可拖（没给回调的场景——比如只读预览——就不摆把手）
      if (handlers.onReorder) li.draggable = true;
      if (index > 0) li.dataset.legIndex = String(legIndex);
      li.innerHTML =
        (R
          ? R.legLineHtml(leg, {
              index: legIndex,
              cum: cums[index],
              base: handlers.base || null,
              selected: legIndex >= 0 && Number(selectedLeg) === legIndex,
            })
          : '') +
        '<div class="poi-head">' +
        (handlers.onReorder ? '<span class="itin-handle" title="按住拖动排序">⋮⋮</span>' : '') +
        '<span class="itin-no">' + (index + 1) + '</span>' +
        shotHtml(pin, handlers) +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(pin.name) + '</b>' +
        '<span class="poi-tag">' + esc(label) + '</span>' +
        '<span class="itin-btns">' +
        (handlers.onPinDay
          ? '<button class="day-prev" title="挪到前一天"' + (dayNo <= 1 ? ' disabled' : '') + '>D-</button>' +
            '<button class="day-next" title="挪到后一天">D+</button>'
          : '') +
        '<button class="up" title="上移">↑</button>' +
        '<button class="down" title="下移">↓</button>' +
        '</span>' +
        '<button class="del" title="从行程删除">×</button>' +
        '</div>' +
        '<div class="poi-addr">' + esc(pin.address || '（无详细地址）') + '</div>' +
        (meta.length ? '<div class="poi-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
        NoteBox.html(note);

      if (leg) {
        const el = li.querySelector('.route-leg');
        if (el) wireLeg(el, legIndex, handlers);
      }

      const up = li.querySelector('.up');
      const down = li.querySelector('.down');
      const del = li.querySelector('.del');
      const dayPrev = li.querySelector('.day-prev');
      const dayNext = li.querySelector('.day-next');
      if (dayPrev && handlers.onPinDay) {
        dayPrev.onclick = (e) => { e.stopPropagation(); handlers.onPinDay(pin, Math.max(1, dayNo - 1)); };
      }
      if (dayNext && handlers.onPinDay) {
        dayNext.onclick = (e) => { e.stopPropagation(); handlers.onPinDay(pin, dayNo + 1); };
      }
      if (up) up.onclick = (e) => { e.stopPropagation(); handlers.onMove(index, -1); };
      if (down) down.onclick = (e) => { e.stopPropagation(); handlers.onMove(index, 1); };
      if (del) del.onclick = (e) => { e.stopPropagation(); handlers.onRemove(pin); };

      if (handlers.onNote) {
        NoteBox.wire(li, {
          value: note,
          placeholder: '这条的备注：几点去 / 必点菜 / 要带什么',
          onSave: (text) => (handlers.onNote ? handlers.onNote(pin, text) : null),
          onDone: handlers.onCancel,
        });
      }
      if (handlers.onReorder) wireDrag(li, index, container, handlers);
      container.appendChild(li);
    });
    paintSelection(container, selectedLeg);
  }

  // 段选中：高亮那一行（并展开它的路书）。地图上点某段、列表上点到达行都走这里。
  function paintSelection(container, selectedLeg) {
    if (!container) return;
    const want = selectedLeg === null || selectedLeg === undefined ? null : Number(selectedLeg);
    Array.prototype.forEach.call(container.querySelectorAll('.route-leg.itin-leg'), (el) => {
      if (el.classList.contains('origin')) return;
      const on = want !== null && Number(el.dataset.index) === want;
      el.classList.toggle('sel', on);
      if (on) el.classList.add('open');
      else el.classList.remove('open');
    });
    if (want === null) return;
    const hit = container.querySelector('.route-leg.itin-leg[data-index="' + want + '"]');
    if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      window.prompt('复制行程单（⌘C）：', text);
      return false;
    }
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.TravelItinerary = { render, paintSelection, copyText, download };
})();
