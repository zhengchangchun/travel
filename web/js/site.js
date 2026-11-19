/* 站点层小工具：接口调用、转义、格式化（首页 / 我的行程 / 分享列表 / 个人设置 / 登录都用它）
   与 web/js/api.js 的区别：api.js 服务地图应用；这里只做站点页面的通用请求与渲染小件 */
(function () {
  function qs(params) {
    const u = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      u.set(k, String(v));
    });
    const s = u.toString();
    return s ? '?' + s : '';
  }

  async function request(path, options) {
    const opt = options || {};
    const res = await fetch(path, {
      method: opt.method || 'GET',
      headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: 'same-origin',
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch (err) {
      payload = null;
    }
    if (!res.ok || !payload || payload.ok !== true) {
      const msg = (payload && payload.error && payload.error.msg) || `请求失败（${res.status}）`;
      const e = new Error(msg);
      e.status = res.status;
      e.code = payload && payload.error ? payload.error.code : '';
      throw e;
    }
    return payload.data;
  }

  const api = {
    request,
    me: () => request('/api/auth/me'),
    login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
    register: (username, password, nickname) =>
      request('/api/auth/register', { method: 'POST', body: { username, password, nickname } }),
    logout: () => request('/api/auth/logout', { method: 'POST', body: {} }),
    updateMe: (fields) => request('/api/auth/me', { method: 'PATCH', body: fields }),
    whereami: (coord) => request('/api/whereami' + qs(coord || {})),
    featured: (params) => request('/api/featured' + qs(params)),
    trips: () => request('/api/trips'),
    createTrip: (payload) => request('/api/trips', { method: 'POST', body: payload }),
    updateTrip: (id, payload) => request(`/api/trips/${id}`, { method: 'PATCH', body: payload }),
    deleteTrip: (id) => request(`/api/trips/${id}`, { method: 'DELETE' }),
    tripPins: (id) => request(`/api/trips/${id}/pins`),
    shares: () => request('/api/shares'),
    deleteShare: (id) => request(`/api/shares/${id}`, { method: 'DELETE' }),
    collect: (city) => request('/api/collect', { method: 'POST', body: { city, category: 'all' } }),
    collectStatus: (runId) => request('/api/collect/status' + qs({ runId })),
    reveal: (file) => request('/api/share/reveal', { method: 'POST', body: { file } }),
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtKm(meters) {
    const n = Number(meters);
    if (!Number.isFinite(n) || n <= 0) return '';
    return n >= 1000 ? (n / 1000).toFixed(1) + ' km' : Math.round(n) + ' m';
  }

  // 高德免 key 链接：分享出去的人点一下就能在自己手机里打开
  function amapSearchUrl(name, city) {
    return 'https://uri.amap.com/search?keyword=' + encodeURIComponent(name) + (city ? '&city=' + encodeURIComponent(city) : '');
  }

  function toast(msg, isOk) {
    let el = document.getElementById('site-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'site-toast';
      el.style.cssText =
        'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99;' +
        'padding:10px 16px;border-radius:10px;font-size:14px;background:#1b2029;border:1px solid rgba(255,255,255,.16);' +
        'box-shadow:0 12px 30px rgba(0,0,0,.5);transition:opacity .2s;max-width:80vw';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.color = isOk ? 'var(--ok)' : 'var(--ink)';
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity = '0';
    }, 2600);
  }

  // 读一次浏览器定位（localhost 属安全上下文，能用）；失败就 resolve(null)，交给上层退 IP
  function browserCoord(timeoutMs) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), Number(timeoutMs) || 6000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          finish({ lng: pos.coords.longitude, lat: pos.coords.latitude });
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        { timeout: Number(timeoutMs) || 6000, maximumAge: 10 * 60 * 1000 }
      );
    });
  }

  // 「这一页要登录」的门：页面自己在没登录时把这段 HTML 插到 #main 里
  function loginGate(text) {
    const here = window.location.pathname + window.location.search;
    return (
      '<div class="card"><h2>先登录</h2>' +
      '<p class="hint">' + esc(text || '这一页要登录后才能看') + '</p>' +
      '<a class="btn primary" href="/login?next=' + encodeURIComponent(here) + '">去登录 / 注册</a></div>'
    );
  }

  window.TravelSite = {
    api, qs, esc, fmtDate, fmtKm, amapSearchUrl, toast, browserCoord, loginGate,
  };
})();
