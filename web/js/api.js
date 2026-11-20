/* 后端接口调用：统一解包 {ok,data,error}，失败抛错 */
(function () {
  function qs(params) {
    const sp = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') sp.set(k, v);
    });
    return sp.toString();
  }

  function post(payload) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  function put(payload) {
    return {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  function patch(payload) {
    return {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  async function request(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      const e = new Error('无法连接后端服务，请确认已运行 node server/index.js');
      e.code = 'NETWORK_ERROR';
      throw e;
    }
    let body;
    try {
      body = await res.json();
    } catch (err) {
      const e = new Error('后端返回了非 JSON 内容（HTTP ' + res.status + '）');
      e.code = 'BAD_RESPONSE';
      e.status = res.status;
      throw e;
    }
    if (res.status === 401) {
      // 没登录 / 会话过期：送去登录页，登录完回到原地（规划页的东西都是「我的」）
      const here = window.location.pathname + window.location.search;
      if (!/^\/login/.test(window.location.pathname)) {
        window.location.href = '/login?next=' + encodeURIComponent(here || '/app');
      }
    }
    if (!res.ok || !body.ok) {
      const info = body && body.error ? body.error : {};
      const e = new Error(info.msg || 'HTTP ' + res.status);
      e.code = info.code || 'HTTP_ERROR';
      e.status = res.status;
      throw e;
    }
    return body.data;
  }

  window.TravelAPI = {
    getConfig: () => request('/api/config'),
    me: () => request('/api/auth/me'),
    legacyPending: () => request('/api/legacy/pending'),
    claimLegacy: () => request('/api/legacy/claim', post({})),
    searchCity: (q) => request('/api/city/search?' + qs({ q })),
    cityBoundary: (city) => request('/api/city/boundary?' + qs({ city })),
    searchPoi: (params) => request('/api/poi/search?' + qs(params)),
    nearbyPoi: (params) => request('/api/poi/nearby?' + qs(params)),
    poiDetail: (id) => request('/api/poi/detail?' + qs({ id })),
    listTrips: (city) => request('/api/trips' + (city ? '?' + qs({ city }) : '')),
    // 旅游搭子（名单在 /buddies 维护，这里只读来显示「这趟跟谁一起」）
    listBuddies: () => request('/api/buddies'),
    // 该城的实景图索引（点位名 → 图）：清单里的小图用
    getCityPhotos: (city) => request('/api/photos?' + qs({ city })),
    createTrip: (payload) => request('/api/trips', post(payload)),
    listPins: (tripId) => request('/api/trips/' + tripId + '/pins'),
    // 行程改内容：标题 / 整条行程的备注
    updateTrip: (tripId, payload) =>
      request('/api/trips/' + tripId, patch(payload || {})),
    // P13 行程分享：拿分享载荷（文本） / 生成分享包（html+txt+json）
    shareTrip: (tripId, payload) => request('/api/trips/' + tripId + '/share', post(payload || {})),
    // 让生成的分享文件在文件管理器里现身（Finder 里选中它）
    revealShare: (file) => request('/api/share/reveal', post({ file })),
    exportTripShare: (tripId, payload) =>
      request('/api/trips/' + tripId + '/share/export', post(payload || {})),
    addPin: (payload) => request('/api/pins', post(payload)),
    deletePin: (id) => request('/api/pins/' + id, { method: 'DELETE' }),
    deleteTrip: (id) => request('/api/trips/' + id, { method: 'DELETE' }),
    // 删除该城市的全部行程与地点（同一城市一个行程的口径；删干净才不留“幽灵星标”）
    clearCityTrips: (city) => request('/api/trips?' + qs({ city }), { method: 'DELETE' }),
    listNotes: (city) => request('/api/notes' + (city ? '?' + qs({ city }) : '')),
    addNote: (payload) => request('/api/notes', post(payload)),
    // P4：分享文案识别 / 单条笔记 / 地名提取与高德补全
    parseNoteShare: (text) => request('/api/notes/parse', post({ text })),
    searchNotes: (params) => request('/api/notes/search?' + qs(params)),
    getNote: (id) => request('/api/notes/' + id),
    notePlaces: (id, payload) => request('/api/notes/' + id + '/places', post(payload || {})),
    deleteNote: (id) => request('/api/notes/' + id, { method: 'DELETE' }),
    // P5：自己抓（本机浏览器 + 平台已登录 profile）
    fetchNote: (payload) => request('/api/notes/fetch', post(payload)),
    discoverNotes: (payload) => request('/api/notes/discover', post(payload)),
    startNoteJob: (payload) => request('/api/notes/jobs', post(payload)),
    getNoteJob: (id) => request('/api/notes/jobs/' + id),
    cancelNoteJob: (id) => request('/api/notes/jobs/' + id + '/cancel', post({})),
    refreshNote: (id) => request('/api/notes/' + id + '/refresh', post({})),
    updatePinNote: (id, note) => request('/api/pins/' + id, patch({ note })),
    updatePinDay: (id, day) => request('/api/pins/' + id, patch({ day })),

    // 选中（T2）：一次只针对「某一趟」（一城多趟）；不给 tripId 就由服务端取该城第一趟
    getSelection: (city, tripId) => request('/api/selection?' + qs({ city, tripId })),
    selectPoi: (payload) => request('/api/selection', post(payload)),
    unselectPoi: ({ city, poiId, tripId }) =>
      request('/api/selection?' + qs({ city, poi_id: poiId, tripId }), { method: 'DELETE' }),
    reorderSelection: (payload) => request('/api/selection/order', put(payload)),
    exportSelection: async (city, order, tripId) => {
      const res = await fetch(
        '/api/selection/export?' +
          qs({
            city,
            tripId,
            format: 'md',
            order: order && order.length ? order.join(',') : undefined,
          })
      );
      if (!res.ok) {
        const e = new Error('导出失败（HTTP ' + res.status + '）');
        e.status = res.status;
        throw e;
      }
      return res.text();
    },

    // 路线（T3）：mode 可以是具体方式，也可以是 auto（每段各取最快）
    route: (params) => request('/api/route?' + qs(params)),
    itineraryRoute: (city, modeOrOpts) => {
      const o = modeOrOpts && typeof modeOrOpts === 'object' ? modeOrOpts : { mode: modeOrOpts };
      return request(
        '/api/itinerary/route?' +
          qs({
            city,
            // 一城多趟：一次只规划「这一趟」的点
            tripId: o.tripId,
            mode: o.modes && o.modes.length ? undefined : o.mode,
            modes: o.modes && o.modes.length ? o.modes.join(',') : undefined,
            // 页面上的点序（默认按距离算的那份）：不带上，服务端会按库里的顺序规划
            order: o.order && o.order.length ? o.order.join(',') : undefined,
          })
      );
    },

    // POI 缓存与实时搜索（T4 / L-1）
    listPois: (params) => request('/api/pois?' + qs(params)),
    // 实时搜索：视野 → 高德（≤ 9 次）→ 落库当缓存 → 返回本视野结果
    liveInView: (params) => request('/api/poi/inview?' + qs(params)),
    poisStats: (city) => request('/api/pois/stats?' + qs({ city })),
    getPoiDetail: (poiId) => request('/api/pois/' + encodeURIComponent(poiId)),
    // 点地图任意处问「这里是哪」：库里没有就走逆地理编码（P19）
    poiAt: (params) => request('/api/poi/at?' + qs(params)),
  };
})();
