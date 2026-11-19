const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash, setDigest } = require('./poi-hash');
const { applyPoiOrder } = require('./order');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  nickname      TEXT,
  avatar        TEXT,
  default_city  TEXT,
  default_mode  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- 分享列表：每次「分享」落一条（网页版 /share/<base>.html 同一个服务里能直接打开）
CREATE TABLE IF NOT EXISTS shares (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER,
  user_id    INTEGER,
  city       TEXT NOT NULL,
  title      TEXT NOT NULL,
  base       TEXT NOT NULL,
  files      TEXT,
  text       TEXT,
  stops      INTEGER NOT NULL DEFAULT 0,
  distance_m INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  city        TEXT NOT NULL,
  title       TEXT NOT NULL,
  note        TEXT,
  theme       TEXT,
  user_id     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER NOT NULL REFERENCES trips(id),
  poi_id      TEXT,
  name        TEXT NOT NULL,
  address     TEXT,
  lng         REAL NOT NULL,
  lat         REAL NOT NULL,
  category    TEXT NOT NULL,
  rating      TEXT,
  cost        TEXT,
  tel         TEXT,
  photo       TEXT,
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_id      INTEGER REFERENCES pins(id),
  city        TEXT,
  url         TEXT NOT NULL,
  title       TEXT,
  source      TEXT,
  source_type TEXT,
  kind        TEXT,
  author      TEXT,
  content     TEXT,
  cover       TEXT,
  images      TEXT,
  tags        TEXT,
  video_url   TEXT,
  share_text  TEXT,
  fetched_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 从笔记正文里提取出来、经高德补全的地点（「按笔记搜地方」的落点）
CREATE TABLE IF NOT EXISTS note_places (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     INTEGER NOT NULL REFERENCES notes(id),
  name        TEXT NOT NULL,
  poi_name    TEXT,
  city        TEXT,
  poi_id      TEXT,
  address     TEXT,
  lng         REAL,
  lat         REAL,
  rating      REAL,
  category    TEXT,
  photo       TEXT,
  source      TEXT,
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pins_trip ON pins(trip_id);
CREATE INDEX IF NOT EXISTS idx_pins_poi ON pins(poi_id);
CREATE INDEX IF NOT EXISTS idx_notes_city ON notes(city);
CREATE INDEX IF NOT EXISTS idx_note_places_note ON note_places(note_id);

CREATE TABLE IF NOT EXISTS pois (
  poi_id     TEXT PRIMARY KEY,
  city       TEXT NOT NULL,
  adcode     TEXT,
  category   TEXT NOT NULL,
  name       TEXT NOT NULL,
  address    TEXT,
  lng        REAL NOT NULL,
  lat        REAL NOT NULL,
  typecode   TEXT,
  rating     TEXT,
  cost       TEXT,
  tel        TEXT,
  photos     TEXT,
  tags       TEXT,
  fetched_at TEXT NOT NULL,
  content_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS idx_pois_city_cat ON pois(city, category);
CREATE INDEX IF NOT EXISTS idx_pois_city_rating ON pois(city, category, rating);

CREATE TABLE IF NOT EXISTS poi_collect_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  city        TEXT NOT NULL,
  category    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  n_fetched   INTEGER NOT NULL DEFAULT 0,
  n_inserted  INTEGER NOT NULL DEFAULT 0,
  n_updated   INTEGER NOT NULL DEFAULT 0,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_city ON poi_collect_runs(city, category);

CREATE TABLE IF NOT EXISTS poi_coverage (
  city         TEXT NOT NULL,
  category     TEXT NOT NULL,
  gx           INTEGER NOT NULL,
  gy           INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  n_inserted   INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (city, category, gx, gy)
);

-- 城市行政轮廓（P21）：一次拉下来长期用（高德行政区查询有日配额）
CREATE TABLE IF NOT EXISTS city_boundaries (
  city       TEXT PRIMARY KEY,
  name       TEXT,
  adcode     TEXT,
  center     TEXT,
  bbox       TEXT,
  rings      TEXT,
  fetched_at TEXT NOT NULL
);
`;

const DEFAULT_CATEGORY_LABELS = {
  food: '美食',
  stay: '住宿',
  sight: '景点',
  play: '游玩',
};

function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// 缓存行 → 前端结构：poi_id 别名 id，photos/tags 还原为数组，photo 取第一张
function mapPoiRow(row) {
  if (!row) return null;
  const photos = parseJsonArray(row.photos);
  const tags = parseJsonArray(row.tags);
  return { ...row, id: row.poi_id, photos, tags, photo: photos[0] || '' };
}

// 标题去重：把「城市 · 城市 · …」折叠回「城市 · …」，修复历史脏标题
function dedupeCityTitle(city, rawTitle) {
  let title = String(rawTitle == null ? '' : rawTitle).trim();
  if (!title) return `${city} · 我的行程`;
  const dup = `${city} · ${city}`;
  let guard = 0;
  while (title.startsWith(dup) && guard < 10) {
    title = `${city} · ${title.slice(dup.length).replace(/^\s*·\s*/, '')}`;
    guard += 1;
  }
  return title;
}

// 分享行 → 给页面用的形状（files 是 JSON 字符串，解开；网页版地址由路由拼）
function parseShareRow(row) {
  if (!row) return null;
  let files = null;
  try {
    files = row.files ? JSON.parse(row.files) : null;
  } catch (err) {
    files = null;
  }
  return { ...row, files: files || {} };
}

// 幂等迁移：先查 pragma table_info，缺列才 ALTER（重复启动不报错）
function ensureColumn(db, table, column, ddl) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function createDb(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  ensureColumn(db, 'pins', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
  // 行程自己的备注（「先吃饭再逛」这类整条行程的话）—— 每条地点的备注在 pins.note
  ensureColumn(db, 'trips', 'note', 'note TEXT');
  // 一城可多趟：主题（比如「西线＋东线」）与归属用户
  ensureColumn(db, 'trips', 'theme', 'theme TEXT');
  ensureColumn(db, 'trips', 'user_id', 'user_id INTEGER');
  ensureColumn(db, 'poi_coverage', 'truncated', 'truncated INTEGER NOT NULL DEFAULT 0');
  // POI 内容指纹列（存量库前滚；缺失指纹的行在下面回填）
  ensureColumn(db, 'pois', 'content_sha256', 'content_sha256 TEXT');
  // 笔记本地缓存（P3）：正文/作者/封面/图全部落本地，页面之后从本地读（不再每次都去平台）
  ensureColumn(db, 'notes', 'source_type', 'source_type TEXT');
  ensureColumn(db, 'notes', 'author', 'author TEXT');
  ensureColumn(db, 'notes', 'content', 'content TEXT');
  ensureColumn(db, 'notes', 'kind', 'kind TEXT');
  ensureColumn(db, 'notes', 'cover', 'cover TEXT');
  ensureColumn(db, 'notes', 'images', 'images TEXT');
  ensureColumn(db, 'notes', 'tags', 'tags TEXT');
  ensureColumn(db, 'notes', 'video_url', 'video_url TEXT');
  ensureColumn(db, 'notes', 'share_text', 'share_text TEXT');
  ensureColumn(db, 'notes', 'fetched_at', 'fetched_at TEXT');
  // 地点来源（amap / osm）：兜底源要能一眼看出，不与高德结果混为一谈
  ensureColumn(db, 'note_places', 'source', 'source TEXT');

  const stmts = {
    insertTrip: db.prepare('INSERT INTO trips (city, title, theme, user_id) VALUES (?, ?, ?, ?)'),
    getTrip: db.prepare('SELECT * FROM trips WHERE id = ?'),
    listTrips: db.prepare('SELECT * FROM trips ORDER BY id DESC'),
    listTripsByCity: db.prepare('SELECT * FROM trips WHERE city = ? ORDER BY id DESC'),
    // 按用户隔离：一个人的行程只看得到自己的（user_id 为 NULL 的是旧数据，靠「认领」归给某个账号）
    listTripsByUser: db.prepare('SELECT * FROM trips WHERE user_id = ? ORDER BY id DESC'),
    listTripsByUserCity: db.prepare('SELECT * FROM trips WHERE user_id = ? AND city = ? ORDER BY id DESC'),
    tripByCityForUser: db.prepare('SELECT * FROM trips WHERE city = ? AND user_id = ? ORDER BY id LIMIT 1'),
    countUnownedTrips: db.prepare('SELECT COUNT(*) AS c FROM trips WHERE user_id IS NULL'),
    countUnownedShares: db.prepare('SELECT COUNT(*) AS c FROM shares WHERE user_id IS NULL'),
    updateTripTitle: db.prepare('UPDATE trips SET title = ? WHERE id = ?'),
    updateTripNote: db.prepare('UPDATE trips SET note = ? WHERE id = ?'),
    updateTripTheme: db.prepare('UPDATE trips SET theme = ? WHERE id = ?'),
    deleteTrip: db.prepare('DELETE FROM trips WHERE id = ?'),
    deletePinsOfTrip: db.prepare('DELETE FROM pins WHERE trip_id = ?'),
    deleteCityPins: db.prepare(
      'DELETE FROM pins WHERE trip_id IN (SELECT id FROM trips WHERE city = ?)'
    ),
    deleteCityTrips: db.prepare('DELETE FROM trips WHERE city = ?'),
    deleteCityPinsOfUser: db.prepare(
      'DELETE FROM pins WHERE trip_id IN (SELECT id FROM trips WHERE city = ? AND user_id = ?)'
    ),
    deleteCityTripsOfUser: db.prepare('DELETE FROM trips WHERE city = ? AND user_id = ?'),
    insertPin: db.prepare(
      `INSERT INTO pins (trip_id, poi_id, name, address, lng, lat, category, rating, cost, tel, photo, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getPin: db.prepare('SELECT * FROM pins WHERE id = ?'),
    pinsByTrip: db.prepare('SELECT * FROM pins WHERE trip_id = ? ORDER BY id'),
    deletePin: db.prepare('DELETE FROM pins WHERE id = ?'),
    insertNote: db.prepare(
      'INSERT INTO notes (pin_id, city, url, title, source) VALUES (?, ?, ?, ?, ?)'
    ),
    getNote: db.prepare('SELECT * FROM notes WHERE id = ?'),
    findNoteByUrl: db.prepare('SELECT * FROM notes WHERE url = ? ORDER BY id LIMIT 1'),
    listNotesAll: db.prepare('SELECT * FROM notes ORDER BY id DESC'),
    listNotesCity: db.prepare('SELECT * FROM notes WHERE city = ? ORDER BY id DESC'),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),
    insertNoteFull: db.prepare(
      `INSERT INTO notes (pin_id, city, url, title, source, source_type, kind, author, content, cover, images, tags, video_url, share_text, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    // 本地搜索：关键词命中标题/正文/作者；source 同时认 source 与 source_type（小红书/抖音…）
    searchNotes: db.prepare(
      `SELECT * FROM notes
        WHERE (? = '' OR COALESCE(title, '') LIKE ? OR COALESCE(content, '') LIKE ? OR COALESCE(author, '') LIKE ?)
          AND (? = '' OR COALESCE(source, '') = ? OR COALESCE(source_type, '') = ?)
          AND (? = '' OR COALESCE(city, '') = ?)
        ORDER BY id DESC LIMIT ?`
    ),
    setNotePayload: db.prepare(
      'UPDATE notes SET author = ?, content = ?, cover = ?, images = ?, tags = ?, fetched_at = ? WHERE id = ?'
    ),
    setNoteIdent: db.prepare(
      'UPDATE notes SET title = ?, source = ?, source_type = ?, kind = ?, url = ?, video_url = ?, share_text = ?, fetched_at = ? WHERE id = ?'
    ),
    listNotePlaces: db.prepare('SELECT * FROM note_places WHERE note_id = ? ORDER BY id'),
    deleteNotePlaces: db.prepare('DELETE FROM note_places WHERE note_id = ?'),
    insertNotePlace: db.prepare(
      `INSERT INTO note_places (note_id, name, poi_name, city, poi_id, address, lng, lat, rating, category, photo, source, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

    // ---- T2 选中模型 ----
    tripByCity: db.prepare('SELECT * FROM trips WHERE city = ? ORDER BY id LIMIT 1'),
    selectionByCityForUser: db.prepare(
      `SELECT p.* FROM pins p JOIN trips t ON p.trip_id = t.id
       WHERE t.city = ? AND t.user_id = ? ORDER BY p.sort_order, p.id`
    ),
    pinByCityPoiForUser: db.prepare(
      `SELECT p.* FROM pins p JOIN trips t ON p.trip_id = t.id
       WHERE t.city = ? AND t.user_id = ? AND p.poi_id = ? ORDER BY p.id LIMIT 1`
    ),
    pinByCityPoi: db.prepare(
      `SELECT p.* FROM pins p JOIN trips t ON p.trip_id = t.id
       WHERE t.city = ? AND p.poi_id = ? ORDER BY p.id LIMIT 1`
    ),
    selectionByCity: db.prepare(
      `SELECT p.* FROM pins p JOIN trips t ON p.trip_id = t.id
       WHERE t.city = ? ORDER BY p.sort_order, p.id`
    ),
    nextSortOrder: db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pins WHERE trip_id = ?'
    ),
    insertPinOrdered: db.prepare(
      `INSERT INTO pins (trip_id, poi_id, name, address, lng, lat, category, rating, cost, tel, photo, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    deletePinByPoi: db.prepare(
      `DELETE FROM pins WHERE poi_id = ? AND trip_id IN (SELECT id FROM trips WHERE city = ?)`
    ),
    deletePinByPoiOfUser: db.prepare(
      `DELETE FROM pins WHERE trip_id IN (SELECT id FROM trips WHERE city = ? AND user_id = ?) AND poi_id = ?`
    ),
    setSortOrderOfUser: db.prepare(
      `UPDATE pins SET sort_order = ? WHERE poi_id = ?
       AND trip_id IN (SELECT id FROM trips WHERE user_id = ? AND city = ?)`
    ),
    setSortOrderByPinOfUser: db.prepare(
      `UPDATE pins SET sort_order = ? WHERE id = ?
       AND trip_id IN (SELECT id FROM trips WHERE user_id = ? AND city = ?)`
    ),
    setSortOrder: db.prepare(
      `UPDATE pins SET sort_order = ? WHERE poi_id = ? AND trip_id IN (SELECT id FROM trips WHERE city = ?)`
    ),
    // 没有 poi_id 的点（geocode 解析出来的，客户端的 key 是 pin:<行号>）只能按行号排
    setSortOrderByPin: db.prepare(
      `UPDATE pins SET sort_order = ? WHERE id = ? AND trip_id IN (SELECT id FROM trips WHERE city = ?)`
    ),
    updatePinNote: db.prepare('UPDATE pins SET note = ? WHERE id = ?'),

    // ---- T4 POI 缓存表 ----
    getPoiRow: db.prepare('SELECT * FROM pois WHERE poi_id = ?'),
    insertPoi: db.prepare(
      `INSERT INTO pois (poi_id, city, adcode, category, name, address, lng, lat, typecode, rating, cost, tel, photos, tags, fetched_at, content_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updatePoi: db.prepare(
      `UPDATE pois SET city = ?, adcode = ?, category = ?, name = ?, address = ?, lng = ?, lat = ?,
        typecode = ?, rating = ?, cost = ?, tel = ?, photos = ?, tags = ?, fetched_at = ?, content_sha256 = ?
       WHERE poi_id = ?`
    ),
    listPoiHashes: db.prepare('SELECT poi_id, content_sha256 FROM pois WHERE city = ?'),
    listMissingHashes: db.prepare(
      'SELECT * FROM pois WHERE content_sha256 IS NULL LIMIT 2000'
    ),
    setPoiHash: db.prepare('UPDATE pois SET content_sha256 = ? WHERE poi_id = ?'),
    getPoiHash: db.prepare('SELECT content_sha256 FROM pois WHERE poi_id = ?'),
    countPoisByCat: db.prepare(
      'SELECT category, COUNT(*) AS c FROM pois WHERE city = ? GROUP BY category'
    ),
    countPoisCity: db.prepare('SELECT COUNT(*) AS c FROM pois WHERE city = ?'),
    listRunsByCity: db.prepare(
      'SELECT * FROM poi_collect_runs WHERE city = ? ORDER BY id DESC'
    ),
    insertRun: db.prepare(
      `INSERT INTO poi_collect_runs (city, category, started_at, status) VALUES (?, ?, ?, 'running')`
    ),
    getRun: db.prepare('SELECT * FROM poi_collect_runs WHERE id = ?'),
    findRunningRun: db.prepare(
      `SELECT * FROM poi_collect_runs WHERE city = ? AND category = ? AND status = 'running'
       ORDER BY id DESC LIMIT 1`
    ),

    // ---- T8 采集覆盖格 ----
    isCovered: db.prepare(
      'SELECT 1 AS hit FROM poi_coverage WHERE city = ? AND category = ? AND gx = ? AND gy = ? LIMIT 1'
    ),
    markCovered: db.prepare(
      `INSERT OR REPLACE INTO poi_coverage (city, category, gx, gy, collected_at, n_inserted, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    listCoverage: db.prepare(
      'SELECT * FROM poi_coverage WHERE city = ? AND category = ? ORDER BY gx, gy'
    ),
    // 含 collected_at：补采决策要按「这个格多久前采的」判新鲜度（P2 账本）
    listCoverageRange: db.prepare(
      `SELECT gx, gy, collected_at, n_inserted, truncated FROM poi_coverage
       WHERE city = ? AND category = ? AND gx BETWEEN ? AND ? AND gy BETWEEN ? AND ?`
    ),
    getCityBoundary: db.prepare('SELECT * FROM city_boundaries WHERE city = ?'),
    upsertCityBoundary: db.prepare(
      `INSERT INTO city_boundaries (city, name, adcode, center, bbox, rings, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(city) DO UPDATE SET
         name = excluded.name, adcode = excluded.adcode, center = excluded.center,
         bbox = excluded.bbox, rings = excluded.rings, fetched_at = excluded.fetched_at`
    ),

    // ---- 账号 / 会话 ----
    insertUser: db.prepare(
      'INSERT INTO users (username, password_hash, salt, nickname) VALUES (?, ?, ?, ?)'
    ),
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    getUserByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    updateUser: db.prepare(
      `UPDATE users SET nickname = ?, avatar = ?, default_city = ?, default_mode = ?, updated_at = ?
       WHERE id = ?`
    ),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    // ---- 分享列表 ----
    insertShare: db.prepare(
      `INSERT INTO shares (trip_id, user_id, city, title, base, files, text, stops, distance_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getShare: db.prepare('SELECT * FROM shares WHERE id = ?'),
    findShareByBase: db.prepare('SELECT * FROM shares WHERE base = ? ORDER BY id DESC LIMIT 1'),
    listShares: db.prepare('SELECT * FROM shares ORDER BY id DESC LIMIT ?'),
    listSharesByUser: db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    claimTrips: db.prepare('UPDATE trips SET user_id = ? WHERE user_id IS NULL'),
    claimShares: db.prepare('UPDATE shares SET user_id = ? WHERE user_id IS NULL'),
    countTripsCity: db.prepare('SELECT COUNT(*) AS c FROM trips WHERE city = ?'),
    deleteShare: db.prepare('DELETE FROM shares WHERE id = ?'),
  };

  const api = {
    raw: db,
    createTrip({ city, title, theme, userId }) {
      const info = stmts.insertTrip.run(city, title, theme || null, userId ?? null);
      return stmts.getTrip.get(toNumber(info.lastInsertRowid));
    },
    // userId 必须给：只看得到自己的行程（旧数据 user_id 为 NULL，不会被任何人看到，要先认领）
    listTrips(userId, city) {
      if (userId == null) return [];
      return city ? stmts.listTripsByUserCity.all(Number(userId), city) : stmts.listTripsByUser.all(Number(userId));
    },
    getTrip(id) {
      return stmts.getTrip.get(id);
    },
    // 这一趟是不是他的（不是就当不存在）
    getTripOfUser(id, userId) {
      const trip = stmts.getTrip.get(Number(id));
      if (!trip) return null;
      return Number(trip.user_id) === Number(userId) ? trip : null;
    },
    deleteTrip(id) {
      db.exec('BEGIN');
      try {
        stmts.deletePinsOfTrip.run(id);
        const info = stmts.deleteTrip.run(id);
        db.exec('COMMIT');
        return { changes: info.changes };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    // 删除该城市里「他的」全部行程与地点（别人同城的动不了）
    deleteCityTrips(city, userId) {
      if (userId == null) return { city, trips: 0, pins: 0 };
      db.exec('BEGIN');
      try {
        const pins = stmts.deleteCityPinsOfUser.run(city, Number(userId));
        const trips = stmts.deleteCityTripsOfUser.run(city, Number(userId));
        db.exec('COMMIT');
        return {
          city,
          trips: toNumber(trips.changes),
          pins: toNumber(pins.changes),
        };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    addPin(pin) {
      const info = stmts.insertPin.run(
        pin.trip_id,
        pin.poi_id || null,
        pin.name,
        pin.address || '',
        Number(pin.lng),
        Number(pin.lat),
        pin.category || 'other',
        pin.rating || null,
        pin.cost || null,
        pin.tel || null,
        pin.photo || null,
        pin.note || null
      );
      return stmts.getPin.get(toNumber(info.lastInsertRowid));
    },
    getPinsByTrip(tripId) {
      return stmts.pinsByTrip.all(tripId);
    },
    getPin(id) {
      return stmts.getPin.get(id);
    },
    deletePin(id) {
      const info = stmts.deletePin.run(id);
      return { changes: info.changes };
    },
    addNote(note) {
      const info = stmts.insertNote.run(
        note.pin_id ?? null,
        note.city || null,
        note.url,
        note.title || null,
        note.source || null
      );
      return stmts.getNote.get(toNumber(info.lastInsertRowid));
    },
    // 带内容的完整入库（笔记本地缓存）
    // P4：kind（note/video）与视频链接、原始分享文案也一起落库
    addNoteFull(note) {
      const info = stmts.insertNoteFull.run(
        note.pin_id ?? null,
        note.city || null,
        note.url,
        note.title || null,
        note.source || null,
        note.source_type || null,
        note.kind || null,
        note.author || null,
        note.content || null,
        note.cover || null,
        note.images ? JSON.stringify(note.images) : null,
        note.tags ? JSON.stringify(note.tags) : null,
        note.video_url || null,
        note.share_text || null,
        note.fetched_at || null
      );
      return stmts.getNote.get(toNumber(info.lastInsertRowid));
    },
    // 改身份信息（平台/形态/链接）；正文与图仍走 setNotePayload
    setNoteIdent(id, patch = {}) {
      const cur = stmts.getNote.get(id);
      if (!cur) return null;
      stmts.setNoteIdent.run(
        patch.title != null ? patch.title : cur.title,
        patch.source != null ? patch.source : cur.source,
        patch.source_type != null ? patch.source_type : cur.source_type,
        patch.kind != null ? patch.kind : cur.kind,
        patch.url != null ? patch.url : cur.url,
        patch.video_url != null ? patch.video_url : cur.video_url,
        patch.share_text != null ? patch.share_text : cur.share_text,
        new Date().toISOString(),
        id
      );
      return stmts.getNote.get(id) || null;
    },
    // 地点候选整批替换（重跑提取/补全不堆历史垃圾）
    replaceNotePlaces(noteId, rows) {
      db.exec('BEGIN');
      try {
        stmts.deleteNotePlaces.run(noteId);
        (rows || []).forEach((p) => {
          stmts.insertNotePlace.run(
            noteId,
            p.name,
            p.poi_name || null,
            p.city || null,
            p.poi_id || null,
            p.address || null,
            p.lng == null ? null : Number(p.lng),
            p.lat == null ? null : Number(p.lat),
            p.rating == null || p.rating === '' ? null : Number(p.rating),
            p.category || null,
            p.photo || null,
            p.source || null,
            p.resolved_at || null
          );
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return stmts.listNotePlaces.all(noteId);
    },
    listNotePlaces(noteId) {
      return stmts.listNotePlaces.all(noteId);
    },
    searchNotes({ q = '', source = '', city = '', limit = 200 } = {}) {
      const like = '%' + q + '%';
      return stmts.searchNotes.all(
        q,
        like,
        like,
        like,
        source,
        source,
        source,
        city,
        city,
        Number(limit) || 200
      );
    },
    setNotePayload(id, { author, content, cover, images, tags } = {}) {
      stmts.setNotePayload.run(
        author || null,
        content || null,
        cover || null,
        images ? JSON.stringify(images) : null,
        tags ? JSON.stringify(tags) : null,
        new Date().toISOString(),
        id
      );
      return stmts.getNote.get(id) || null;
    },
    listNotes(city) {
      return city ? stmts.listNotesCity.all(city) : stmts.listNotesAll.all();
    },
    findNoteByUrl(url) {
      if (!url) return null;
      return stmts.findNoteByUrl.get(String(url)) || null;
    },
    deleteNote(id) {
      // 地点候选跟笔记一起走（不留孤儿行）
      stmts.deleteNotePlaces.run(id);
      const info = stmts.deleteNote.run(id);
      return { changes: info.changes };
    },

    // ---- T2 选中模型 ----
    getCityTrip(city, userId) {
      if (userId == null) return null;
      return stmts.tripByCityForUser.get(city, Number(userId)) || null;
    },
    getOrCreateCityTrip(city, userId) {
      if (userId == null) throw new Error('getOrCreateCityTrip 需要 userId');
      const existing = stmts.tripByCityForUser.get(city, Number(userId));
      if (existing) {
        const fixed = dedupeCityTitle(city, existing.title);
        if (fixed !== existing.title) {
          stmts.updateTripTitle.run(fixed, existing.id);
          return stmts.getTrip.get(existing.id);
        }
        return existing;
      }
      return this.createTrip({ city, title: `${city} · 我的行程`, userId });
    },
    getSelectionByCity(city, userId) {
      if (userId == null) return [];
      return stmts.selectionByCityForUser.all(city, Number(userId));
    },
    insertPinIfAbsent(city, poi, userId) {
      if (userId == null) throw new Error('insertPinIfAbsent 需要 userId');
      const existing = stmts.pinByCityPoiForUser.get(city, Number(userId), poi.id);
      if (existing) return existing;
      const trip = this.getOrCreateCityTrip(city, userId);
      const { next } = stmts.nextSortOrder.get(trip.id);
      const info = stmts.insertPinOrdered.run(
        trip.id,
        poi.id,
        poi.name,
        poi.address || '',
        Number(poi.lng),
        Number(poi.lat),
        poi.category || 'other',
        poi.rating || null,
        poi.cost || null,
        poi.tel || null,
        poi.photo || null,
        poi.note || null,
        Number(next) || 0
      );
      return stmts.getPin.get(toNumber(info.lastInsertRowid));
    },
    // 按 poi 删 / 排：只动当前用户自己那些行程里的点
    deletePinByPoi(city, poiId, userId) {
      if (userId == null) return { changes: 0 };
      const info = stmts.deletePinByPoiOfUser.run(city, Number(userId), poiId);
      return { changes: toNumber(info.changes) };
    },
    reorderPins(city, poiIds, userId) {
      if (userId == null) return [];
      db.exec('BEGIN');
      try {
        poiIds.forEach((poiId, index) => {
          const key = String(poiId);
          // 客户端的点序口径：有 poi_id 给 poi_id，没有的给 pin:<pins.id>（见 web/js/selection.js::mapPin）
          const synthetic = /^pin:(\d+)$/.exec(key);
          if (synthetic) stmts.setSortOrderByPinOfUser.run(index, Number(synthetic[1]), Number(userId), city);
          else stmts.setSortOrderOfUser.run(index, key, Number(userId), city);
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return this.getSelectionByCity(city, userId);
    },
    updatePinNote(id, note) {
      const info = stmts.updatePinNote.run(note, id);
      return { changes: info.changes, pin: stmts.getPin.get(id) };
    },

    // 整条行程的备注（空字符串也当成「写了个空的」，存 NULL 更干净）
    updateTripTitle(id, title) {
      const info = stmts.updateTripTitle.run(String(title), id);
      return { changes: info.changes, trip: stmts.getTrip.get(id) };
    },

    updateTripNote(id, note) {
      const text = note === undefined || note === null || String(note).trim() === '' ? null : String(note);
      const info = stmts.updateTripNote.run(text, id);
      return { changes: info.changes, trip: stmts.getTrip.get(id) };
    },

    // ---- T4 POI 缓存 ----
    upsertPoi(poi) {
      const photos = JSON.stringify(Array.isArray(poi.photos) ? poi.photos : []);
      const tags = JSON.stringify(Array.isArray(poi.tags) ? poi.tags : []);
      const fetchedAt = poi.fetched_at || new Date().toISOString();
      const hash = contentHash({ ...poi, photos, tags: JSON.parse(tags) });
      const existing = stmts.getPoiRow.get(poi.poi_id);
      if (existing) {
        stmts.updatePoi.run(
          poi.city,
          poi.adcode || null,
          poi.category,
          poi.name,
          poi.address || '',
          Number(poi.lng),
          Number(poi.lat),
          poi.typecode || null,
          poi.rating || null,
          poi.cost || null,
          poi.tel || null,
          photos,
          tags,
          fetchedAt,
          hash,
          poi.poi_id
        );
        return { status: 'updated', row: stmts.getPoiRow.get(poi.poi_id) };
      }
      stmts.insertPoi.run(
        poi.poi_id,
        poi.city,
        poi.adcode || null,
        poi.category,
        poi.name,
        poi.address || '',
        Number(poi.lng),
        Number(poi.lat),
        poi.typecode || null,
        poi.rating || null,
        poi.cost || null,
        poi.tel || null,
        photos,
        tags,
        fetchedAt,
        hash
      );
      return { status: 'inserted', row: stmts.getPoiRow.get(poi.poi_id) };
    },
    getPoi(poiId) {
      return stmts.getPoiRow.get(poiId) || null;
    },
    // 一条 POI 的已存内容指纹（可能为 null：未回填）
    poiContentHash(poiId) {
      const row = stmts.getPoiHash.get(poiId);
      return row ? row.content_sha256 : null;
    },
    // 某城市全部 POI 的集合指纹（与顺序无关）——用于「库没被悄悄改动」的核账
    poiDigest(city) {
      const rows = stmts.listPoiHashes.all(city);
      const withHash = rows.filter((r) => r.content_sha256);
      return {
        total: rows.length,
        hashed: withHash.length,
        digest: setDigest(withHash.map((r) => ({ poi_id: r.poi_id, hash: r.content_sha256 }))),
      };
    },
    countPois(city, category) {
      if (category) {
        const rows = stmts.countPoisByCat.all(city);
        const hit = rows.find((r) => r.category === category);
        return hit ? toNumber(hit.c) : 0;
      }
      return toNumber(stmts.countPoisCity.get(city).c);
    },
    listPois({ city, category, minRating, sort, limit, offset, bbox } = {}) {
      if (!city) return { total: 0, items: [] };
      const where = ['city = ?'];
      const params = [city];
      if (category) {
        where.push('category = ?');
        params.push(category);
      }
      if (minRating !== undefined && minRating !== null && minRating !== '') {
        where.push("rating IS NOT NULL AND rating <> '' AND CAST(rating AS REAL) >= ?");
        params.push(Number(minRating));
      }
      if (bbox) {
        where.push('lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?');
        params.push(
          Number(bbox.minLng),
          Number(bbox.maxLng),
          Number(bbox.minLat),
          Number(bbox.maxLat)
        );
      }
      const whereSql = 'WHERE ' + where.join(' AND ');
      const orderSql =
        sort === 'rating'
          ? "ORDER BY (rating IS NULL OR rating = '') ASC, CAST(rating AS REAL) DESC, name ASC"
          : 'ORDER BY name ASC';
      const off = Math.max(0, Number(offset) || 0);
      // 有 bbox（视野加载）且不给 limit → 框内全量返回；其余情况保持既有默认封顶 200
      const hasLimit = limit !== undefined && limit !== null && limit !== '';
      const lim = hasLimit ? Math.max(0, Number(limit) || 0) || 200 : bbox ? null : 200;
      const total = toNumber(
        db.prepare(`SELECT COUNT(*) AS c FROM pois ${whereSql}`).get(...params).c
      );
      const rows =
        lim === null
          ? db.prepare(`SELECT * FROM pois ${whereSql} ${orderSql}`).all(...params)
          : db
              .prepare(`SELECT * FROM pois ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
              .all(...params, lim, off);
      return { total, items: rows.map(mapPoiRow) };
    },
    // P9-⑥ 本地关键词搜索：高德配额用尽 / 没结果时的回退，直接查本地已收录的 pois。
    // 支持空格分开的多词：每个词都必须在 name/address 里出现（AND）。
    // 排序：**名字里有的排在「只有地址里有」的前面**（搜「西湖」不该先给一条地址里带西湖的民宿），
    // 同一档再按评分降序。命中行带 local: true，调用方据此告诉用户「结果来自本地缓存」。
    searchPoisLocal({ city, keywords, category, limit = 60 } = {}) {
      const kw = String(keywords == null ? '' : keywords).trim();
      if (!city || !kw) return [];
      const where = ['city = ?'];
      const params = [city];
      if (category) {
        where.push('category = ?');
        params.push(category);
      }
      kw
        .split(/\s+/)
        .filter((t) => t)
        .slice(0, 4)
        .forEach((t) => {
          where.push("(name LIKE ? OR COALESCE(address, '') LIKE ?)");
          params.push('%' + t + '%', '%' + t + '%');
        });
      const lim = Math.max(1, Math.min(200, Number(limit) || 60));
      // ORDER BY 里的 ? 按出现顺序接在 WHERE 的 ? 后面。
      // 档位：名字**完全相同** > 名字**以它开头** > 名字里含它 > 只有地址里有它；
      // 同一档内按评分降序（搜「西湖」先给「西湖风景名胜区」，而不是「…民宿(西湖湖滨商圈店)」）
      const rows = db
        .prepare(
          'SELECT * FROM pois WHERE ' +
            where.join(' AND ') +
            ' ORDER BY CASE' +
            ' WHEN name = ? THEN 0' +
            ' WHEN name LIKE ? THEN 1' +
            ' WHEN name LIKE ? THEN 2' +
            ' ELSE 3 END,' +
            " (rating IS NULL OR rating = '') ASC, CAST(rating AS REAL) DESC, name ASC LIMIT ?"
        )
        .all(...params, kw, kw + '%', '%' + kw + '%', lim);
      return rows.map((r) => ({ ...mapPoiRow(r), local: true }));
    },
    // 点地图任意处：这一带我们库里真有的点（P19）。deg 是粗筛方框半径（度，0.0015 ≈ 150m）。
    poisNearPoint({ lng, lat, deg = 0.0015, limit = 5 } = {}) {
      const x = Number(lng);
      const y = Number(lat);
      const d = Number(deg) > 0 ? Number(deg) : 0.0015;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      const lim = Math.max(1, Math.min(50, Number(limit) || 5));
      // 经度方向乘 cos(纬度)² ≈ 0.75（杭州一带）—— 只用于排序，够用
      const rows = db
        .prepare(
          'SELECT * FROM pois WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?' +
            ' ORDER BY ((lng - ?) * (lng - ?) * 0.75 + (lat - ?) * (lat - ?)) ASC LIMIT ?'
        )
        .all(x - d, x + d, y - d, y + d, x, x, y, y, lim);
      return rows.map(mapPoiRow);
    },
    poisStats(city) {
      const rows = stmts.countPoisByCat.all(city);
      const total = toNumber(stmts.countPoisCity.get(city).c);
      const countWhere = (cond) =>
        toNumber(
          db.prepare(`SELECT COUNT(*) AS c FROM pois WHERE city = ? AND ${cond}`).get(city).c
        );
      const ratingBuckets = [
        { label: '≥4.5', count: countWhere("rating <> '' AND CAST(rating AS REAL) >= 4.5") },
        {
          label: '4.0–4.5',
          count: countWhere(
            "rating <> '' AND CAST(rating AS REAL) >= 4.0 AND CAST(rating AS REAL) < 4.5"
          ),
        },
        {
          label: '3.5–4.0',
          count: countWhere(
            "rating <> '' AND CAST(rating AS REAL) >= 3.5 AND CAST(rating AS REAL) < 4.0"
          ),
        },
        { label: '<3.5', count: countWhere("rating <> '' AND CAST(rating AS REAL) < 3.5") },
        { label: '无评分', count: countWhere("rating IS NULL OR rating = ''") },
      ];
      return {
        total,
        categories: rows.map((r) => ({ key: r.category, count: toNumber(r.c) })),
        ratingBuckets,
      };
    },
    createRun({ city, category }) {
      const info = stmts.insertRun.run(city, category, new Date().toISOString());
      return stmts.getRun.get(toNumber(info.lastInsertRowid));
    },
    updateRun(id, fields = {}) {
      const sets = [];
      const params = [];
      const push = (col, val) => {
        sets.push(`${col} = ?`);
        params.push(val);
      };
      if (fields.status !== undefined) push('status', fields.status);
      if (fields.finished_at !== undefined) push('finished_at', fields.finished_at);
      if (fields.n_fetched !== undefined) push('n_fetched', Number(fields.n_fetched) || 0);
      if (fields.n_inserted !== undefined) push('n_inserted', Number(fields.n_inserted) || 0);
      if (fields.n_updated !== undefined) push('n_updated', Number(fields.n_updated) || 0);
      if (fields.detail !== undefined) push('detail', JSON.stringify(fields.detail));
      if (sets.length) {
        params.push(id);
        db.prepare(`UPDATE poi_collect_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
      return stmts.getRun.get(id);
    },
    getRun(id) {
      return stmts.getRun.get(id) || null;
    },
    findRunningRun(city, category) {
      return stmts.findRunningRun.get(city, category) || null;
    },
    // ---- T8 采集覆盖格 ----
    isCovered(city, category, gx, gy) {
      return !!stmts.isCovered.get(city, category, gx, gy);
    },
    markCovered(city, category, gx, gy, nInserted = 0, truncated = false) {
      stmts.markCovered.run(
        city,
        category,
        gx,
        gy,
        new Date().toISOString(),
        Number(nInserted) || 0,
        truncated ? 1 : 0
      );
    },
    listCoverage(city, category) {
      return stmts.listCoverage.all(city, category);
    },
    listCoverageRange(city, category, minGx, maxGx, minGy, maxGy) {
      return stmts.listCoverageRange.all(city, category, minGx, maxGx, minGy, maxGy);
    },
    listRuns(city) {
      const rows = stmts.listRunsByCity.all(city);
      const seen = new Set();
      const out = [];
      rows.forEach((r) => {
        if (seen.has(r.category)) return;
        seen.add(r.category);
        out.push(r);
      });
      return out;
    },
    // 一条路线就是一个有序清单：不再按类别分组（页面上列表也是不分的），
    // 有明确点序（order）时就按那条顺序排，没有就按库里的 sort_order。
    buildItineraryMarkdown(city, labels = DEFAULT_CATEGORY_LABELS, order = null, userId = null) {
      const trip = userId == null ? null : stmts.tripByCityForUser.get(city, Number(userId));
      const pins = applyPoiOrder(
        userId == null ? [] : stmts.selectionByCityForUser.all(city, Number(userId)),
        order
      );
      void labels; // 兼容老调用点：分组标题已取消，labels 不再参与排版
      const title = (trip && trip.title) || `${city} · 我的行程`;
      const lines = [`# ${title}（${pins.length} 个地点）`];
      pins.forEach((pin, index) => {        const meta = [];
        if (pin.rating) meta.push(`★${pin.rating}`);
        if (pin.cost) meta.push(`¥${pin.cost}`);
        const suffix = meta.length ? `（${meta.join(' · ')}）` : '';
        lines.push(`${index + 1}. ${pin.name} — ${pin.address || '（无详细地址）'}${suffix}`);
      });
      return lines.join('\n');
    },
    // 城市轮廓：rings 不在或为空就当作没缓存（宁可重新拉，也别画一张空图）
    getCityBoundary(city) {
      const row = stmts.getCityBoundary.get(city);
      if (!row) return null;
      const rings = parseJsonArray(row.rings);
      if (!rings.length) return null;
      return {
        name: row.name || city,
        adcode: row.adcode || '',
        center: parseJsonArray(row.center),
        bbox: parseJsonArray(row.bbox),
        rings,
        fetchedAt: row.fetched_at,
        cached: true,
      };
    },
    saveCityBoundary(city, b) {
      const data = b || {};
      stmts.upsertCityBoundary.run(
        city,
        data.name || city,
        data.adcode || '',
        JSON.stringify(data.center || null),
        JSON.stringify(data.bbox || null),
        JSON.stringify(data.rings || []),
        data.fetchedAt || new Date().toISOString()
      );
      return this.getCityBoundary(city);
    },
    // ---- 账号 / 会话（账号密码登录；密码 scrypt 哈希，会话存 token 的 sha256）----
    createUser({ username, passwordHash, salt, nickname }) {
      const info = stmts.insertUser.run(username, passwordHash, salt, nickname || username);
      return stmts.getUserById.get(toNumber(info.lastInsertRowid));
    },
    getUserByName(username) {
      return stmts.getUserByName.get(String(username)) || null;
    },
    getUserById(id) {
      return stmts.getUserById.get(Number(id)) || null;
    },
    updateUser(id, fields) {
      const cur = stmts.getUserById.get(Number(id));
      if (!cur) return null;
      stmts.updateUser.run(
        fields.nickname !== undefined ? fields.nickname : cur.nickname,
        fields.avatar !== undefined ? fields.avatar : cur.avatar,
        fields.defaultCity !== undefined ? fields.defaultCity : cur.default_city,
        fields.defaultMode !== undefined ? fields.defaultMode : cur.default_mode,
        new Date().toISOString(),
        Number(id)
      );
      return stmts.getUserById.get(Number(id));
    },
    createSession({ tokenHash, userId, expiresAt }) {
      stmts.insertSession.run(tokenHash, Number(userId), expiresAt);
    },
    getSession(tokenHash) {
      const row = stmts.getSession.get(String(tokenHash));
      if (!row) return null;
      if (row.expires_at && String(row.expires_at) < new Date().toISOString()) {
        stmts.deleteSession.run(String(tokenHash));
        return null;
      }
      return row;
    },
    deleteSession(tokenHash) {
      const info = stmts.deleteSession.run(String(tokenHash));
      return { changes: toNumber(info.changes) };
    },
    purgeExpiredSessions(nowIso) {
      const info = stmts.purgeSessions.run(nowIso || new Date().toISOString());
      return { changes: toNumber(info.changes) };
    },

    addShare(s) {
      const info = stmts.insertShare.run(
        s.tripId ?? null,
        s.userId ?? null,
        s.city,
        s.title,
        s.base,
        s.files ? JSON.stringify(s.files) : null,
        s.text || null,
        Number(s.stops) || 0,
        Number.isFinite(Number(s.distanceM)) ? Number(s.distanceM) : null
      );
      return parseShareRow(stmts.getShare.get(toNumber(info.lastInsertRowid)));
    },
    listShares(limit) {
      return stmts.listShares.all(Number(limit) || 50).map(parseShareRow);
    },
    listSharesByUser(userId, limit) {
      if (userId == null) return [];
      return stmts.listSharesByUser.all(Number(userId), Number(limit) || 50).map(parseShareRow);
    },
    countUnowned() {
      const trips = toNumber(stmts.countUnownedTrips.get().c);
      const shares = toNumber(stmts.countUnownedShares.get().c);
      return { trips, shares };
    },
    // 旧数据认领：把没有归属的行程 / 分享归给当前账号（单机场景下的迁移用）
    claimUnowned(userId) {
      if (userId == null) return { trips: 0, shares: 0 };
      db.exec('BEGIN');
      try {
        const t = stmts.claimTrips.run(Number(userId));
        const s = stmts.claimShares.run(Number(userId));
        db.exec('COMMIT');
        return { trips: toNumber(t.changes), shares: toNumber(s.changes) };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getShare(id) {
      const row = stmts.getShare.get(Number(id));
      return row ? parseShareRow(row) : null;
    },
    findShareByBase(base) {
      const row = stmts.findShareByBase.get(String(base));
      return row ? parseShareRow(row) : null;
    },
    deleteShare(id) {
      const info = stmts.deleteShare.run(Number(id));
      return { changes: toNumber(info.changes) };
    },
    countPoisByCity(city) {
      const row = stmts.countPoisCity.get(String(city));
      return toNumber(row && row.c);
    },
    countTripsByCity(city) {
      const row = stmts.countTripsCity.get(String(city));
      return toNumber(row && row.c);
    },
    updateTripTheme(id, theme) {
      stmts.updateTripTheme.run(theme || null, Number(id));
      return stmts.getTrip.get(Number(id));
    },
    close() {
      db.close();
    },
  };

  // 存量行回填内容指纹（幂等；新库无行直接跳过）。
  // 包在一个事务里：38k 行逐行隐式事务会慢到让启动卡住（每行一次 fsync）。
  const missing = db.prepare('SELECT COUNT(*) AS c FROM pois WHERE content_sha256 IS NULL').get();
  if (toNumber(missing && missing.c) > 0) {
    db.exec('BEGIN');
    try {
      for (;;) {
        const rows = stmts.listMissingHashes.all();
        if (!rows.length) break;
        rows.forEach((row) => {
          stmts.setPoiHash.run(
            contentHash({
              ...row,
              photos: parseJsonArray(row.photos),
              tags: parseJsonArray(row.tags),
            }),
            row.poi_id
          );
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return api;
}

module.exports = { createDb, SCHEMA };
