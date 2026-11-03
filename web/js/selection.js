/* 选中态管理：本地维护已选 poi_id 集合，与后端 /api/selection 同步（乐观更新 + 失败回滚） */
(function () {
  const API = window.TravelAPI;

  let city = null;
  let tripId = null;
  let pins = [];
  let ids = new Set();
  const listeners = [];

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
      sort_order: pin.sort_order,
    };
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

  async function load(nextCity) {
    city = nextCity;
    const data = await API.getSelection(city);
    tripId = data.tripId;
    pins = (data.pins || []).map(mapPin);
    ids = new Set(pins.map((p) => p.id));
    notify();
    return snapshot();
  }

  function has(poi) {
    return ids.has(keyOf(poi));
  }

  function list() {
    return pins.slice();
  }

  function count() {
    return ids.size;
  }

  async function select(poi) {
    const key = keyOf(poi);
    if (!key || ids.has(key)) return;
    ids.add(key);
    pins.push(mapPin(Object.assign({ photo: undefined }, poi, { poi_id: key })));
    notify();
    try {
      const res = await API.selectPoi({ city, poi: toPayload(poi) });
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
    const key = typeof poiOrKey === 'string' ? poiOrKey : keyOf(poiOrKey);
    if (!key || !ids.has(key)) return;
    const backupPins = pins.slice();
    const backupIds = new Set(ids);
    ids.delete(key);
    pins = pins.filter((p) => p.id !== key);
    notify();
    try {
      await API.unselectPoi({ city, poiId: key });
    } catch (err) {
      pins = backupPins;
      ids = backupIds;
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
      await API.reorderSelection({ city, poi_ids: next.map((p) => p.id) });
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
      await API.reorderSelection({ city, poi_ids: next.map((p) => p.id) });
      return next;
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
    select,
    remove,
    toggle,
    move,
    reorder,
    subscribe,
    keyOf,
    getCity: () => city,
    getTripId: () => tripId,
  };
})();
