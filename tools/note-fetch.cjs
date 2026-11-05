/* 笔记抓取器（跑在本机 Playwright + 各平台已登录 profile 上）
 *
 * 为什么这样抓：平台网页的接口都带签名（抖音 a_bogus、小红书 x-s），Node 直接请求拿不到；
 * 但浏览器里由平台自己的 JS 发请求就一切正常 ⇒ 我们只做两件事：
 *   ① 让页面自己去加载（搜索页 / 笔记页）
 *   ② 拦它自己的接口响应（或读它挂在 window 上的状态）再归一化
 * 进程内零依赖：本文件由 ~/.nanobot/workspace/tools/browser/pw.cjs 加载运行。
 *
 * 用法（pw.cjs run 后面都是位置参数）：
 *   <mode=search> <platform> <keyword> <limit>
 *   <mode=url>    <platform> <url>
 * 输出：一行 JSON 到 stdout。
 */
const PLATFORMS = {
  xhs: { profile: 'xhs', source: '小红书', source_type: 'xhs' },
  douyin: { profile: 'douyin', source: '抖音', source_type: 'douyin' },
  kuaishou: { profile: 'kuaishou', source: '快手', source_type: 'kuaishou' },
  bilibili: { profile: null, source: 'B站', source_type: 'bilibili' },
};

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

// 打开页面：给足超时，失败重试一次（同一 profile 被别的进程占着时会瞬挂）
async function open(page, url, waitMs) {
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  let lastErr = null;
  for (let i = 0; i < 2; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(waitMs || 3000);
      return null;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(1500);
    }
  }
  return lastErr;
}
function fail(code, msg, extra) {
  return Object.assign({ ok: false, error: code, message: msg }, extra || {});
}

function pick(list, keys) {
  for (const k of keys) {
    const v = list && list[k];
    if (v) return v;
  }
  return '';
}

// ---------- 小红书 ----------
// 搜索：拦 api/sns/web/v2/search/notes（页面自己签字；我们拿 id/标题/作者/封面/token）
async function xhsSearch({ page, keyword, limit }) {
  const got = [];
  page.on('response', async (r) => {
    if (/api\/sns\/web\/v\d\/search\/notes/.test(r.url())) {
      try {
        got.push(await r.json());
      } catch (e) {
        /* 跳过非 JSON */
      }
    }
  });
  const navErr = await open(
    page,
    'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword),
    0
  );
  const deadline = Date.now() + 30000;
  while (!got.length && Date.now() < deadline) await page.waitForTimeout(800);
  if (!got.length) {
    return fail(
      'NO_DATA',
      '小红书搜索没返回数据' +
        (navErr
          ? '（页面打不开：' + String(navErr.message).split('\n')[0] + '）'
          : '（可能需要重新扫码登录）'),
      { platform: 'xhs' }
    );
  }
  const items = [];
  got.forEach((j) => {
    ((j.data && j.data.items) || []).forEach((it) => {
      const card = it.note_card || {};
      const id = it.id;
      if (!id) return;
      const token = it.xsec_token || card.xsec_token || '';
      items.push({
        platform: 'xhs',
        id,
        url:
          'https://www.xiaohongshu.com/explore/' +
          id +
          (token ? '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_search' : ''),
        title: card.display_title || it.display_title || '',
        author: (card.user && card.user.nickname) || '',
        cover_url: (card.cover && pick(card.cover, ['url_default', 'url_pre', 'url'])) || '',
        kind: card.type === 'video' ? 'video' : 'note',
        liked: (card.interact_info && card.interact_info.liked_count) || '',
      });
    });
  });
  const seen = new Set();
  const uniq = items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
  return ok({ platform: 'xhs', mode: 'search', keyword, count: uniq.length, items: uniq.slice(0, limit) });
}

// 详情：读 window.__INITIAL_STATE__.note.noteDetailMap
async function xhsNote({ page, url }) {
  await open(page, url, 6000);
  const data = await page.evaluate(() => {
    const st = window.__INITIAL_STATE__ || {};
    const map = (st.note && st.note.noteDetailMap) || {};
    const key = Object.keys(map)[0];
    return key ? map[key].note : null;
  });
  if (!data) {
    return fail('NO_NOTE', '小红书笔记没读到（链接可能失效，或需要重新扫码登录）', { platform: 'xhs', url });
  }
  const images = (data.imageList || [])
    .map((i) => pick(i, ['urlDefault', 'urlPre', 'url']))
    .filter(Boolean);
  return ok({
    platform: 'xhs',
    mode: 'url',
    url: page.url(),
    id: data.noteId || '',
    kind: data.type === 'video' ? 'video' : 'note',
    title: data.title || '',
    content: data.desc || '',
    author: (data.user && data.user.nickname) || '',
    cover_url: images[0] || '',
    image_urls: images,
    video_url: data.video ? 'https://www.xiaohongshu.com' + (page.url().split('?')[0] || '') : '',
    tags: (data.tagList || []).map((t) => t.name).filter(Boolean),
    stats: {
      liked: (data.interactInfo && data.interactInfo.likedCount) || '',
      collected: (data.interactInfo && data.interactInfo.collectedCount) || '',
      comment: (data.interactInfo && data.interactInfo.commentCount) || '',
    },
  });
}

