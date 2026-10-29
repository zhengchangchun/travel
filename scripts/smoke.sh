#!/usr/bin/env bash
# 自测：起服务 → 打 P1–P9 接口 → 断言 → 关服务；全绿时 exit 0
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-8799}"
export PORT
SMOKE_DIR="$(mktemp -d -t travel-smoke.XXXXXX)"
export TRAVEL_DB="$SMOKE_DIR/travel.db"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t travel-smoke-log.XXXXXX)"
SERVER_PID=""

cleanup() {
  stop_server
  rm -f "$LOG"
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

start_server() {
  node server/index.js >"$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -sf "$BASE/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "FAIL: 服务未在预期时间内就绪"
  cat "$LOG"
  exit 1
}

jget() {
  JQ_EXPR="$1" node -e '
    let s="";
    process.stdin.on("data",c=>s+=c).on("end",()=>{
      try { const o=JSON.parse(s); const v=eval("o" + process.env.JQ_EXPR);
        process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)));
      } catch(e){ process.stdout.write("PARSE_ERR"); }
    });
  '
}

PASS=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
fail() { echo "FAIL  $1"; echo "--- 服务日志 ---"; cat "$LOG"; exit 1; }

req_body() { curl -s "$BASE$1"; }
req_code() { curl -s -o /dev/null -w "%{http_code}" "$BASE$1"; }

start_server

# P1 health
H="$(req_body /api/health)"
[ "$(printf '%s' "$H" | jget '.ok')" = "true" ] || fail "P1 health ok!=true"
[ "$(printf '%s' "$H" | jget '.data.status')" = "up" ] || fail "P1 status!=up"
ok "P1 GET /api/health"

# P2 config
C="$(req_body /api/config)"
[ -n "$(printf '%s' "$C" | jget '.data.jsApiKey')" ] || fail "P2 缺 jsApiKey"
[ "$(printf '%s' "$C" | jget '.data.categories.length')" = "4" ] || fail "P2 categories!=4"
ok "P2 GET /api/config（jsApiKey + 4 分类）"

# P3 city search
CS="$(req_body '/api/city/search?q=%E6%9D%AD%E5%B7%9E')"
[ "$(printf '%s' "$CS" | jget '.data[0].name')" != "" ] || fail "P3 无城市 name"
[ "$(printf '%s' "$CS" | jget '.data[0].center')" != "" ] || fail "P3 无城市 center"
ok "P3 GET /api/city/search（杭州 → 城市 + center）"

# P4 poi search，address 必须非空
PS="$(req_body '/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food')"
[ "$(printf '%s' "$PS" | jget '.data.length')" -ge 1 ] 2>/dev/null || fail "P4 结果为空"
[ "$(printf '%s' "$PS" | jget '.data[0].address')" != "" ] || fail "P4 address 为空"
[ "$(printf '%s' "$PS" | jget '.data[0].lng')" != "" ] || fail "P4 缺 lng"
[ "$(printf '%s' "$PS" | jget '.data[0].category')" = "food" ] || fail "P4 category!=food"
ok "P4 GET /api/poi/search（≥1 条、address 非空）"

# P5 nearby
NB="$(req_body '/api/poi/nearby?lng=120.15507&lat=30.27415&category=sight')"
[ "$(printf '%s' "$NB" | jget '.ok')" = "true" ] || fail "P5 nearby 失败"
ok "P5 GET /api/poi/nearby"

# P6 缓存命中
HITS1="$(req_body /api/health | jget '.data.cache.hits')"
req_body '/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food' >/dev/null
req_body '/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food' >/dev/null
HITS2="$(req_body /api/health | jget '.data.cache.hits')"
[ "$HITS2" -gt "$HITS1" ] 2>/dev/null || fail "P6 缓存 hits 未增加（${HITS1} → ${HITS2}）"
ok "P6 同参数二次请求命中缓存（hits ${HITS1} → ${HITS2}）"

