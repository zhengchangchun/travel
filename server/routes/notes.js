// 笔记：本地缓存 + 按来源区分 + 本地搜索 + 从正文提取地名→高德补全（「按笔记搜地方」）
// 口径：内容由用户提供（分享文案/链接/正文/图 URL），平台侧抓取在本机被风控
// （抖音验证码页、小红书 300012 IP 风险、B站风控页、微博 302 访客登）⇒ 这里只做「落库/落图/本地读/补全」。
const path = require('node:path');
const { downloadImages, refererForPlatform } = require('../note-images');
const { matchesName } = require('../geocode-osm');

// 同一个地名可能在两个源上都失败：错因合并成一条，别在界面上重复报同一个名字
function pushErr(errors, name, msg) {
  const hit = errors.find((e) => e.name === name);
  if (hit) {
    if (!hit.msg.includes(msg)) hit.msg = hit.msg + ' / ' + msg;
    return;
  }
  errors.push({ name, msg });
}
const {
  parseShareText,
  extractPlaceNames,
  cleanContent,
  tidyText,
  nameOfType,
  kindOfType,
} = require('../note-share');

const ROOT = path.join(__dirname, '..', '..');
// 可用环境变量重定向（测试隔离用），默认 data/notes-img
const NOTE_IMG_DIR = process.env.TRAVEL_NOTE_IMG_DIR || path.join(ROOT, 'data', 'notes-img');

// 一次最多给几个地名打高德（配额按次算，逐名 1 次）
const NOTE_PLACE_MAX = 8;

function parseJsonList(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (err) {
    return [];
  }
}

// 库里存的是本地文件名；对外统一暴露成可访问 URL
function toPublic(note) {
  if (!note) return note;
  const imgs = parseJsonList(note.images);
  return Object.assign({}, note, {
    images: imgs.map((f) => '/notes-img/' + f),
    cover_url: note.cover ? '/notes-img/' + note.cover : null,
    tags: parseJsonList(note.tags),
    kind: note.kind || 'note',
  });
}

function findNote(db, id) {
  return db.listNotes().find((n) => n.id === id) || null;
}

// 每条笔记的地点条数（列表角标用；一次 GROUP BY，不逐条查）
function placeCounts(db) {
  const map = new Map();
  try {
    db.raw
      .prepare('SELECT note_id, COUNT(*) AS n FROM note_places GROUP BY note_id')
      .all()
      .forEach((r) => map.set(r.note_id, r.n));
  } catch (err) {
    return map;
  }
  return map;
}

function withCounts(db, notes) {
  const counts = placeCounts(db);
  return notes.map((n) => Object.assign(toPublic(n), { place_count: counts.get(n.id) || 0 }));
}

// 高德补全：一条地名 → 一个 POI（1 次调用）。挑「名字最贴」的一条，其次评分高的
function pickBest(name, list) {
  if (!list || !list.length) return null;
  const key = String(name).toLowerCase();
  const exact = list.find((p) => String(p.name || '').toLowerCase() === key);
  if (exact) return exact;
  const contain = list.filter(
    (p) => p.name && (String(p.name).includes(name) || name.includes(String(p.name)))
  );
  const pool = contain.length ? contain : list;
  return pool
    .slice()
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0))[0];
}

