'use strict';
/*
 * 分享列表（首页/分享列表页用）
 *   GET    /api/shares          列出每次分享（新的在前）：网页版链接 + 纯文本 + 点数
 *   GET    /api/shares/:id      单条（要纯文本时用）
 *   DELETE /api/shares/:id      删记录 + 删掉那三个文件（html/txt/json）
 *
 * 网页版地址就是同一个服务里的 /share/<base>.html —— 分享给别人的链接直接能打开。
 */

const fs = require('node:fs');
const path = require('node:path');

const SHARE_DIR = () => process.env.TRAVEL_SHARE_DIR || path.join(__dirname, '..', '..', 'share');

function withLinks(row) {
  if (!row) return null;
  return {
    ...row,
    url: '/share/' + encodeURIComponent(row.base + '.html'),
    textUrl: '/share/' + encodeURIComponent(row.base + '.txt'),
    jsonUrl: '/share/' + encodeURIComponent(row.base + '.json'),
  };
}

// 老文件补账：share/ 目录里当年生成的分享包（那时还没有分享表）要能在列表里看到。
// 文件名约定 <城市>-<行程名>-<本地日期>.html ⇒ 拆出城市与标题；只读文件头部，不动内容。
function importExistingShares(ctx) {
  const dir = path.resolve(SHARE_DIR());
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return 0;
  }
  let imported = 0;
  entries
    .filter((n) => n.endsWith('.html'))
    .slice(0, 300)
    .forEach((name) => {
      const base = name.slice(0, -'.html'.length);
      if (ctx.db.findShareByBase(base)) return;
      const parts = base.split('-');
      // <城市>-<标题...>-<日期>（日期是最后三段 YYYY-MM-DD）
      const day = parts.length >= 4 ? parts.slice(-3).join('-') : '';
      const city = parts[0] || '';
      const title = parts.length >= 4 ? parts.slice(1, -3).join('-') : base;
      let text = '';
      let stops = 0;
      try {
        const txt = path.join(dir, base + '.txt');
        if (fs.existsSync(txt)) text = fs.readFileSync(txt, 'utf8').slice(0, 20000);
      } catch (err) {
        text = '';
      }
      try {
        const json = JSON.parse(fs.readFileSync(path.join(dir, base + '.json'), 'utf8'));
        stops = Array.isArray(json.stops) ? json.stops.length : 0;
      } catch (err) {
        stops = 0;
      }
      try {
        ctx.db.addShare({ city, title: title || base, base, text, stops, files: { imported: true, day } });
        imported += 1;
      } catch (err) {
        /* 单条失败不挡其余 */
      }
    });
  return imported;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/shares',
    handler(ctx) {
      const limit = Number((ctx.query && ctx.query.limit) || 50) || 50;
      importExistingShares(ctx);
      return ctx.db.listShares(limit).map(withLinks);
    },
  },
  {
    method: 'GET',
    path: '/api/shares/:id',
    handler(ctx) {
      const row = ctx.db.getShare(Number(ctx.params.id));
      if (!row) throw new ctx.HttpError(404, 'NOT_FOUND', `分享 ${ctx.params.id} 不存在`);
      return withLinks(row);
    },
  },
  {
    method: 'DELETE',
    path: '/api/shares/:id',
    handler(ctx) {
      const id = Number(ctx.params.id);
      const row = ctx.db.getShare(id);
      if (!row) throw new ctx.HttpError(404, 'NOT_FOUND', `分享 ${id} 不存在`);
      const dir = path.resolve(SHARE_DIR());
      const removed = [];
      ['html', 'txt', 'json'].forEach((ext) => {
        const full = path.resolve(dir, path.basename(row.base + '.' + ext));
        if (path.dirname(full) !== dir) return;
        try {
          if (fs.existsSync(full)) {
            fs.unlinkSync(full);
            removed.push(path.basename(full));
          }
        } catch (err) {
          /* 删不掉就留着，记录先删 */
        }
      });
      const { changes } = ctx.db.deleteShare(id);
      return { deleted: id, changes, removedFiles: removed };
    },
  },
];
