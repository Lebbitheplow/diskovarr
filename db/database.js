const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'diskovarr.db'));

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plex_user_id TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(plex_user_id, rating_key)
  );
  CREATE INDEX IF NOT EXISTS idx_dismissals_user ON dismissals(plex_user_id);

  CREATE TABLE IF NOT EXISTS library_items (
    rating_key TEXT PRIMARY KEY,
    section_id TEXT NOT NULL,
    title TEXT,
    year INTEGER,
    thumb TEXT,
    type TEXT,
    genres TEXT DEFAULT '[]',
    directors TEXT DEFAULT '[]',
    cast TEXT DEFAULT '[]',
    audience_rating REAL DEFAULT 0,
    content_rating TEXT DEFAULT '',
    added_at INTEGER DEFAULT 0,
    summary TEXT DEFAULT '',
    synced_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_library_section ON library_items(section_id);

  CREATE TABLE IF NOT EXISTS user_watched (
    user_id TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    synced_at INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, rating_key)
  );
  CREATE INDEX IF NOT EXISTS idx_watched_user ON user_watched(user_id);

  CREATE TABLE IF NOT EXISTS sync_log (
    key TEXT PRIMARY KEY,
    last_sync INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const stmtAdd = db.prepare(
  'INSERT OR IGNORE INTO dismissals (plex_user_id, rating_key) VALUES (?, ?)'
);
const stmtGet = db.prepare(
  'SELECT rating_key FROM dismissals WHERE plex_user_id = ?'
);
const stmtRemove = db.prepare(
  'DELETE FROM dismissals WHERE plex_user_id = ? AND rating_key = ?'
);

function addDismissal(userId, ratingKey) {
  stmtAdd.run(String(userId), String(ratingKey));
}

function getDismissals(userId) {
  const rows = stmtGet.all(String(userId));
  return new Set(rows.map(r => r.rating_key));
}

function removeDismissal(userId, ratingKey) {
  stmtRemove.run(String(userId), String(ratingKey));
}

// ── Migrate: add columns if this is an existing DB ────────────────────────────
[
  'ALTER TABLE library_items ADD COLUMN rating REAL DEFAULT 0',
  "ALTER TABLE library_items ADD COLUMN rating_image TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN audience_rating_image TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN studio TEXT DEFAULT ''",
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// User ratings table (Plex star ratings, per user)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_ratings (
    user_id TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    user_rating REAL NOT NULL,
    PRIMARY KEY (user_id, rating_key)
  );
`);

// ── Library items ─────────────────────────────────────────────────────────────

const stmtUpsertItem = db.prepare(`
  INSERT OR REPLACE INTO library_items
    (rating_key, section_id, title, year, thumb, type, genres, directors, cast,
     audience_rating, content_rating, added_at, summary, synced_at,
     rating, rating_image, audience_rating_image, studio)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertManyItems = db.transaction((items) => {
  for (const item of items) {
    stmtUpsertItem.run(
      item.ratingKey, item.sectionId, item.title, item.year, item.thumb, item.type,
      JSON.stringify(item.genres), JSON.stringify(item.directors), JSON.stringify(item.cast),
      item.audienceRating, item.contentRating, item.addedAt, item.summary,
      Math.floor(Date.now() / 1000),
      item.rating, item.ratingImage, item.audienceRatingImage, item.studio
    );
  }
});

function rowToItem(r) {
  return {
    ratingKey: r.rating_key,
    sectionId: r.section_id,
    title: r.title,
    year: r.year,
    thumb: r.thumb,
    type: r.type,
    genres: JSON.parse(r.genres || '[]'),
    directors: JSON.parse(r.directors || '[]'),
    cast: JSON.parse(r.cast || '[]'),
    audienceRating: r.audience_rating,
    contentRating: r.content_rating,
    addedAt: r.added_at,
    summary: r.summary,
    rating: r.rating || 0,
    ratingImage: r.rating_image || '',
    audienceRatingImage: r.audience_rating_image || '',
    studio: r.studio || '',
  };
}

function getLibraryItemsFromDb(sectionId) {
  return db.prepare('SELECT * FROM library_items WHERE section_id = ?')
    .all(String(sectionId)).map(rowToItem);
}

function getLibraryItemByKey(ratingKey) {
  const r = db.prepare('SELECT * FROM library_items WHERE rating_key = ?').get(String(ratingKey));
  return r ? rowToItem(r) : null;
}

// ── User watched ──────────────────────────────────────────────────────────────

const stmtReplaceWatched = db.prepare(
  'INSERT OR REPLACE INTO user_watched (user_id, rating_key, synced_at) VALUES (?, ?, ?)'
);
const stmtClearWatched = db.prepare('DELETE FROM user_watched WHERE user_id = ?');

const replaceWatchedBatch = db.transaction((userId, ratingKeys) => {
  stmtClearWatched.run(String(userId));
  const now = Math.floor(Date.now() / 1000);
  for (const key of ratingKeys) {
    stmtReplaceWatched.run(String(userId), String(key), now);
  }
});

function getWatchedKeysFromDb(userId) {
  const rows = db.prepare('SELECT rating_key FROM user_watched WHERE user_id = ?').all(String(userId));
  return new Set(rows.map(r => r.rating_key));
}

// ── Sync log ──────────────────────────────────────────────────────────────────

function getSyncTime(key) {
  const row = db.prepare('SELECT last_sync FROM sync_log WHERE key = ?').get(key);
  return row ? row.last_sync : 0;
}

function setSyncTime(key) {
  db.prepare('INSERT OR REPLACE INTO sync_log (key, last_sync) VALUES (?, ?)')
    .run(key, Math.floor(Date.now() / 1000));
}

// ── Admin stats ───────────────────────────────────────────────────────────────

function getAdminStats() {
  const movieCount = db.prepare("SELECT COUNT(*) as c FROM library_items WHERE section_id = ?")
    .get(process.env.PLEX_MOVIES_SECTION_ID || '1')?.c || 0;
  const tvCount = db.prepare("SELECT COUNT(*) as c FROM library_items WHERE section_id = ?")
    .get(process.env.PLEX_TV_SECTION_ID || '2')?.c || 0;
  const dismissalCount = db.prepare("SELECT COUNT(*) as c FROM dismissals").get()?.c || 0;

  // Per-user watched counts — include users from sync_log even if they have 0 watched items
  const watchedStats = db.prepare(`
    SELECT
      s.uid AS user_id,
      COALESCE(ku.username, s.uid) AS username,
      ku.thumb,
      COALESCE(w.watched_count, 0) AS watched_count,
      COALESCE(w.last_sync, s.last_sync) AS last_sync
    FROM (
      SELECT SUBSTR(key, 9) AS uid, last_sync
      FROM sync_log WHERE key LIKE 'watched_%'
    ) s
    LEFT JOIN (
      SELECT user_id, COUNT(*) as watched_count, MAX(synced_at) as last_sync
      FROM user_watched GROUP BY user_id
    ) w ON w.user_id = s.uid
    LEFT JOIN known_users ku ON ku.user_id = s.uid
    ORDER BY last_sync DESC
  `).all();

  // Sync times
  const libSync1 = getSyncTime(`library_${process.env.PLEX_MOVIES_SECTION_ID || '1'}`);
  const libSync2 = getSyncTime(`library_${process.env.PLEX_TV_SECTION_ID || '2'}`);

  return {
    library: {
      movies: movieCount,
      tv: tvCount,
      lastSyncMovies: libSync1,
      lastSyncTV: libSync2,
    },
    users: watchedStats,
    dismissals: dismissalCount,
  };
}

function clearUserWatched(userId) {
  db.prepare('DELETE FROM user_watched WHERE user_id = ?').run(String(userId));
  db.prepare('DELETE FROM sync_log WHERE key = ?').run(`watched_${userId}`);
}

function clearAllUserWatched() {
  db.prepare('DELETE FROM user_watched').run();
  db.prepare("DELETE FROM sync_log WHERE key LIKE 'watched_%'").run();
}

function clearLibraryDb(sectionId) {
  if (sectionId) {
    db.prepare('DELETE FROM library_items WHERE section_id = ?').run(String(sectionId));
    db.prepare('DELETE FROM sync_log WHERE key = ?').run(`library_${sectionId}`);
  } else {
    db.prepare('DELETE FROM library_items').run();
    db.prepare("DELETE FROM sync_log WHERE key LIKE 'library_%'").run();
  }
}

function clearUserDismissals(userId) {
  if (userId) {
    db.prepare('DELETE FROM dismissals WHERE plex_user_id = ?').run(String(userId));
  } else {
    db.prepare('DELETE FROM dismissals').run();
  }
}

// ── Known users (username cache) ─────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS known_users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    thumb TEXT,
    seen_at INTEGER DEFAULT 0
  );