// 抓回来的东西落成一个笔记（先落图再入库）：抓取遇到配额/风控时如实报错，不造数据
async function ingestFetched(ctx, r, opts = {}) {
  const sourceType = r.platform || 'other';
  const referer = refererForPlatform(sourceType);
  const imageUrls = Array.isArray(r.image_urls) ? r.image_urls : [];
  const downloaded = imageUrls.length
    ? await downloadImages(imageUrls, NOTE_IMG_DIR, { referer })
    : [];
  const files = downloaded.filter((d) => d.ok).map((d) => d.file);
  let coverFile = null;
  let coverErr = null;
  if (r.cover_url) {
    const got = await downloadImages([String(r.cover_url)], NOTE_IMG_DIR, { referer });
    if (got[0] && got[0].ok) coverFile = got[0].file;
    else coverErr = got[0] ? got[0].error : '封面下载失败';
  }
  const download = {
    requested: imageUrls.length,
    saved: files.length,
    failed: downloaded.filter((d) => !d.ok).map((d) => ({ url: d.url, error: d.error })),
    cover: coverFile ? { saved: true, file: coverFile } : coverErr ? { saved: false, error: coverErr } : null,
  };
  // 抓回来的文案先洗一遍：抖音的 desc 里常混着它自己那串分享话术
  const sourceName = nameOfType(sourceType);
  const tidyTitle = tidyText(r.title, 80) || sourceName + (r.kind === 'video' ? ' 视频' : ' 笔记');
  const payload = {
    city: opts.city || null,
    url: r.url || '',
    title: tidyTitle,
    source: nameOfType(sourceType),
    source_type: sourceType,
    kind: r.kind || kindOfType(sourceType),
    author: r.author || '',
    content: tidyText(r.content),
    cover: coverFile || files[0] || null,
    images: files,
    tags: Array.isArray(r.tags) ? r.tags : [],
    video_url: r.video_url || '',
    share_text: '',
    fetched_at: new Date().toISOString(),
  };
  if (!opts.save) {
    // 只预览：图已经落到本地缓存（按 URL 幂等），库里不写
    const preview = Object.assign({}, payload, {
      id: null,
      images: JSON.stringify(files),
      tags: JSON.stringify(payload.tags || []),
    });
    return { note: toPublic(preview), preview: true, download, saved: false, updated: false, stats: r.stats || null };
  }
  const existing = ctx.db.findNoteByUrl(payload.url);
  let note;
  let updated = false;
  if (existing) {
    ctx.db.setNoteIdent(existing.id, {
      title: payload.title,
      source: payload.source,
      source_type: payload.source_type,
      kind: payload.kind,
      url: payload.url,
      video_url: payload.video_url,
      share_text: payload.share_text,
    });
    note = ctx.db.setNotePayload(existing.id, {
      author: payload.author,
      content: payload.content,
      cover: payload.cover,
      images: files,
      tags: payload.tags,
    });
    updated = true;
  } else {
    note = ctx.db.addNoteFull(payload);
  }
  return { note: toPublic(note), download, saved: true, updated, stats: r.stats || null };
}

