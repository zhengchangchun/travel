/* 我的行程：全部行程（一城多趟）+ 新建 / 改名 / 改主题 / 删除 / 去规划
   行程与点都在本机 sqlite；未登录只看得到「先登录」的门（真登录口径） */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);
  const state = { trips: [], pins: {} };

  function tripCard(t) {
    const pins = state.pins[t.id];
    const n = Array.isArray(pins) ? pins.length : null;
    const acts = [
      '<a class="btn small primary" href="/app?city=' + encodeURIComponent(t.city) + '">去规划</a>',
      '<button class="btn small" type="button" data-act="rename" data-id="' + t.id + '">改名</button>',
      '<button class="btn small" type="button" data-act="theme" data-id="' + t.id + '">改主题</button>',
      '<button class="btn small danger" type="button" data-act="del" data-id="' + t.id + '">删除</button>',
    ].join('');
    return (
      '<div class="item" data-id="' + t.id + '">' +
      '<div class="body">' +
      '<div class="t">' + Site.esc(t.title) +
      '<span class="badge">' + Site.esc(t.city) + '</span>' +
      (t.theme ? '<span class="badge" style="color:#0b0d12;background:var(--accent-2);border-color:transparent">' + Site.esc(t.theme) + '</span>' : '') +
      '</div>' +
      '<div class="s">' +
      (n === null ? '点数读取中…' : n + ' 个点') +
      ' · 建于 ' + Site.esc(Site.fmtDate(t.created_at)) +
      (t.note ? ' · 备注：' + Site.esc(t.note) : '') +
      '</div>' +
      '</div>' +
      '<div class="acts">' + acts + '</div>' +
      '</div>'
    );
  }

  function render() {
    const box = $('main');
    if (!state.trips.length) {
      box.innerHTML = '<div class="empty-box">还没有行程：上面新建一趟，或直接去 <a href="/app">地图</a> 里挑点</div>';
      return;
    }
    box.innerHTML = '<div class="list">' + state.trips.map(tripCard).join('') + '</div>';
    box.querySelectorAll('[data-act]').forEach((b) => {
      const id = Number(b.dataset.id);
      const trip = state.trips.find((t) => Number(t.id) === id);
      if (!trip) return;
      if (b.dataset.act === 'rename') b.onclick = () => rename(trip);
      else if (b.dataset.act === 'theme') b.onclick = () => theme(trip);
      else if (b.dataset.act === 'del') b.onclick = () => remove(trip);
    });
  }

  async function reload() {
    state.trips = await Site.api.trips();
    render();
    // 点数逐个补（不阻塞列表）
    state.trips.forEach(async (t) => {
      try {
        const pins = await Site.api.tripPins(t.id);
        state.pins[t.id] = pins;
        render();
      } catch (err) {
        state.pins[t.id] = [];
      }
    });
  }

  async function rename(t) {
    const v = window.prompt('新名字：', t.title);
    if (v === null) return;
    const title = String(v).trim();
    if (!title) return;
    try {
      await Site.api.updateTrip(t.id, { title });
      Site.toast('已改名', true);
      await reload();
    } catch (err) {
      Site.toast(err.message || '改名失败');
    }
  }

  async function theme(t) {
    const v = window.prompt('主题（比如「西线＋东线」，留空为取消主题）：', t.theme || '');
    if (v === null) return;
    try {
      await Site.api.updateTrip(t.id, { theme: String(v).trim() });
      Site.toast('主题已更新', true);
      await reload();
    } catch (err) {
      Site.toast(err.message || '改主题失败');
    }
  }

  async function remove(t) {
    const pins = state.pins[t.id];
    const n = Array.isArray(pins) ? pins.length : 0;
    if (!window.confirm(`删除「${t.title}」（${n} 个点）？删了就没了，不可恢复。`)) return;
    try {
      await Site.api.deleteTrip(t.id);
      Site.toast('已删除', true);
      await reload();
    } catch (err) {
      Site.toast(err.message || '删除失败');
    }
  }

  async function create() {
    const city = $('tp-city').value.trim();
    const theme = $('tp-theme').value.trim();
    let title = $('tp-title').value.trim();
    const msg = $('tp-msg');
    if (!city) {
      msg.textContent = '至少填个城市';
      msg.className = 'form-msg';
      return;
    }
    if (!title) title = city + ' · 我的行程';
    $('tp-create').disabled = true;
    try {
      const trip = await Site.api.createTrip({ city, title, theme });
      msg.textContent = '已新建：' + trip.title;
      msg.className = 'form-msg ok';
      $('tp-city').value = '';
      $('tp-theme').value = '';
      $('tp-title').value = '';
      await reload();
    } catch (err) {
      msg.textContent = err.message || '新建失败';
      msg.className = 'form-msg';
    } finally {
      $('tp-create').disabled = false;
    }
  }

  function claimBanner(pending, user) {
    const trips = Number(pending && pending.trips) || 0;
    const shares = Number(pending && pending.shares) || 0;
    if (!trips && !shares) return '';
    const bits = [];
    if (trips) bits.push(trips + ' 条历史行程');
    if (shares) bits.push(shares + ' 条历史分享');
    return (
      '<div class="card" style="border-color:rgba(255,200,97,.4)">' +
      '<h2>有没归属的旧数据</h2>' +
      '<p class="hint" style="margin-bottom:10px">账号上线前建的 ' +
      bits.join(' / ') +
      ' 还没归属给任何账号（现在谁都看不到）。这是本机自用，一次性认领到「' +
      Site.esc(user.nickname || user.username) +
      '」名下就行。</p>' +
      '<button class="btn primary" type="button" id="claim-btn">认领到我的账号</button>' +
      '</div>'
    );
  }

  async function loadPending(user) {
    try {
      const pending = await Site.api.request('/api/legacy/pending');
      const holder = document.getElementById('pending-box');
      if (!holder) return;
      holder.innerHTML = claimBanner(pending, user);
      const btn = document.getElementById('claim-btn');
      if (btn) {
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = '认领中…';
          try {
            const done = await Site.api.request('/api/legacy/claim', { method: 'POST', body: {} });
            Site.toast('已认领 ' + (done.trips || 0) + ' 条行程 / ' + (done.shares || 0) + ' 条分享', true);
            await reload();
            await loadPending(user);
          } catch (err) {
            Site.toast(err.message || '认领失败');
            btn.disabled = false;
            btn.textContent = '认领到我的账号';
          }
        };
      }
    } catch (err) {
      /* 读不到就不提示 */
    }
  }

  (async function init() {
    let me = { user: null };
    if (window.TravelHead) me = (await window.TravelHead.start()) || me;
    else me = { user: (await Site.api.me()).user };
    if (!me.user) {
      $('main').innerHTML = Site.loginGate('「我的行程」要登录后才能看（一座城市可以有多趟，每趟一个主题）。');
      document.querySelector('.card').style.display = 'none';
      return;
    }
    $('tp-create').onclick = create;
    await reload();
    await loadPending(me.user);
  })();
})();
