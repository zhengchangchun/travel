const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash, setDigest } = require('./poi-hash');
const { applyPoiOrder } = require('./order');
const { createPoiStore } = require('./poi-store');

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
  -- 预约与时间段（2026-11-25）：用户自己的安排，不是高德的事实
  booking     TEXT NOT NULL DEFAULT 'none',
  slot        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 旅游搭子（同行的人）：一个人一条，随身带上关系/口味/习惯这类“约他出去玩要知道的事”
CREATE TABLE IF NOT EXISTS buddies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  relation   TEXT,
  tags       TEXT,
  contact    TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 这趟行程跟谁一起（一个搭子可以出现在多趟里）
CREATE TABLE IF NOT EXISTS trip_buddies (
  trip_id  INTEGER NOT NULL,
  buddy_id INTEGER NOT NULL,
  PRIMARY KEY (trip_id, buddy_id)
);

-- 一起改（2026-11-24，对标圆周旅迹的多人协作）：一趟行程可以有多个成员
--   role: owner（建的人）/ editor（被邀请进来一起改的）
CREATE TABLE IF NOT EXISTS trip_members (
  trip_id   INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role      TEXT NOT NULL DEFAULT 'editor',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, user_id)
);

-- 邀请链接：一个 token 对应一趟行程，可撤销、可过期（默认 30 天）
CREATE TABLE IF NOT EXISTS trip_invites (
  token      TEXT PRIMARY KEY,
  trip_id    INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trip_invites_trip ON trip_invites (trip_id);

-- 行程留言：分享页/协作页上「大家一起商量」的落点（append-only，不删不改）
CREATE TABLE IF NOT EXISTS trip_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL,
  user_id    INTEGER,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trip_comments_trip ON trip_comments (trip_id, id);

-- 每个点下面的小清单：到了这个地方「必去/要做的事」（一个点可以多条）
CREATE TABLE IF NOT EXISTS pin_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_id     INTEGER NOT NULL,
  user_id    INTEGER,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pin_items_pin ON pin_items (pin_id);

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

-- 2026-11-25：pois / poi_coverage / city_boundaries 三张表**不再建**。
-- 用户口径「不要所有的数据都存在本地，可以做缓存 但是不能持久化到我这，
-- 要不然数据更新了 我们就都是错的」—— 地点、评分、人均、电话、图片、行政区划
-- 都是上游事实，落盘就会变成「静默的错」。它们现在只在内存里带 TTL 活着（server/poi-store.js）。
-- 老库里的这三张表不主动删（删数据不可逆），但代码不再读写它们。

-- 采集运行日志（poi_collect_runs）仍落盘：那是「我们做过什么」的记录，不是上游事实。
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
`;

const DEFAULT_CATEGORY_LABELS = {
  food: '美食',
  stay: '住宿',
  sight: '景点',
  play: '游玩',
};

// 时间段与预约的文案（2026-11-25）：与 server/share.js 同一套说法（行程单/分享包/页面三处一致）
const SLOT_LABEL = { morning: '上午', afternoon: '下午', evening: '傍晚', night: '晚上' };
const BOOKING_LABEL = { needed: '建议提前预约', required: '必须提前预约（没约进不去）' };

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
function mapItemRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: toNumber(row.id),
    pin_id: toNumber(row.pin_id),
    user_id: row.user_id == null ? null : toNumber(row.user_id),
    done: !!toNumber(row.done),
    sort_order: toNumber(row.sort_order),
  };
}

function toNullableText(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function mapBuddyRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: toNumber(row.id),
    user_id: toNumber(row.user_id),
    tags: parseJsonArray(row.tags),
    tripCount: toNumber(row.trip_count || 0),
  };
}

function ensureColumn(db, table, column, ddl) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function createDb(filePath, opts = {}) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // POI / 覆盖账本 / 城市轮廓：内存缓存（带 TTL，不落盘）。
  // 用户口径（2026-11-25）：「不要所有的数据都存在本地，可以做缓存 但是不能持久化到我这，
  // 要不然数据更新了 我们就都是错的」。可注入（测试里换短 TTL / 假时钟）。
  const poiStore = opts.poiStore || createPoiStore();
  ensureColumn(db, 'pins', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
  // 预约与时间段（2026-11-25）：这两样是**用户自己的安排**，不是高德的事实 ⇒ 存库。
  //   booking：none（不用预约）/ needed（建议预约）/ required（必须预约，没约进不去）
  //   slot：morning / afternoon / evening / night（打算什么时候去）
  // 营业时间不在这里 —— 那个会变，每次实时取（见 /api/poi/business）。
  ensureColumn(db, 'pins', 'booking', "booking TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, 'pins', 'slot', 'slot TEXT');
  // 行程自己的备注（「先吃饭再逛」这类整条行程的话）—— 每条地点的备注在 pins.note
  ensureColumn(db, 'trips', 'note', 'note TEXT');
  // 一城可多趟：主题（比如「西线＋东线」）与归属用户
  ensureColumn(db, 'trips', 'theme', 'theme TEXT');
  ensureColumn(db, 'trips', 'user_id', 'user_id INTEGER');
  // POI 内容指纹列（存量库前滚；缺失指纹的行在下面回填）
  // 2026-11-25：pois 已不落盘，这行只为兼容老库（表还在但不再读写）
  try {
    ensureColumn(db, 'pois', 'content_sha256', 'content_sha256 TEXT');
  } catch (err) {
    /* 新库没有 pois 表：正常 */
  }
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

  // 按天分段：每个点属于第几天（默认 1）——要多天就得先有这个列，再建下面那些语句
  ensureColumn(db, 'pins', 'day', 'day INTEGER NOT NULL DEFAULT 1');
  // 待规划（2026-11-24，对标圆周旅迹的「待规划地点」）：先收着、还没排进日程的点。
  // planned = 已排进行程（默认，老数据全是这个）；wish = 待规划（只在候选清单里，不参与连线/分享）
  ensureColumn(db, 'pins', 'status', "status TEXT NOT NULL DEFAULT 'planned'");
  // 笔记也按账号隔离（账号上线前的笔记 user_id 为空，靠「认领」归给某个账号）
  ensureColumn(db, 'notes', 'user_id', 'user_id INTEGER');

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
      'INSERT INTO notes (pin_id, city, url, title, source, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    getNote: db.prepare('SELECT * FROM notes WHERE id = ?'),
    findNoteByUrl: db.prepare('SELECT * FROM notes WHERE url = ? ORDER BY id LIMIT 1'),
    listNotesAll: db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY id DESC'),
    listNotesCity: db.prepare('SELECT * FROM notes WHERE user_id = ? AND city = ? ORDER BY id DESC'),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),
    insertNoteFull: db.prepare(
      `INSERT INTO notes (pin_id, city, url, title, source, source_type, kind, author, content, cover, images, tags, video_url, share_text, fetched_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    // 本地搜索：关键词命中标题/正文/作者；source 同时认 source 与 source_type（小红书/抖音…）
    searchNotes: db.prepare(
      `SELECT * FROM notes
        WHERE user_id = ?
          AND (? = '' OR COALESCE(title, '') LIKE ? OR COALESCE(content, '') LIKE ? OR COALESCE(author, '') LIKE ?)
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
    // 按「某一趟」看点的序（一城多趟之后，规划页一次只改一趟）
    pinsByTripOrdered: db.prepare('SELECT * FROM pins WHERE trip_id = ? ORDER BY day, sort_order, id'),
    pinInTripByPoi: db.prepare(
      'SELECT * FROM pins WHERE trip_id = ? AND poi_id = ? ORDER BY id LIMIT 1'
    ),
    maxSortInTrip: db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pins WHERE trip_id = ?'
    ),
    insertPinInTrip: db.prepare(
      `INSERT INTO pins (trip_id, poi_id, name, address, lng, lat, category, rating, cost, tel, photo, note, sort_order, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    deletePinOfTripByPoi: db.prepare('DELETE FROM pins WHERE trip_id = ? AND poi_id = ?'),
    setSortOrderInTrip: db.prepare('UPDATE pins SET sort_order = ? WHERE poi_id = ? AND trip_id = ?'),
    setSortOrderByPinInTrip: db.prepare('UPDATE pins SET sort_order = ? WHERE id = ? AND trip_id = ?'),
    countPinsByTrip: db.prepare('SELECT COUNT(*) AS c FROM pins WHERE trip_id = ?'),
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
    updatePinDay: db.prepare('UPDATE pins SET day = ? WHERE id = ?'),
    updatePinStatus: db.prepare('UPDATE pins SET status = ? WHERE id = ?'),
    // 预约与时间段（2026-11-25）：用户自己的安排
    updatePinBooking: db.prepare('UPDATE pins SET booking = ? WHERE id = ?'),
    updatePinSlot: db.prepare('UPDATE pins SET slot = ? WHERE id = ?'),

    // ---- POI / 覆盖账本 / 城市轮廓：2026-11-25 起**不落盘**，全在内存（server/poi-store.js）----
    // 下面这些 SQL 语句已删除：pois / poi_coverage / city_boundaries 三张表不再读写。
    // 采集运行日志仍落盘（那是「我们做过什么」，不是上游事实）。
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
    // 同一趟行程只留最新一条分享（2026-11-24：实测同一趟导出 6 次就堆 6 行一模一样的）
    deleteSharesOfTrip: db.prepare('DELETE FROM shares WHERE user_id = ? AND trip_id = ?'),
    listSharesOfTrip: db.prepare('SELECT * FROM shares WHERE user_id = ? AND trip_id = ? ORDER BY id DESC'),
    listShares: db.prepare('SELECT * FROM shares ORDER BY id DESC LIMIT ?'),
    listSharesByUser: db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    claimTrips: db.prepare('UPDATE trips SET user_id = ? WHERE user_id IS NULL'),
    // ---- 旅游搭子 ----
    listBuddies: db.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM trip_buddies tb JOIN trips t ON t.id = tb.trip_id
                    WHERE tb.buddy_id = b.id AND t.user_id = b.user_id) AS trip_count
       FROM buddies b WHERE b.user_id = ? ORDER BY b.name COLLATE NOCASE, b.id`
    ),
    getBuddy: db.prepare('SELECT * FROM buddies WHERE id = ?'),
    getBuddyOfUser: db.prepare('SELECT * FROM buddies WHERE id = ? AND user_id = ?'),
    insertBuddy: db.prepare(
      'INSERT INTO buddies (user_id, name, relation, tags, contact, note) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    updateBuddy: db.prepare(
      "UPDATE buddies SET name = ?, relation = ?, tags = ?, contact = ?, note = ?, updated_at = datetime('now') WHERE id = ?"
    ),
    deleteBuddy: db.prepare('DELETE FROM buddies WHERE id = ?'),
    tripBuddyIds: db.prepare('SELECT buddy_id FROM trip_buddies WHERE trip_id = ? ORDER BY buddy_id'),
    // ---- 一起改：成员 / 邀请 / 留言 ----
    memberOf: db.prepare('SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?'),
    membersOfTrip: db.prepare(
      'SELECT m.*, u.username, u.nickname FROM trip_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.trip_id = ? ORDER BY m.joined_at'
    ),
    insertMember: db.prepare(
      "INSERT OR IGNORE INTO trip_members (trip_id, user_id, role) VALUES (?, ?, 'editor')"
    ),
    deleteMember: db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?'),
    tripsSharedWithUser: db.prepare(
      'SELECT t.* FROM trips t JOIN trip_members m ON m.trip_id = t.id WHERE m.user_id = ? ORDER BY t.id DESC'
    ),
    insertInvite: db.prepare(
      'INSERT INTO trip_invites (token, trip_id, created_by, expires_at) VALUES (?, ?, ?, ?)'
    ),
    getInvite: db.prepare('SELECT * FROM trip_invites WHERE token = ?'),
    invitesOfTrip: db.prepare('SELECT * FROM trip_invites WHERE trip_id = ? ORDER BY created_at DESC'),
    revokeInvitesOfTrip: db.prepare('UPDATE trip_invites SET revoked = 1 WHERE trip_id = ?'),
    insertComment: db.prepare(
      'INSERT INTO trip_comments (trip_id, user_id, author, text) VALUES (?, ?, ?, ?)'
    ),
    commentsOfTrip: db.prepare('SELECT * FROM trip_comments WHERE trip_id = ? ORDER BY id'),
    countComments: db.prepare('SELECT COUNT(*) AS c FROM trip_comments WHERE trip_id = ?'),
    tripBuddiesOfUser: db.prepare(
      'SELECT tb.trip_id, tb.buddy_id FROM trip_buddies tb JOIN trips t ON t.id = tb.trip_id WHERE t.user_id = ?'
    ),
    insertTripBuddy: db.prepare('INSERT OR IGNORE INTO trip_buddies (trip_id, buddy_id) VALUES (?, ?)'),
    deleteTripBuddies: db.prepare('DELETE FROM trip_buddies WHERE trip_id = ?'),
    deleteBuddyLinks: db.prepare('DELETE FROM trip_buddies WHERE buddy_id = ?'),
    // ---- 每个点下面的小清单（pin_items）----
    itemsOfPin: db.prepare('SELECT * FROM pin_items WHERE pin_id = ? ORDER BY sort_order, id'),
    itemsOfTrip: db.prepare(
      `SELECT i.* FROM pin_items i JOIN pins p ON p.id = i.pin_id
       WHERE p.trip_id = ? ORDER BY p.sort_order, p.id, i.sort_order, i.id`
    ),
    itemsOfUser: db.prepare(
      `SELECT i.* FROM pin_items i
       JOIN pins p ON p.id = i.pin_id JOIN trips t ON t.id = p.trip_id
       WHERE t.user_id = ? ORDER BY i.id`
    ),
    getItem: db.prepare('SELECT * FROM pin_items WHERE id = ?'),
    // 这一条是不是他的：一路走到 trips.user_id（不是自己的当不存在）
    itemOfUser: db.prepare(
      `SELECT i.* FROM pin_items i JOIN pins p ON p.id = i.pin_id JOIN trips t ON t.id = p.trip_id
       WHERE i.id = ? AND t.user_id = ?`
    ),
    countItemsOfPin: db.prepare('SELECT COUNT(*) AS c FROM pin_items WHERE pin_id = ?'),
    insertItem: db.prepare(
      'INSERT INTO pin_items (pin_id, user_id, text, sort_order) VALUES (?, ?, ?, ?)'
    ),
    nextItemOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM pin_items WHERE pin_id = ?'),
    updateItemText: db.prepare('UPDATE pin_items SET text = ? WHERE id = ?'),
    setItemDone: db.prepare(
      "UPDATE pin_items SET done = ?, done_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?"
    ),
    deleteItem: db.prepare('DELETE FROM pin_items WHERE id = ?'),
    deleteItemsOfPin: db.prepare('DELETE FROM pin_items WHERE pin_id = ?'),
    deleteItemsOfTrip: db.prepare('DELETE FROM pin_items WHERE pin_id IN (SELECT id FROM pins WHERE trip_id = ?)'),
    deleteItemsOfUserCity: db.prepare(
      'DELETE FROM pin_items WHERE pin_id IN (SELECT p.id FROM pins p JOIN trips t ON t.id = p.trip_id WHERE t.city = ? AND t.user_id = ?)'
    ),
    claimNotes: db.prepare('UPDATE notes SET user_id = ? WHERE user_id IS NULL'),
    countUnownedNotes: db.prepare('SELECT COUNT(*) AS c FROM notes WHERE user_id IS NULL'),
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
    // ---- 一起改（2026-11-24）：一趟行程的「能看/能改」不再只看 owner ----
    // 返回 { trip, role } 或 null；role = owner | editor
    getTripForMember(id, userId) {
      const trip = stmts.getTrip.get(Number(id));
      if (!trip) return null;
      if (Number(trip.user_id) === Number(userId)) return { trip, role: 'owner' };
      const m = stmts.memberOf.get(Number(id), Number(userId));
      if (!m) return null;
      return { trip, role: m.role || 'editor' };
    },
    listMembers(tripId) {
      return stmts.membersOfTrip.all(Number(tripId)).map((r) => ({
        userId: toNumber(r.user_id),
        role: r.role || 'editor',
        username: r.username || '',
        nickname: r.nickname || r.username || '',
        joinedAt: r.joined_at,
      }));
    },
    addMember(tripId, userId) {
      stmts.insertMember.run(Number(tripId), Number(userId));
      return this.listMembers(tripId);
    },
    removeMember(tripId, userId) {
      stmts.deleteMember.run(Number(tripId), Number(userId));
      return this.listMembers(tripId);
    },
    listTripsSharedWith(userId) {
      return stmts.tripsSharedWithUser.all(Number(userId));
    },
    createInvite({ token, tripId, createdBy, expiresAt }) {
      stmts.insertInvite.run(String(token), Number(tripId), Number(createdBy), expiresAt || null);
      return stmts.getInvite.get(String(token));
    },
    getInvite(token) {
      return stmts.getInvite.get(String(token)) || null;
    },
    listInvitesOfTrip(tripId) {
      return stmts.invitesOfTrip.all(Number(tripId));
    },
    revokeInvites(tripId) {
      stmts.revokeInvitesOfTrip.run(Number(tripId));
    },
    addComment({ tripId, userId, author, text }) {
      const info = stmts.insertComment.run(Number(tripId), userId == null ? null : Number(userId), String(author), String(text));
      return toNumber(info.lastInsertRowid);
    },
    listComments(tripId) {
      return stmts.commentsOfTrip.all(Number(tripId)).map((r) => ({
        id: toNumber(r.id),
        userId: r.user_id == null ? null : toNumber(r.user_id),
        author: r.author,
        text: r.text,
        createdAt: r.created_at,
      }));
    },
    countComments(tripId) {
      return toNumber(stmts.countComments.get(Number(tripId)).c);
    },
    deleteTrip(id) {
      db.exec('BEGIN');
      try {
        stmts.deleteItemsOfTrip.run(id);   // 点下面的小清单跟着点走
        stmts.deletePinsOfTrip.run(id);
        stmts.deleteTripBuddies.run(id);   // 顺手把「这趟跟谁一起」也清掉
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
        stmts.deleteItemsOfUserCity.run(String(city), Number(userId));
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
    // ---- 旅游搭子：一个人一条；一律只看得到自己的 ----
    listBuddies(userId) {
      if (userId == null) return [];
      return stmts.listBuddies.all(Number(userId)).map(mapBuddyRow);
    },
    getBuddyOfUser(id, userId) {
      if (userId == null) return null;
      return mapBuddyRow(stmts.getBuddyOfUser.get(Number(id), Number(userId)));
    },
    createBuddy({ userId, name, relation, tags, contact, note }) {
      const info = stmts.insertBuddy.run(
        Number(userId),
        String(name),
        toNullableText(relation),
        Array.isArray(tags) && tags.length ? JSON.stringify(tags) : null,
        toNullableText(contact),
        toNullableText(note)
      );
      return mapBuddyRow(stmts.getBuddyOfUser.get(toNumber(info.lastInsertRowid), Number(userId)));
    },
    // 只传要改的那几个字段（没传的保持原样）
    updateBuddyOfUser(id, userId, fields) {
      const cur = stmts.getBuddyOfUser.get(Number(id), Number(userId));
      if (!cur) return null;
      const b = fields || {};
      const pick = (key, fallback) => (b[key] === undefined ? fallback : b[key]);
      const tags =
        b.tags === undefined
          ? cur.tags
          : Array.isArray(b.tags) && b.tags.length
            ? JSON.stringify(b.tags)
            : null;
      const name = String(pick('name', cur.name) == null ? cur.name : pick('name', cur.name)).trim();
      stmts.updateBuddy.run(
        name,
        toNullableText(pick('relation', cur.relation)),
        tags,
        toNullableText(pick('contact', cur.contact)),
        toNullableText(pick('note', cur.note)),
        cur.id
      );
      return mapBuddyRow(stmts.getBuddy.get(cur.id));
    },
    deleteBuddyOfUser(id, userId) {
      const cur = stmts.getBuddyOfUser.get(Number(id), Number(userId));
      if (!cur) return { deleted: 0 };
      db.exec('BEGIN');
      try {
        stmts.deleteBuddyLinks.run(cur.id);   // 从各趟行程里也移掉，别留半条引用
        stmts.deleteBuddy.run(cur.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { deleted: toNumber(cur.id) };
    },
    tripBuddyIds(tripId) {
      return stmts.tripBuddyIds.all(Number(tripId)).map((r) => toNumber(r.buddy_id));
    },
    // 整组替换（页面上是多选，点保存一次提交）
    setTripBuddies(tripId, buddyIds) {
      db.exec('BEGIN');
      try {
        stmts.deleteTripBuddies.run(Number(tripId));
        (buddyIds || []).forEach((bid) => stmts.insertTripBuddy.run(Number(tripId), Number(bid)));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return stmts.tripBuddyIds.all(Number(tripId)).map((r) => toNumber(r.buddy_id));
    },
    // 列表用：一次把我每趟分别跟谁拉出来，别一趟一个查询
    tripBuddiesOfUser(userId) {
      if (userId == null) return {};
      const out = {};
      stmts.tripBuddiesOfUser.all(Number(userId)).forEach((r) => {
        const tripId = toNumber(r.trip_id);
        if (!out[tripId]) out[tripId] = [];
        out[tripId].push(toNumber(r.buddy_id));
      });
      return out;
    },
    // ---- 每个点下面的小清单：一律只看得到自己行程里的 ----
    listTripItems(tripId) {
      return stmts.itemsOfTrip.all(Number(tripId)).map(mapItemRow);
    },
    listPinItems(pinId) {
      return stmts.itemsOfPin.all(Number(pinId)).map(mapItemRow);
    },
    getItemOfUser(itemId, userId) {
      if (userId == null) return null;
      return mapItemRow(stmts.itemOfUser.get(Number(itemId), Number(userId)));
    },
    countItemsOfPin(pinId) {
      return toNumber(stmts.countItemsOfPin.get(Number(pinId)).c);
    },
    createItem({ pinId, userId, text }) {
      const order = toNumber(stmts.nextItemOrder.get(Number(pinId)).n);
      const info = stmts.insertItem.run(Number(pinId), userId == null ? null : Number(userId), String(text), order);
      return mapItemRow(stmts.getItem.get(toNumber(info.lastInsertRowid)));
    },
    updateItemOfUser(itemId, userId, fields) {
      const cur = mapItemRow(stmts.itemOfUser.get(Number(itemId), Number(userId)));
      if (!cur) return null;
      const b = fields || {};
      if (b.text !== undefined) stmts.updateItemText.run(String(b.text), cur.id);
      if (b.done !== undefined) stmts.setItemDone.run(b.done ? 1 : 0, b.done ? 1 : 0, cur.id);
      return mapItemRow(stmts.getItem.get(cur.id));
    },
    deleteItemOfUser(itemId, userId) {
      const cur = mapItemRow(stmts.itemOfUser.get(Number(itemId), Number(userId)));
      if (!cur) return { deleted: 0 };
      stmts.deleteItem.run(cur.id);
      return { deleted: toNumber(cur.id) };
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
      stmts.deleteItemsOfPin.run(Number(id));   // 点没了，它下面的小清单也一起没
      const info = stmts.deletePin.run(id);
      return { changes: info.changes };
    },
    addNote(note) {
      const info = stmts.insertNote.run(
        note.pin_id ?? null,
        note.city || null,
        note.url,
        note.title || null,
        note.source || null,
        note.userId ?? null
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
        note.fetched_at || null,
        note.userId ?? null
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
    searchNotes({ userId = null, q = '', source = '', city = '', limit = 200 } = {}) {
      if (userId == null) return [];
      const like = '%' + q + '%';
      return stmts.searchNotes.all(
        Number(userId),
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
    listNotes(userId, city) {
      if (userId == null) return [];
      return city
        ? stmts.listNotesCity.all(Number(userId), city)
        : stmts.listNotesAll.all(Number(userId));
    },
    // 单条笔记：不是自己的当不存在
    getNoteOfUser(id, userId) {
      const row = stmts.getNote.get(Number(id));
      if (!row) return null;
      return Number(row.user_id) === Number(userId) ? row : null;
    },
    findNoteByUrl(url, userId) {
      if (!url) return null;
      const row = stmts.findNoteByUrl.get(String(url)) || null;
      if (!row) return null;
      // 没给 userId 就照旧返回（内部用途）；给了就只认自己的那条
      if (userId == null) return row;
      return Number(row.user_id) === Number(userId) ? row : null;
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
    // ---- 按「某一趟」工作（一城多趟）----
    getTripPinsOrdered(tripId) {
      return stmts.pinsByTripOrdered.all(Number(tripId));
    },
    countPinsOfTrip(tripId) {
      const row = stmts.countPinsByTrip.get(Number(tripId));
      return toNumber(row && row.c);
    },
    insertPinIntoTrip(tripId, poi) {
      const existing = stmts.pinInTripByPoi.get(Number(tripId), poi.id);
      if (existing) return existing;
      const { next } = stmts.maxSortInTrip.get(Number(tripId));
      const info = stmts.insertPinInTrip.run(
        Number(tripId),
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
        Number(next) || 0,
        Number(poi.day) || 1
      );
      return stmts.getPin.get(toNumber(info.lastInsertRowid));
    },
    updatePinDay(id, day) {
      const n = Math.max(1, Math.min(30, Number(day) || 1));
      const info = stmts.updatePinDay.run(n, Number(id));
      return { changes: toNumber(info.changes), pin: stmts.getPin.get(Number(id)) };
    },
    deletePinOfTripByPoi(tripId, poiId) {
      const info = stmts.deletePinOfTripByPoi.run(Number(tripId), String(poiId));
      return { changes: toNumber(info.changes) };
    },
    reorderPinsOfTrip(tripId, poiIds) {
      db.exec('BEGIN');
      try {
        (poiIds || []).forEach((poiId, index) => {
          const key = String(poiId);
          const synthetic = /^pin:(\d+)$/.exec(key);
          if (synthetic) stmts.setSortOrderByPinInTrip.run(index, Number(synthetic[1]), Number(tripId));
          else stmts.setSortOrderInTrip.run(index, key, Number(tripId));
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return this.getTripPinsOrdered(tripId);
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
    // 待规划：planned ⇄ wish（只改这一个字段，别的都不动）
    updatePinStatus(id, status) {
      const next = String(status) === 'wish' ? 'wish' : 'planned';
      const info = stmts.updatePinStatus.run(next, Number(id));
      if (!info.changes) return { updated: false, pin: null };
      return { updated: true, pin: this.getPin(Number(id)) };
    },
    updatePinNote(id, note) {
      const info = stmts.updatePinNote.run(note, id);
      return { changes: info.changes, pin: stmts.getPin.get(id) };
    },
    // 预约：none / needed / required（只认这三个值，别的当 none）
    updatePinBooking(id, booking) {
      const raw = String(booking == null ? '' : booking).trim();
      const next = raw === 'needed' || raw === 'required' ? raw : 'none';
      const info = stmts.updatePinBooking.run(next, Number(id));
      if (!info.changes) return { updated: false, pin: null };
      return { updated: true, pin: stmts.getPin.get(Number(id)) };
    },
    // 时间段：morning / afternoon / evening / night；传空 = 清掉（不排时段）
    updatePinSlot(id, slot) {
      const raw = String(slot == null ? '' : slot).trim();
      const next = ['morning', 'afternoon', 'evening', 'night'].includes(raw) ? raw : null;
      const info = stmts.updatePinSlot.run(next, Number(id));
      if (!info.changes) return { updated: false, pin: null };
      return { updated: true, pin: stmts.getPin.get(Number(id)) };
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

    // ---- POI / 覆盖账本 / 城市轮廓（2026-11-25 起全在内存，不落盘）----
    // 用户口径：「不要所有的数据都存在本地，可以做缓存 但是不能持久化到我这，
    // 要不然数据更新了 我们就都是错的」。这些是上游事实，落盘就会变成静默的错。
    // 实现见 server/poi-store.js（带 TTL，进程重启即清空）。
    upsertPoi(poi) {
      return poiStore.upsertPoi(poi);
    },
    getPoi(poiId) {
      return poiStore.getPoi(poiId);
    },
    poiContentHash(poiId) {
      return poiStore.poiContentHash(poiId);
    },
    poiDigest(city) {
      return poiStore.poiDigest(city);
    },
    countPois(city, category) {
      return poiStore.countPois(city, category);
    },
    listPois(opts = {}) {
      const { total, rows } = poiStore.listPois(opts);
      return { total, items: rows.map(mapPoiRow) };
    },
    searchPoisLocal(opts = {}) {
      return poiStore.searchPoisLocal(opts).map((r) => ({ ...mapPoiRow(r), local: true }));
    },
    poisNearPoint(opts = {}) {
      return poiStore.poisNearPoint(opts).map(mapPoiRow);
    },
    poisStats(city) {
      return poiStore.poisStats(city);
    },
    // 采集覆盖账本：与 POI 同寿命（POI 没了账本留着就会「以为采过其实没有」）
    isCovered(city, category, gx, gy) {
      return poiStore.isCovered(city, category, gx, gy);
    },
    markCovered(city, category, gx, gy, nInserted = 0, truncated = false) {
      poiStore.markCovered(city, category, gx, gy, nInserted, truncated);
    },
    listCoverage(city, category) {
      return poiStore.listCoverage(city, category);
    },
    listCoverageRange(city, category, minGx, maxGx, minGy, maxGy) {
      return poiStore.listCoverageRange(city, category, minGx, maxGx, minGy, maxGy);
    },
    // 采集运行日志仍落盘（那是「我们做过什么」，不是上游事实）
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
    // 一趟行程的 Markdown 清单（导出 / 分享都用它）；多天时按天分段
    buildTripMarkdown(tripId, order = null) {
      const trip = stmts.getTrip.get(Number(tripId));
      const pins = applyPoiOrder(this.getTripPinsOrdered(tripId), order);
      const city = (trip && trip.city) || '';
      const title = (trip && trip.title) || `${city} · 我的行程`;
      const dayCount = pins.reduce((m, p) => Math.max(m, Number(p.day) || 1), 1);
      const lines = [`# ${title}（${pins.length} 个地点）`];
      let curDay = null;
      let seq = 0;
      pins.forEach((pin) => {
        const d = Number(pin.day) || 1;
        if (dayCount > 1 && d !== curDay) {
          lines.push('', `## 第 ${d} 天`);
          curDay = d;
        }
        seq += 1;
        const meta = [];
        if (pin.rating) meta.push(`★${pin.rating}`);
        if (pin.cost) meta.push(`¥${pin.cost}`);
        // 时间段与预约（2026-11-25）：行程单（.md 导出）也要带上
        if (pin.slot) meta.push(SLOT_LABEL[pin.slot] || pin.slot);
        if (pin.booking && pin.booking !== 'none') meta.push(BOOKING_LABEL[pin.booking] || pin.booking);
        const suffix = meta.length ? `（${meta.join(' · ')}）` : '';
        lines.push(`${seq}. ${pin.name} — ${pin.address || '（无详细地址）'}${suffix}`);
      });
      return lines.join('\n');
    },
    buildItineraryMarkdown(city, labels = DEFAULT_CATEGORY_LABELS, order = null, userId = null) {
      void labels; // 兼容老调用点：分组标题已取消，labels 不再参与排版
      const trip = userId == null ? null : stmts.tripByCityForUser.get(city, Number(userId));
      if (!trip) return `# ${city} · 我的行程（0 个地点）`;
      return this.buildTripMarkdown(trip.id, order);
    },
    // 城市轮廓：rings 不在或为空就当作没缓存（宁可重新拉，也别画一张空图）
    // 城市轮廓：行政区划会调整 ⇒ 同样只放内存（不落盘）
    getCityBoundary(city) {
      return poiStore.getCityBoundary(city);
    },
    saveCityBoundary(city, b) {
      return poiStore.saveCityBoundary(city, b);
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
    // 同一趟行程只留最新一条：先删旧的再插新的（旧文件由调用方自己清）
    replaceShareOfTrip(s) {
      if (s.tripId == null || s.userId == null) return this.addShare(s);
      const removed = stmts.deleteSharesOfTrip.run(Number(s.userId), Number(s.tripId));
      const row = this.addShare(s);
      return Object.assign(row, { replaced: toNumber(removed.changes) });
    },
    listSharesOfTrip(userId, tripId) {
      if (userId == null || tripId == null) return [];
      return stmts.listSharesOfTrip.all(Number(userId), Number(tripId)).map(parseShareRow);
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
      const notesRow = stmts.countUnownedNotes.get();
      return { trips, shares, notes: toNumber(notesRow && notesRow.c) };
    },
    // 旧数据认领：把没有归属的行程 / 分享归给当前账号（单机场景下的迁移用）
    claimUnowned(userId) {
      if (userId == null) return { trips: 0, shares: 0 };
      db.exec('BEGIN');
      try {
        const t = stmts.claimTrips.run(Number(userId));
        const s = stmts.claimShares.run(Number(userId));
        const n = stmts.claimNotes.run(Number(userId));
        db.exec('COMMIT');
        return { trips: toNumber(t.changes), shares: toNumber(s.changes), notes: toNumber(n.changes) };
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
      return poiStore.countPoisByCity(city);
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
    // 内存缓存的读数（/api/health 与调试用）
    poiCacheStats() {
      return poiStore.stats();
    },
    clearPoiCache() {
      poiStore.clear();
    },
  };

  // 2026-11-25：pois 已不落盘，不再需要回填内容指纹。
  // 老库里那三张表（pois / poi_coverage / city_boundaries）不主动删（删数据不可逆），
  // 但代码不再读写它们。

  return api;
}

module.exports = { createDb, SCHEMA };
