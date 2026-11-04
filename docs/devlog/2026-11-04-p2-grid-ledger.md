# travel · P2 账本补采（2026-11-04）

> 归档位置说明：约定是 `~/.nanobot/workspace/projects/devlog/travel/`，但该目录属 root（`drwxr-xr-x root staff`）、
> 当前身份写不进（`sudo` 需要密码）⇒ 改放仓内 `docs/devlog/`，跟代码一起提交。
> 项目卡同步条目在 `~/.nanobot/workspace/projects/travel.md`。

用户一句话需求：「有没有什么办法能够减少冗余 api 的调用」
→ 我先给冗余清单（①视野 TTL 键是整框坐标、②无脑实时搜不看库里有多少、③TTL 只 10 分钟、④配额耗尽还重试、
⑤详情现取不落库、⑥关键词搜索只内存缓存、⑦切分类立刻重查、⑧两套覆盖判定不共享）
→ 用户问「真正解决问题的方案是什么样的」→ 拍板：「直接做 P2 吧，30 天就行」。

## 做了什么（提交 dafbd5f）

核心一句话：**把「打高德」的触发条件从「地图动了」改成「本地账本里这片区域不新鲜了」**。
账本（`poi_coverage`：`city/category/gx/gy/collected_at/n_inserted/truncated`，格边长 0.01° ≈ 1.1km）
本来就在库里，但只有深度采集在写、实时搜索完全不读。

| 情形 | 行为 |
|---|---|
| 全 fresh | **0 次调用**（只读 SQLite，秒出旗） |
| 需补 1–2 格 | `place/around` 1 次/格（浏览级：只第 1 页 25 条，不翻页不细分） |
| 需补 ≥3 格 | `place/polygon` 整框查（≤4 页，不满一页即停），采完把**框内所有格**标新鲜 |
| 整框查被截断 | 只标 `grids_hit`（真有数据的格）⇒ 不留 30 天空洞 |
| 任何失败 | 一律不标覆盖 ⇒ 下次进入自动重试 |
| `force=1` | 跳过账本强制重查 |

新增：`planFill` / `fillAroundGrids` / `fillRectGrids` / `fillByGrids`（`server/collect.js`）；
`liveRect` 返回加 `grids_hit`；`db.listCoverageRange` SELECT 增三列；`/api/poi/inview` 支持 `force`。
前端三件事：修 TTL 键 bug、小位移抑制（中心 <≈300m 且面积变化 <20% 不打）、读数改账本口径。
**没有加任何采集 UI**（用户 11-03 已定「数据采集那个模块先去掉」，`tests/live-search-flow.test.js` 有守卫）。

## 验证

1. 全量 `node --test tests/*.test.js`：**283 passed / 0 fail**（基线 264，新增 19 条 `tests/poi-grid-fill.test.js`）。
2. 真实服务（副本库 `:8791`）三探针：
   - 空账本 + 配额耗尽 ⇒ `rect / calls=1 / errors=[USER_DAILY_QUERY_OVER_LIMIT] / filled=0 marked=0`，缓存 119 条照常出；
   - seed 今天采过 ⇒ `cache / calls=0 / fresh=6`；
   - seed 64 天前 ⇒ `rect / calls=1 / stale=6`。
3. 真实页面 `http://127.0.0.1:8787`（工作树已 `checkout --detach dafbd5f`）：
   选「住宿」→ 缓存 10213 条落旗、状态栏「实时搜索失败（高德调用 1 次全失败）：…」；
   页面内调 `TravelAPI.liveInView` 三态全对（已覆盖格 ⇒ cache/0；force ⇒ around/1；没采过的格 ⇒ around/1）。
   截图 `artifacts/travel/2026-11-04/P2-账本补采-页面.png`（nanobot workspace 下）。

## 坑 / 结论

- **`currentBbox()` 返回字符串**（不是对象），而 `queryKeyOf` 按对象取字段 ⇒ 前端 TTL 键一直是
  `NaN|NaN|NaN|NaN|<cat>`：副作用是「10 分钟内所有视野都被挡住」（看着省配额，实则语义错、还误报
  「X 分钟前刚查过」）。这次一并修掉。
- 本项目铁律再次生效：**源码正则单测绿 ≠ 页面能跑** ⇒ SQLite 侧全绿后仍真开页面看了状态栏。
- 高德两个池子别混：**搜索池**（关键字/周边/多边形/ID/提示，个人 5,000 次/月、30 元/万次、无折扣）
  vs **JS API 地图渲染池**（个人 150 万次/月）⇒ 搜索被限不影响地图显示。

## 没做（留作下一步）

- `/api/poi/search`（关键词搜索）结果落库；POI 详情（`/api/pois/:poiId` 现取的那条）落库。
- 配额耗尽类错误（`10044/10003/40000`）不重试（`collectCell` 现在最多重试 3 次，纯浪费）。
- 整城采集（`collectCityCategory`，按行政区）与按视野采集（按格）共享同一套覆盖判定。
- 30 天内新开/关店不会自动出现 ⇒ 需要 `force=1` 或深度采集刷新（用户已接受此取舍）。
