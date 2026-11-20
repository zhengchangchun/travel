/* 首页：精选线路展示台（左轮转实景 / 右线路明细）+ 推荐地区 + 推荐路程详情
    - 默认地区＝浏览器定位 → 后端认城市 → IP 兜底（headbar 负责认，这里只管展示与联动）
    - 未收录的城市卡片上给「现在收录」：现场按城市采集（4 个分类），进度实时刷
    - 推荐路程只浏览（用户 2026-11-19 定），点开看每一站并给高德搜索链接 */
(function () {
  const Site = window.TravelSite;
  const Head = window.TravelHead;

  const DUR = 5200; // 每张实景停留多久（毫秒）；进度条与换图共用一个时钟
  const state = { city: '', data: null, collecting: null };
  const sc = { routes: [], route: null, shots: [], i: 0, layer: 0, paused: false, remain: DUR, last: 0, raf: 0, hover: false };
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const $ = (id) => document.getElementById(id);
  const esc = Site.esc;
  const pad2 = (n) => String(n).padStart(2, '0');

  /* ================= 展示台：时钟（进度条 + 换图） ================= */
  function paintBar() {
    const bar = $('sc-bar-fill');
    if (!bar) return;
    const p = Math.max(0, Math.min(1, 1 - sc.remain / DUR));
    bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }

  function clockStop() {
    if (sc.raf) cancelAnimationFrame(sc.raf);
    sc.raf = 0;
  }

  function clockRun() {
    clockStop();
    const step = (t) => {
      const dt = Math.max(0, t - sc.last);
      sc.last = t;
      sc.remain = Math.max(0, sc.remain - dt);
      paintBar();
      if (sc.remain <= 0) {
        show(sc.i + 1); // 时间到，翻下一张（show 会把时钟归零重跑）
        return;
      }
      sc.raf = requestAnimationFrame(step);
    };
    sc.raf = requestAnimationFrame((t) => {
      sc.last = t;
      sc.raf = requestAnimationFrame(step);
    });
  }

  function clockStart() {
    sc.remain = DUR;
    sc.paused = false;
    paintBar();
    if (reduce || sc.shots.length < 2) return; // 只有一张、或用户要求少动画，就不自动轮转
    clockRun();
  }

  function clockPause() {
    if (sc.paused) return;
    sc.paused = true;
    clockStop();
  }

  function clockResume() {
    if (!sc.paused || reduce || sc.shots.length < 2) return;
    sc.paused = false;
    sc.last = performance.now();
    clockRun();
  }

  /* ================= 展示台：渲染 ================= */
  // 一条线路上「有实景图」的站，按顺序排（轮转只在这些站之间走）
  function shotsOf(rt) {
    return (rt.stops || [])
      .map((s, i) => Object.assign({}, s, { stopIndex: i }))
      .filter((s) => s.photo);
  }

  function photoLayers() {
    const box = $('sc-photo');
    return box ? Array.prototype.slice.call(box.querySelectorAll('.sc-layer')) : [];
  }

  // 右栏里让当前站一直待在可视区（只滚列表这一格，不动整页）；要躲开粘住的表头
  function keepVisible(box, el) {
    if (!box || !el) return;
    const head = 34;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top - head < box.scrollTop) box.scrollTop = Math.max(0, top - head - 4);
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 10;
  }

  function show(k) {
    if (!sc.shots.length) return;
    const n = sc.shots.length;
    sc.i = ((Number(k) % n) + n) % n;
    const sh = sc.shots[sc.i];

    // 两张图层交替淡入：进的那张带缓慢推近，出的那张淡掉
    const layers = photoLayers();
    if (layers.length === 2) {
      const incoming = layers[sc.layer ^ 1];
      const outgoing = layers[sc.layer];
      incoming.style.backgroundImage = 'url("' + String(sh.photo).replace(/"/g, '%22') + '")';
      incoming.classList.remove('in');
      void incoming.offsetWidth; // 强制重排，让淡入与缓推重新跑一遍
      incoming.classList.add('in');
      outgoing.classList.remove('in');
      sc.layer ^= 1;
    }

    const setText = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    setText('sc-count-i', pad2(sc.i + 1));
    setText('sc-count-n', pad2(n));
    setText('sc-list-i', pad2(sc.i + 1));
    setText('sc-cap-name', sh.name);
    setText('sc-cap-note', sh.note || '');
    setText('sc-cap-credit', sh.photoCredit ? '图：' + sh.photoCredit : '');
    setText('sc-photo-city', sc.route ? sc.route.city : '');

    // 缩略图与右栏跟着高亮同一站
    Array.prototype.forEach.call(document.querySelectorAll('#sc-thumbs .shot-btn'), (b, idx) => {
      b.classList.toggle('on', idx === sc.i);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#sc-stops .sc-stop'), (li) => {
      li.classList.toggle('active', Number(li.dataset.stop) === sh.stopIndex);
    });
    const box = $('sc-stops');
    keepVisible(box, box ? box.querySelector('.sc-stop.active') : null);

    clockStart();
  }

  function renderTabs() {
    const box = $('sc-tabs');
    if (!box) return;
    box.innerHTML = sc.routes
      .map(
        (r, k) =>
          '<button class="sc-tab' + (sc.route && r.id === sc.route.id ? ' on' : '') + '" type="button" role="tab" ' +
          'aria-selected="' + (sc.route && r.id === sc.route.id ? 'true' : 'false') + '" ' +
          'data-id="' + esc(r.id) + '" title="' + esc(r.title) + '">' +
          '<b>' + pad2(k + 1) + '</b><span>' + esc(shortTitle(r.title)) + '</span></button>'
      )
      .join('');
    Array.prototype.forEach.call(box.querySelectorAll('.sc-tab'), (b) => {
      b.onclick = () => pickRoute(b.dataset.id);
    });
  }

  function shortTitle(t) {
    const s = String(t || '');
    const i = s.indexOf('：');
    return i > 0 ? s.slice(0, i) : s;
  }

  function renderSpec(rt) {
    const title = $('sc-title');
    if (title) title.textContent = rt.title;

    const meta = [rt.city + (rt.current ? ' · 当前城市' : ''), rt.days + ' 天', rt.stopCount + ' 站'];
    if (rt.photoCount) meta.push('实景 ' + rt.photoCount + ' 张');
    const metaBox = $('sc-meta');
    if (metaBox) metaBox.innerHTML = meta.map((x) => '<span>' + esc(x) + '</span>').join('<i>·</i>');

    const chips = $('sc-chips');
    if (chips) {
      chips.innerHTML = (rt.highlights || [])
        .map((h) => '<span class="tag-pill">' + esc(h) + '</span>')
        .join('');
    }

    // 每一天一条分隔行，站点按顺序编号（点一下＝左边轮转到那一站的实景）；
    // 最上面一条是粘住的「第几站 / 共几站」，列表滚上去也不会让人以为少了站
    let html =
      '<li class="sc-listhead" role="presentation">' +
      '<b id="sc-list-i">01</b><span>/ ' + pad2((rt.stops || []).length) + ' 站</span>' +
      '<em>点一下看那站实景</em></li>';
    let day = 0;
    (rt.stops || []).forEach((s, i) => {
      const d = Number(s.day) || 1;
      if (d !== day) {
        day = d;
        html += '<li class="sc-day" role="presentation">DAY ' + pad2(d) + '</li>';
      }
      html +=
        '<li class="sc-stop' + (s.photo ? '' : ' no-photo') + '" data-stop="' + i + '">' +
        '<span class="sc-no">' + pad2(i + 1) + '</span>' +
        '<span class="sc-stop-main">' +
        '<a href="' + Site.amapSearchUrl(s.name, rt.city) + '" target="_blank" rel="noreferrer">' + esc(s.name) + '</a>' +
        (s.note ? '<span class="sc-stop-note">' + esc(s.note) + '</span>' : '') +
        '</span>' +
        (s.photo ? '<span class="sc-dot" title="有实景图"></span>' : '') +
        '</li>';
    });
    const box = $('sc-stops');
    if (box) {
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll('.sc-stop'), (li) => {
        li.onclick = (e) => {
          if (e.target.closest && e.target.closest('a')) return; // 点名字＝去高德，不动轮转
          const k = sc.shots.findIndex((x) => x.stopIndex === Number(li.dataset.stop));
          if (k >= 0) show(k);
        };
      });
      box.scrollTop = 0;
    }

    const plan = $('sc-plan');
    if (plan) plan.href = '/app?city=' + encodeURIComponent(rt.city);
    const detail = $('sc-detail');
    if (detail) detail.onclick = () => openRoute(rt.id);
    const badge = $('sc-badge');
    if (badge) badge.textContent = 'ROUTE ' + pad2(sc.routes.indexOf(rt) + 1);
  }

  function renderThumbs() {
    const box = $('sc-thumbs');
    if (!box) return;
    if (!sc.shots.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML =
      '<div class="shots">' +
      sc.shots
        .map(
          (s, k) =>
            '<button class="shot-btn' + (k === sc.i ? ' on' : '') + '" type="button" data-k="' + k + '" ' +
            'title="' + esc(s.name) + '">' +
            '<img class="shot-img" src="' + esc(s.photo) + '" alt="' + esc(s.name) + '" loading="lazy" ' +
            'onerror="this.remove()" />' +
            '<span class="shot-i">' + pad2(k + 1) + '</span></button>'
        )
        .join('') +
      '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.shot-btn'), (b) => {
      b.onclick = () => show(Number(b.dataset.k));
    });
  }

  function pickRoute(id) {
    const rt = sc.routes.filter((r) => r.id === id)[0] || sc.routes[0];
    if (!rt) return;
    sc.route = rt;
    sc.shots = shotsOf(rt);
    sc.i = 0;
    sc.layer = 0;
    renderTabs();
    renderSpec(rt);
    renderThumbs();
    if (sc.shots.length) {
      show(0);
      return;
    }
    // 这条线路暂时没有实景图：左面写明，别留个空壳
    photoLayers().forEach((el) => {
      el.classList.remove('in');
      el.style.backgroundImage = '';
    });
    clockStop();
    sc.remain = DUR;
    paintBar();
    const setText = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    setText('sc-count-i', '00');
    setText('sc-count-n', '00');
    setText('sc-cap-name', rt.title);
    setText('sc-cap-note', '这条线路还没有实景图');
    setText('sc-cap-credit', '');
    setText('sc-photo-city', rt.city);
  }

  // 换了城市/重新加载推荐：线路顺序会变，但别把用户正在看的那条踢掉
  function mountShowcase(routes) {
    const sec = $('showcase');
    sc.routes = Array.isArray(routes) ? routes.filter((r) => r && r.stops && r.stops.length) : [];
    if (!sc.routes.length) {
      if (sec) sec.hidden = true;
      return;
    }
    if (sec) sec.hidden = false;

    const same = sc.route && sc.routes.filter((r) => r.id === sc.route.id)[0];
    if (!same) {
      pickRoute(sc.routes[0].id);
      return;
    }
    const before = sc.shots.map((s) => s.photo).join('|');
    sc.route = same;
    sc.shots = shotsOf(same);
    renderTabs();
    renderSpec(same);
    renderThumbs();
    if (before !== sc.shots.map((s) => s.photo).join('|') || !sc.shots.length) {
      sc.i = 0;
      sc.layer = 0;
      if (sc.shots.length) show(0);
    } else {
      Array.prototype.forEach.call(document.querySelectorAll('#sc-thumbs .shot-btn'), (b, idx) => {
        b.classList.toggle('on', idx === sc.i);
      });
    }
  }

  /* ================= 推荐地区 ================= */
  // 卡片头图：静态地图缩略图（服务端生成）；拿不到就让它自己消失，露出渐变底
  function coverHtml(src, alt) {
    if (!src) return '';
    return (
      '<img src="' + esc(src) + '" alt="' + esc(alt || '') + '" loading="lazy" ' +
      'onerror="this.remove()" />'
    );
  }

  function regionCard(r) {
    const tags = (r.highlights || [])
      .map((h) => '<span class="tag-pill">' + esc(h) + '</span>')
      .join('');
    const count = r.collected
      ? '已收录 ' + r.collected.toLocaleString('zh-CN') + ' 个点'
      : '还没收录地点';
    const actions = r.collected
      ? '<button class="btn small primary" type="button" data-act="plan" data-city="' + esc(r.city) + '">去规划</button>'
      : '<button class="btn small" type="button" data-act="collect" data-city="' + esc(r.city) + '">收录这一带</button>';
    return (
      '<div class="region' + (r.current ? ' current' : '') + '" data-city="' + esc(r.city) + '">' +
      '<div class="cover">' + coverHtml(r.cover, r.city + ' 地图') +
      '<div class="name">' + esc(r.city) + (r.current ? '<span class="here">当前</span>' : '') + '</div>' +
      '</div>' +
      '<div class="body">' +
      '<div class="tag">' + esc(r.tagline || '') + '</div>' +
      '<div class="tags">' + tags + '</div>' +
      '<div class="count">' + count + '</div>' +
      '<div class="foot">' + actions + '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function render() {
    const d = state.data || { regions: [], routes: [] };
    const box = $('regions');
    if (box) box.innerHTML = d.regions.map(regionCard).join('') || '<div class="empty-box">精选库里还没有地区</div>';
    mountShowcase(d.routes || []);
    const note = $('regions-note');
    if (note && state.city) note.textContent = '按你所在地区排（当前 ' + state.city + '）';
    if (box) {
      box.querySelectorAll('[data-act="plan"]').forEach((b) => {
        b.onclick = () => goPlan(b.dataset.city);
      });
      box.querySelectorAll('[data-act="collect"]').forEach((b) => {
        b.onclick = () => startCollect(b.dataset.city, b);
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
    let html = rt.note ? '<p class="small muted" style="margin:0 0 10px">' + esc(rt.note) + '</p>' : '';
    if (rt.highlights && rt.highlights.length) {
      html +=
        '<div class="row" style="margin-bottom:6px">' +
        rt.highlights.map((h) => '<span class="tag-pill">' + esc(h) + '</span>').join('') +
        '</div>';
    }
    Object.keys(days).forEach((d) => {
      html += '<div class="day">第 ' + d + ' 天</div><ol class="stops">';
      days[d].forEach((s) => {
        const thumb = s.photo
          ? '<img class="stop-shot" src="' + esc(s.photo) + '" alt="" loading="lazy" ' +
            'title="' + esc(s.photoCredit ? '图：' + s.photoCredit : '实景图') + '" onerror="this.remove()" />'
          : '<span class="stop-shot empty" aria-hidden="true"></span>';
        html +=
          '<li>' + thumb +
          '<span class="stop-main"><a href="' + Site.amapSearchUrl(s.name, rt.city) + '" target="_blank" rel="noreferrer">' +
          esc(s.name) + '</a>' +
          (s.note ? ' — <span class="muted">' + esc(s.note) + '</span>' : '') +
          '<span class="sn">第 ' + s.seq + ' 站</span></span></li>';
      });
      html += '</ol>';
    });
    if (rt.photoCount) {
      html +=
        '<p class="credit">实景图来自 Wikimedia Commons（CC 授权，' + rt.photoCount + ' 张）—— 把鼠标放到图上能看到摄影者与许可。</p>';
    }
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
    // 怎么认出来的：优先听头部的口径（它才是真去定位的那个人）
    const src = (Head && Head.citySource) || (d.current && d.current.source) || '';
    const how =
      src === 'browser' ? '浏览器定位'
        : src === 'ip' ? '按网络大致判断'
          : src === 'default' || src === 'fallback' ? '没认出来，先用默认城市'
            : src === 'saved' ? '上次你选的城市'
              : src === 'cached' ? '上次认出来的城市'
                : src === 'pick' || src === 'input' || src === 'query' ? '你选的城市'
                  : src === 'app' ? '规划页当前城市'
                    : '本机默认';
    el.textContent = '当前地区：' + cur + '（' + how + '）· 换城市点右上角';
  }

  /* ================= 展示台：交互接线 ================= */
  function wireShowcase() {
    const stage = $('sc-stage');
    if (stage) {
      // 鼠标停在展示台上就停住（在右边看字时图别乱翻）
      stage.addEventListener('pointerenter', () => {
        sc.hover = true;
        clockPause();
      });
      stage.addEventListener('pointerleave', () => {
        sc.hover = false;
        clockResume();
      });
    }
    const prev = $('sc-prev');
    if (prev) prev.onclick = (e) => {
      e.stopPropagation();
      show(sc.i - 1);
    };
    const next = $('sc-next');
    if (next) next.onclick = (e) => {
      e.stopPropagation();
      show(sc.i + 1);
    };

    // 点图＝往后翻；左右拖动＝翻上一张 / 下一张（手机上也能用）
    const photo = $('sc-photo');
    if (photo) {
      let down = null;
      photo.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, t: Date.now() };
      });
      photo.addEventListener('pointerup', (e) => {
        if (!down) return;
        const dx = e.clientX - down.x;
        const swipe = Math.abs(dx) > 40 && Date.now() - down.t < 900;
        down = null;
        if (swipe) {
          show(sc.i + (dx < 0 ? 1 : -1));
          return;
        }
        if (e.target.closest && e.target.closest('.sc-arrow')) return; // 箭头自己管
        show(sc.i + 1);
      });
      photo.addEventListener('pointercancel', () => {
        down = null;
      });
    }

    document.addEventListener('keydown', (e) => {
      const mask = $('route-mask');
      if (mask && !mask.classList.contains('hidden')) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!sc.shots.length) return;
      if (e.key === 'ArrowRight') show(sc.i + 1);
      else if (e.key === 'ArrowLeft') show(sc.i - 1);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clockPause();
      else if (!sc.hover) clockResume();
    });

    // 进到眼前再淡入（浏览器不支持 IntersectionObserver 就直接显示）
    const reveals = document.querySelectorAll('[data-reveal]');
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (rows) => {
          rows.forEach((r) => {
            if (!r.isIntersecting) return;
            r.target.classList.add('in');
            io.unobserve(r.target);
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
      );
      Array.prototype.forEach.call(reveals, (el) => io.observe(el));
    } else {
      Array.prototype.forEach.call(reveals, (el) => el.classList.add('in'));
    }
  }

  (async function init() {
    // 先把页面基本结构立起来，再等定位（定位最多 6 秒，不阻塞渲染）
    render();
    wireShowcase();
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
