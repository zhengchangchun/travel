/* 首页：推荐地区 + 推荐路程（数据来自 /api/featured）
   - 默认地区＝浏览器定位 → 后端认城市 → IP 兜底（headbar 负责认，这里只管展示与联动）
   - 未收录的城市卡片上给「现在收录」：现场按城市采集（4 个分类），进度实时刷
   - 推荐路程只浏览（用户 2026-11-19 定），点开看每一站并给高德搜索链接 */
(function () {
  const Site = window.TravelSite;
  const Head = window.TravelHead;

  const state = { city: '', data: null, collecting: null };

  const $ = (id) => document.getElementById(id);

  function regionCard(r) {
    const tags = (r.highlights || [])
      .map((h) => '<span class="tag-pill">' + Site.esc(h) + '</span>')
      .join('');
    const count = r.collected
      ? '已收录 ' + r.collected.toLocaleString('zh-CN') + ' 个点'
      : '还没收录地点';
    const actions = r.collected
      ? '<button class="btn small primary" type="button" data-act="plan" data-city="' + Site.esc(r.city) + '">用这个城市规划</button>'
      : '<button class="btn small" type="button" data-act="collect" data-city="' + Site.esc(r.city) + '">现在收录这一带</button>';
    return (
      '<div class="region' + (r.current ? ' current' : '') + '" data-city="' + Site.esc(r.city) + '">' +
      '<div class="name">' + Site.esc(r.city) + (r.current ? '<span class="here">当前</span>' : '') + '</div>' +
      '<div class="tag">' + Site.esc(r.tagline || '') + '</div>' +
      '<div class="tags">' + tags + '</div>' +
      '<div class="foot">' + actions + '<span class="count">' + count + '</span></div>' +
      '</div>'
    );
  }

  function routeCard(rt) {
    const path = (rt.stops || [])
      .map((s) => s.name)
      .join(' → ');
    const meta = [
      rt.days + ' 天',
      rt.stopCount + ' 个点',
      rt.theme || '',
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      '<button class="route-card" type="button" data-route="' + Site.esc(rt.id) + '">' +
      '<div class="top">' +
      '<span class="title">' + Site.esc(rt.title) + '</span>' +
      (rt.theme ? '<span class="theme">' + Site.esc(rt.theme) + '</span>' : '') +
      '<span class="city">' + Site.esc(rt.city) + (rt.current ? ' · 当前' : '') + '</span>' +
      '</div>' +
      '<div class="meta">' + Site.esc(meta) + '</div>' +
      '<div class="path">' + Site.esc(path) + '</div>' +
      '<div class="note">' + Site.esc(rt.note || '') + '</div>' +
      '</button>'
    );
  }

  function render() {
    const d = state.data || { regions: [], routes: [] };
    const box = $('regions');
    const list = $('route-list');
    if (box) box.innerHTML = d.regions.map(regionCard).join('') || '<div class="empty-box">精选库里还没有地区</div>';
    if (list) list.innerHTML = d.routes.map(routeCard).join('') || '<div class="empty-box">精选库里还没有路线</div>';
    const note = $('regions-note');
    if (note && state.city) {
      note.textContent = '按你所在地区排（当前 ' + state.city + '）';
    }
    if (box) {
      box.querySelectorAll('[data-act="plan"]').forEach((b) => {
        b.onclick = () => goPlan(b.dataset.city);
      });
      box.querySelectorAll('[data-act="collect"]').forEach((b) => {
        b.onclick = () => startCollect(b.dataset.city, b);
      });
    }
    if (list) {
      list.querySelectorAll('[data-route]').forEach((b) => {
        b.onclick = () => openRoute(b.dataset.route);
      });
    }
  }

  function goPlan(city) {
    if (city && Head && Head.setCity) Head.setCity(city, 'pick');
    window.location.href = '/app' + (city ? '?city=' + encodeURIComponent(city) : '');
  }

  // 现场采集：4 个分类一起跑（后端已有的按城市采集），进度实时刷
  async function startCollect(city, btn) {
    if (!city) return;
    if (state.collecting) {
      Site.toast('已经在收录 ' + state.collecting + ' 了，等它跑完');
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在收录…';
    }
    state.collecting = city;
    try {
      const started = await Site.api.collect(city);
      const ids = started.runIds || [];
      Site.toast('开始收录 ' + city + '（4 个分类），跑完这页会自动刷新', true);
      await pollRuns(ids, city, btn);
    } catch (err) {
      Site.toast(err.message || '收录失败');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '现在收录这一带';
      }
      state.collecting = null;
    }
  }

  async function pollRuns(runIds, city, btn) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let last = '';
    for (;;) {
      if (Date.now() > deadline) {
        Site.toast('收录还在后台跑，稍后回来看「已收录」的数字');
        break;
      }
      let rows = [];
      try {
        rows = await Promise.all((runIds || []).map((id) => Site.api.collectStatus(id)));
      } catch (err) {
        rows = [];
      }
      const done = rows.filter((r) => r && r.run && r.run.status && r.run.status !== 'running').length;
      const inserted = rows.reduce((n, r) => n + Number((r && r.run && r.run.n_inserted) || 0), 0);
      const line = '收录 ' + city + '：' + done + '/' + (runIds || []).length + ' 个分类跑完，已入库 ' + inserted + ' 个点';
      if (line !== last) {
        last = line;
        if (btn) btn.textContent = line;
      }
      const failed = rows.find((r) => r && r.run && r.run.status === 'failed');
      if (done >= (runIds || []).length) {
        if (failed) {
          Site.toast('收录结束但有分类失败：' + ((failed.run && failed.run.detail) || '看状态里的说明'));
        } else {
          Site.toast('收录完成，已入库 ' + inserted + ' 个点', true);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    state.collecting = null;
    await load(state.city);
  }

  // 推荐路程：只浏览（按天分组 + 每站给高德搜索链接）
  function openRoute(id) {
    const rt = ((state.data && state.data.routes) || []).find((r) => r.id === id);
    if (!rt) return;
    const mask = $('route-mask');
    $('rd-title').textContent = rt.title;
    $('rd-sub').textContent =
      rt.city + ' · ' + rt.days + ' 天 · ' + rt.stopCount + ' 个点' + (rt.theme ? ' · ' + rt.theme : '');
    const days = {};
    rt.stops.forEach((s, i) => {
      const d = s.day || 1;
      if (!days[d]) days[d] = [];
      days[d].push({ ...s, seq: i + 1 });
    });
    let html = rt.note ? '<p class="small muted" style="margin:0 0 10px">' + Site.esc(rt.note) + '</p>' : '';
    if (rt.highlights && rt.highlights.length) {
      html +=
        '<div class="row" style="margin-bottom:6px">' +
        rt.highlights.map((h) => '<span class="tag-pill">' + Site.esc(h) + '</span>').join('') +
        '</div>';
    }
    Object.keys(days).forEach((d) => {
      html += '<div class="day">第 ' + d + ' 天</div><ol class="stops">';
      days[d].forEach((s) => {
        html +=
          '<li><a href="' + Site.amapSearchUrl(s.name, rt.city) + '" target="_blank" rel="noreferrer">' +
          Site.esc(s.name) + '</a>' +
          (s.note ? ' — <span class="muted">' + Site.esc(s.note) + '</span>' : '') +
          '<span class="sn">第 ' + s.seq + ' 站</span></li>';
      });
      html += '</ol>';
    });
    $('rd-body').innerHTML = html;
    $('rd-plan').href = '/app?city=' + encodeURIComponent(rt.city);
    mask.classList.remove('hidden');
  }

  function closeRoute() {
    $('route-mask').classList.add('hidden');
  }

  async function load(city) {
    try {
      const data = await Site.api.featured(city ? { city } : {});
      state.data = data;
      if (data.current && data.current.city) state.city = data.current.city;
      render();
      updateWhereLine();
    } catch (err) {
      Site.toast(err.message || '推荐加载失败');
    }
  }

  function updateWhereLine() {
    const el = $('where-line');
    if (!el) return;
    const d = state.data || {};
    const cur = (d.current && d.current.city) || state.city || '—';
    const src = (d.current && d.current.source) || '';
    const how =
      src === 'browser' ? '浏览器定位'
        : src === 'ip' ? '按网络大致判断'
          : src === 'default' ? '没认出来，先用默认城市'
            : src === 'saved' ? '上次你选的城市'
              : src === 'pick' || src === 'query' ? '你选的城市'
                : '本机默认';
    el.textContent = '当前地区：' + cur + '（' + how + '）· 换城市点右上角';
  }

  (async function init() {
    // 先把页面基本结构立起来，再等定位（定位最多 6 秒，不阻塞渲染）
    render();
    const close = $('rd-close');
    if (close) close.onclick = closeRoute;
    const close2 = $('rd-close2');
    if (close2) close2.onclick = closeRoute;
    const mask = $('route-mask');
    if (mask) {
      mask.onclick = (e) => {
        if (e.target === mask) closeRoute();
      };
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeRoute();
    });

    if (Head) {
      Head.onCity(() => load(Head.city));
      const started = await Head.start();
      await load((started && started.city) || Head.city);
    } else {
      await load('');
    }
    const startBtn = $('start-btn');
    if (startBtn && Head && Head.city) {
      startBtn.href = '/app?city=' + encodeURIComponent(Head.city);
    }
  })();
})();
