'use strict';
/*
 * 备份（要登录）：
 *   POST /api/backup        立刻打一个 zip（数据库快照 + 分享包 + 实景图 + 首页封面）
 *   GET  /api/backup        列出最近几个备份（名字/大小/时间）
 *   POST /api/backup/reveal 在 Finder 里选中这个备份
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const auth = require('../auth');
const backup = require('../backup');

const me = (ctx) => auth.requireUser(ctx);

function revealFile(full) {
  if (process.platform === 'darwin') return spawnSync('/usr/bin/open', ['-R', full], { timeout: 5000 });
  if (process.platform === 'win32') return spawnSync('explorer', ['/select,' + full], { timeout: 5000 });
  return spawnSync('xdg-open', [path.dirname(full)], { timeout: 5000 });
}

module.exports = [
  {
    method: 'POST',
    path: '/api/backup',
    handler(ctx) {
      me(ctx);
      return backup.createBackup({ db: ctx.db });
    },
  },
  {
    method: 'GET',
    path: '/api/backup',
    handler(ctx) {
      me(ctx);
      return { dir: backup.backupsDir(), items: backup.listBackups(10) };
    },
  },
  {
    method: 'POST',
    path: '/api/backup/reveal',
    handler(ctx) {
      me(ctx);
      const name = String((ctx.body && ctx.body.name) || '').trim();
      const full = backup.backupPath(name);
      if (!full) throw new ctx.HttpError(404, 'NOT_FOUND', '没有这个备份文件');
      const r = revealFile(full);
      if (r && r.error) throw new ctx.HttpError(500, 'REVEAL_FAILED', r.error.message);
      return { ok: true, file: path.basename(full) };
    },
  },
];
