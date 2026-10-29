// 地图选点 - 基于高德地图 JS API 2.0
let map = null, geocoder = null, placeSearch = null;
let markers = []; // {id, marker, lng, lat, address}
let idSeq = 1;

const $ = (id) => document.getElementById(id);
const statusEl = () => $("map-status");
function setStatus(t) { statusEl().textContent = t; }

function loadSaved() {
  $("inp-key").value = localStorage.getItem("amap_key") || "";
  $("inp-jscode").value = localStorage.getItem("amap_jscode") || "";
  try {
    const pts = JSON.parse(localStorage.getItem("amap_points") || "[]");
    pts.forEach(p => addPoint(p.lng, p.lat, p.address, true));
  } catch {}
}
function savePoints() {
  localStorage.setItem("amap_points", JSON.stringify(
    markers.map(m => ({ lng: m.lng, lat: m.lat, address: m.address }))
  ));
}

function loadAmap(key, jscode) {
  return new Promise((resolve, reject) => {
    if (window.AMap) return resolve();
    window._AMapSecurityConfig = { securityJsCode: jscode };
    const s = document.createElement("script");
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Geocoder,AMap.PlaceSearch,AMap.Geolocation`;
    s.onload = resolve;
    s.onerror = () => reject(new Error("高德 SDK 加载失败，检查 Key / 网络"));
    document.head.appendChild(s);
  });
}

async function initMap() {
  const key = $("inp-key").value.trim();
  const jscode = $("inp-jscode").value.trim();
  if (!key || !jscode) { alert("请先填 Key 和安全密钥 jsCode"); return; }
  localStorage.setItem("amap_key", key);
  localStorage.setItem("amap_jscode", jscode);
  setStatus("地图 SDK 加载中…");
  try {
    await loadAmap(key, jscode);
  } catch (e) { setStatus("加载失败：" + e.message); alert(e.message); return; }

  if (!map) {
    map = new AMap.Map("map", { zoom: 12, center: [120.15507, 30.27415] }); // 杭州
    geocoder = new AMap.Geocoder({ city: "全国" });
    placeSearch = new AMap.PlaceSearch({ pageSize: 8, pageIndex: 1 });

    map.on("click", (e) => {
      const lng = +e.lnglat.getLng().toFixed(6);
      const lat = +e.lnglat.getLat().toFixed(6);
      addPoint(lng, lat, "逆编码中…");
      reverseGeocode(markers[markers.length - 1]);
      setStatus(`已选点 ${lng}, ${lat}`);
    });
    setStatus("地图已加载：单击地图任意位置加选点");
  } else {
    setStatus("Key 已更新，地图继续可用");
  }
}

function addPoint(lng, lat, address, silent) {
  if (!map) return;
  const marker = new AMap.Marker({
    position: [lng, lat],
    draggable: true,
    title: address || `${lng},${lat}`,
  });
  map.add(marker);
  const item = { id: idSeq++, marker, lng, lat, address: address || "" };
  markers.push(item);
  marker.on("dragend", (ev) => {
    item.lng = +ev.lnglat.getLng().toFixed(6);
    item.lat = +ev.lnglat.getLat().toFixed(6);
    item.address = "逆编码中…";
    renderList();
    reverseGeocode(item);
  });
  if (!silent) savePoints();
  renderList();
  return item;
}

function reverseGeocode(item) {
  geocoder.getAddress([item.lng, item.lat], (status, result) => {
    if (status === "complete" && result.regeocode) {
      item.address = result.regeocode.formattedAddress || `${item.lng},${item.lat}`;
    } else {
      item.address = `${item.lng},${item.lat}`;
    }
    item.marker.setTitle(item.address);
    savePoints();
    renderList();
  });
}

function renderList() {
  $("point-count").textContent = markers.length;
  const ul = $("point-list");
  ul.innerHTML = "";
  markers.forEach((m, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="addr">${idx + 1}. ${escapeHtml(m.address || "…")}</div>
      <div class="lnglat">${m.lng}, ${m.lat}</div>
      <div class="meta"><span>#${m.id}</span><button class="del" data-id="${m.id}">× 删除</button></div>`;
    li.onclick = (e) => {
      if (e.target.classList.contains("del")) return;
      map.setCenter([m.lng, m.lat]);
      map.setZoom(15);
    };
    ul.appendChild(li);
  });
  ul.querySelectorAll(".del").forEach(btn => {
    btn.onclick = () => {
      const id = +btn.dataset.id;
      const i = markers.findIndex(m => m.id === id);
      if (i >= 0) { map.remove(markers[i].marker); markers.splice(i, 1); }
      savePoints(); renderList();
    };
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function doSearch() {
  if (!map) { alert("请先加载地图"); return; }
  const kw = $("inp-search").value.trim();
  if (!kw) return;
  placeSearch.search(kw, (status, result) => {
    const box = $("search-results");
    box.innerHTML = "";
    if (status !== "complete" || !result.poiList || !result.poiList.pois.length) {
      box.innerHTML = `<div class="hint">没搜到「${escapeHtml(kw)}」，换个关键词试试</div>`;
      return;
    }
    result.poiList.pois.forEach(poi => {
      const b = document.createElement("button");
      b.className = "search-item";
      b.innerHTML = `<b>${escapeHtml(poi.name)}</b><span>${escapeHtml(poi.address || "")} · ${poi.location.lng},${poi.location.lat}</span>`;
      b.onclick = () => {
        const lng = +poi.location.lng.toFixed(6), lat = +poi.location.lat.toFixed(6);
        map.setCenter([lng, lat]); map.setZoom(15);
        addPoint(lng, lat, `${poi.name} ${poi.address || ""}`.trim());
        savePoints();
      };
      box.appendChild(b);
    });
  });
}

function locateMe() {
  if (!map) { alert("请先加载地图"); return; }
  map.plugin("AMap.Geolocation", () => {
    const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 8000 });
    geo.getCurrentPosition((status, res) => {
      if (status === "complete") {
        map.setCenter([res.position.lng, res.position.lat]); map.setZoom(15);
        addPoint(+res.position.lng.toFixed(6), +res.position.lat.toFixed(6), "我的位置");
        savePoints(); setStatus("已定位到当前位置");
      } else alert("定位失败：" + (res.message || status));
    });
  });
}

function download(name, text, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

$("btn-save-key").onclick = initMap;
$("btn-clear-key").onclick = () => {
  localStorage.removeItem("amap_key"); localStorage.removeItem("amap_jscode");
  $("inp-key").value = ""; $("inp-jscode").value = ""; setStatus("Key 已清除");
};
$("btn-search").onclick = doSearch;
$("inp-search").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
$("btn-locate").onclick = locateMe;
$("btn-export-json").onclick = () => {
  download("points.json", JSON.stringify(markers.map(m => ({ lng: m.lng, lat: m.lat, address: m.address })), null, 2), "application/json");
};
$("btn-export-csv").onclick = () => {
  const rows = ["序号,地址,经度,纬度"];
  markers.forEach((m, i) => rows.push([i + 1, `"${(m.address || "").replace(/"/g, '""')}"`, m.lng, m.lat].join(",")));
  download("points.csv", "\ufeff" + rows.join("\n"), "text/csv");
};
$("btn-copy").onclick = async () => {
  const t = markers.map(m => `${m.lng},${m.lat}`).join("\n");
  if (!t) { alert("还没有选点"); return; }
  try { await navigator.clipboard.writeText(t); alert(`已复制 ${markers.length} 个点`); }
  catch { prompt("复制这些经纬度：", t); }
};
$("btn-clear-points").onclick = () => {
  if (!markers.length) return;
  if (!confirm(`确定清空 ${markers.length} 个点？`)) return;
  markers.forEach(m => map && map.remove(m.marker));
  markers = []; savePoints(); renderList();
};

loadSaved();
if ($("inp-key").value && $("inp-jscode").value) initMap();