# P7 高德错误归一为 502 AMAP_ERROR（按任务书允许：单测 mock，不触碰 local.json 的 key）
if node -e '
  const { createApp } = require("./server/index");
  const { createDb } = require("./server/db");
  const app = createApp({
    config: { port: 0, amap: { webServiceKey: "K", jsApiKey: "J", jsApiSecurityCode: "" }, defaultCity: "杭州" },
    db: createDb(":memory:"),
    amap: { searchPoi: async () => { const e = new Error("INVALID_USER_KEY"); e.code = "AMAP_ERROR"; throw e; } },
  });
  app.server.listen(0, "127.0.0.1", async () => {
    const base = "http://127.0.0.1:" + app.server.address().port;
    const res = await fetch(base + "/api/poi/search?city=%E6%9D%AD%E5%B7%9E&category=food");
    const body = await res.json();
    const pass = res.status === 502 && body.error && body.error.code === "AMAP_ERROR";
    console.log("P7 mock:", res.status, JSON.stringify(body.error));
    app.server.close(); app.db.close(); process.exit(pass ? 0 : 1);
  });
'; then
  ok "P7 高德错误 → 502 AMAP_ERROR（mock）"
else
  fail "P7 高德错误未归一为 502 AMAP_ERROR"
fi

# P8 持久化：建行程 → 加点 → 重启 → 仍可读
TRIP="$(curl -s -X POST "$BASE/api/trips" -H 'Content-Type: application/json' \
  -d '{"city":"杭州","title":"smoke 行程"}')"
TRIP_ID="$(printf '%s' "$TRIP" | jget '.data.id')"
[ -n "$TRIP_ID" ] && [ "$TRIP_ID" != "PARSE_ERR" ] || fail "P8 建行程失败"
curl -s -X POST "$BASE/api/pins" -H 'Content-Type: application/json' \
  -d "{\"trip_id\":$TRIP_ID,\"name\":\"西湖\",\"address\":\"西湖区\",\"lng\":120.1,\"lat\":30.2,\"category\":\"sight\"}" >/dev/null

stop_server
start_server
PINS="$(req_body "/api/trips/$TRIP_ID/pins")"
[ "$(printf '%s' "$PINS" | jget '.data.length')" = "1" ] || fail "P8 重启后读不到 pin"
[ "$(printf '%s' "$PINS" | jget '.data[0].name')" = "西湖" ] || fail "P8 重启后 pin 内容不符"
ok "P8 重启后行程与点仍可读（持久化）"

# P9 删行程 → 其下 pins 消失
DEL_CODE="$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/trips/$TRIP_ID")"
[ "$DEL_CODE" = "200" ] || fail "P9 删行程返回 $DEL_CODE"
AFTER_CODE="$(req_code "/api/trips/$TRIP_ID/pins")"
[ "$AFTER_CODE" = "404" ] || fail "P9 删行程后 pins 仍可访问（${AFTER_CODE}）"
ok "P9 删行程后其下 pins 一并消失"

# ================= T2 选中（P17–P24） =================
SELQ="%E6%9D%AD%E5%B7%9E"
sel_post() { curl -s -X POST "$BASE/api/selection" -H 'Content-Type: application/json' -d "$1"; }
sel_get()  { req_body "/api/selection?city=${SELQ}"; }

# P17 选中一条 → GET 返回该点、count=1
S17="$(sel_post '{"city":"杭州","poi":{"id":"SMOKE_P1","name":"烟测美食店","address":"测试路1号","lng":120.2,"lat":30.25,"category":"food","rating":"4.5","cost":"88"}}')"
[ "$(printf '%s' "$S17" | jget '.ok')" = "true" ] || fail "P17 选中返回非 ok"
[ "$(printf '%s' "$S17" | jget '.data.tripId')" != "" ] || fail "P17 未自动建行程"
G17="$(sel_get)"
[ "$(printf '%s' "$G17" | jget '.data.count')" = "1" ] || fail "P17 count!=1"
[ "$(printf '%s' "$G17" | jget '.data.pins[0].poi_id')" = "SMOKE_P1" ] || fail "P17 poi_id 不符"
ok "P17 POST /api/selection 选中 → GET count=1"

# P18 同 (city, poi_id) 重复选中仍 count=1（幂等）
sel_post '{"city":"杭州","poi":{"id":"SMOKE_P1","name":"烟测美食店","address":"测试路1号","lng":120.2,"lat":30.25,"category":"food"}}' >/dev/null
G18="$(sel_get)"
[ "$(printf '%s' "$G18" | jget '.data.count')" = "1" ] || fail "P18 重复选中 count!=1"
ok "P18 重复选中幂等（count 仍为 1）"