`);

function upsertKnownUser(userId, username, thumb) {
  db.prepare(`
    INSERT OR REPLACE INTO known_users (user_id, username, thumb, seen_at)
    VALUES (?, ?, ?, ?)
  `).run(String(userId), username, thumb || null, Math.floor(Date.now() / 1000));
}

function getKnownUsers() {
  return db.prepare('SELECT user_id, username, thumb FROM known_users ORDER BY seen_at DESC').all();
}

// ── User ratings (Plex star ratings) ─────────────────────────────────────────

const upsertUserRatings = db.transaction((userId, ratings) => {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO user_ratings (user_id, rating_key, user_rating) VALUES (?, ?, ?)'
  );
  for (const { ratingKey, userRating } of ratings) {
    stmt.run(String(userId), String(ratingKey), userRating);
  }
});

function getUserRatingsFromDb(userId) {
  const rows = db.prepare('SELECT rating_key, user_rating FROM user_ratings WHERE user_id = ?').all(String(userId));
  return new Map(rows.map(r => [r.rating_key, r.user_rating]));
}

// ── Theme ─────────────────────────────────────────────────────────────────────

const DEFAULT_ACCENT = '#e5a00d';

function getThemeColor() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'theme_color'").get();
  return row ? row.value : DEFAULT_ACCENT;
}

function setThemeColor(hex) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme_color', ?)")
    .run(hex);
}

module.exports = {
  addDismissal, getDismissals, removeDismissal,
  upsertKnownUser, getKnownUsers,
  upsertManyItems, getLibraryItemsFromDb, getLibraryItemByKey,
  replaceWatchedBatch, getWatchedKeysFromDb,
  upsertUserRatings, getUserRatingsFromDb,
  getSyncTime, setSyncTime,
  getAdminStats, clearUserWatched, clearAllUserWatched,
  clearLibraryDb, clearUserDismissals,
  getThemeColor, setThemeColor,
};
