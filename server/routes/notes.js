module.exports = [
  {
    method: 'GET',
    path: '/api/notes',
    handler(ctx) {
      const city = ctx.query.city ? String(ctx.query.city).trim() : '';
      return ctx.db.listNotes(city || undefined);
    },
  },
  {
    method: 'POST',
    path: '/api/notes',
    handler(ctx) {
      const b = ctx.body || {};
      if (!b.url || !String(b.url).trim()) {
        throw new ctx.HttpError(400, 'BAD_REQUEST', '缺少必填字段 url');
      }
      return ctx.db.addNote({
        city: b.city,
        url: String(b.url).trim(),
        title: b.title,
        source: b.source,
        pin_id: b.pin_id,
      });
    },
  },
  {
    method: 'DELETE',
    path: '/api/notes/:id',
    handler(ctx) {
      const id = Number(ctx.params.id);
      const existing = ctx.db.listNotes().find((n) => n.id === id);
      if (!existing) {
        throw new ctx.HttpError(404, 'NOT_FOUND', `笔记 ${id} 不存在`);
      }
      ctx.db.deleteNote(id);
      return { deleted: id };
    },
  },
];