# P19 取消选中 → count=0
D19="$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/selection?city=${SELQ}&poi_id=SMOKE_P1")"
[ "$D19" = "200" ] || fail "P19 取消返回 ${D19}"
[ "$(sel_get | jget '.data.count')" = "0" ] || fail "P19 取消后 count!=0"
ok "P19 DELETE /api/selection → count=0"

# P20 调序 [B,A] → GET 顺序为 B,A（顺序持久化）
sel_post '{"city":"杭州","poi":{"id":"SMOKE_P1","name":"甲点","address":"甲路1号","lng":120.21,"lat":30.26,"category":"food","rating":"4.5","cost":"88"}}' >/dev/null
sel_post '{"city":"杭州","poi":{"id":"SMOKE_P2","name":"乙点","address":"乙路2号","lng":120.22,"lat":30.27,"category":"sight"}}' >/dev/null
curl -s -X PUT "$BASE/api/selection/order" -H 'Content-Type: application/json' \
  -d '{"city":"杭州","poi_ids":["SMOKE_P2","SMOKE_P1"]}' >/dev/null
G20="$(sel_get)"
[ "$(printf '%s' "$G20" | jget '.data.pins[0].poi_id')" = "SMOKE_P2" ] || fail "P20 首项应为 SMOKE_P2"
[ "$(printf '%s' "$G20" | jget '.data.pins[1].poi_id')" = "SMOKE_P1" ] || fail "P20 次项应为 SMOKE_P1"
ok "P20 PUT /api/selection/order 顺序持久化（B,A）"

# P21 导出 Markdown
MD21="$(req_body "/api/selection/export?city=${SELQ}&format=md")"
[[ "$MD21" == *"# 杭州 · 我的行程"* ]] || fail "P21 缺标题"
[[ "$MD21" == *"## 美食"* ]] || fail "P21 缺分类分组"
[[ "$MD21" == *"## 景点"* ]] || fail "P21 缺第二个分类分组"
[[ "$MD21" == *"乙路2号"* ]] || fail "P21 缺详细地址"
[[ "$MD21" == *"★4.5"* ]] || fail "P21 缺评分"
ok "P21 GET /api/selection/export 返回 Markdown（标题/分组/地址）"

# P22 旧库迁移幂等：无 sort_order 的旧库副本 → 自动补列且连跑两次不报错
if node -e '
  const fs=require("node:fs"), os=require("node:os"), path=require("node:path");
  const { DatabaseSync }=require("node:sqlite");
  const { createDb }=require("./server/db");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"travel-old-"));
  const file=path.join(dir,"travel.db");
  const raw=new DatabaseSync(file);
  raw.exec("CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT);");
  raw.exec("CREATE TABLE pins (id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL, poi_id TEXT, name TEXT NOT NULL, address TEXT, lng REAL NOT NULL, lat REAL NOT NULL, category TEXT NOT NULL, rating TEXT, cost TEXT, tel TEXT, photo TEXT, note TEXT, created_at TEXT);");
  raw.close();
  const d1=createDb(file);
  const cols=d1.raw.prepare("PRAGMA table_info(pins)").all().map(c=>c.name);
  d1.close();
  const d2=createDb(file);
  d2.close();
  process.exit(cols.includes("sort_order")?0:1);
'; then
  ok "P22 旧库迁移幂等（自动补 sort_order，连跑两次不报错）"
else
  fail "P22 迁移未补列或不幂等"
fi

# P23 前端选中资产就绪（★ 选中）
A23="$(req_body /js/selection.js)"
[[ "$A23" == *"TravelSelection"* ]] || fail "P23 selection.js 未含 TravelSelection"
[[ "$(sel_get | jget '.data.count')" = "2" ]] || fail "P23 选中集应为 2"
ok "P23 前端选中资产 selection.js 就绪（TravelSelection）"

# P24 只看选中：行程/选中资产与开关就绪
A24="$(req_body /js/itinerary.js)"
[[ "$A24" == *"TravelItinerary"* ]] || fail "P24 itinerary.js 未含 TravelItinerary"
IDX24="$(req_body /)"
[[ "$IDX24" == *"only-selected-btn"* ]] || fail "P24 index 缺只看选中开关"
ok "P24 只看选中与行程视图资产就绪（only-selected-btn / itinerary.js）"

