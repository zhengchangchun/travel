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
CREATE INDEX IF NOT EXISTS idx_notes_city ON notes(city);
`;

function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function createDb(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stmts = {
    insertTrip: db.prepare('INSERT INTO trips (city, title) VALUES (?, ?)'),
    getTrip: db.prepare('SELECT * FROM trips WHERE id = ?'),
    listTrips: db.prepare('SELECT * FROM trips ORDER BY id DESC'),
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
  };

  return {
    raw: db,
    createTrip({ city, title }) {
      const info = stmts.insertTrip.run(city, title);
      return stmts.getTrip.get(toNumber(info.lastInsertRowid));
    },
    listTrips() {
      return stmts.listTrips.all();
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
    close() {
      db.close();
    },
  };
}

module.exports = { createDb, SCHEMA };
