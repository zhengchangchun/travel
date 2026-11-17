/* 行程视图：按 sort_order 列出、拖拽或 ↑↓ 调序、每条写备注、一键复制 / 下载 .md */
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

  function render(container, pins, handlers) {
    handlers = handlers || {};
    container.innerHTML = '';
    if (!pins.length) {
      container.innerHTML = '<li class="empty">还没有选中的地点，先去挑几个吧</li>';
      return;
    }
    pins.forEach((pin, index) => {
      const color = Cats.colorOf(pin.category);
      const label = Cats.labelOf(pin.category);
      const meta = [];
      if (pin.rating) meta.push('★' + pin.rating);
      if (pin.cost) meta.push('¥' + pin.cost);
      const note = pin.note ? String(pin.note) : '';

      const li = document.createElement('li');
      li.className = 'poi-item itin-item';
      li.dataset.index = String(index);
      // 有 onReorder 才让行可拖（没给回调的场景——比如只读预览——就不摆把手）
      if (handlers.onReorder) li.draggable = true;
      li.innerHTML =
        '<div class="poi-head">' +
        (handlers.onReorder ? '<span class="itin-handle" title="按住拖动排序">⋮⋮</span>' : '') +
        '<span class="itin-no">' + (index + 1) + '</span>' +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(pin.name) + '</b>' +
        '<span class="poi-tag">' + esc(label) + '</span>' +
        '<span class="itin-btns">' +
        '<button class="up" title="上移">↑</button>' +
        '<button class="down" title="下移">↓</button>' +
        '</span>' +
        '<button class="del" title="从行程删除">×</button>' +
        '</div>' +
        '<div class="poi-addr">' + esc(pin.address || '（无详细地址）') + '</div>' +
        (meta.length ? '<div class="poi-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
        NoteBox.html(note);

      const up = li.querySelector('.up');
      const down = li.querySelector('.down');
      const del = li.querySelector('.del');
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

  window.TravelItinerary = { render, copyText, download };
})();
