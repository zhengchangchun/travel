# devlog 2026-11-09 · 解释性文字收进「i」气泡

## 触发

用户贴了分类卡那片截图（「默认不选；选中哪个分类就只显示哪个分类；勾「全部」显示所有分类」常驻一行）：
「这种解释说明的都可以使用 tip 这会总显示 没必要直接放在页面上」。
提交 `b69ca31`（并在项目卡里立了「待优化清单」，用户要求每次提的意见都记下来）。

## 改法

常驻说明段 → 悬停/键盘聚焦才展开的气泡：

| 卡片 | 原常驻文案（`<p class="hint">`） | 现在挂在 |
| --- | --- | --- |
| 城市 | 打字即出建议 · ↑↓ 选、回车确认 | 城市标题条的 i |
| 筛选 · 结果 | 默认不选；选中哪个分类就只显示哪个分类；勾「全部」显示所有分类 | 筛选标题条的 i |
| 筛选 · 结果 | 拖动滑块调最低分：0 = 不限，5 = 只留满分 | 「评分过滤」行右端 i |
| 住宿锚点 | 先定住宿，再看它周边的美食与景点（一次查询 ≤4 次调用，其余走缓存） | 锚点标题条的 i |
| 笔记 → 找地方 | 粘链接（…）或整段分享文案，本机自己抓（用已登录的浏览器 profile） | 笔记标题条的 i |

- 说明点＝`<span class="tip" data-tip="…" tabindex="0" aria-label="用法说明">i</span>`；气泡是纯 CSS（`::after` + `content: attr(data-tip)`），
  鼠标悬停与键盘 `:focus-visible` 都出，默认 `opacity:0/visibility:hidden` —— 一点 JS 都不用于渲染。
- 标题条右侧改成一组 `.bar-right`（当前城市 / 本地 N ／ i ／ 折叠箭头），保证 **i 紧挨箭头**且原有右对齐不回退
  （改前 `.bar-note` 与 `.chev` 各占一个 `margin-left:auto`，插一个元素进去会把信息挤到中间）。
- 标题条本身是「点一下折叠」的按钮 ⇒ 新增 `bindTips()`：对 `.tip` 的 `click`/`mousedown`/`keydown` 一律 `stopPropagation`，
  点说明点不会顺手把卡片收起来（实测点前后都是 `card collapsed`）。

## 没搬的（并加了守卫）

「状态」和「当下必须看见」的文案留着：地图状态栏、空态引导与 CTA「显示全部」、倍率不够的提示、结果汇总、
笔记长任务的进度行与「取消」按钮、信息卡里「怎么关」那一行（只在卡片打开时出现，不是常驻说明）。
`tests/hints-as-tips.test.js` 里专门有一条守卫这些不许跟着一起被搬走。

## 验收读数（真预览 8787）

- 页面正文里 5 段说明文字**全部消失**（`innerText` 检测 0 命中）；`.tip` 数量 = 5。
- 五个标题条的右侧顺序实测：city `[bar-note, tip, chev]`、filter `[tip, chev]`、base/note `[bar-note, tip, chev]`、search `[chev]`。
- 气泡：悬停前 `opacity:0/visibility:hidden`，悬停后 `opacity:1/visibility:visible`；Tab 走到 i 上同样出气泡。
- 点 i：卡片折叠状态不变（`card collapsed` → `card collapsed`）。0 console error。
- 全量测试 **390 passed / 0 fail**（+3，新 `tests/hints-as-tips.test.js`）。
- 截图 `artifacts/travel/2026-11-09-p10/`（T1 悬停出气泡 / T2 键盘聚焦 / T3 页面不再常驻说明）。
