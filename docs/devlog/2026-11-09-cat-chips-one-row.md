# devlog 2026-11-09 · 分类 chip 固定一行

## 触发

用户贴了一张侧栏截图（5 个分类 chip 折成两行：第一行 全部/美食/住宿、第二行 景点/游玩）＋一句
「4 个下拉菜单显示在一个行号」⇒ 意思是要**一行放得下**。提交 `f9faffb`。

## 改法

- `.chips` 容器对 `#chips` 改成 `flex-wrap: nowrap`：**绝不折成第二行**。
- chip 收紧：`padding 5px 7px`、`font-size 12px`、点 7px、间距 4px（原 `5px 12px`/13px/9px/6px）。
- 标签包一层 `<span class="chip-label">`（`ui.js::renderChips`）：窄了先按 `flex: 0 1 auto` 缩，
  真挤不下才 `text-overflow: ellipsis` 省略 —— 以前标签是裸文本节点，想截断都截不了。
- 只作用于 `#chips`（分类），不动「只看我选中的」那个 `.chip.toggle`。

## 验收读数（真预览 8787）

| 场景 | 行数 | 每个 chip 宽 | 容器高 / chip 高 | 溢出 |
| --- | --- | --- | --- | --- |
| 宽屏（侧栏 340px） | **1** | 51px × 5 | 29 / 29 | 0 |
| 窄屏（1000px 宽） | **1** | 51px × 5 | 29 / 29 | 0 |
| 选中「美食」态 | **1** | 51px × 5 | 29 / 29 | 0 |

容器高 == 单个 chip 高 ⇒ 就是一行（并且 340px 侧栏里 275px < 282px 可用宽，**没有触发压缩**）。0 console error；
截图 `artifacts/travel/2026-11-09-p10/`（C1 宽屏 / C2 窄屏 / C3 选中态）。全量测试 **387 passed / 0 fail**（+1）。