// ---------- 抖音 ----------
// 拦 aweme/v1/web/aweme/detail/（页面自己签字）
async function douyinNote({ page, url }) {
  const got = [];
  page.on('response', async (r) => {
    if (/aweme\/v1\/web\/aweme\/detail\//.test(r.url())) {
      try {
        got.push(await r.json());
      } catch (e) {
        /* 跳过 */
      }
    }
  });
  page.setDefaultNavigationTimeout(60000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + 30000;
  while (!got.length && Date.now() < deadline) await page.waitForTimeout(800);
  const detail = got.map((j) => j.aweme_detail).filter(Boolean)[0];
  if (!detail) {
    return fail('NO_DATA', '抖音没返回视频数据（可能需要重新扫码登录）', { platform: 'douyin', url });
  }
  const cover = ((detail.video && detail.video.cover) || detail.video && detail.video.origin_cover || {}).url_list || [];
  const images = (detail.images || []).map((im) => ((im.url_list || [])[0] || '')).filter(Boolean);
  const isAlbum = detail.aweme_type === 68 || detail.aweme_type === '68';
  // 抖音的文案里常带着它自己的分享链接，标题里去掉
  const desc = String(detail.desc || '');
  const cleanTitle = desc.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return ok({
    platform: 'douyin',
    mode: 'url',
    url: page.url(),
    id: detail.aweme_id || '',
    kind: isAlbum || (images.length && !detail.video) ? 'note' : 'video',
    title: cleanTitle || ((detail.author && detail.author.nickname) || '抖音') + ' 的视频',
    content: desc,
    author: (detail.author && detail.author.nickname) || '',
    cover_url: cover[0] || images[0] || '',
    image_urls: images,
    video_url: url,
    tags: (detail.text_extra || []).map((t) => (t.hashtag_name || '').trim()).filter(Boolean),
    stats: {
      liked: (detail.statistics && detail.statistics.digg_count) || '',
      comment: (detail.statistics && detail.statistics.comment_count) || '',
      share: (detail.statistics && detail.statistics.share_count) || '',
    },
  });
}

// ---------- 抖音搜索：试一次，把风控原因说清楚 ----------
async function douyinSearch({ page, keyword }) {
  const err = await open(page, 'https://www.douyin.com/search/' + encodeURIComponent(keyword) + '?type=general', 8000);
  const info = await page.evaluate(() => ({
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 200),
  }));
  if (/验证码|滑块|安全验证/.test(info.title + info.text)) {
    return fail('NEED_CAPTCHA', '抖音搜索页弹验证码中间页（风控）⇒ 抖音只能给链接抓单条，不能按关键词搜', {
      platform: 'douyin',
    });
  }
  if (err) return fail('NO_DATA', '抖音搜索页打不开：' + String(err.message).split('\n')[0], { platform: 'douyin' });
  return fail('NOT_IMPLEMENTED', '抖音搜索接口还没接（页面可打开，但列表接口没拦到）', { platform: 'douyin' });
}

// ---------- 快手（网页端要登录，未登录时如实报） ----------
async function kuaishouNote({ page, url }) {
  await open(page, url, 6000);
  const blocked = await page.evaluate(() =>
    /result":2|请登录|扫码登录|登录快手/.test(document.body ? document.body.innerText.slice(0, 400) : '')
  );
  const state = await page.evaluate(() => {
    const st = window.__APOLLO_STATE__ || window.__INITIAL_STATE__ || null;
    return st ? Object.keys(st).slice(0, 5) : null;
  });
  if (blocked || !state) {
    return fail('NEED_LOGIN', '快手网页端未登录（result=2 风控）⇒ 需要先在本机扫码登录一次', {
      platform: 'kuaishou',
      url,
    });
  }
  return fail('NOT_IMPLEMENTED', '快手登录后的解析还没实现（先跑通小红书/抖音）', { platform: 'kuaishou' });
}

module.exports = async ({ page, context, args }) => {
  // 抓取也走「别像机器人」的常规处理（网页端风控会看这些指纹）
  try {
    if (context && context.addInitScript) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
        window.chrome = window.chrome || { runtime: {} };
      });
    }
  } catch (e) {
    /* 忽略 */
  }
  const rest = ((args && args._) || []).slice(2); // ['run', '<script>', mode, a, b...]
  const [mode, platform, a, b] = rest;
  const def = PLATFORMS[platform];
  let result;
  try {
    if (!def) {
      result = fail('BAD_PLATFORM', '不支持的平台: ' + platform, { platform });
    } else if (mode === 'search' && platform === 'xhs') {
      result = await xhsSearch({ page, keyword: a, limit: Number(b) || 12 });
    } else if (mode === 'search' && platform === 'douyin') {
      result = await douyinSearch({ page, keyword: a });
    } else if (mode === 'search') {
      result = fail('NOT_IMPLEMENTED', '该平台的「按关键词搜」还没实现（可用链接抓取）', { platform });
    } else if (mode === 'url' && platform === 'xhs') {
      result = await xhsNote({ page, url: a });
    } else if (mode === 'url' && platform === 'douyin') {
      result = await douyinNote({ page, url: a });
    } else if (mode === 'url' && platform === 'kuaishou') {
      result = await kuaishouNote({ page, url: a });
    } else {
      result = fail('NOT_IMPLEMENTED', '这一组合还没实现: ' + mode + '/' + platform, { platform });
    }
  } catch (err) {
    result = fail('FETCH_FAIL', String((err && err.message) || err), { platform });
  }
  console.log(JSON.stringify(result));
};
