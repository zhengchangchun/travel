/* 选中态管理：本地维护已选 poi_id 集合，与后端 /api/selection 同步（乐观更新 + 失败回滚） */
(function () {
  const API = window.TravelAPI;

  let city = null;
  let tripId = null;
  let pins = [];
  let ids = new Set();
  const listeners = [];

  // 写还在飞的计数（2026-11-24）：乐观更新会先 notify 一次，这时候服务端还没看到这个点；
  // 路线规划（/api/itinerary/route）读的是库里的这趟点，撞上就会 400「行程点数不足 2」。
  // 所以把写包起来计数，规划那边等它归零再发请求。
  let writes = 0;
  async function write(fn) {
    writes += 1;
    try {
      return await fn();
    } finally {
      writes -= 1;
    }
  }
  function pendingCount() {
    return writes;
  }

  function keyOf(poi) {
    if (!poi) return '';
    if (poi.id != null) return String(poi.id);
    if (poi.poi_id != null) return String(poi.poi_id);
    return poi.name + '@' + poi.lng + ',' + poi.lat;
  }

  function mapPin(pin) {
    return {
      id: pin.poi_id != null ? String(pin.poi_id) : 'pin:' + pin.id,
      pinId: pin.id,
      poi_id: pin.poi_id,
      name: pin.name,
      address: pin.address,
      lng: pin.lng,
      lat: pin.lat,
      category: pin.category,
      rating: pin.rating,
      cost: pin.cost,
      tel: pin.tel,
      photo: pin.photo,
      note: pin.note || '',
      sort_order: pin.sort_order,
      // 按天分段：第几天（默认 1）——清单分组要用
      day: Number(pin.day) || 1,
      // 待规划（2026-11-24）：planned = 已排进日程；wish = 先收着、还没排
      status: pin.status === 'wish' ? 'wish' : 'planned',
      // 预约与时间段（2026-11-25）：用户自己的安排
      booking: pin.booking === 'needed' || pin.booking === 'required' ? pin.booking : 'none',
      slot: pin.slot || '',
    };
  }

  // 本地合成的 key（pin:<pins.id>）：说明这条 pin 没有真高德 poi_id（见 mapPin）
  function isSyntheticKey(key) {
    return /^pin:\d+$/.test(String(key));
  }

  function toPayload(poi) {
    return {
      id: keyOf(poi),
      name: poi.name,
      address: poi.address,
      lng: poi.lng,
      lat: poi.lat,
      category: poi.category,
      rating: poi.rating,
      cost: poi.cost,
      tel: poi.tel,
      photo: poi.photo,
    };
  }

  function snapshot() {
    return { city, tripId, pins: pins.slice(), ids: new Set(ids), count: ids.size };
  }

  function notify() {
    const snap = snapshot();
    listeners.forEach((fn) => fn(snap));
  }

  async function load(nextCity, nextTripId) {
    city = nextCity;
    tripId = nextTripId == null || nextTripId === '' ? null : Number(nextTripId);
    const data = await API.getSelection(city, tripId || undefined);
    // 服务端可能回「该城第一趟」（没指定 tripId 时）：以它为准
    tripId = data.tripId == null ? null : Number(data.tripId);
    pins = (data.pins || []).map(mapPin);
    ids = new Set(pins.map((p) => p.id));
    notify();
    return snapshot();
  }

  // 换一趟（同一城市）：重新拉那一趟的点
  async function loadTrip(nextTripId) {
    if (!city) return snapshot();
    return load(city, nextTripId);
  }

  function has(poi) {
    return ids.has(keyOf(poi));
  }

  function list() {
    return pins.slice();
  }

  // 清空本地选中态（删除行程后必须调，否则列表里会留“幽灵星标”）
  function reset() {
    pins = [];
    ids = new Set();
    tripId = null;
    notify();
    return snapshot();
  }

  function count() {
    return ids.size;
  }

  async function select(poi) {
    const key = keyOf(poi);
    if (!key || ids.has(key)) return;
    ids.add(key);
    // 乐观占位：pinId 必须是 pins.id（数字），还没落库就先留 null。
    // 不能走 mapPin —— 那里的 pinId 取的是传进来的 id 字段，会把高德 poi_id 当成 pin 行号
    pins.push({
      id: key,
      pinId: null,
      poi_id: poi.poi_id != null ? poi.poi_id : key,
      name: poi.name,
      address: poi.address,
      lng: poi.lng,
      lat: poi.lat,
      category: poi.category,
      rating: poi.rating,
      cost: poi.cost,
      tel: poi.tel,
      photo: poi.photo,
      note: '',
      day: Number(poi.day) || 1,
      status: 'planned',
    });
    notify();
    try {
      const res = await write(() => API.selectPoi({ city, poi: toPayload(poi) }));
      tripId = res.tripId;
      const idx = pins.findIndex((p) => p.id === key);
      if (idx >= 0) pins[idx] = mapPin(res.pin);
      notify();
    } catch (err) {
      ids.delete(key);
      pins = pins.filter((p) => p.id !== key);
      notify();
      throw err;
    }
  }

  async function remove(poiOrKey) {
    const item = typeof poiOrKey === 'string' ? null : poiOrKey;
    const key = typeof poiOrKey === 'string' ? poiOrKey : keyOf(poiOrKey);
    if (!key || !ids.has(key)) return;
    const backupPins = pins.slice();
    const backupIds = new Set(ids);
    ids.delete(key);
    pins = pins.filter((p) => p.id !== key);
    notify();
    try {
      // 没有真 poi_id 的点（本地 key 是 pin:<行号>）：后端按 poi_id 查不到，必然 404「未选中该地点 pin:<n>」
      // ⇒ 只能删 pin 行；有真 poi_id 的仍走 /api/selection（顺带把同 poi_id 的重复行一起清）
      if (isSyntheticKey(key)) {
        const rowId =
          item && typeof item.pinId === 'number' && Number.isFinite(item.pinId)
            ? item.pinId
            : Number(String(key).slice(4));
        await write(() => API.deletePin(rowId));
      } else {
        await write(() => API.unselectPoi({ city, poiId: key, tripId: tripId || undefined }));
      }
    } catch (err) {
      pins = backupPins;
      ids = backupIds;
      notify();
      throw err;
    }
  }

  // 待规划：把某个点标成 wish / planned（乐观更新，失败回滚）
  async function setStatus(poiOrKey, status) {
    const key = typeof poiOrKey === 'string' ? poiOrKey : keyOf(poiOrKey);
    const next = String(status) === 'wish' ? 'wish' : 'planned';
    const idx = pins.findIndex((p) => p.id === key);
    if (idx < 0) return null;
    const before = pins[idx].status;
    if (before === next) return pins[idx];
    pins[idx] = Object.assign({}, pins[idx], { status: next });
    notify();
    try {
      const row = await write(() => API.updatePin(pins[idx].pinId, { status: next }));
      const at = pins.findIndex((p) => p.id === key);
      if (at >= 0 && row) pins[at] = mapPin(row);
      notify();
      return pins[at] || null;
    } catch (err) {
      const at = pins.findIndex((p) => p.id === key);
      if (at >= 0) pins[at] = Object.assign({}, pins[at], { status: before });
      notify();
      throw err;
    }
  }

  async function toggle(poi) {
    if (has(poi)) await remove(poi);
    else await select(poi);
  }

  async function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= pins.length) return;
    const next = pins.slice();
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    const backup = pins;
    pins = next;
    notify();
    try {
      await write(() => API.reorderSelection({ city, tripId: tripId || undefined, poi_ids: next.map((p) => p.id) }));
    } catch (err) {
      pins = backup;
      notify();
      throw err;
    }
  }

  // 整单重排（自动成线用）：按给定 poi_id 顺序重排并落库；失败回滚
  async function reorder(orderedIds) {
    const want = (Array.isArray(orderedIds) ? orderedIds : []).map(String);
    if (!want.length) return pins.slice();
    const byId = new Map(pins.map((p) => [p.id, p]));
    const next = [];
    want.forEach((id) => {
      const hit = byId.get(id);
      if (hit) {
        next.push(hit);
        byId.delete(id);
      }
    });
    byId.forEach((p) => next.push(p)); // 没点名的保持原相对顺序附在末尾
    if (next.length !== pins.length) return pins.slice();
    const backup = pins;
    pins = next;
    notify();
    try {
      await write(() => API.reorderSelection({ city, tripId: tripId || undefined, poi_ids: next.map((p) => p.id) }));
      return next;
    } catch (err) {
      pins = backup;
      notify();
      throw err;
    }
  }

  // 写备注（每条地点自己的话）：乐观更新，失败回滚。
  // 刚选中还没落库的点没有 pin 行号，PATCH 打不了 ⇒ 先把选中态从后端刷一遍再写。
  async function setNote(key, note) {
    const id = String(key);
    const text = note == null ? '' : String(note);
    const at = pins.findIndex((p) => p.id === id);
    if (at < 0) return null;
    const before = pins[at];
    if ((before.note || '') === text) return before;
    const backup = pins;
    pins = pins.slice();
    pins[at] = Object.assign({}, before, { note: text });
    notify();
    try {
      let rowId = before.pinId;
      if (typeof rowId !== 'number' || !Number.isFinite(rowId)) {
        const data = await API.getSelection(city);
        tripId = data.tripId;
        pins = (data.pins || []).map(mapPin);
        const hit = pins.find((p) => p.id === id);
        if (!hit) throw new Error('没找到这条记录的落库行号，重试一次');
        rowId = hit.pinId;
        const i2 = pins.indexOf(hit);
        pins[i2] = Object.assign({}, hit, { note: text });
        notify();
      }
      const saved = await API.updatePinNote(rowId, text);
      const i3 = pins.findIndex((p) => p.id === id);
      if (i3 >= 0) pins[i3] = Object.assign({}, pins[i3], { note: (saved && saved.note) || null, pinId: rowId });
      notify();
      return pins[i3] || null;
    } catch (err) {
      pins = backup;
      notify();
      throw err;
    }
  }

  function subscribe(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  window.TravelSelection = {
    load,
    has,
    list,
    count,
    pendingCount,
    setStatus,
    select,
    remove,
    toggle,
    move,
    reorder,
    setNote,
    reset,
    subscribe,
    keyOf,
    getCity: () => city,
    getTripId: () => tripId,
  };
})();
