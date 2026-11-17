/* 备注位（两处共用：行程视图每行 / 我的选择每行）
   显示：有备注就是一行字 +「改」；没有就是「＋ 备注」。
   编辑：点一下就地变输入框；回车 / 失焦保存，Esc 取消。保存与重画由调用方给的回调负责。 */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function html(note) {
    const text = note ? String(note) : '';
    return (
      '<div class="note-row' + (text ? '' : ' empty') + '">' +
      (text
        ? esc(text) + '<button type="button" class="note-edit" title="改这句备注">改</button>'
        : '<button type="button" class="note-add" title="给这一条写句话">＋ 备注</button>') +
      '</div>'
    );
  }

  function startEdit(box, opts) {
    opts = opts || {};
    if (!box || box.dataset.editing === '1') return null;
    box.dataset.editing = '1';
    const current = opts.value ? String(opts.value) : '';
    const input = document.createElement('input');
    input.className = 'note-input';
    input.type = 'text';
    input.value = current;
    input.maxLength = 200;
    input.placeholder = opts.placeholder || '写句话：几点去 / 必点菜 / 要带什么';
    box.textContent = '';
    box.appendChild(input);

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      const back = () => {
        if (opts.onDone) opts.onDone();
      };
      if (!save || text === current) {
        back();
        return;
      }
      // 保存失败由调用方提示，这里无论如何都要把界面交回列表（不能卡在输入框里）
      Promise.resolve()
        .then(() => (opts.onSave ? opts.onSave(text) : null))
        .catch(() => null)
        .then(back);
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
    return input;
  }

  // 绑到一行上：点空白处、「＋ 备注」、「改」都进编辑；点输入框本身不会冒泡到行（免得触发行点击）
  function wire(li, opts) {
    const box = li.querySelector('.note-row');
    if (!box) return null;
    const btn = box.querySelector('.note-edit') || box.querySelector('.note-add');
    const open = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      startEdit(box, opts);
    };
    if (btn) btn.onclick = open;
    box.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (e.target === box) open();
    };
    return box;
  }

  window.TravelNoteBox = { html, startEdit, wire };
})();
