const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');

const db = new DatabaseSync(path.join(config.dataDir, 'tuberr.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');

// Owner-only modes on the files holding secrets (DB, management key, YouTube
// cookies). The data dir goes 0700 only when downloads live outside it —
// Sonarr, often another OS user, must traverse into a nested downloads dir.
if (process.platform !== 'win32') {
  const restrict = (p, mode) => {
    try {
      const st = fs.lstatSync(p);
      if (!st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o777) !== mode) fs.chmodSync(p, mode);
    } catch { /* missing or not ours — leave it */ }
  };
  for (const f of ['tuberr.db', 'tuberr.db-wal', 'tuberr.db-shm', 'cookies.txt', 'api_key.txt']) {
    restrict(path.join(config.dataDir, f), 0o600);
  }
  const rel = path.relative(config.dataDir, config.downloadsDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) restrict(config.dataDir, 0o700);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS series_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tvdb_id INTEGER NOT NULL UNIQUE,
    sonarr_series_id INTEGER,
    title TEXT NOT NULL,
    channel_id TEXT,
    channel_title TEXT,
    uploads_playlist_id TEXT,
    playlist_ids TEXT DEFAULT '[]',
    match_status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT 0,
    last_refreshed_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT NOT NULL,
    mapping_id INTEGER NOT NULL,
    title TEXT,
    description TEXT,
    published_at TEXT,
    duration_sec INTEGER DEFAULT 0,
    playlist_id TEXT,
    position INTEGER DEFAULT -1,
    status TEXT DEFAULT 'ok',
    fetched_at INTEGER DEFAULT 0,
    PRIMARY KEY (video_id, mapping_id)
  );
  CREATE INDEX IF NOT EXISTS idx_videos_mapping ON videos(mapping_id);

  CREATE TABLE IF NOT EXISTS episode_matches (
    mapping_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    sonarr_episode_id INTEGER,
    episode_title TEXT,
    air_date TEXT,
    video_id TEXT,
    confidence REAL DEFAULT 0,
    source TEXT DEFAULT 'auto',
    broken INTEGER DEFAULT 0,
    candidates_json TEXT DEFAULT '[]',
    PRIMARY KEY (mapping_id, season, episode)
  );

  CREATE TABLE IF NOT EXISTS grabs (
    info_hash TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    mapping_id INTEGER,
    season INTEGER,
    episode INTEGER,
    release_title TEXT,
    size_bytes INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS downloads (
    info_hash TEXT PRIMARY KEY,
    video_id TEXT,
    release_title TEXT,
    category TEXT DEFAULT '',
    save_path TEXT,
    content_path TEXT,
    state TEXT DEFAULT 'queued',
    progress REAL DEFAULT 0,
    size_bytes INTEGER DEFAULT 0,
    dlspeed INTEGER DEFAULT 0,
    eta INTEGER DEFAULT 0,
    error TEXT,
    added_on INTEGER DEFAULT 0,
    completed_on INTEGER DEFAULT 0
  );
`);

// Migrations for columns added after first release
for (const migration of [
  'ALTER TABLE series_mappings ADD COLUMN detect_attempts INTEGER DEFAULT 0',
  // Mapping lifecycle: 'active' | 'paused' | 'unavailable' (skipped by the
  // scheduler and hidden from Torznab), plus activity timestamps for status.
  "ALTER TABLE series_mappings ADD COLUMN state TEXT DEFAULT 'active'",
  'ALTER TABLE series_mappings ADD COLUMN state_reason TEXT',
  'ALTER TABLE series_mappings ADD COLUMN zero_progress_runs INTEGER DEFAULT 0',
  'ALTER TABLE series_mappings ADD COLUMN last_new_video_at INTEGER DEFAULT 0',
  'ALTER TABLE series_mappings ADD COLUMN last_grab_at INTEGER DEFAULT 0',
  'ALTER TABLE series_mappings ADD COLUMN last_full_refresh_at INTEGER DEFAULT 0',
  'ALTER TABLE series_mappings ADD COLUMN last_tvdb_refresh_at INTEGER DEFAULT 0',
  // Per-episode skip (never offered to Sonarr) and download attempt counter
  // (folded into the fake infohash so a retry is a fresh release for Sonarr).
  'ALTER TABLE episode_matches ADD COLUMN skipped INTEGER DEFAULT 0',
  'ALTER TABLE episode_matches ADD COLUMN skip_reason TEXT',
  'ALTER TABLE episode_matches ADD COLUMN attempts INTEGER DEFAULT 0',
  'ALTER TABLE grabs ADD COLUMN attempt INTEGER DEFAULT 0',
]) {
  try { db.exec(migration); } catch { /* column already exists */ }
}

function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Owner-only mirror of the management API key. writeFileSync's mode only
// applies when the file is created, so an older world-readable copy is chmodded.
function writeApiKeyFile(key) {
  const file = path.join(config.dataDir, 'api_key.txt');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// Self-provision the management API key on first boot. Also mirror it to a
// plain-text file so admins can grab it without spelunking sqlite (it is not
// logged) — Diskovarr's Connections page needs it once, then displays it from there.
if (!getSetting('api_key')) {
  setSetting('api_key', crypto.randomBytes(24).toString('hex'));
}
try {
  writeApiKeyFile(getSetting('api_key'));
} catch { /* non-fatal — key is still in the DB */ }

module.exports = { db, getSetting, setSetting, writeApiKeyFile };