# P28 工程约束：无 node_modules、无 dependencies、scripts 无 $VAR 紧跟非 ASCII
if node -e '
  const fs=require("node:fs"), path=require("node:path");
  if (fs.existsSync("node_modules")) { console.log("node_modules exists"); process.exit(1); }
  if (fs.existsSync("package.json")) {
    const p=JSON.parse(fs.readFileSync("package.json","utf8"));
    if (p.dependencies && Object.keys(p.dependencies).length) { console.log("dependencies 非空"); process.exit(2); }
  }
  const bad=[];
  for (const f of fs.readdirSync("scripts")) {
    if (!f.endsWith(".sh")) continue;
    const t=fs.readFileSync(path.join("scripts",f),"utf8");
    const re=/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;
    let m; while ((m=re.exec(t))) bad.push(f+": "+m[0]);
  }
  if (bad.length) { console.log("脚本卫生问题:", bad.join(" | ")); process.exit(3); }
  process.exit(0);
'; then
  ok "P28 无 node_modules / 无 dependencies / scripts 无 \$VAR 紧跟非 ASCII"
else
  fail "P28 工程约束不满足"
fi

# ================= T3 路线连线（P29–P37） =================

# P29 单段驾车路线：距离/耗时 > 0、折线 >= 2 点
R29="$(req_body '/api/route?mode=driving&origin=120.161,30.279&destination=120.148,30.246')"
[ "$(printf '%s' "${R29}" | jget '.ok')" = "true" ] || fail "P29 driving 返回非 ok"
[ "$(printf '%s' "${R29}" | jget '.data.distance')" -gt 0 ] 2>/dev/null || fail "P29 distance<=0"
[ "$(printf '%s' "${R29}" | jget '.data.duration')" -gt 0 ] 2>/dev/null || fail "P29 duration<=0"
[ "$(printf '%s' "${R29}" | jget '.data.polyline.length')" -ge 2 ] 2>/dev/null || fail "P29 polyline<2 点"
ok "P29 GET /api/route driving（distance/duration>0，polyline>=2 点）"
sleep 0.4

# P30 步行可返回；公交（带 city）可返回且含换乘摘要
R30W="$(req_body '/api/route?mode=walking&origin=120.161,30.279&destination=120.148,30.246')"
[ "$(printf '%s' "${R30W}" | jget '.ok')" = "true" ] || fail "P30 walking 返回非 ok"
[ "$(printf '%s' "${R30W}" | jget '.data.mode')" = "walking" ] || fail "P30 walking mode 不符"
sleep 0.4
R30T="$(req_body '/api/route?mode=transit&origin=120.161,30.279&destination=120.148,30.246&city=%E6%9D%AD%E5%B7%9E')"
[ "$(printf '%s' "${R30T}" | jget '.ok')" = "true" ] || fail "P30 transit 返回非 ok"
[ "$(printf '%s' "${R30T}" | jget '.data.mode')" = "transit" ] || fail "P30 transit mode 不符"
[ "$(printf '%s' "${R30T}" | jget '.data.transit.segments.length')" -ge 1 ] 2>/dev/null || fail "P30 transit 缺换乘摘要"
[ "$(printf '%s' "${R30T}" | jget '.data.polyline.length')" -ge 2 ] 2>/dev/null || fail "P30 transit 折线<2 点"
ok "P30 walking 正常；transit 含换乘摘要与外接折线"
sleep 0.4

# P31 非法参数：mode 非法 / transit 缺 city / 坐标格式错 → 400
C31A="$(req_code '/api/route?mode=fly&origin=120.1,30.2&destination=120.2,30.3')"
[ "${C31A}" = "400" ] || fail "P31 mode 非法应 400（${C31A}）"
C31B="$(req_code '/api/route?mode=transit&origin=120.1,30.2&destination=120.2,30.3')"
[ "${C31B}" = "400" ] || fail "P31 transit 缺 city 应 400（${C31B}）"
C31C="$(req_code '/api/route?mode=driving&origin=abc&destination=120.2,30.3')"
[ "${C31C}" = "400" ] || fail "P31 坐标格式错应 400（${C31C}）"
ok "P31 非法 mode / transit 缺 city / 坐标格式错 → 400"

