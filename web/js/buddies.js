/* 旅游搭子：一人一条的小名单（名字 / 关系 / 标签 / 联系方式 / 备注）
   上面的表单既用来新增，也用来编辑（点某条上的「编辑」会把内容填回表单）。
   名单是真登录口径：没登录只给登录门；接口一律只返回自己的。 */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);
  const state = { buddies: [], editing: null };

  function tagPills(tags) {
    return (tags || []).map((t) => '<span class="tag-pill">' + Site.esc(t) + '</span>').join('');
  }

  function buddyCard(b) {
    const meta = [];
    if (b.contact) meta.push(Site.esc(b.contact));
    meta.push(b.tripCount ? '一起走过 ' + b.tripCount + ' 趟' : '还没一起走过');
    meta.push('建于 ' + Site.esc(Site.fmtDate(b.created_at)));
    return (
      '<div class="item" data-id="' + b.id + '">' +
      '<div class="body">' +
      '<div class="t">' + Site.esc(b.name) +
      (b.relation ? '<span class="badge">' + Site.esc(b.relation) + '</span>' : '') +
      '</div>' +
      ((b.tags && b.tags.length) ? '<div class="tags" style="margin-top:6px">' + tagPills(b.tags) + '</div>' : '') +
      '<div class="s">' + meta.join(' · ') + (b.note ? ' · 备注：' + Site.esc(b.note) : '') + '</div>' +
      '</div>' +
      '<div class="acts">' +
      '<a class="btn small" href="/trips">挂到行程上</a>' +
      '<button class="btn small" type="button" data-act="edit" data-id="' + b.id + '">编辑</button>' +
      '<button class="btn small danger" type="button" data-act="del" data-id="' + b.id + '">删除</button>' +
      '</div>' +
      '</div>'
    );
  }

  function render() {
    const box = $('main');
    const n = state.buddies.length;
    $('bd-count').textContent = n ? n + ' 个人' : '还没有';
    if (!n) {
      box.innerHTML =
        '<div class="empty-box">还没有搭子：在上面填个名字存一下就有了（名字以外都可以空着）</div>';
      return;
    }
    box.innerHTML = '<div class="list">' + state.buddies.map(buddyCard).join('') + '</div>';
    box.querySelectorAll('[data-act]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const buddy = state.buddies.find((x) => Number(x.id) === id);
      if (!buddy) return;
      if (btn.dataset.act === 'edit') btn.onclick = () => startEdit(buddy);
      else if (btn.dataset.act === 'del') btn.onclick = () => remove(buddy);
    });
  }

  async function load() {
    const data = await Site.api.buddies();
    state.buddies = (data && data.buddies) || [];
    render();
  }

  // 标签输入：用中英文逗号、空格、顿号、分号都算分隔符
  function readTags() {
    return $('bd-tags')
      .value.split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function setMsg(text, ok) {
    const el = $('bd-msg');
    el.textContent = text || '';
    el.className = 'form-msg' + (ok ? ' ok' : '');
  }

  function fillForm(buddy) {
    $('bd-name').value = buddy ? buddy.name : '';
    $('bd-relation').value = buddy ? buddy.relation || '' : '';
    $('bd-tags').value = buddy ? (buddy.tags || []).join(', ') : '';
    $('bd-contact').value = buddy ? buddy.contact || '' : '';
    $('bd-note').value = buddy ? buddy.note || '' : '';
  }

  function startEdit(buddy) {
    state.editing = buddy;
    fillForm(buddy);
    $('form-title').textContent = '正在改「' + buddy.name + '」';
    $('bd-cancel').classList.remove('hidden');
    $('bd-save').textContent = '保存修改';
    setMsg('');
    $('bd-name').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function stopEdit() {
    state.editing = null;
    fillForm(null);
    $('form-title').textContent = '新的一条';
    $('bd-cancel').classList.add('hidden');
    $('bd-save').textContent = '保存';
    setMsg('');
  }

  async function save() {
    const name = $('bd-name').value.trim();
    if (!name) {
      setMsg('先写个名字');
      $('bd-name').focus();
      return;
    }
    const payload = {
      name,
      relation: $('bd-relation').value.trim(),
      tags: readTags(),
      contact: $('bd-contact').value.trim(),
      note: $('bd-note').value.trim(),
    };
    const btn = $('bd-save');
    btn.disabled = true;
    try {
      if (state.editing) {
        await Site.api.updateBuddy(state.editing.id, payload);
        Site.toast('已保存「' + name + '」', true);
      } else {
        await Site.api.createBuddy(payload);
        Site.toast('加好了：' + name, true);
      }
      stopEdit();
      await load();
    } catch (err) {
      setMsg(err.message || '保存失败');
    } finally {
      btn.disabled = false;
    }
  }

  async function remove(buddy) {
    const extra = buddy.tripCount ? '\n（已经在 ' + buddy.tripCount + ' 趟行程里，会一并移掉）' : '';
    if (!window.confirm('删掉搭子「' + buddy.name + '」？' + extra)) return;
    try {
      await Site.api.deleteBuddy(buddy.id);
      if (state.editing && Number(state.editing.id) === Number(buddy.id)) stopEdit();
      Site.toast('已删除', true);
      await load();
    } catch (err) {
      Site.toast(err.message || '删除失败');
    }
  }

  (async function init() {
    let me = { user: null };
    if (window.TravelHead) me = (await window.TravelHead.start()) || me;
    else me = { user: (await Site.api.me()).user };
    if (!me.user) {
      $('main').innerHTML = Site.loginGate('「旅游搭子」要登录后才能看。');
      $('bd-save').disabled = true;
      return;
    }
    const go = $('bd-save');
    if (go) go.onclick = save;
    const cancel = $('bd-cancel');
    if (cancel) cancel.onclick = stopEdit;
    ['bd-name', 'bd-relation', 'bd-tags', 'bd-contact', 'bd-note'].forEach((id) => {
      const el = $(id);
      if (el) {
        el.onkeydown = (e) => {
          if (e.key === 'Enter') save();
        };
      }
    });
    try {
      await load();
    } catch (err) {
      $('main').innerHTML = '<div class="empty-box">' + Site.esc(err.message || '加载失败') + '</div>';
    }
  })();
})();
