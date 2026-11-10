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
    searchCity: (q) => request('/api/city/search?' + qs({ q })),
    searchPoi: (params) => request('/api/poi/search?' + qs(params)),
    nearbyPoi: (params) => request('/api/poi/nearby?' + qs(params)),
    poiDetail: (id) => request('/api/poi/detail?' + qs({ id })),
    listTrips: (city) => request('/api/trips' + (city ? '?' + qs({ city }) : '')),
    createTrip: (payload) => request('/api/trips', post(payload)),
    listPins: (tripId) => request('/api/trips/' + tripId + '/pins'),
    // P13 行程分享：拿分享载荷（文本） / 生成分享包（html+txt+json）
    shareTrip: (tripId, payload) => request('/api/trips/' + tripId + '/share', post(payload || {})),
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
    updatePinNote: (id, note) =>
      request('/api/pins/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      }),

    // 选中（T2）
    getSelection: (city) => request('/api/selection?' + qs({ city })),
    selectPoi: (payload) => request('/api/selection', post(payload)),
    unselectPoi: ({ city, poiId }) =>
      request('/api/selection?' + qs({ city, poi_id: poiId }), { method: 'DELETE' }),
    reorderSelection: (payload) => request('/api/selection/order', put(payload)),
    exportSelection: async (city) => {
      const res = await fetch('/api/selection/export?' + qs({ city, format: 'md' }));
      if (!res.ok) {
        const e = new Error('导出失败（HTTP ' + res.status + '）');
        e.status = res.status;
        throw e;
      }
      return res.text();
    },

    // 路线（T3）
    route: (params) => request('/api/route?' + qs(params)),
    itineraryRoute: (city, mode) => request('/api/itinerary/route?' + qs({ city, mode })),

    // POI 缓存与实时搜索（T4 / L-1）
    listPois: (params) => request('/api/pois?' + qs(params)),
    // 实时搜索：视野 → 高德（≤ 9 次）→ 落库当缓存 → 返回本视野结果
    liveInView: (params) => request('/api/poi/inview?' + qs(params)),
    poisStats: (city) => request('/api/pois/stats?' + qs({ city })),
    getPoiDetail: (poiId) => request('/api/pois/' + encodeURIComponent(poiId)),
  };
})();
