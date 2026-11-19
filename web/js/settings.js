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