# P32 3 个点行程 → legs=2 且 totalDistance = 两段之和
sel_post '{"city":"杭州","poi":{"id":"SMOKE_P3","name":"丙点","address":"丙路3号","lng":120.25,"lat":30.24,"category":"stay"}}' >/dev/null
R32="$(req_body '/api/itinerary/route?city=%E6%9D%AD%E5%B7%9E&mode=driving')"
[ "$(printf '%s' "${R32}" | jget '.ok')" = "true" ] || fail "P32 行程路线返回非 ok"
[ "$(printf '%s' "${R32}" | jget '.data.legs.length')" = "2" ] || fail "P32 legs!=2"
L0="$(printf '%s' "${R32}" | jget '.data.legs[0].distance')"
L1="$(printf '%s' "${R32}" | jget '.data.legs[1].distance')"
TOT="$(printf '%s' "${R32}" | jget '.data.totalDistance')"
[ "${TOT}" = "$((L0 + L1))" ] || fail "P32 totalDistance 不等于段和（${TOT} != $((L0 + L1))）"
ok "P32 3 点行程 legs=2，totalDistance=两段之和（${TOT}）"

# P33 同参数连打两次 → 第二次命中缓存（cache hits 增加）
req_body '/api/itinerary/route?city=%E6%9D%AD%E5%B7%9E&mode=driving' >/dev/null
HITS33A="$(req_body /api/health | jget '.data.cache.hits')"
req_body '/api/itinerary/route?city=%E6%9D%AD%E5%B7%9E&mode=driving' >/dev/null
HITS33B="$(req_body /api/health | jget '.data.cache.hits')"
[ "${HITS33B}" -gt "${HITS33A}" ] 2>/dev/null || fail "P33 第二次未命中缓存（${HITS33A} → ${HITS33B}）"
ok "P33 同参数二次请求命中缓存（hits ${HITS33A} → ${HITS33B}）"

# P34 单点行程（<2 点）→ 400
sel_post '{"city":"上海","poi":{"id":"SMOKE_S1","name":"外滩","address":"中山东一路","lng":121.49,"lat":31.24,"category":"sight"}}' >/dev/null
C34="$(req_code '/api/itinerary/route?city=%E4%B8%8A%E6%B5%B7&mode=driving')"
[ "${C34}" = "400" ] || fail "P34 单点行程应 400（${C34}）"
ok "P34 单点行程（<2 点）→ 400"

# P35 段级失败降级：mock 第二段失败 → HTTP 200，该段 ok:false/degraded:true 且有 reason，其余段正常
if node -e '
  const { createApp } = require("./server/index");
  const { createDb } = require("./server/db");
  const db = createDb(":memory:");
  [["A", 120.1, 30.2], ["B", 120.11, 30.21], ["C", 120.12, 30.22]].forEach(([id, lng, lat]) =>
    db.insertPinIfAbsent("杭州", { id, name: id, lng, lat, category: "food" })
  );
  let n = 0;
  const amap = {
    planDriving: async () => {
      n += 1;
      if (n === 2) { const e = new Error("段级规划失败"); e.code = "AMAP_ERROR"; throw e; }
      return { mode: "driving", distance: 1000, duration: 600,
        polyline: [[120.1, 30.2], [120.11, 30.21]], steps: [], transit: null, degraded: false };
    },
  };
  const app = createApp({
    config: { port: 0, amap: { webServiceKey: "K", jsApiKey: "J", jsApiSecurityCode: "" }, defaultCity: "杭州" },
    db, amap, routeIntervalMs: 0,
  });
  app.server.listen(0, "127.0.0.1", async () => {
    const base = "http://127.0.0.1:" + app.server.address().port;
    const res = await fetch(base + "/api/itinerary/route?city=" + encodeURIComponent("杭州") + "&mode=driving");
    const body = await res.json();
    const d = body.data || {};
    const ok = res.status === 200 && d.legs && d.legs.length === 2 &&
      d.legs[0].ok === true && d.legs[1].ok === false && d.legs[1].degraded === true &&
      !!d.legs[1].reason && d.totalDistance === 1000 && d.failed && d.failed.length === 1;
    console.log("P35 mock:", res.status, JSON.stringify((d.legs || []).map((l) => ({ ok: l.ok, degraded: l.degraded, reason: l.reason }))));
    app.server.close(); app.db.close(); process.exit(ok ? 0 : 1);
  });
'; then
  ok "P35 段级失败降级（200 + ok:false/degraded:true/reason，其余段正常）"
else
  fail "P35 段级失败未正确降级"
fi

