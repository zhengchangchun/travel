# 旅迹（travel）

> 2026-11-09 改名：原名「城市旅行规划器」；仓库目录与项目别名仍是 `travel`。

选一座城 → 看这座城的推荐地点 → 按分类筛 → 落到地图上（不同类型不同小旗）→ 存成自己的行程。

## 目录

```
travel/
├── README.md                 本文件
├── docs/
│   ├── plans/                需求与设计（先看这个）
│   └── tasks/                任务书（派站用）
├── prototype/                交互原型（静态单页，仅作形态参考，不是最终实现）
├── server/                   后端（Node.js 零依赖）
├── web/                      前端（原生 HTML/CSS/JS + 高德 JS API）
├── scripts/                  启动 / 自测脚本
└── data/                     SQLite 数据库（gitignore）
```

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js **零 npm 依赖**（`node:http` + `node:sqlite`） | 本机 Node v25.8.0，内置模块够用，不引入 `node_modules` |
| 前端 | 原生 HTML/CSS/JS + **高德地图 JS API 2.0**（CDN） | 无构建步骤，双击/直连都行 |
| 数据库 | SQLite（`data/travel.db`，`node:sqlite`） | 存行程与已选点 |
| 数据源 | 高德开放平台（POI 搜索 / 行政区划 / 逆地理编码） | 免费额度；小红书/抖音**只做跳转**，不抓取 |

## 快速开始

```bash
cp config/example.json config/local.json   # 填入高德 key
node server/index.js                        # 起服务（默认 http://127.0.0.1:8787）
```

## 计分口径（为什么这么设计）

- **能落旗、能过滤的，是高德 POI 的结构化数据**（名称/地址/坐标/分类/评分/人均/图片）—— 免费、稳定、合法。
- **小红书/抖音的笔记**没有可用的官方接口，自动化抓取被风控挡（实测：小红书 `300012 IP存在风险`、抖音滑块验证），
  且平台禁止外部网页内嵌（抖音 `X-Frame-Options: DENY`）。⇒ 只做「点按钮跳过去看」+「手动贴链接入库」。

## 文档

- 需求与设计：`docs/plans/2026-10-29-城市旅行规划器-需求与设计.md`
- 任务书：`docs/tasks/`
