const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash, setDigest } = require('./poi-hash');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  city        TEXT NOT NULL,
  title       TEXT NOT NULL,
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pins_trip ON pins(trip_id);
CREATE INDEX IF NOT EXISTS idx_pins_poi ON pins(poi_id);
CREATE INDEX IF NOT EXISTS idx_notes_city ON notes(city);

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
  ensureColumn(db, 'poi_coverage', 'truncated', 'truncated INTEGER NOT NULL DEFAULT 0');
  // POI 内容指纹列（存量库前滚；缺失指纹的行在下面回填）
  ensureColumn(db, 'pois', 'content_sha256', 'content_sha256 TEXT');

  const stmts = {
    insertTrip: db.prepare('INSERT INTO trips (city, title) VALUES (?, ?)'),
    getTrip: db.prepare('SELECT * FROM trips WHERE id = ?'),
    listTrips: db.prepare('SELECT * FROM trips ORDER BY id DESC'),
    listTripsByCity: db.prepare('SELECT * FROM trips WHERE city = ? ORDER BY id DESC'),
    updateTripTitle: db.prepare('UPDATE trips SET title = ? WHERE id = ?'),
    deleteTrip: db.prepare('DELETE FROM trips WHERE id = ?'),
    deletePinsOfTrip: db.prepare('DELETE FROM pins WHERE trip_id = ?'),
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
    listNotesAll: db.prepare('SELECT * FROM notes ORDER BY id DESC'),
    listNotesCity: db.prepare('SELECT * FROM notes WHERE city = ? ORDER BY id DESC'),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),

    // ---- T2 选中模型 ----
    tripByCity: db.prepare('SELECT * FROM trips WHERE city = ? ORDER BY id LIMIT 1'),
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
    setSortOrder: db.prepare(
      `UPDATE pins SET sort_order = ? WHERE poi_id = ? AND trip_id IN (SELECT id FROM trips WHERE city = ?)`
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
    listCoverageRange: db.prepare(
      `SELECT gx, gy FROM poi_coverage
       WHERE city = ? AND category = ? AND gx BETWEEN ? AND ? AND gy BETWEEN ? AND ?`
    ),
  };

  const api = {
    raw: db,
    createTrip({ city, title }) {
      const info = stmts.insertTrip.run(city, title);
      return stmts.getTrip.get(toNumber(info.lastInsertRowid));
    },
    listTrips(city) {
      return city ? stmts.listTripsByCity.all(city) : stmts.listTrips.all();
    },
    getTrip(id) {
      return stmts.getTrip.get(id);
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
    listNotes(city) {
      return city ? stmts.listNotesCity.all(city) : stmts.listNotesAll.all();
    },
    deleteNote(id) {
      const info = stmts.deleteNote.run(id);
      return { changes: info.changes };
    },

    // ---- T2 选中模型 ----
    getCityTrip(city) {
      return stmts.tripByCity.get(city) || null;
    },
    getOrCreateCityTrip(city) {
      const existing = stmts.tripByCity.get(city);
      if (existing) {
        const fixed = dedupeCityTitle(city, existing.title);
        if (fixed !== existing.title) {
          stmts.updateTripTitle.run(fixed, existing.id);
          return stmts.getTrip.get(existing.id);
        }
        return existing;
      }
      return this.createTrip({ city, title: `${city} · 我的行程` });
    },
    getSelectionByCity(city) {
      return stmts.selectionByCity.all(city);
    },
    insertPinIfAbsent(city, poi) {
      const existing = stmts.pinByCityPoi.get(city, poi.id);
      if (existing) return existing;
      const trip = this.getOrCreateCityTrip(city);
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
    deletePinByPoi(city, poiId) {
      const info = stmts.deletePinByPoi.run(poiId, city);
      return { changes: info.changes };
    },
    reorderPins(city, poiIds) {
      db.exec('BEGIN');
      try {
        poiIds.forEach((poiId, index) => {
          stmts.setSortOrder.run(index, poiId, city);
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return this.getSelectionByCity(city);
    },
    updatePinNote(id, note) {
      const info = stmts.updatePinNote.run(note, id);
      return { changes: info.changes, pin: stmts.getPin.get(id) };
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
    buildItineraryMarkdown(city, labels = DEFAULT_CATEGORY_LABELS) {
      const trip = stmts.tripByCity.get(city);
      const pins = stmts.selectionByCity.all(city);
      const title = (trip && trip.title) || `${city} · 我的行程`;
      const lines = [`# ${title}（${pins.length} 个地点）`];
      let lastCategory = null;
      pins.forEach((pin, index) => {
        if (pin.category !== lastCategory) {
          const label =
            (labels && labels[pin.category] && labels[pin.category].label) ||
            labels[pin.category] ||
            pin.category;
          lines.push(`## ${label}`);
          lastCategory = pin.category;
        }
        const meta = [];
        if (pin.rating) meta.push(`★${pin.rating}`);
        if (pin.cost) meta.push(`¥${pin.cost}`);
        const suffix = meta.length ? `（${meta.join(' · ')}）` : '';
        lines.push(`${index + 1}. ${pin.name} — ${pin.address || '（无详细地址）'}${suffix}`);
      });
      return lines.join('\n');
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
