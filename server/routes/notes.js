// 笔记：本地缓存 + 按来源区分 + 本地搜索
// 口径：内容由用户提供（链接/正文/图片），平台侧抓取在本机被风控（抖音验证码页、小红书 300012 IP 风险）
// ⇒ 这里只负责“落库 + 落图 + 本地读”，不假装能自动抓。
const path = require('node:path');
const { downloadImages } = require('../note-images');

const ROOT = path.join(__dirname, '..', '..');
// 可用环境变量重定向（测试隔离用），默认 data/notes-img
const NOTE_IMG_DIR = process.env.TRAVEL_NOTE_IMG_DIR || path.join(ROOT, 'data', 'notes-img');

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
  });
}

function findNote(db, id) {
  return db.listNotes().find((n) => n.id === id) || null;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/notes',
    handler(ctx) {
      const city = ctx.query.city ? String(ctx.query.city).trim() : '';
      return ctx.db.listNotes(city || undefined).map(toPublic);
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
      const items = ctx.db.searchNotes({ q, source, city, limit }).map(toPublic);
      return { q, source, city, total: items.length, items };
    },
  },
  {
    method: 'POST',
    path: '/api/notes',
    async handler(ctx) {
      const b = ctx.body || {};
      const url = b.url ? String(b.url).trim() : '';
      if (!url) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 url');
      }
      const imageUrls = Array.isArray(b.image_urls) ? b.image_urls : [];
      const downloaded = imageUrls.length ? await downloadImages(imageUrls, NOTE_IMG_DIR) : [];
      const files = downloaded.filter((d) => d.ok).map((d) => d.file);
      const note = ctx.db.addNoteFull({
        pin_id: b.pin_id,
        city: b.city,
        url,
        title: b.title,
        source: b.source,
        source_type: b.source_type,
        author: b.author,
        content: b.content,
        cover: b.cover || files[0] || null,
        images: files,
        tags: Array.isArray(b.tags) ? b.tags : undefined,
        fetched_at: new Date().toISOString(),
      });
      return Object.assign(toPublic(note), {
        download: {
          requested: imageUrls.length,
          saved: files.length,
          failed: downloaded.filter((d) => !d.ok).map((d) => ({ url: d.url, error: d.error })),
        },
      });
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
