/* 行程视图：按 sort_order 列出、↑↓ 调序、按分类分组、一键复制 / 下载 .md */
(function () {
  const Cats = window.TravelCategories;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function render(container, pins, handlers) {
    container.innerHTML = '';
    if (!pins.length) {
      container.innerHTML = '<li class="empty">还没有选中的地点，先去挑几个吧</li>';
      return;
    }
    let lastCategory = null;
    let seq = 0;
    pins.forEach((pin, index) => {
      if (pin.category !== lastCategory) {
        const group = document.createElement('li');
        group.className = 'itin-group';
        group.textContent = Cats.labelOf(pin.category);
        container.appendChild(group);
        lastCategory = pin.category;
      }
      seq += 1;
      const color = Cats.colorOf(pin.category);
      const meta = [];
      if (pin.rating) meta.push('★' + pin.rating);
      if (pin.cost) meta.push('¥' + pin.cost);

      const li = document.createElement('li');
      li.className = 'poi-item itin-item';
      li.innerHTML =
        '<div class="poi-head">' +
        '<span class="itin-no">' + seq + '</span>' +
        '<span class="dot" style="background:' + esc(color) + '"></span>' +
        '<b class="poi-name">' + esc(pin.name) + '</b>' +
        '<span class="itin-btns">' +
        '<button class="up" title="上移">↑</button>' +
        '<button class="down" title="下移">↓</button>' +
        '</span>' +
        '</div>' +
        '<div class="poi-addr">' + esc(pin.address || '（无详细地址）') + '</div>' +
        (meta.length ? '<div class="poi-meta">' + esc(meta.join(' · ')) + '</div>' : '');

      const up = li.querySelector('.up');
      const down = li.querySelector('.down');
      if (up) up.onclick = (e) => { e.stopPropagation(); handlers.onMove(index, -1); };
      if (down) down.onclick = (e) => { e.stopPropagation(); handlers.onMove(index, 1); };
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
