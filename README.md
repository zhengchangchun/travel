# 旅迹（travel）

> 2026-11-09 改名：原名「城市旅行规划器」；仓库目录与项目别名仍是 `travel`。
> 2026-11-19 起它不只是一个规划页：多了一个**首页**（对外门面 + 推荐）、**账号登录**、**我的行程**、**旅游搭子**、**分享列表**、**个人设置**。

一句话：把刷到的笔记变成能走的行程 —— 按笔记找地方 → 地图上挑点看实时耗时 → 自动按里程排成不折返的路线（可按天分段）→ 生成能发给别人的网页。

## 目录

```
travel/
├── README.md                 本文件
├── config/                   分类、精选库（推荐地区/路线/坐标/实景图索引）；local.json 放高德 key（gitignore）
├── docs/
│   ├── plans/                需求与设计（先看这个）
│   ├── devlog/               每批改动的记录
│   └── tasks/                任务书（派站用）
├── prototype/                交互原型（静态单页，仅作形态参考，不是最终实现）
├── server/                   后端（Node.js 零依赖）
│   ├── index.js              静态页 + API 路由入口
│   ├── auth.js               账号与会话（scrypt 口令、sha256 会话令牌）
│   ├── backup.js             一键备份（自己写的 zip + VACUUM INTO 快照）
│   ├── featured.js           推荐地区/路程；featured-photos.js 实景图；home-img.js 静态地图封面
│   └── routes/               各接口：auth / home / trips / selection / shares / legacy / backup / notes / route / pois / poi / city
├── web/                      前端（原生 HTML/CSS/JS + 高德 JS API）
│   ├── home.html             首页（`/`）
│   ├── index.html            规划页（`/app`）
│   ├── login|trips|shares|settings.html
│   ├── css/{style,site}.css  style=规划页；site=站点页（带 body.site 前缀，避免同名类互撞）
│   └── js/                   页面脚本 + headbar.js（通栏头部，所有页面共用）
├── scripts/                  启动/自测/维护脚本（geo-featured.cjs、fetch-featured-photos.cjs）
└── data/                     SQLite 数据库 + 各类缓存（gitignore）
```

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js **零 npm 依赖**（`node:http` + `node:sqlite` + `node:zlib`） | 本机 Node v25.8.0；连 zip 都是自己写的 |
| 前端 | 原生 HTML/CSS/JS + **高德地图 JS API 2.0**（CDN） | 无构建步骤 |
| 数据库 | SQLite（`data/travel.db`） | 账号、会话、行程、点位、笔记、分享记录、已收录地点 |
| 数据源 | 高德开放平台（POI / 行政区划 / 逆地理 / 路径规划 / 静态地图） | 免费额度；`place/*` 月度额度用尽时降级到本地库 + OSM |
| 实景图 | 中文维基百科 / Wikimedia Commons | 只取自由许可（CC0 / CC BY / CC BY-SA / PD），出处与许可记在 `config/featured-photos.json` |

## 快速开始

```bash
cp config/example.json config/local.json   # 填入高德 key
node server/index.js                        # 起服务（默认 http://127.0.0.1:8787）
```

打开 `http://127.0.0.1:8787`：首页 → 点「登录 / 注册」建账号 → 「我的行程」里点「认领到我的账号」（把账号体系上线前的行程/分享/笔记收回来）→「开始规划」。

## 页面与接口

| 页面 | 路径 | 要登录 | 说明 |
|---|---|---|---|
| 首页 | `/` | 否 | 主视觉 + 推荐地区 + 推荐路程（只浏览）+ 能力卡；当前地区按浏览器定位→高德反查→IP→默认 |
| 规划页 | `/app` | **是** | 挑点 / 实时耗时 / 自动成线 / 按天分段 / 分享；`?city=` 或 `?trip=` 可直接打开 |
| 我的行程 | `/trips` | **是** | 一城多趟（每趟一个主题）；新建 / 改名 / 改主题 / 挑同行搭子 / 删除 / 去规划 |
| 旅游搭子 | `/buddies` | **是** | 常一起出门的人：名字 / 关系 / 标签 / 联系方式 / 备注；带「一起走过 N 趟」 |
| 分享列表 | `/shares` | **是** | 每次分享一条；网页版 `/share/<file>.html` 直接能开，可复制文字 / 发 Finder / 删除 |
| 个人设置 | `/settings` | **是** | 昵称头像、默认城市与出行方式、一键备份 |
| 登录 | `/login` | — | 账号 + 密码；`?next=` 登录后回原页 |

接口一律 `/api/*`，响应 `{ok, data, error}`；个人数据要会话，未登录 `401 AUTH_REQUIRED`，别人的资源 `404`。

## 账号与数据隔离

- 口令 **scrypt**（每用户 16 字节盐），库里不存明文；会话令牌是 32 字节随机串，**库里只存它的 sha256**，浏览器侧是 HttpOnly Cookie。
- 行程 / 点位 / 笔记 / 分享都带 `user_id`，查询全部按会话用户过滤；同城多趟互不干扰，同一个点两个人各自加是两条。
- 账号体系上线前的行 `user_id` 为空，**谁都看不到**；`GET /api/legacy/pending` 报数量、`POST /api/legacy/claim` 一次性归给当前账号（行程 / 分享 / 笔记三样都算）。

## 备份

设置页点「立即备份」→ `data/backups/travel-backup-YYYYMMDD-HHMMSS.zip`：数据库（`VACUUM INTO` 一致性快照）+ `share/` + 实景图 + 首页封面 + 说明文件。恢复步骤在包里的 `README.txt`。
⚠️ macOS 请双击解压（或 `ditto -x -k`）；老的 `unzip` 命令行不认 UTF-8 文件名。

## 推荐内容的真源（都是文件，可手改）

| 文件 | 内容 |
|---|---|
| `config/featured.json` | 推荐地区（城市 + 一句话 + 标签）与推荐路程（主题 / 天数 / 每站名称与要点） |
| `config/featured-geo.json` | 上面那些站点的坐标（`scripts/geo-featured.cjs` 用高德正地理编码生成；只服务端用） |
| `config/featured-photos.json` | 实景图索引（文件、作者、许可、原页面；`scripts/fetch-featured-photos.cjs` 生成） |
| `config/categories.json` | 分类（美食 / 住宿 / 景点 / 游玩）与颜色 |

## 计分口径（为什么这么设计）

- **能落旗、能过滤的，是高德 POI 的结构化数据**（名称/地址/坐标/分类/评分/人均/图片）—— 免费、稳定、合法。
- **小红书/抖音的笔记**没有可用的官方接口，自动化抓取被风控挡（实测：小红书 `300012 IP存在风险`、抖音滑块验证），
  且平台禁止外部网页内嵌（抖音 `X-Frame-Options: DENY`）⇒ 只做「点按钮跳过去看」+「手动贴链接入库」；「自己抓」走本机已登录浏览器 profile。

## 文档

- 需求与设计：`docs/plans/2026-10-29-城市旅行规划器-需求与设计.md`
- 站点层与账号：`docs/devlog/2026-11-19-site-layer.md`
- 其它改动记录：`docs/devlog/`
- 任务书：`docs/tasks/`
