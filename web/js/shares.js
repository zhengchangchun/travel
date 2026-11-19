/* 分享列表：网页版能直接在浏览器打开（/share/xxx.html），也能复制纯文本、发到 Finder、删除 */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);
  let rows = [];

  function item(r) {
    const title = r.title || r.city;
    return (
      '<div class="item" data-id="' + r.id + '">' +
      '<div class="body">' +
      '<div class="t">' + Site.esc(title) +
      '<span class="badge">' + Site.esc(r.city) + '</span>' +
      '<span class="badge">' + (Number(r.stops) || 0) + ' 个点</span>' +
      (Site.fmtKm(r.distance_m) ? '<span class="badge">' + Site.fmtKm(r.distance_m) + '</span>' : '') +
      '</div>' +
      '<div class="s">' + Site.esc(Site.fmtDate(r.created_at)) +
      ' · <code style="font-size:12px">share/' + Site.esc(r.base) + '.html</code></div>' +
      '</div>' +
      '<div class="acts">' +
      '<a class="btn small primary" href="' + r.url + '" target="_blank" rel="noreferrer">打开网页版</a>' +
      '<button class="btn small" type="button" data-act="copy" data-id="' + r.id + '">复制文字</button>' +
      '<button class="btn small" type="button" data-act="reveal" data-id="' + r.id + '">发到 Finder</button>' +
      '<button class="btn small danger" type="button" data-act="del" data-id="' + r.id + '">删除</button>' +
      '</div>' +
      '</div>'
    );
  }

  function render() {
    const box = $('main');
    if (!rows.length) {
      box.innerHTML = '<div class="empty-box">还没有分享过：在 <a href="/app">规划页</a> 点「分享」生成一个</div>';
      return;
    }
    box.innerHTML = '<div class="list">' + rows.map(item).join('') + '</div>';
    box.querySelectorAll('[data-act]').forEach((b) => {
      const id = Number(b.dataset.id);
      const row = rows.find((r) => Number(r.id) === id);
      if (!row) return;
      const act = b.dataset.act;
      if (act === 'copy') b.onclick = () => copy(row);
      else if (act === 'reveal') b.onclick = () => reveal(row);
      else if (act === 'del') b.onclick = () => remove(row);
    });
  }

  async function copy(row) {
    let text = row.text || '';
    if (!text) {
      try {
        const res = await fetch(row.textUrl);
        text = res.ok ? await res.text() : '';
      } catch (err) {
        text = '';
      }
    }
    if (!text) {
      Site.toast('这条没有可复制的文本');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      Site.toast('行程文字已复制，去微信里粘贴', true);
    } catch (err) {
      window.prompt('复制下面这段（⌘C）：', text);
    }
  }

  async function reveal(row) {
    try {
      const r = await Site.api.reveal(row.base + '.html');
      Site.toast('已在 ' + ((r && r.dir) || 'share 目录') + ' 里选中', true);
    } catch (err) {
      Site.toast(err.message || '打不开目录');
    }
  }

  async function remove(row) {
    if (!window.confirm('删除这条分享（连同 share/ 里的三个文件）？')) return;
    try {
      await Site.api.deleteShare(row.id);
      Site.toast('已删除', true);
      await load();
    } catch (err) {
      Site.toast(err.message || '删除失败');
    }
  }

  async function load() {
    rows = await Site.api.shares();
    render();
  }

  (async function init() {
    let me = { user: null };
    if (window.TravelHead) me = (await window.TravelHead.start()) || me;
    else me = { user: (await Site.api.me()).user };
    if (!me.user) {
      $('main').innerHTML = Site.loginGate('「分享列表」要登录后才能看。');
      return;
    }
    try {
      await load();
    } catch (err) {
      $('main').innerHTML = '<div class="empty-box">' + Site.esc(err.message || '加载失败') + '</div>';
    }
  })();
})();
