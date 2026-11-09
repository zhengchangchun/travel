/* 城市选择：输入框 + 下拉建议合成一个控件（P10）。
   老做法是「输入框 + 搜索按钮 + 下面一块结果列表」——三个东西各干一半；
   现在打字就出下拉、上下键选、回车/点一下确认，一个控件一条路。
   这里只放纯逻辑（不碰 DOM），方便单测：
     buildOptions(query, results)      高德结果 → 下拉项
     rawOption(query, note)            搜索失败时的兜底项（只切名字、地图不动）
     moveActive(active, delta, len)    上下键高亮（首尾循环）
     pickIndex(options, query, active) 回车确认时选哪一项
     statusText / emptyText            下拉顶部那一行说明
   下拉项形状：{ name, sub, city, raw }（city=null 表示没有坐标，不能移地图）。 */
(function () {
  const CITY_SUB = '跳到主城区';

  function trim(v) {
    return String(v == null ? '' : v).trim();
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // 城市键：库里/接口里的城市名不带「市」（默认城市是「杭州」），高德返回的是「杭州市」
  // ⇒ 选中时去掉尾字「市」，否则切过去会变成另一个城市键、本地已收录的点全看不见
  function cityKey(name) {
    const s = trim(name);
    return s.replace(/市$/, '') || s;
  }

  function buildOptions(query, results) {
    const out = [];
    const seen = {};
    if (!trim(query)) return out;
    const list = Array.isArray(results) ? results : [];
    list.forEach((r) => {
      if (!r || !r.name) return;
      const name = String(r.name);
      if (seen[name]) return;
      seen[name] = 1;
      out.push({
        name,
        sub: CITY_SUB,
        raw: false,
        city: {
          name: cityKey(name),
          display: name,
          lng: num(r.lng),
          lat: num(r.lat),
          adcode: r.adcode || '',
          citycode: r.citycode || '',
        },
      });
    });
    return out;
  }

  function rawOption(query, note) {
    const q = trim(query);
    if (!q) return null;
    const why = note ? String(note) : '高德暂时没应答';
    return {
      name: q,
      sub: why + ' · 只切名字、地图不动',
      raw: true,
      city: { name: q, lng: null, lat: null },
    };
  }

  function moveActive(active, delta, len) {
    const n = Number(len) || 0;
    if (n <= 0) return -1;
    let cur = Number(active);
    if (!Number.isFinite(cur) || cur < 0) cur = delta >= 0 ? -1 : 0;
    let next = cur + (Number(delta) || 0);
    if (next < 0) next = n - 1;
    if (next >= n) next = 0;
    return next;
  }

  // 名字对齐（「杭州」≈「杭州市」）时优先选它，否则用高亮项，再否则用第一条
  function sameCity(a, b) {
    const x = trim(a).replace(/市$/, '');
    const y = trim(b).replace(/市$/, '');
    return !!x && x === y;
  }

  function pickIndex(options, query, active) {
    const opts = Array.isArray(options) ? options : [];
    if (!opts.length) return -1;
    if (active >= 0 && active < opts.length) return active;
    const q = trim(query);
    if (q) {
      for (let i = 0; i < opts.length; i += 1) {
        if (sameCity(opts[i].name, q)) return i;
      }
    }
    return 0;
  }

  function statusText(count, query) {
    const n = Number(count) || 0;
    if (!n) return '';
    const q = trim(query);
    return q
      ? '找到 ' + n + ' 个城市 · ↑↓ 选，回车确认'
      : n + ' 个城市 · ↑↓ 选，回车确认';
  }

  function emptyText(query) {
    const q = trim(query);
    return q
      ? '没找到城市「' + q + '」· 换个写法（如 杭州 / 杭州市）'
      : '输入城市名，如 杭州';
  }

  window.TravelCityBox = {
    CITY_SUB,
    buildOptions,
    rawOption,
    moveActive,
    pickIndex,
    statusText,
    emptyText,
    cityKey,
  };
})();
