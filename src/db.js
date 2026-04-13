const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'flight-alert.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL,
    origin      TEXT NOT NULL,
    destination TEXT NOT NULL,
    date        TEXT NOT NULL,
    return_date TEXT,
    last_price  REAL,
    triggered   INTEGER NOT NULL DEFAULT 0,
    triggered_at TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id   TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    price      REAL NOT NULL,
    checked_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_history_alert ON price_history(alert_id, checked_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_chat   ON alerts(chat_id);
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
const cols = db.pragma('table_info(alerts)').map((c) => c.name);

// Migration 1: Add return_date column if upgrading from a schema that didn't have it.
if (!cols.includes('return_date')) {
  db.exec('ALTER TABLE alerts ADD COLUMN return_date TEXT');
  console.log('[db] Migration: added return_date column to alerts');
}

// Migration 2: Remove max_price column (no longer used — was NOT NULL, breaks inserts).
// SQLite doesn't support ALTER TABLE DROP COLUMN in older versions, so we recreate the table.
if (cols.includes('max_price')) {
  db.exec(`
    BEGIN TRANSACTION;
    CREATE TABLE alerts_new (
      id           TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL,
      origin       TEXT NOT NULL,
      destination  TEXT NOT NULL,
      date         TEXT NOT NULL,
      return_date  TEXT,
      last_price   REAL,
      triggered    INTEGER NOT NULL DEFAULT 0,
      triggered_at TEXT,
      created_at   TEXT NOT NULL
    );
    INSERT INTO alerts_new
      SELECT id, chat_id, origin, destination, date, return_date,
             last_price, triggered, triggered_at, created_at
      FROM alerts;
    DROP TABLE alerts;
    ALTER TABLE alerts_new RENAME TO alerts;
    CREATE INDEX IF NOT EXISTS idx_alerts_chat ON alerts(chat_id);
    COMMIT;
  `);
  console.log('[db] Migration: removed max_price column from alerts (data preserved)');
}

module.exports = db;
