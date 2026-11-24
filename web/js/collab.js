/* 一起改（2026-11-24，对标圆周旅迹的多人协作）
   两种进入方式：
     ① /invite/<token>：被邀请的人落地 → 看这是哪趟 → 登录后接受 → 进协作页
     ② /collab?trip=<id>：已经是成员，直接看成员 / 留言 / 邀请链接
   页面只做三件事：接受邀请、看成员、留言（加点调顺序仍在 /app 里做，成员身份已经打通）。 */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);
  const esc = Site.esc;

  const state = { token: '', tripId: null, trip: null, user: null, members: null, comments: [] };

  function tokenFromPath() {
    const m = location.pathname.match(/^\/invite\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function tripIdFromQuery() {
    const q = new URLSearchParams(location.search);
    const n = Number(q.get('trip'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function msg(text, ok) {
    const el = $('collab-msg');
    if (!el) return;
    el.className = 'form-msg' + (ok ? ' ok' : '');
    el.textContent = text || '';
  }

  function renderGate(html) {
    $('main').innerHTML = html;
  }

  // ---------- ① 邀请落地 ----------
  async function bootInvite(token) {
    let info = null;
    try {
      info = await Site.api.inviteInfo(token);
    } catch (err) {
      renderGate(
        '<div class="card"><h2>这条邀请打不开</h2><p class="hint">' +
          esc(err.message || '邀请已失效') +
          '</p><p><a class="btn" href="/">回首页</a></p></div>'
      );
      return;
    }
    state.tripId = info.tripId;
    state.trip = info;
    if (!state.user) {
      renderGate(
        '<div class="card"><h2>' + esc(info.title || '一趟行程') + '</h2>' +
          '<p class="hint">' + esc(info.city || '') + ' · 有人邀请你一起改这趟行程。</p>' +
          '<p class="hint">先登录（没有账号就注册一个），回来点同一个链接就能加入。</p>' +
          '<p><a class="btn primary" href="/login?next=' + encodeURIComponent(location.pathname) + '">登录 / 注册</a></p>' +
          '</div>'
      );
      return;
    }
    // 已登录：直接接受
    try {
      const out = await Site.api.acceptInvite(token);
      renderGate(
        '<div class="card"><h2>已加入：' + esc(info.title || '') + '</h2>' +
          '<p class="hint">' + (out.already ? '你本来就在这趟里。' : '现在可以一起改了。') + '</p>' +
          '<p><a class="btn primary" href="/app?trip=' + info.tripId + '">去规划页</a> ' +
          '<a class="btn" href="/collab?trip=' + info.tripId + '">看成员和留言</a></p></div>'
      );
    } catch (err) {
      renderGate('<div class="card"><h2>加入失败</h2><p class="hint">' + esc(err.message || '') + '</p></div>');
    }
  }

  // ---------- ② 协作页 ----------
  function memberRow(m, ownerId) {
    const isOwner = Number(m.userId) === Number(ownerId);
    return (
      '<li class="collab-member">' +
      '<span class="who">' + esc(m.nickname || m.username || '同行的人') + '</span>' +
      '<span class="tag-pill">' + (isOwner ? '建这趟的人' : '一起改') + '</span>' +
      (isOwner ? '' : '<button class="btn small ghost" type="button" data-kick="' + m.userId + '">移除</button>') +
      '</li>'
    );
  }

  function renderCollab() {
    const t = state.trip || {};
    const ownerId = state.members && state.members.owner ? state.members.owner.userId : null;
    const members = (state.members && state.members.members) || [];
    const owner = state.members && state.members.owner;
    const rows = [];
    if (owner) rows.push(memberRow({ userId: owner.userId, nickname: owner.nickname }, owner.userId));
    members.forEach((m) => rows.push(memberRow(m, ownerId)));

    const comments = state.comments || [];
    $('main').innerHTML =
      '<div class="card">' +
      '<h2>' + esc(t.title || '这趟行程') + '</h2>' +
      '<p class="hint">' + esc(t.city || '') + ' · 一起改：谁都能加点、调顺序、留言。</p>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<a class="btn primary" href="/app?trip=' + state.tripId + '">去规划页</a>' +
      '<button class="btn" type="button" id="collab-invite">生成邀请链接</button>' +
      '<button class="btn ghost" type="button" id="collab-revoke">撤销邀请</button>' +
      '</div>' +
      '<div class="form-msg" id="collab-msg"></div>' +
      '<div id="collab-invite-box"></div>' +
      '</div>' +
      '<div class="card"><h2>谁在这趟里</h2><ul class="collab-members">' + rows.join('') + '</ul></div>' +
      '<div class="card"><h2>留言</h2>' +
      '<p class="hint">「第三天想加个地方」这类话写在这儿，同行的人刷新就能看到。</p>' +
      '<div class="row"><input id="collab-text" maxlength="500" placeholder="说点什么…" />' +
      '<button class="btn primary" type="button" id="collab-send">发</button></div>' +
      '<ul class="collab-comments">' +
      (comments.length
        ? comments
            .map(
              (c) =>
                '<li><span class="who">' + esc(c.author) + '</span>' +
                '<span class="when">' + esc(Site.fmtDate(c.createdAt)) + '</span>' +
                '<p>' + esc(c.text) + '</p></li>'
            )
            .join('')
        : '<li class="empty">还没有留言</li>') +
      '</ul></div>';

    const inviteBtn = $('collab-invite');
    if (inviteBtn) {
      inviteBtn.onclick = async () => {
        try {
          const out = await Site.api.createTripInvite(state.tripId);
          const url = location.origin + out.url;
          $('collab-invite-box').innerHTML =
            '<p class="hint">把这条链接发给同行的人（30 天内有效）：</p>' +
            '<div class="row"><input id="collab-invite-url" readonly value="' + esc(url) + '" />' +
            '<button class="btn" type="button" id="collab-copy">复制</button></div>';
          const copy = $('collab-copy');
          if (copy) {
            copy.onclick = async () => {
              try {
                await navigator.clipboard.writeText(url);
                msg('已复制', true);
              } catch (err) {
                msg('复制失败，手动选一下上面的链接');
              }
            };
          }
        } catch (err) {
          msg(err.message || '生成失败');
        }
      };
    }
    const revokeBtn = $('collab-revoke');
    if (revokeBtn) {
      revokeBtn.onclick = async () => {
        try {
          await Site.api.revokeTripInvite(state.tripId);
          $('collab-invite-box').innerHTML = '';
          msg('旧链接已失效', true);
        } catch (err) {
          msg(err.message || '撤销失败');
        }
      };
    }
    const send = $('collab-send');
    if (send) {
      send.onclick = async () => {
        const input = $('collab-text');
        const text = String((input && input.value) || '').trim();
        if (!text) return;
        try {
          const out = await Site.api.addTripComment(state.tripId, text);
          state.comments = out.comments || [];
          renderCollab();
          msg('已发出', true);
        } catch (err) {
          msg(err.message || '发送失败');
        }
      };
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-kick]'), (btn) => {
      btn.onclick = async () => {
        const uid = Number(btn.dataset.kick);
        try {
          const out = await Site.api.removeTripMember(state.tripId, uid);
          state.members.members = out.members || [];
          renderCollab();
          msg('已移除', true);
        } catch (err) {
          msg(err.message || '移除失败');
        }
      };
    });
  }

  async function bootCollab(tripId) {
    if (!state.user) {
      renderGate(Site.loginGate('「一起改」要登录后才能看。'));
      return;
    }
    try {
      const [members, comments] = await Promise.all([
        Site.api.tripMembers(tripId),
        Site.api.tripComments(tripId),
      ]);
      state.members = members;
      state.comments = comments.comments || [];
      // 标题从成员接口拿不到，用行程列表里那一条
      const trips = await Site.api.trips();
      state.trip = (trips || []).find((t) => Number(t.id) === Number(tripId)) || { title: '这趟行程' };
      renderCollab();
    } catch (err) {
      renderGate(
        '<div class="card"><h2>打不开这趟行程</h2><p class="hint">' + esc(err.message || '') + '</p></div>'
      );
    }
  }

  (async function init() {
    let started = null;
    if (window.TravelHead) started = await window.TravelHead.start();
    else started = { user: (await Site.api.me()).user };
    state.user = started && started.user;

    state.token = tokenFromPath();
    if (state.token) {
      await bootInvite(state.token);
      return;
    }
    const tripId = tripIdFromQuery();
    if (tripId) {
      state.tripId = tripId;
      await bootCollab(tripId);
      return;
    }
    renderGate(
      '<div class="card"><h2>没有指定行程</h2><p class="hint">从「我的行程」里点「一起改」，或者用别人发你的邀请链接打开。</p>' +
        '<p><a class="btn" href="/trips">我的行程</a></p></div>'
    );
  })();
})();