module.exports = [
  // 分享文案解析（纯解析、零调用、不落库）——页面「识别」按钮走这条
  {
    method: 'POST',
    path: '/api/notes/parse',
    handler(ctx) {
      const b = ctx.body || {};
      const text = String(b.text || '').trim();
      if (!text) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 text');
      const parsed = parseShareText(text);
      // 地名要从「真正文」里抠：分享文案里的引导语会污染候选
      const content = b.content != null ? String(b.content) : cleanContent(text, parsed);
      const names = extractPlaceNames({ title: parsed.title, content }, {
        limit: NOTE_PLACE_MAX,
      });
      return Object.assign(parsed, {
        names,
        // 给页面一个「可编辑的正文」初值：原文去掉链接/引导语/标题
        content_guess: text.replace(parsed.url, '').trim(),
        content_clean: content,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/notes',
    handler(ctx) {
      const city = ctx.query.city ? String(ctx.query.city).trim() : '';
      return withCounts(ctx.db, ctx.db.listNotes(city || undefined));
    },
  },
  // 本地搜索（注册在 /api/notes/:id 之前，否则会被 :id 抢）
  {
    method: 'GET',
    path: '/api/notes/search',
    handler(ctx) {
      const q = ctx.query.q ? String(ctx.query.q).trim() : '';
      const source = ctx.query.source ? String(ctx.query.source).trim() : '';
      const city = ctx.query.city ? String(ctx.query.city).trim() : '';
      const limit = Number(ctx.query.limit) || 200;
      const items = withCounts(ctx.db, ctx.db.searchNotes({ q, source, city, limit }));
      return { q, source, city, total: items.length, items };
    },
  },
  // 单条笔记（含它的地点候选）
  {
    method: 'GET',
    path: '/api/notes/:id',
    handler(ctx) {
      const id = Number(ctx.params.id);
      const note = findNote(ctx.db, id);
      if (!note) throw new ctx.HttpError(404, 'NOT_FOUND', `笔记 ${id} 不存在`);
      return Object.assign(toPublic(note), {
        places: ctx.db.listNotePlaces(id),
        place_count: ctx.db.listNotePlaces(id).length,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/notes',
    async handler(ctx) {
      const b = ctx.body || {};
      // 用户既可能贴分享文案，也可能只给链接/正文 ⇒ 分享文案优先补全其它字段
      const shareText = b.share_text ? String(b.share_text) : '';
      const parsed = shareText ? parseShareText(shareText) : null;
      const url = String(b.url || (parsed && parsed.url) || '').trim();
      const title = String(b.title || (parsed && parsed.title) || '').trim();
      if (!url && !title && !shareText) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '至少要给 url / share_text / title 之一');
      }
      const imageUrls = Array.isArray(b.image_urls) ? b.image_urls : [];
      const downloaded = imageUrls.length ? await downloadImages(imageUrls, NOTE_IMG_DIR) : [];
      const files = downloaded.filter((d) => d.ok).map((d) => d.file);
      // 视频/笔记封面单独落一张（不混进正文图条）
      let coverFile = null;
      let coverErr = null;
      if (b.cover_url) {
        const got = await downloadImages([String(b.cover_url)], NOTE_IMG_DIR);
        if (got[0] && got[0].ok) coverFile = got[0].file;
        else coverErr = got[0] ? got[0].error : '封面下载失败';
      }
      const note = ctx.db.addNoteFull({
        pin_id: b.pin_id,
        city: b.city,
        url,
        title,
        source: b.source || (parsed && parsed.source),
        source_type: b.source_type || (parsed && parsed.source_type),
        kind: b.kind || (parsed && parsed.kind),
        author: b.author || (parsed && parsed.author),
        // 只贴分享文案时，正文存「去掉引导语的干净版」而不是整段复制文案
        content: b.content != null ? String(b.content) : parsed ? cleanContent(shareText, parsed) : null,
        cover: coverFile || b.cover || files[0] || null,
        images: files,
        tags: Array.isArray(b.tags) ? b.tags : undefined,
        video_url: b.video_url,
        share_text: shareText,
        fetched_at: new Date().toISOString(),
      });
      return Object.assign(toPublic(note), {
        download: {
          requested: imageUrls.length,
          saved: files.length,
          failed: downloaded.filter((d) => !d.ok).map((d) => ({ url: d.url, error: d.error })),
          cover: coverFile ? { saved: true, file: coverFile } : coverErr ? { saved: false, error: coverErr } : null,
        },
      });
    },
  },
  // 自己抓：给链接（或分享文案）→ 本机浏览器（已登录 profile）把笔记/视频抓回来，落图到本地
  // save=1 才写库（不给就只返回预览，用户确认后再存）
  {
    method: 'POST',
    path: '/api/notes/fetch',
    async handler(ctx) {
      const b = ctx.body || {};
      const raw = String(b.url || b.share_text || '').trim();
      if (!raw) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少 url（或 share_text）');
      const parsed = /^https?:\/\//.test(raw) ? { url: raw } : parseShareText(raw);
      const url = parsed.url;
      if (!url) throw new ctx.HttpError(400, 'BAD_REQUEST', '这段文字里没找到链接');
      const r = await ctx.noteFetch.fetchNote({ url });
      if (!r || r.ok !== true) {
        const info = r || {};
        throw new ctx.HttpError(502, info.error || 'FETCH_FAIL', info.message || '抓取失败');
      }
      const out = await ingestFetched(ctx, r, {
        city: b.city || null,
        save: !!b.save,
      });
      return Object.assign({ fetch: { platform: r.platform, mode: r.mode, url: r.url } }, out);
    },
  },
  // 按关键词搜笔记（目前小红书已通；返回候选，不写库，用户挑完再抓）
  {
    method: 'POST',
    path: '/api/notes/discover',
    async handler(ctx) {
      const b = ctx.body || {};
      const keyword = String(b.keyword || '').trim();
      if (!keyword) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少 keyword');
      const platform = String(b.platform || 'xhs');
      const limit = Math.min(Math.max(1, Number(b.limit) || 10), 30);
      const r = await ctx.noteFetch.searchNotes({ platform, keyword, limit });
      if (!r || r.ok !== true) {
        const info = r || {};
        throw new ctx.HttpError(502, info.error || 'FETCH_FAIL', info.message || '搜索失败');
      }
      const items = [];
      // 候选项的封面也下到本地（否则页面直连平台 CDN 会 403，且「下载后缓存到本地」不成立）
      for (const it of r.items || []) {
        let cover = it.cover_url || '';
        if (cover) {
          const got = await downloadImages([cover], NOTE_IMG_DIR, {
            referer: refererForPlatform(r.platform),
          });
          cover = got[0] && got[0].ok ? '/notes-img/' + got[0].file : '';
        }
        items.push(
          Object.assign({}, it, { cover_url: cover, exists: !!ctx.db.findNoteByUrl(it.url) })
        );
      }
      return { platform, keyword, total: items.length, items };
    },
  },
  // 重新抓一遍（对「只存了标题封面」的候选记录很有用）
  {
    method: 'POST',
    path: '/api/notes/:id/refresh',
    async handler(ctx) {
      const id = Number(ctx.params.id);
      const existing = findNote(ctx.db, id);
      if (!existing) throw new ctx.HttpError(404, 'NOT_FOUND', `笔记 ${id} 不存在`);
      if (!existing.url) throw new ctx.HttpError(400, 'BAD_REQUEST', '这条笔记没有链接，没法重抓');
      const r = await ctx.noteFetch.fetchNote({ url: existing.url });
      if (!r || r.ok !== true) {
        const info = r || {};
        throw new ctx.HttpError(502, info.error || 'FETCH_FAIL', info.message || '抓取失败');
      }
      const out = await ingestFetched(ctx, r, { city: existing.city, save: true });
      return Object.assign({ fetch: { platform: r.platform, mode: r.mode, url: r.url } }, out);
    },
  },
  // 给已有笔记补内容/补图（用户手动提供时走这里）
  {
    method: 'PATCH',
    path: '/api/notes/:id',
    async handler(ctx) {
      const id = Number(ctx.params.id);
      if (!id) throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少参数 id');
      const existing = findNote(ctx.db, id);
      if (!existing) throw new ctx.HttpError(404, 'NOT_FOUND', `笔记 ${id} 不存在`);
      const b = ctx.body || {};
      const imageUrls = Array.isArray(b.image_urls) ? b.image_urls : [];
      const cur = parseJsonList(existing.images);
      let files = cur;
      if (imageUrls.length) {
        const downloaded = await downloadImages(imageUrls, NOTE_IMG_DIR);
        files = cur.concat(downloaded.filter((d) => d.ok).map((d) => d.file));
      }
      // 身份类字段（平台/形态/链接/标题）单独一条语句，避免动到 P3 的既有语义
      if (
        b.title != null ||
        b.source != null ||
        b.source_type != null ||
        b.kind != null ||
        b.url != null ||
        b.video_url != null ||
        b.share_text != null
      ) {
        ctx.db.setNoteIdent(id, {
          title: b.title,
          source: b.source,
          source_type: b.source_type,
          kind: b.kind,
          url: b.url,
          video_url: b.video_url,
          share_text: b.share_text,
        });
      }
      const note = ctx.db.setNotePayload(id, {
        author: b.author != null ? b.author : existing.author,
        content: b.content != null ? b.content : existing.content,
        cover: b.cover || existing.cover || files[0] || null,
        images: files,
        tags: Array.isArray(b.tags) ? b.tags : parseJsonList(existing.tags),
      });
      return toPublic(note);
    },
  },
  // 从笔记正文提取地名（resolve=1 时再打高德补全，逐名 1 次调用）
  {
    method: 'POST',
    path: '/api/notes/:id/places',
    async handler(ctx) {
      const id = Number(ctx.params.id);
      const note = findNote(ctx.db, id);
      if (!note) throw new ctx.HttpError(404, 'NOT_FOUND', `笔记 ${id} 不存在`);
      const b = ctx.body || {};
      const city = String(b.city || note.city || '').trim();
      const names = Array.isArray(b.names) && b.names.length
        ? b.names.map((n) => String(n).trim()).filter(Boolean).slice(0, NOTE_PLACE_MAX)
        : extractPlaceNames(
            { title: note.title, content: note.content },
            { limit: NOTE_PLACE_MAX }
          );
      const resolvedAt = new Date().toISOString();

      if (!b.resolve) {
        // 只提取（零调用）：名字先落库，poi_id 空着，等页面点「补全」
        const rows = names.map((name) => ({ name, city: city || null, resolved_at: null }));
        const places = ctx.db.replaceNotePlaces(id, rows);
        return { note_id: id, city: city || null, names, places, calls: 0, errors: [], resolved: 0 };
      }

      const geocoder = String(b.geocoder || 'auto'); // auto | amap | osm
      if (!city) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '地名补全需要 city（笔记里没有就带上）');
      }

      const rows = [];
      const errors = [];
      let calls = 0; // 高德调用次数
      let osmCalls = 0; // OSM 兜底调用次数
      for (const name of names) {
        let hit = null;
        let amapErr = null;
        if (geocoder !== 'osm') {
          try {
            calls += 1;
            const list = await ctx.amap.searchPoi({ city, keywords: name, page: 1 });
            hit = pickBest(name, list);
          } catch (err) {
            // 配额/网络失败先记下，再让 OSM 兜底；两条都不成才如实报错（不写假点）
            amapErr = (err && err.message) || String(err);
          }
        }
        if (!hit && geocoder !== 'amap' && ctx.osm && typeof ctx.osm.searchOsm === 'function') {
          try {
            osmCalls += 1;
            const list = await ctx.osm.searchOsm({ city, keywords: name, limit: 5 });
            // OSM 只认同名的（不然它会给一条无关街道）
            const same = list.filter((p) => matchesName(name, p.name));
            const best = pickBest(name, same);
            if (best) hit = Object.assign({}, best, { source: 'osm' });
            else pushErr(errors, name, 'OSM 里没有同名地点（不拿别的点凑）');
          } catch (err) {
            pushErr(errors, name, 'OSM 兜底也失败：' + ((err && err.message) || String(err)));
          }
        }
        if (!hit) {
          rows.push({ name, city, resolved_at: null });
          if (amapErr) pushErr(errors, name, amapErr);
          else pushErr(errors, name, '没查到这个地名');
          continue;
        }
        rows.push({
          name,
          poi_name: hit.name,
          city,
          poi_id: hit.id,
          address: hit.address,
          lng: hit.lng,
          lat: hit.lat,
          rating: hit.rating,
          category: hit.category,
          photo: hit.photo,
          source: hit.source === 'osm' ? 'osm' : 'amap',
          resolved_at: resolvedAt,
        });
      }
      const places = ctx.db.replaceNotePlaces(id, rows);
      return {
        note_id: id,
        city,
        names,
        places,
        calls,
        osm_calls: osmCalls,
        resolved: places.filter((p) => p.poi_id).length,
        by_source: {
          amap: places.filter((p) => p.source === 'amap').length,
          osm: places.filter((p) => p.source === 'osm').length,
        },
        errors,
      };
    },
  },
  {
    method: 'DELETE',
    path: '/api/notes/:id',
    handler(ctx) {
      const id = Number(ctx.params.id);
      const existing = findNote(ctx.db, id);
      if (!existing) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `笔记 ${id} 不存在`);
      }
      ctx.db.deleteNote(id);
      return { deleted: id };
    },
  },
];
