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
    listTrips: () => request('/api/trips'),
    createTrip: (payload) => request('/api/trips', post(payload)),
    listPins: (tripId) => request('/api/trips/' + tripId + '/pins'),
    addPin: (payload) => request('/api/pins', post(payload)),
    deletePin: (id) => request('/api/pins/' + id, { method: 'DELETE' }),
    listNotes: (city) => request('/api/notes' + (city ? '?' + qs({ city }) : '')),
    addNote: (payload) => request('/api/notes', post(payload)),
  };
})();
