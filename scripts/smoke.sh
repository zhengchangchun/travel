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

echo "-----------------------------------------"
echo "smoke 全部通过：$PASS 项"
exit 0
