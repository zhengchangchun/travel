/* 个人设置：昵称 / 头像链接 / 默认城市 / 默认出行方式（都要先登录） */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);
  const MODES = [
    { key: '', label: '不指定（规划页用「最快」）' },
    { key: 'auto', label: '最快（每段各取最快）' },
    { key: 'driving', label: '驾车' },
    { key: 'riding', label: '骑行' },
    { key: 'walking', label: '步行' },
    { key: 'transit', label: '公交' },
  ];

  function form(user) {
    const opts = MODES.map(
      (m) =>
        '<option value="' + m.key + '"' + (m.key === (user.defaultMode || '') ? ' selected' : '') + '>' +
        Site.esc(m.label) + '</option>'
    ).join('');
    return (
      '<div class="card">' +
      '<h2>账号</h2>' +
      '<div class="s small muted" style="margin:-6px 0 12px">账号：<code>' + Site.esc(user.username) + '</code> · 建于 ' +
      Site.esc(Site.fmtDate(user.createdAt)) + '</div>' +
      '<div class="field"><label for="st-nick">昵称</label><input id="st-nick" maxlength="24" value="' +
      Site.esc(user.nickname || '') + '" /></div>' +
      '<div class="field"><label for="st-avatar">头像链接（http(s) 或 data:image，可留空）</label><input id="st-avatar" value="' +
      Site.esc(user.avatar || '') + '" placeholder="https://…" /></div>' +
      '<div class="field"><label for="st-city">默认城市</label><input id="st-city" value="' +
      Site.esc(user.defaultCity || '') + '" placeholder="留空就用浏览器定位认出来的" /></div>' +
      '<div class="field"><label for="st-mode">默认出行方式</label><select id="st-mode">' + opts + '</select></div>' +
      '<div class="form-msg" id="st-msg"></div>' +
      '<div class="row"><button class="btn primary" type="button" id="st-save">保存</button>' +
      '<button class="btn ghost" type="button" id="st-logout">退出登录</button></div>' +
      '</div>'
    );
  }

  async function save() {
    const msg = $('st-msg');
    $('st-save').disabled = true;
    try {
      await Site.api.updateMe({
        nickname: $('st-nick').value.trim(),
        avatar: $('st-avatar').value.trim(),
        defaultCity: $('st-city').value.trim(),
        defaultMode: $('st-mode').value,
      });
      msg.textContent = '已保存';
      msg.className = 'form-msg ok';
      if (window.TravelHead) window.TravelHead.refresh();
    } catch (err) {
      msg.textContent = err.message || '保存失败';
      msg.className = 'form-msg';
    } finally {
      $('st-save').disabled = false;
    }
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return v + ' B';
  }

  function renderBackups(data) {
    const box = $('bk-list');
    if (!box) return;
    const items = (data && data.items) || [];
    if (!items.length) {
      box.innerHTML = '<div class="empty-box">还没有备份</div>';
      return;
    }
    box.innerHTML = items
      .map(
        (it) =>
          '<div class="item"><div class="body"><div class="t">' + Site.esc(it.name) +
          '<span class="badge">' + fmtBytes(it.bytes) + '</span></div>' +
          '<div class="s">' + Site.esc(Site.fmtDate(it.at)) + ' · data/backups/</div></div>' +
          '<div class="acts"><button class="btn small" type="button" data-reveal="' + Site.esc(it.name) + '">发到 Finder</button></div></div>'
      )
      .join('');
    box.querySelectorAll('[data-reveal]').forEach((b) => {
      b.onclick = async () => {
        try {
          await Site.api.request('/api/backup/reveal', { method: 'POST', body: { name: b.dataset.reveal } });
          Site.toast('已在 Finder 里选中', true);
        } catch (err) {
          Site.toast(err.message || '打不开目录');
        }
      };
    });
  }

  async function loadBackups() {
    try {
      const data = await Site.api.request('/api/backup');
      renderBackups(data);
    } catch (err) {
      renderBackups({ items: [] });
    }
  }

  function wireBackup() {
    const card = $('backup-card');
    if (!card) return;
    card.style.display = '';
    $('bk-now').onclick = async () => {
      const btn = $('bk-now');
      const msg = $('bk-msg');
      btn.disabled = true;
      msg.className = 'form-msg';
      msg.textContent = '正在打包…';
      try {
        const out = await Site.api.request('/api/backup', { method: 'POST', body: {} });
        msg.className = 'form-msg ok';
        msg.textContent =
          '已生成 ' + out.file + '（' + fmtBytes(out.bytes) + '，' + out.entries + ' 个文件 · 库里 ' + fmtBytes(out.dbBytes) + '）';
        await loadBackups();
      } catch (err) {
        msg.className = 'form-msg';
        msg.textContent = err.message || '备份失败';
      } finally {
        btn.disabled = false;
      }
    };
    loadBackups();
  }

  (async function init() {
    let started = null;
    if (window.TravelHead) started = await window.TravelHead.start();
    else started = { user: (await Site.api.me()).user };
    const user = started && started.user;
    if (!user) {
      $('main').innerHTML = Site.loginGate('个人设置要登录后才能改。');
      return;
    }
    $('main').innerHTML = form(user);
    $('st-save').onclick = save;
    wireBackup();
    $('st-logout').onclick = async () => {
      try {
        await Site.api.logout();
        window.location.href = '/';
      } catch (err) {
        Site.toast(err.message || '退出失败');
      }
    };
  })();
})();
