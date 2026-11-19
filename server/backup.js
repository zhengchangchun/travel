'use strict';
/*
 * 备份：把数据打成一个 zip（数据库快照 + 分享包 + 实景图 + 首页封面）。
 *
 * 零依赖口径：自己写 ZIP（本地头 + 中央目录 + EOCD），压缩用 node:zlib 的 deflateRaw。
 * 不直接压 travel.db 文件本体（可能在写），而是先 VACUUM INTO 一份一致性快照再加进去。
 *
 * 产物：data/backups/travel-backup-YYYYMMDD-HHMMSS.zip
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { ROOT } = require('./config');

// ---------- 极简 ZIP 写入器（STORE / DEFLATE 两种都能） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// DOS 时间：zip 头里要的是本地时间（1980 起）
function dosTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function createZip(file) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();

  function add(name, data, { compress = true } = {}) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const deflated = compress && raw.length > 256 ? zlib.deflateRawSync(raw, { level: 6 }) : null;
    const body = deflated && deflated.length < raw.length ? deflated : raw;
    const method = deflated && deflated.length < raw.length ? 8 : 0;
    const crc = crc32(raw);
    const { date, time } = dosTime(now);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    central.push({ nameBuf, crc, method, time, date, csize: body.length, usize: raw.length, offset });
    offset += local.length + nameBuf.length + body.length;
    return raw.length;
  }

  function finish() {
    const dirStart = offset;
    let dirSize = 0;
    central.forEach((e) => {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4); // version made by
      head.writeUInt16LE(20, 6); // version needed
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(e.method, 10);
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.date, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.csize, 20);
      head.writeUInt32LE(e.usize, 24);
      head.writeUInt16LE(e.nameBuf.length, 28);
      head.writeUInt16LE(0, 30); // extra
      head.writeUInt16LE(0, 32); // comment
      head.writeUInt16LE(0, 34); // disk
      head.writeUInt16LE(0, 36); // internal attrs
      head.writeUInt32LE(0, 38); // external attrs
      head.writeUInt32LE(e.offset, 42);
      chunks.push(head, e.nameBuf);
      dirSize += head.length + e.nameBuf.length;
    });
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(dirSize, 12);
    eocd.writeUInt32LE(dirStart, 16);
    eocd.writeUInt16LE(0, 20);
    chunks.push(eocd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat(chunks));
    return { bytes: fs.statSync(file).size, entries: central.length };
  }

  return { add, finish };
}

// ---------- 打包 ----------
function backupsDir() {
  return process.env.TRAVEL_BACKUP_DIR || path.join(ROOT, 'data', 'backups');
}

function stampName(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    'travel-backup-' +
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    '.zip'
  );
}

function walk(dir, prefix, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  entries.forEach((e) => {
    if (e.name.startsWith('.')) return;
    const full = path.join(dir, e.name);
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel, out);
    else if (e.isFile()) out.push({ full, rel });
  });
  return out;
}

// 数据库一致性快照：VACUUM INTO 到临时文件，再整份塞进 zip
function snapshotDb(db, tmpFile) {
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch (err) {
    /* ignore */
  }
  db.raw.exec(`VACUUM INTO '${String(tmpFile).replace(/'/g, "''")}'`);
  return tmpFile;
}

function createBackup({ db, include = {}, now } = {}) {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, stampName(now));
  const tmpDb = path.join(dir, '.snapshot-' + process.pid + '-' + Date.now() + '.db');
  const zip = createZip(file);
  const summary = { file: path.basename(file), dir, dbBytes: 0, shares: 0, photos: 0, covers: 0 };

  try {
    if (db) {
      snapshotDb(db, tmpDb);
      const size = fs.statSync(tmpDb).size;
      zip.add('travel.db', fs.readFileSync(tmpDb), { compress: true });
      summary.dbBytes = size;
    }
    const dirs = [
      { key: 'shares', dir: process.env.TRAVEL_SHARE_DIR || path.join(ROOT, 'share'), prefix: 'share' },
      {
        key: 'photos',
        dir: process.env.TRAVEL_FEATURED_PHOTO_DIR || path.join(ROOT, 'data', 'featured-photos'),
        prefix: 'featured-photos',
      },
      { key: 'covers', dir: process.env.TRAVEL_HOME_IMG_DIR || path.join(ROOT, 'data', 'home-img'), prefix: 'home-img' },
    ];
    dirs.forEach((d) => {
      if (include[d.key] === false) return;
      const files = walk(d.dir, '', []);
      files.forEach((f) => {
        // 图片/分享包本来就不太压得动，直接 store 快一些
        const compress = !/\.(jpe?g|png|webp|zip|mp4)$/i.test(f.full);
        zip.add(d.prefix + '/' + f.rel, fs.readFileSync(f.full), { compress });
      });
      summary[d.key] = files.length;
    });

    // 恢复说明：别让人拿到 zip 不知道怎么用
    const readme = [
      '旅迹 · 数据备份',
      '生成时间：' + new Date().toISOString(),
      '',
      '压缩包内容：',
      '  travel.db              —— SQLite 数据库（账号、行程、点位、分享记录、已收录地点）',
      '  share/                 —— 每次生成的分享包（html/txt/json）',
      '  featured-photos/       —— 推荐路程与行程里的实景图',
      '  home-img/              —— 首页的静态地图封面（可再生成，留着省事）',
      '',
      '怎么恢复：',
      '  1) 退出正在运行的服务（关掉 node server/index.js）',
      '  2) 把 travel.db 放回项目的 data/travel.db（原文件先改名留档）',
      '  3) share/ 与 featured-photos/ 放回原位（同名覆盖即可）',
      '  4) 重新启动服务（node server/index.js），打开 http://127.0.0.1:8787',
      '',
      '说明：home-img/ 可以不放回，缺图时服务会按需重画。',
    ].join('\n') + '\n';
    zip.add('README.txt', readme, { compress: true });

    const done = zip.finish();
    summary.bytes = done.bytes;
    summary.entries = done.entries;
    return summary;
  } finally {
    try {
      fs.rmSync(tmpDb, { force: true });
    } catch (err) {
      /* ignore */
    }
  }
}

function listBackups(limit) {
  const dir = backupsDir();
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^travel-backup-.*\.zip$/.test(n))
      .sort()
      .reverse()
      .slice(0, Number(limit) || 10);
  } catch (err) {
    return [];
  }
  return names.map((n) => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, bytes: st.size, at: st.mtime.toISOString() };
  });
}

function backupPath(name) {
  const dir = path.resolve(backupsDir());
  const full = path.resolve(dir, path.basename(String(name || '')));
  if (path.dirname(full) !== dir) return null;
  return fs.existsSync(full) ? full : null;
}

module.exports = { createBackup, listBackups, backupPath, backupsDir, createZip, crc32 };
