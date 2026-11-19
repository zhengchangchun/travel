/* 通栏头部（所有页面共用）：左「旅迹」，右「当前地区 · 分享列表 · 我的行程 · 个人设置 · 登录状态」
   用法：页面里放 <div id="headbar"></div>（第一个元素），引 headbar.js 即可。
   暴露 window.TravelHead 给页面用：city / user / setCity() / onCity() / refresh()。 */
(function () {
  const Site = window.TravelSite;

  const CITY_KEY = 'travel.city'; // 他自己选的城市（选过就一直用）
  const CITY_AUTO = 'travel.cityAuto'; // 自动认出来的城市（浏览器定位 → IP）

  const listeners = [];
  const state = { user: null, city: '', citySource: '', loaded: false };

  function emit(name) {
    listeners.forEach((fn) => {
      try {
        fn(name, { city: state.city, user: state.user, citySource: state.citySource });
      } catch (err) {
        /* 单个监听器出错不影响别人 */
      }
    });
  }

  function savedCity() {
    try {
      return window.localStorage.getItem(CITY_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function rememberAuto(city) {
    try {
      window.localStorage.setItem(CITY_AUTO, city || '');
    } catch (err) {
      /* 存不了就算了 */
    }
  }

  function autoCity() {
    try {
      return window.localStorage.getItem(CITY_AUTO) || '';
    } catch (err) {
      return '';
    }
  }

  function initials(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  function avatarHtml(user) {
    if (user && user.avatar) return '<img src="' + Site.esc(user.avatar) + '" alt="" />';
    return Site.esc(initials(user && (user.nickname || user.username)));
  }

  function currentPath() {
    const p = window.location.pathname.replace(/\/+$/, '');
    return p === '' ? '/' : p;
  }

  function navHtml() {
    const here = currentPath();
    const item = (href, label) =>
      '<a href="' + href + '"' + (here === href ? ' class="on"' : '') + '>' + label + '</a>';
    return (
      '<nav>' +
      item('/trips', '我的行程') +
      item('/shares', '分享列表') +
      '</nav>'
    );
  }

  function rightHtml() {
    const u = state.user;
    const city = state.city || '—';
    const cityBtn =
      '<button type="button" class="chip-static" id="head-city" title="点一下换城市">当前地区 <b>' +
      Site.esc(city) +
      '</b></button>';
    if (!u) {
      return (
        cityBtn +
        '<a class="btn small ghost" href="/settings" title="个人设置（先登录）">个人设置</a>' +
        '<a class="btn small primary" href="/login' + nextParam() + '">登录 / 注册</a>'
      );
    }
    return (
      cityBtn +
      '<div class="menu-wrap">' +
      '<button type="button" class="who btn small ghost" id="head-user" title="个人设置">' +
      '<span class="avatar">' + avatarHtml(u) + '</span>' +
      '<span>' + Site.esc(u.nickname || u.username) + '</span>' +
      '</button>' +
      '<div class="menu" id="head-menu">' +
      '<a href="/settings">个人设置</a>' +
      '<a href="/trips">我的行程</a>' +
      '<a href="/shares">分享列表</a>' +
      '<div class="sep"></div>' +
      '<button type="button" id="head-logout">退出登录</button>' +
      '</div>' +
      '</div>'
    );
  }

  function nextParam() {
    const here = currentPath();
    if (!here || here === '/' || here === '/login') return '';
    return '?next=' + encodeURIComponent(here + window.location.search);
  }

  function render() {
    const host = document.getElementById('headbar');
    if (!host) return;
    host.innerHTML =
      '<header class="head">' +
      '<a class="brand" href="/"><img src="/img/logo.svg" alt="" /><span>旅迹</span></a>' +
      '<span class="spacer"></span>' +
      navHtml() +
      '<div class="right">' + rightHtml() + '</div>' +
      '</header>' +
      cityDialogHtml();
    wire();
  }

  // 换城市：精选库里已有的城市一点就行；也可以直接输入任意城市
  function cityDialogHtml() {
    return (
      '<div class="mask hidden" id="city-mask">' +
      '<div class="dialog" role="dialog" aria-label="换城市">' +
      '<div class="dhead"><h3>换城市</h3><span class="spacer" style="flex:1"></span>' +
      '<button class="icobtn" type="button" id="city-close" aria-label="关闭">×</button></div>' +
      '<div class="dbody">' +
      '<div class="field"><label for="city-free">直接输入城市名</label>' +
      '<div class="row"><input id="city-free" placeholder="如 杭州 / 大理" autocomplete="off" />' +
      '<button class="btn primary" type="button" id="city-go">就用这个</button></div></div>' +
      '<div class="small muted" style="margin:14px 0 6px">或者从推荐地区里挑：</div>' +
      '<div class="row" id="city-list"></div>' +
      '</div></div></div>'
    );
  }

  function openCityDialog() {
    const mask = document.getElementById('city-mask');
    if (!mask) return;
    mask.classList.remove('hidden');
    const input = document.getElementById('city-free');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 30);
    }
    const list = document.getElementById('city-list');
    if (list && !list.dataset.filled) {
      list.dataset.filled = '1';
      Site.api
        .featured({ city: state.city || undefined })
        .then((data) => {
          list.innerHTML = (data.regions || [])
            .map(
              (r) =>
                '<button type="button" class="chip-static city-pick" data-city="' +
                Site.esc(r.city) +
                '">' + Site.esc(r.city) + '</button>'
            )
            .join('');
          list.querySelectorAll('.city-pick').forEach((b) => {
            b.onclick = () => {
              setCity(b.dataset.city, 'pick');
              closeCityDialog();
            };
          });
        })
        .catch(() => {
          list.dataset.filled = '';
        });
    }
  }

  function closeCityDialog() {
    const mask = document.getElementById('city-mask');
    if (mask) mask.classList.add('hidden');
  }

  function wire() {
    const cityBtn = document.getElementById('head-city');
    if (cityBtn) cityBtn.onclick = openCityDialog;
    const close = document.getElementById('city-close');
    if (close) close.onclick = closeCityDialog;
    const mask = document.getElementById('city-mask');
    if (mask) {
      mask.onclick = (e) => {
        if (e.target === mask) closeCityDialog();
      };
    }
    const go = document.getElementById('city-go');
    const free = document.getElementById('city-free');
    const submitFree = () => {
      const v = (free && free.value) || '';
      if (!String(v).trim()) return;
      setCity(String(v).trim(), 'input');
      closeCityDialog();
    };
    if (go) go.onclick = submitFree;
    if (free) {
      free.onkeydown = (e) => {
        if (e.key === 'Enter') submitFree();
      };
    }

    const userBtn = document.getElementById('head-user');
    const menu = document.getElementById('head-menu');
    if (userBtn && menu) {
      userBtn.onclick = (e) => {
        e.stopPropagation();
        menu.classList.toggle('open');
      };
      document.addEventListener('click', () => menu.classList.remove('open'));
    }
    const logout = document.getElementById('head-logout');
    if (logout) {
      logout.onclick = async () => {
        try {
          await Site.api.logout();
          state.user = null;
          render();
          emit('logout');
          Site.toast('已退出登录', true);
        } catch (err) {
          Site.toast(err.message || '退出失败');
        }
      };
    }
  }

  // 自己选的城市：记下来，之后每次都用它（想回到自动识别就在换城市里选回来）
  function setCity(city, source) {
    const name = String(city || '').trim();
    if (!name) return;
    state.city = name;
    state.citySource = source || 'set';
    try {
      if (source === 'auto') window.localStorage.removeItem(CITY_KEY);
      else if (source === 'pick' || source === 'input') window.localStorage.setItem(CITY_KEY, name);
    } catch (err) {
      /* 存不了就算了，本次会话照用 */
    }
    // 规划页（/app）自己就是按城市工作的：头部换城市就带参数重开一次，免得两处不一致
    const onApp = currentPath() === '/app';
    if (onApp && (source === 'pick' || source === 'input')) {
      window.location.href = '/app?city=' + encodeURIComponent(name);
      return;
    }
    render();
    emit('city');
  }

  // 默认地区：他自己选过就用他选的；没选过就浏览器定位 → 后端认城市 → IP 兜底
  async function resolveCity() {
    const saved = savedCity();
    if (saved) {
      state.city = saved;
      state.citySource = 'saved';
      return state.city;
    }
    const cached = autoCity();
    if (cached) {
      state.city = cached;
      state.citySource = 'cached';
      // 后台再认一次（换城市了就跟着更新页面，但不闪：先显示缓存值）
      detect().catch(() => {});
      return state.city;
    }
    return detect();
  }

  async function detect() {
    const coord = Site.browserCoord ? await Site.browserCoord() : null;
    try {
      const res = await Site.api.whereami(coord || {});
      const city = res.used || res.fallbackCity || '';
      state.city = city;
      state.citySource = res.source || (res.fallback ? 'fallback' : 'browser');
      if (city) rememberAuto(city);
      render();
      emit('city');
      return city;
    } catch (err) {
      if (!state.city) {
        state.city = '杭州';
        state.citySource = 'fallback';
      }
      render();
      return state.city;
    }
  }

  async function loadUser() {
    try {
      const data = await Site.api.me();
      state.user = data.user || null;
    } catch (err) {
      state.user = null;
    }
    state.loaded = true;
    render();
    emit('user');
  }

  function onCity(fn) {
    listeners.push(fn);
  }

  window.TravelHead = {
    get city() {
      return state.city;
    },
    get citySource() {
      return state.citySource;
    },
    get user() {
      return state.user;
    },
    setCity,
    onCity,
    refresh: render,
    async start(opts) {
      render();
      const given = opts && opts.city ? String(opts.city) : '';
      if (given) {
        // 页面自己已经知道当前城市（规划页）：不再去定位，避免与它抢
        state.city = given;
        state.citySource = 'app';
        render();
      }
      await Promise.all([given ? Promise.resolve(given) : resolveCity(), loadUser()]);
      render();
      return { city: state.city, user: state.user };
    },
  };
})();