# P36 前端路线资产就绪：TravelRoute + 三方式 + 总览面板
A36="$(req_body /js/route.js)"
[[ "${A36}" == *TravelRoute* ]] || fail "P36 route.js 未含 TravelRoute"
[[ "${A36}" == *正在规划* ]] || fail "P36 route.js 缺逐段进度文案"
[[ "${A36}" == *driving* && "${A36}" == *walking* && "${A36}" == *transit* ]] || fail "P36 route.js 缺三种出行方式"
IDX36="$(req_body /)"
[[ "${IDX36}" == *route-modes* && "${IDX36}" == *route-totals* && "${IDX36}" == *route-legs* ]] || fail "P36 index 缺路线总览面板"
ok "P36 前端路线资产就绪（TravelRoute + 三方式 + 总览面板）"

# P37 调序自动重算与分段点击：app 调 Route.draw / map drawRoute / route focusLeg
M37="$(req_body /js/map.js)"
AP37="$(req_body /js/app.js)"
[[ "${M37}" == *drawRoute* && "${M37}" == *clearRoute* ]] || fail "P37 map.js 缺 drawRoute/clearRoute"
[[ "${AP37}" == *Route.draw* ]] || fail "P37 app.js 未在调序后重算（缺 Route.draw）"
[[ "${A36}" == *focusLeg* ]] || fail "P37 route.js 缺 focusLeg（分段可点）"
ok "P37 调序自动重算与分段点击资产就绪（app Route.draw / map drawRoute / route focusLeg）"

# ================= T6 三栏左右分离（P39–P42） =================
IDX_T6="$(req_body /)"

# P39 三栏容器与折叠按钮就绪
[[ "${IDX_T6}" == *'id="sidebar"'* ]] || fail "P39 缺左栏 #sidebar"
[[ "${IDX_T6}" == *'id="map-wrap"'* ]] || fail "P39 缺中栏 #map-wrap"
[[ "${IDX_T6}" == *'id="right-panel"'* ]] || fail "P39 缺右栏 #right-panel"
[[ "${IDX_T6}" == *'id="panel-toggle"'* ]] || fail "P39 缺折叠按钮"
ok "P39 三栏容器与折叠按钮就绪（sidebar / map-wrap / right-panel / panel-toggle）"

# P40 左栏无「我挑的」残留；右栏含全部「我挑的」元素
if printf '%s' "${IDX_T6}" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const l = s.indexOf("id=\"sidebar\"");
    const m = s.indexOf("id=\"map-wrap\"");
    const r = s.indexOf("id=\"right-panel\"");
    if (!(l >= 0 && m > l && r > m)) { console.log("三栏顺序/容器缺失"); process.exit(1); }
    const left = s.slice(l, m);
    const right = s.slice(r);
    const pin = ["selection-count","only-selected-btn","plan-btn","selection-list","itinerary-panel","itinerary-list","route-modes","route-totals","route-legs"];
    const residual = pin.filter((x) => left.indexOf(x) >= 0);
    if (residual.length) { console.log("左栏残留: " + residual.join(",")); process.exit(2); }
    const missing = pin.filter((x) => right.indexOf(x) < 0);
    if (missing.length) { console.log("右栏缺失: " + missing.join(",")); process.exit(3); }
    process.exit(0);
  });
'; then
  ok "P40 左栏无「我挑的」残留，右栏含全部「我挑的」元素"
else
  fail "P40 左右分离未达成"
fi

# P41 三栏 / 折叠 / 响应式样式就绪
CSS_T6="$(req_body /css/style.css)"
[[ "${CSS_T6}" == *"right-panel"* ]] || fail "P41 CSS 缺右栏样式"
[[ "${CSS_T6}" == *"collapsed"* ]] || fail "P41 CSS 缺折叠样式"
[[ "${CSS_T6}" == *"1100px"* ]] || fail "P41 CSS 缺窄屏断点 1100px"
ok "P41 三栏 + 折叠 + 1100px 响应式样式就绪"

# P42 地图自适应：折叠后 resize
MJ_T6="$(req_body /js/map.js)"
AJ_T6="$(req_body /js/app.js)"
[[ "${MJ_T6}" == *"resize"* ]] || fail "P42 map.js 缺 resize"
[[ "${AJ_T6}" == *"collapsed"* ]] || fail "P42 app.js 缺折叠处理"
[[ "${AJ_T6}" == *"resize"* ]] || fail "P42 app.js 折叠后未调 resize"
ok "P42 地图自适应就绪（map resize + app 折叠调用）"

echo "-----------------------------------------"
echo "smoke 全部通过：${PASS} 项"
exit 0
