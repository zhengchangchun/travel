# devlog 2026-11-09 · 信息卡里那坨黑色色块＝来源徽标被拉变形

## 现象

用户截了信息卡图集：照片左侧有一整块半透明黑色圆角矩形（高约 200px），问「这个红色框住的黑色框是什么」。
里面顶着「用户实拍 · 来源：高德」。

## 真因

那元素是 `.badge-comment`（图集的来源徽标），两条规则同时命中了它：

```css
.badge-comment { position: absolute; left: 8px; top: 8px; ... }         /* 老的基础规则 */
.infocard .badge-comment { position: absolute; left: 8px; bottom: 8px; ... }  /* 信息卡里贴左下 */
```

`top` 与 `bottom` 同时存在、`height: auto` ⇒ 弹性拉伸到容器高度减上下各 8px，
221px 高的图集里就成了 **130×205 的半透明黑块**（实测 rect `[949,33,130,205]`）。

## 修法

在 `.infocard .badge-comment` 里加 **`top: auto`**（基础规则不动，别的地方还用得上），并写了注释说明为什么。
修后实测 rect `[949,216,130,22]` —— 正常的胶囊，贴图集左下，跟右下角的 `1 / 3` 对称。

## 守卫

`tests/infocard-badge.test.js`：
- 断言 `.infocard .badge-comment` 里必须出现 `top: auto`（否则 top+bottom 会拉满）；
- 断言徽标文案仍是「来源标签 · 来源：平台」。

## 验收

真预览：截图 `artifacts/travel/2026-11-09-p11/I1-infocard.png`（黑块消失）；0 console error；全量 **397 passed / 0 fail**。
