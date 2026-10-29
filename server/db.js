const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

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
  };

  return {
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
}

module.exports = { createDb, SCHEMA };
