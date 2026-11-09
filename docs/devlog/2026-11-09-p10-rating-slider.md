# devlog 2026-11-09 · P10 评分过滤改成可拖的滑块

## 触发

用户一句话：「评分那个不要说选项 要是个可以滑动的选择器」。
改前是**一排 chip**（全部 / ≥3.5 / ≥4.0 / ≥4.5 / ★满分），只能点，不能连续调。提交 `5cfd3ec`。

## 改法

| 处 | 改前 | 改后 |
| --- | --- | --- |
| 控件 | `<div id="rating-chips">` 5 个按钮 chip | `<input id="rating-slider" type="range" min=0 max=5 step=0.5>` ＋ 左「不限」右「满分」两端文字 ＋ 当前值徽标 `#rating-value` ＋ 一行用法说明 |
| 语义 | 键 `all/3.5/4.0/4.5/top` | 数值 0~5（0.5 一档）→ 键：`0 ⇒ all`（不限）、`5 ⇒ top`（只留满分，沿用星标同一口径）、其余 ⇒ 「≥ N」 |
| 反馈 | 点一下才变 | 拖动时**徽标 + 轨道已填充部分实时跟手**；停下手 140ms 再重算列表与地图（不然拖一格重建一次 500 面旗） |
| 键盘/无障碍 | chip 可 Tab | 原生 range（方向键可调）＋ `aria-label` ＋ 动态 `aria-valuetext`（「只看 4.0 分及以上」/「只留满分」/「不限评分」） |
| 默认 | ≥4.0 | 不变（`DEFAULT_RATING_FILTER='4.0'`，滑块初始位置 4） |

新增 `web/js/rating.js`：**纯逻辑**（`valueToFilter` / `filterToValue` / `labelOf` / `ariaOf` / `percentOf` / `clampValue`），
不碰 DOM，单测直接真跑；`app.js` 只留 `renderRatingSlider`（按 state 画）、`paintRating`（只动画界面）、`onRatingSlide`（跟手 + 防抖提交）。
原 `ui.js::renderRatingChips` 与 `.rating-chip` 样式**一并删掉**（有测试钉住不许留）。

样式 = 自绘轨道：`::-webkit-slider-runnable-track` 用 `linear-gradient`＋CSS 变量 `--rating-pct`（JS 按 0~5 算百分比）画「已填充/未填充」两段；
滑块头 15px 白圆＋主轴色描边；`input[type=range]` 单独洗掉全局 `input` 的白底/内边距（否则深色底上会露出一个方框）。

## 验收读数

- 全量 `zsh -lic 'node --test tests/*.test.js'` **386 passed / 0 fail**（P10 基线 379 ⇒ +7，全是新 `tests/rating-slider.test.js`）。
- 活体（真预览 8787、真数据：杭州本视野 14830 条）：

| 操作 | 徽标 | 滑块 | 填充 | 合条件条数 |
| --- | --- | --- | --- | --- |
| 默认 | ≥ 4.0 | 4 | 80% | **7,987** |
| 按住拖到中间（未松手） | ≥ 2.5 | 2.5 | 50% | 7,987（**还没重算**，这正是「跟手但不一步一重建」） |
| 松手后 | ≥ 1.0 | 1 | 20% | **13,267** |
| 拉到 0 | 不限 | 0 | 0% | **14,830**（全量） |
| 拉到 5 | ★ 满分 | 5 | 100% | **53** |
| 键盘 ← 一下 | ≥ 3.5 | 3.5 | 70% | **10,745** |

  0 console error；`#rating-chips`/`.rating-chip` 在页面上已不存在。截图 `artifacts/travel/2026-11-09-p10/`（R1 默认 / R2 拖动中跟手 / R3 松手后 / R4 满分）。

## 没做的

- 没给滑块加刻度数字（0~5 十档全标会糊；当前值徽标已经写清「≥ 4.0」，两端有「不限/满分」，需要精确回默认有「回到默认」按钮）。
