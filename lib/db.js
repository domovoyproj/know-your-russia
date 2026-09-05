// SQLite storage layer. Uses Bun's built-in driver — zero native deps.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

export const db = new Database("data/kyr.sqlite", { create: true });

// WAL = better concurrency for read-heavy map queries.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Coordinates live on the media row (1:1 point per upload). A separate
  -- locations table would only add a join for no gain at this scale.
  CREATE TABLE IF NOT EXISTS media (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT    NOT NULL,
    description   TEXT    NOT NULL DEFAULT '',
    kind          TEXT    NOT NULL CHECK (kind IN ('image','video')),
    filename      TEXT    NOT NULL,          -- stored file, relative to uploads/
    thumb         TEXT,                       -- preview file, relative to uploads/ (nullable)
    mime          TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    lat           REAL    NOT NULL,
    lng           REAL    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
    review_note   TEXT    NOT NULL DEFAULT '',
    reviewed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at   TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Bounding-box scans for the visible map area + moderation queue.
  CREATE INDEX IF NOT EXISTS idx_media_status_bbox
    ON media (status, lat, lng);
  CREATE INDEX IF NOT EXISTS idx_media_user
    ON media (user_id, created_at);
`);

// Profile fields were added after the first release — migrate in place.
const userCols = new Set(db.query("PRAGMA table_info(users)").all().map((c) => c.name));
if (!userCols.has("bio")) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!userCols.has("avatar")) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");

// Seed the first admin so the moderation panel is usable out of the box.
const adminUser = Bun.env.ADMIN_USER || "admin";
const adminPass = Bun.env.ADMIN_PASS || "admin123";
const anyUser = db.query("SELECT id FROM users LIMIT 1").get();
if (!anyUser) {
  const hash = await Bun.password.hash(adminPass);
  db.query(
    "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)"
  ).run(adminUser, hash);
  console.log(`[seed] admin user created: ${adminUser} / ${adminPass}`);
}
