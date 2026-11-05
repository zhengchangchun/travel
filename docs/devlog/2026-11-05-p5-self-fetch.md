# devlog 2026-11-05 · P5 笔记/视频「自己抓」

## 触发

用户：「不要复制粘贴 要自己抓取」——P4 已把**粘贴**那条路做顺，这次要把**抓**这条做出来。

## 先摸底（真链接真跑，结论留档）

| 路子 | 结果 |
|---|---|
| Node `curl` 直连 | 小红书 `/explore` 302；抖音 `iesdouyin` 分享页给的是空壳（`_ROUTER_DATA` 只有 1.4KB 壳）；B站 api 412；快手 97KB 但无 `__APOLLO_STATE__`；微博 302 |
| 抖音 `aweme/detail` 直连 | 403（要 `a_bogus`/`X-Bogus` 签名） |
| B站 api + `Referer` + `buvid3` | **200 + 完整 JSON** ⇒ B站不用浏览器 |
| 本机 Playwright + `--profile xhs` 打开搜索页 | **200**，并且它自己的 `api/sns/web/v2/search/notes` 返回 200 ⇒ 拦响应即可拿列表 |
| 小红书带 token 的笔记页 | **200**，`__INITIAL_STATE__.note.noteDetailMap` 有正文/图/标签 |
| 本机 Playwright + `--profile douyin` 打开视频页 | **200**，`aweme/v1/web/aweme/detail/` 200 ⇒ 拦响应拿 `aweme_detail` |
| 小红书在页面里手调 `h5/v1/note_info`、`web/v1/feed` | **406**（要 `x-s` 签名）⇒ **不要在页面里自己发请求，让页面发** |
| 快手搜索页 | `{"result":2}` 风控（profile 未登录） |

⇒ 定架构：**浏览器里让页面自己加载，我们只拦它自己的响应**。

## 落地

1. `tools/note-fetch.cjs`（仓内，跑在 pw.cjs 里）：`search` / `url` 两模式，stdout 一行 JSON；
   每次 `page.goto` 60s 超时 + 失败重试一次；失败形状统一（`NEED_LOGIN`/`NO_DATA`/`TIMEOUT`…）。
2. `server/note-fetch.js`：拼命令（`/opt/homebrew/bin/node <pw.cjs> run <script> …`，不进登录 shell）、
   解析最后一行 JSON、`fetchNote`（B站走官方接口）、`searchNotes`、失败重试一次、`createApp({noteFetch})` 可注入。
3. 路由：`/api/notes/fetch`（预览/落库/同链接更新）、`/api/notes/discover`（搜一批，封面也落本地，标 `exists`）、
   `/api/notes/:id/refresh`（重抓）。
4. 页面：抓取框 + 搜笔记框 + 候选列表 + 详情「重抓」；手动贴正文降级进 `<details>`。

## 踩到的坑

- **`pw.cjs run` 的位置参数在 `args._` 里**（`_[0]='run'`、`_[1]=script`、`_[2]=mode`…），不是 `args[0]`。
- **抖音分享页的 SSR 数据已被拿掉**（`_ROUTER_DATA` 只剩 1.4KB 壳）⇒ 别指望免登 SSR，必须带登录态浏览器。
- **在页面里自己 fetch 平台接口会 406**（签名是页面 JS 现算的）⇒ 只能拦页面自己发出的请求。
- **候选列表直连平台 CDN 的封面会 403** ⇒ 搜出来就把封面下到本地再给前端。
- **同一个浏览器 profile 被别的进程占着时，第一次 `goto` 会 30–60s 超时**（本机曾同时有 music 任务在跑 `--profile douyin`）⇒ 加超时 + 重试一次。
- 抖音 `desc` 里常混着它自己的分享串（`复制此链接，打开抖音搜索…`）⇒ 落库前过 `tidyText`。
- 地名抽取又修了两处：`行`（本意是银行/车行）会把「步行」当地名 ⇒ 换成 `银行`；再补一批文风噪声词（朋友/爱喝/一起/步行/地铁…）。
  剩下的噪声由「地名可编辑 + 高德补全会筛掉查不到的」兜住。

## 读数

- 全量单测 **323 passed / 0 fail**（P4 基线 311）。
- 真机：搜「杭州咖啡」12 条候选（0 个 403）；存一条 = 完整正文（6 家店名+地址）+ 6 张图；抖音链接抓成图文；
  刷新后全从本地读；抓取零 token、每次 10–25 秒。
