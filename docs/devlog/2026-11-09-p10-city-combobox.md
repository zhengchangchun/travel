# devlog 2026-11-09 · P10 城市「输入框 + 下拉」合成一个控件

## 触发

用户一句话：「城市那个输入框和下拉框现在一般都合成一个」。
改前那个卡是**三样东西各干一半**：一个 `<input id="city-input">`、一个「搜索」按钮、
外加下面一块独立结果列表（`#city-results.result-list`）——打字不出东西，得点按钮，结果在另一块牌子里。
提交 `ce5b198`（本地仓，无远端）。

## 改法（一个控件一条路）

| 处 | 改前 | 改后 |
| --- | --- | --- |
| 结构 | input ＋ 搜索按钮 ＋ 结果列表 | `#city-combo`（`role=combobox` 输入框 ＋ 贴着的 `#city-results.combo-list`），**按钮删掉** |
| 触发 | 点按钮 / 回车 | `input` 事件 200ms 防抖即搜；聚焦且有字时也重查 |
| 选谁 | 点列表项 | ↑↓ 高亮（mechanics 在纯逻辑里）＋ 回车/点一下确认；名字对齐（杭州≈杭州市）优先 |
| 收起 | — | Esc、点外面、Tab 走开（120ms 延迟）都能收 |
| 说明 | 无 | 下拉顶部一行「找到 N 个城市 · ↑↓ 选，回车确认」；空结果给人话「没找到城市「x」· 换个写法」 |
| 失败 | 一句「城市搜索失败：…」 | 仍给**一项**「只切名字、地图不动」兜底（副标题写原因），不把用户卡死 |

新增 `web/js/citybox.js`：**纯逻辑**（不碰 DOM），单测直接真跑 —— `buildOptions`（去重/带坐标/副标题）、
`rawOption`（兜底项）、`moveActive`（首尾循环）、`pickIndex`（回车选谁：高亮 → 名字对齐 → 第一条）、
`statusText`/`emptyText`、`cityKey`（城市键）。

## 顺手修的两个真问题

1. **切城市键不对**（改前就有，只是以前要手点列表，碰到的人少）：高德返回的是「杭州市」，而库里/接口里的城市键是
   **「杭州」**（38,245 条 POI、1 条行程都挂在这个键上）⇒ 选中「杭州市」后 `#map-status` 报「该城市还没采到数据」、
   地图上的旗子全没了。修法＝`cityKey()` 去掉尾字「市」再当键（`display` 保留高德写法）。实测：选「杭州市」后
   `current-city=杭州`、`map-status=""`（不再报没数据）。
2. **下拉会「诈尸」**：收起时若还有搜索在飞，结果回来会 `classList.remove('hidden')` 把下拉又弹开。
   修法＝`closeCityList()` 里一并 `clearTimeout` ＋ `citySeq += 1`（在飞的请求作废）。实测：打字后立刻 Tab 走开 ⇒ 保持收起。

另外：下拉项加 `tabindex="-1"`（↑↓ 选项，Tab 直接走出这个控件，不再逐个跳选项）。

## 版式取舍

- 宽屏：`position: absolute` 浮层（`top: calc(100% + 4px)`，边框 `--line-2`＋`0 18px 40px rgba(0,0,0,.6)` 阴影），
  贴着输入框往下盖，**不把下面的卡顶开**。
- 窄屏（`@media (max-width: 1100px)`）：改成 `position: static`。原因＝那一档 `#sidebar` 本身就是
  `max-height: 42vh; overflow-y: auto` 的限高滚动容器，浮层会被它剪掉；在流内展开则由侧栏自己滚
  （实测 1000×900：`scrollHeight 974 > client 377`，四项建议都能滚到）。
- 窄屏城市卡**默认展开**（`cardExpanded('city')` 走 `narrowScreen()`）：原来宽窄屏一律默认收起，
  窄屏侧栏只有 42vh，收起后城市输入框等于看不见。宽屏保持默认收起。

## 验收读数

- 全量 `zsh -lic 'node --test tests/*.test.js'` **364 passed / 0 fail**（P9 基线 355 ⇒ +9，全是新 `tests/city-combo.test.js`）。
- 活体（`uxaudit` 私有 profile ＋ 真高德：
  - 1600×1000：打「杭」⇒ 下拉 1 项（杭州市·跳到主城区）＋顶部说明；↑↓/回车选中 ⇒ `current-city=杭州市`→键 `杭州`、
    下拉收起、输入框清空；打「州」⇒ 4 项（沧州市/朔州市/忻州市/锦州市）浮层 top=182（输入框底 178＋4）、高亮第一项；
    「zzzz」⇒ 空态人话；把 `/api/city/search` 掐掉 ⇒ 出现「城市搜索失败 · 你仍可以直接用这个名字」＋兜底项，回车切名字成功。
  - 1000×900：城市卡默认展开、下拉 `position: static`、可滚到。
  - 0 console error（唯一一条是我故意 abort 请求时浏览器报的 `ERR_FAILED`）。
- 截图 `~/.nanobot/workspace/artifacts/travel/2026-11-09-p10/`（P10-1…P10-11）。

## 副作用／顺带修的运维问题

预览工作树 `/tmp/travel-preview-wt` 的 **`.git` 掉了**（`git worktree list` 标 prunable），
而 `preview-serve.sh` 只在「目录不存在」时重建 ⇒ `git checkout` 静默失败、8787 一直发 11-07 的旧代码。
已在 `~/.nanobot/workspace/tools/travel/preview-serve.sh` 加一条：目录在但缺 `.git` ⇒ 先摘软链（`data`、`config/local.json`）再重建。
8787 已重建并跟到 `ce5b198`，实测下拉在真预览上生效（`hasOldButton=false`）。

## 仍开着（P2 剩余）

⑩ 笔记搜索无进度/无取消（`DEFAULT_TIMEOUT_MS=90000` ＋ 失败重试一次 ⇒ 最坏 3 分钟无反馈、两次状态互覆盖），要进度＋取消得先出个小设计。
