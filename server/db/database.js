const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'diskovarr.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');

function withTransaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

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

  CREATE TABLE IF NOT EXISTS explore_dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plex_user_id TEXT NOT NULL,
    tmdb_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(plex_user_id, tmdb_id, media_type)
  );
  CREATE INDEX IF NOT EXISTS idx_explore_dismissals_user ON explore_dismissals(plex_user_id);

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

  CREATE TABLE IF NOT EXISTS tmdb_cache (
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (tmdb_id, media_type)
  );

  CREATE TABLE IF NOT EXISTS discover_pool_cache (
    user_id TEXT PRIMARY KEY,
    pools TEXT NOT NULL,
    built_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discover_candidates_cache (
    pool_key   TEXT PRIMARY KEY,
    candidate_ids TEXT NOT NULL,
    updated_at INTEGER NOT NULL
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

// ── Explore dismissals (by TMDB ID) ──────────────────────────────────────────

function addExploreDismissal(userId, tmdbId, mediaType) {
  db.prepare('INSERT OR IGNORE INTO explore_dismissals (plex_user_id, tmdb_id, media_type) VALUES (?, ?, ?)')
    .run(String(userId), String(tmdbId), String(mediaType));
}

function getExploreDismissedIds(userId) {
  const rows = db.prepare('SELECT tmdb_id, media_type FROM explore_dismissals WHERE plex_user_id = ?').all(String(userId));
  return new Set(rows.map(r => `${r.tmdb_id}:${r.media_type}`));
}

// ── Request limits ────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS global_request_limits (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER DEFAULT 0,
    movie_limit INTEGER DEFAULT 0,
    movie_window_days INTEGER DEFAULT 7,
    season_limit INTEGER DEFAULT 0,
    season_window_days INTEGER DEFAULT 7
  );
  INSERT OR IGNORE INTO global_request_limits (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS user_request_limits (
    user_id TEXT PRIMARY KEY,
    override_enabled INTEGER DEFAULT 0,
    movie_limit INTEGER DEFAULT 0,
    movie_window_days INTEGER DEFAULT 7,
    season_limit INTEGER DEFAULT 0,
    season_window_days INTEGER DEFAULT 7
  );
`);

function getGlobalRequestLimits() {
  const row = db.prepare('SELECT * FROM global_request_limits WHERE id = 1').get();
  return {
    enabled: row ? !!row.enabled : false,
    movieLimit: row?.movie_limit ?? 0,
    movieWindowDays: row?.movie_window_days ?? 7,
    seasonLimit: row?.season_limit ?? 0,
    seasonWindowDays: row?.season_window_days ?? 7,
  };
}

function setGlobalRequestLimits({ enabled, movieLimit, movieWindowDays, seasonLimit, seasonWindowDays }) {
  db.prepare(`
    INSERT OR REPLACE INTO global_request_limits (id, enabled, movie_limit, movie_window_days, season_limit, season_window_days)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(enabled ? 1 : 0, Number(movieLimit) || 0, Number(movieWindowDays) || 7,
         Number(seasonLimit) || 0, Number(seasonWindowDays) || 7);
}

function getUserRequestLimitOverride(userId) {
  const row = db.prepare('SELECT * FROM user_request_limits WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  return {
    overrideEnabled: !!row.override_enabled,
    movieLimit: row.movie_limit,
    movieWindowDays: row.movie_window_days,
    seasonLimit: row.season_limit,
    seasonWindowDays: row.season_window_days,
  };
}

function setUserRequestLimitOverride(userId, { overrideEnabled, movieLimit, movieWindowDays, seasonLimit, seasonWindowDays }) {
  db.prepare(`
    INSERT OR REPLACE INTO user_request_limits (user_id, override_enabled, movie_limit, movie_window_days, season_limit, season_window_days)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(userId), overrideEnabled ? 1 : 0, Number(movieLimit) || 0, Number(movieWindowDays) || 7,
         Number(seasonLimit) || 0, Number(seasonWindowDays) || 7);
}

function getAllUserRequestLimitOverrides() {
  const rows = db.prepare('SELECT * FROM user_request_limits').all();
  const map = {};
  for (const r of rows) {
    map[r.user_id] = {
      overrideEnabled: !!r.override_enabled,
      movieLimit: r.movie_limit,
      movieWindowDays: r.movie_window_days,
      seasonLimit: r.season_limit,
      seasonWindowDays: r.season_window_days,
    };
  }
  return map;
}

// Returns the effective limits for a user (user override if active, else global).
// 0 means unlimited for that type; enforcement checks > 0 per field.
function getEffectiveLimits(userId) {
  const global = getGlobalRequestLimits();
  const override = getUserRequestLimitOverride(userId);
  if (override && override.overrideEnabled) {
    return {
      movieLimit: override.movieLimit,
      movieWindowDays: override.movieWindowDays,
      seasonLimit: override.seasonLimit,
      seasonWindowDays: override.seasonWindowDays,
    };
  }
  return {
    movieLimit: global.movieLimit,
    movieWindowDays: global.movieWindowDays,
    seasonLimit: global.seasonLimit,
    seasonWindowDays: global.seasonWindowDays,
  };
}

function countRecentMovieRequests(userId, windowDays) {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM discover_requests WHERE user_id = ? AND media_type = 'movie' AND requested_at > ? AND status != 'denied'"
  ).get(String(userId), since);
  return row?.cnt || 0;
}

function countRecentSeasonRequests(userId, windowDays) {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const row = db.prepare(
    "SELECT COALESCE(SUM(seasons_count), 0) as cnt FROM discover_requests WHERE user_id = ? AND media_type = 'tv' AND requested_at > ? AND status != 'denied'"
  ).get(String(userId), since);
  return row?.cnt || 0;
}

// ── Known users (created here so migration block below can ALTER it) ─────────

db.exec(`
  CREATE TABLE IF NOT EXISTS known_users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    thumb TEXT,
    seen_at INTEGER DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
`);

// ── Discover requests log (created here so migration block below can ALTER it) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS discover_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    title TEXT,
    service TEXT,
    requested_at INTEGER DEFAULT 0,
    seasons_count INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'approved',
    denial_note TEXT,
    seasons_json TEXT,
    poster_url TEXT DEFAULT NULL,
    notified_available_at INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_discover_requests_user ON discover_requests(user_id);
`);

// ── Migrate: add columns if this is an existing DB ────────────────────────────
[
  'ALTER TABLE library_items ADD COLUMN rating REAL DEFAULT 0',
  "ALTER TABLE library_items ADD COLUMN rating_image TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN audience_rating_image TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN studio TEXT DEFAULT ''",
  'ALTER TABLE library_items ADD COLUMN tmdb_id TEXT DEFAULT NULL',
  'ALTER TABLE library_items ADD COLUMN art TEXT DEFAULT NULL',
  'ALTER TABLE library_items ADD COLUMN leaf_count INTEGER DEFAULT NULL',
  'ALTER TABLE discover_requests ADD COLUMN seasons_count INTEGER DEFAULT 1',
  "ALTER TABLE discover_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'",
  'ALTER TABLE discover_requests ADD COLUMN denial_note TEXT',
  'ALTER TABLE discover_requests ADD COLUMN seasons_json TEXT',
  'ALTER TABLE discover_requests ADD COLUMN poster_url TEXT DEFAULT NULL',
  'ALTER TABLE discover_requests ADD COLUMN notified_available_at INTEGER DEFAULT NULL',
  'ALTER TABLE known_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE known_users ADD COLUMN plex_token TEXT',
  'ALTER TABLE user_request_limits ADD COLUMN auto_approve_movies INTEGER',
  'ALTER TABLE user_request_limits ADD COLUMN auto_approve_tv INTEGER',
].forEach(sql => { try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column') && !e.message.includes('no such table')) throw e; } });

// Segment B migrations: user preferences
['ALTER TABLE user_request_limits ADD COLUMN region TEXT DEFAULT NULL',
 'ALTER TABLE user_request_limits ADD COLUMN language TEXT DEFAULT NULL',
 'ALTER TABLE user_request_limits ADD COLUMN auto_request_movies INTEGER DEFAULT 0',
 'ALTER TABLE user_request_limits ADD COLUMN auto_request_tv INTEGER DEFAULT 0',
 'ALTER TABLE user_request_limits ADD COLUMN allow_requests_override INTEGER DEFAULT 0',
 'ALTER TABLE user_request_limits ADD COLUMN landing_page TEXT DEFAULT NULL',
 'ALTER TABLE user_request_limits ADD COLUMN show_mature INTEGER DEFAULT 0',
].forEach(sql => { try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column') && !e.message.includes('no such table')) throw e; } });

// Initialize global auto-request settings if not set
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'auto_request_watchlist_movies'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('auto_request_watchlist_movies', 'false')").run();
}
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'auto_request_watchlist_tv'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('auto_request_watchlist_tv', 'false')").run();
}

// ── One-time migrations (tracked by a migrations table) ───────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at INTEGER)`);
[
  {
    name: 'mature_rating_filter_v1',
    sql: () => {
      db.prepare('DELETE FROM tmdb_cache').run();
      db.prepare('DELETE FROM discover_pool_cache').run();
    },
  },
  {
    name: 'content_rating_field_v1',
    sql: () => {
      db.prepare('DELETE FROM tmdb_cache').run();
      db.prepare('DELETE FROM discover_pool_cache').run();
    },
  },
].forEach(({ name, sql }) => {
  const already = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name);
  if (!already) {
    sql();
    db.prepare('INSERT INTO migrations (name, ran_at) VALUES (?, ?)').run(name, Date.now());
    console.log(`[db] Migration applied: ${name}`);
  }
});

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
    (rating_key, section_id, title, year, thumb, art, type, genres, directors, cast,
     audience_rating, content_rating, added_at, summary, synced_at,
     rating, rating_image, audience_rating_image, studio, tmdb_id, leaf_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function upsertManyItems(items) {
  withTransaction(() => {
    for (const item of items) {
      stmtUpsertItem.run(
        item.ratingKey, item.sectionId, item.title, item.year, item.thumb, item.art || null, item.type,
        JSON.stringify(item.genres), JSON.stringify(item.directors), JSON.stringify(item.cast),
        item.audienceRating, item.contentRating, item.addedAt, item.summary,
        Math.floor(Date.now() / 1000),
        item.rating, item.ratingImage, item.audienceRatingImage, item.studio,
        item.tmdbId || null, item.leafCount ?? null
      );
    }
  });
}

function rowToItem(r) {
  return {
    ratingKey: r.rating_key,
    sectionId: r.section_id,
    title: r.title,
    year: r.year,
    thumb: r.thumb,
    art: r.art || null,
    type: r.type,
    genres: JSON.parse(r.genres || '[]').filter(g => g && g.trim()),
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
    tmdbId: r.tmdb_id || null,
    leafCount: r.leaf_count ?? null,
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

function replaceWatchedBatch(userId, ratingKeys) {
  withTransaction(() => {
    stmtClearWatched.run(String(userId));
    const now = Math.floor(Date.now() / 1000);
    for (const key of ratingKeys) {
      stmtReplaceWatched.run(String(userId), String(key), now);
    }
  });
}

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
      ku.seen_at AS last_login,
      COALESCE(w.watched_count, 0) AS watched_count,
      COALESCE(w.last_sync, s.last_sync) AS last_sync,
      COALESCE(r.request_count, 0) AS request_count
    FROM (
      SELECT SUBSTR(key, 9) AS uid, last_sync
      FROM sync_log WHERE key LIKE 'watched_%'
    ) s
    LEFT JOIN (
      SELECT user_id, COUNT(*) as watched_count, MAX(synced_at) as last_sync
      FROM user_watched GROUP BY user_id
    ) w ON w.user_id = s.uid
    LEFT JOIN known_users ku ON ku.user_id = s.uid
    LEFT JOIN (
      SELECT user_id, COUNT(*) as request_count
      FROM discover_requests GROUP BY user_id
    ) r ON r.user_id = s.uid
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

function upsertKnownUser(userId, username, thumb) {
  db.prepare(`
    INSERT OR REPLACE INTO known_users (user_id, username, thumb, seen_at, plex_token)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(userId), username, thumb || null, Math.floor(Date.now() / 1000), token || null);
}

function getAllKnownUsersWithTokens() {
  return db.prepare('SELECT user_id, plex_token FROM known_users WHERE plex_token IS NOT NULL').all();
}

function getLibraryItemByTmdbId(tmdbId) {
  return db.prepare('SELECT * FROM library_items WHERE tmdb_id = ? LIMIT 1').get(String(tmdbId));
}

function touchKnownUser(userId) {
  db.prepare('UPDATE known_users SET seen_at = ? WHERE user_id = ?')
    .run(Math.floor(Date.now() / 1000), String(userId));
}

function getKnownUsers() {
  return db.prepare('SELECT user_id, username, thumb FROM known_users ORDER BY seen_at DESC').all();
}

// ── Watchlist (local DB — avoids Plex playlist 401 for Friend accounts) ───────

db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    user_id TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    added_at INTEGER DEFAULT 0,
    plex_playlist_id TEXT,
    plex_item_id TEXT,
    PRIMARY KEY (user_id, rating_key)
  );
`);
// Migrate: add plex columns if this is an existing watchlist table
['ALTER TABLE watchlist ADD COLUMN plex_playlist_id TEXT',
 'ALTER TABLE watchlist ADD COLUMN plex_item_id TEXT',
 'ALTER TABLE watchlist ADD COLUMN plex_guid TEXT',
].forEach(sql => { try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column') && !e.message.includes('no such table')) throw e; } });

function addToWatchlistDb(userId, ratingKey) {
  db.prepare(`INSERT OR IGNORE INTO watchlist (user_id, rating_key, added_at) VALUES (?, ?, ?)`)
    .run(String(userId), String(ratingKey), Math.floor(Date.now() / 1000));
}

function removeFromWatchlistDb(userId, ratingKey) {
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND rating_key = ?')
    .run(String(userId), String(ratingKey));
}

function getWatchlistFromDb(userId) {
  return db.prepare('SELECT rating_key FROM watchlist WHERE user_id = ? ORDER BY added_at DESC')
    .all(String(userId)).map(r => r.rating_key);
}

function updateWatchlistPlexIds(userId, ratingKey, plexPlaylistId, plexItemId) {
  db.prepare('UPDATE watchlist SET plex_playlist_id = ?, plex_item_id = ? WHERE user_id = ? AND rating_key = ?')
    .run(plexPlaylistId, plexItemId, String(userId), String(ratingKey));
}

function getWatchlistPlexIds(userId, ratingKey) {
  return db.prepare('SELECT plex_playlist_id, plex_item_id, plex_guid FROM watchlist WHERE user_id = ? AND rating_key = ?')
    .get(String(userId), String(ratingKey));
}

function updateWatchlistPlexGuid(userId, ratingKey, plexGuid) {
  db.prepare('UPDATE watchlist SET plex_guid = ? WHERE user_id = ? AND rating_key = ?')
    .run(plexGuid, String(userId), String(ratingKey));
}

// ── User ratings (Plex star ratings) ─────────────────────────────────────────

const stmtUpsertUserRating = db.prepare(
  'INSERT OR REPLACE INTO user_ratings (user_id, rating_key, user_rating) VALUES (?, ?, ?)'
);

function upsertUserRatings(userId, ratings) {
  withTransaction(() => {
    for (const { ratingKey, userRating } of ratings) {
      stmtUpsertUserRating.run(String(userId), String(ratingKey), userRating);
    }
  });
}

function getUserRatingsFromDb(userId) {
  const rows = db.prepare('SELECT rating_key, user_rating FROM user_ratings WHERE user_id = ?').all(String(userId));
  return new Map(rows.map(r => [r.rating_key, r.user_rating]));
}

// ── Theme ─────────────────────────────────────────────────────────────────────

const DEFAULT_ACCENT = '#e5a00d';
let _themeColorCache = null;

function getThemeColor() {
  if (_themeColorCache !== null) return _themeColorCache;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'theme_color'").get();
  _themeColorCache = row ? row.value : DEFAULT_ACCENT;
  return _themeColorCache;
}

function setThemeColor(hex) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme_color', ?)")
    .run(hex);
  _themeColorCache = hex;
}

// ── Watchlist mode (admin only) ───────────────────────────────────────────────
// 'watchlist' = sync to plex.tv Watchlist (default, works for all accounts)
// 'playlist'  = sync to a private server playlist (for use with pd_zurg etc.)
// Only applies to the server owner (admin); Friends always use plex.tv Watchlist.

function getAdminWatchlistMode() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_watchlist_mode'").get();
  return row ? row.value : 'watchlist';
}

function setAdminWatchlistMode(mode) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_watchlist_mode', ?)")
    .run(mode);
}

// ── Server owner Plex user ID ─────────────────────────────────────────────────
// The owner gets playlist-mode watchlist sync when playlist mode is enabled.
// Set via the admin panel — pick from the known users list.

function getOwnerUserId() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'owner_plex_user_id'").get();
  return row ? row.value : null;
}

function setOwnerUserId(userId) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_plex_user_id', ?)")
    .run(String(userId));
}

// ── Generic settings helpers ──────────────────────────────────────────────────

function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

function getConnectionSettings() {
  return {
    plexUrl: getSetting('plex_url', '') || process.env.PLEX_URL || '',
    plexToken: !!(getSetting('plex_token', '') || process.env.PLEX_TOKEN),
    tautulliUrl: getSetting('tautulli_url', '') || process.env.TAUTULLI_URL || '',
    tautulliApiKey: !!(getSetting('tautulli_api_key', '') || process.env.TAUTULLI_API_KEY),
    tmdbApiKey: getSetting('tmdb_api_key', '') || process.env.TMDB_API_KEY || '',
    discoverEnabled: getSetting('discover_enabled', '1') === '1',
    overseerrUrl: getSetting('overseerr_url', ''),
    overseerrApiKey: getSetting('overseerr_api_key', ''),
    overseerrEnabled: getSetting('overseerr_enabled', '0') === '1',
    radarrUrl: getSetting('radarr_url', ''),
    radarrApiKey: getSetting('radarr_api_key', ''),
    radarrEnabled: getSetting('radarr_enabled', '0') === '1',
    radarrQualityProfileId: getSetting('radarr_quality_profile_id', ''),
    radarrQualityProfileName: getSetting('radarr_quality_profile_name', ''),
    sonarrUrl: getSetting('sonarr_url', ''),
    sonarrApiKey: getSetting('sonarr_api_key', ''),
    sonarrEnabled: getSetting('sonarr_enabled', '0') === '1',
    sonarrQualityProfileId: getSetting('sonarr_quality_profile_id', ''),
    sonarrQualityProfileName: getSetting('sonarr_quality_profile_name', ''),
    defaultRequestService: getSetting('default_request_service', 'overseerr'),
    rivenUrl: getSetting('riven_url', '') || 'http://127.0.0.1:8082',
    rivenApiKey: getSetting('riven_api_key', ''),
    rivenEnabled: getSetting('riven_enabled', '0') === '1',
    dumbEnabled: getSetting('dumb_enabled', '0') === '1',
    dumbRequestMode: getSetting('dumb_request_mode', 'pull'),
  };
}

// Tab is visible if the toggle is on (TMDB key checked separately at recommendation time)
function isDiscoverEnabled() {
  return getSetting('discover_enabled', '1') === '1';
}

function hasTmdbKey() {
  return !!(getSetting('tmdb_api_key', '') || process.env.TMDB_API_KEY);
}

// ── TMDB cache ────────────────────────────────────────────────────────────────

const TMDB_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

function getTmdbCache(tmdbId, mediaType) {
  const row = db.prepare('SELECT data, fetched_at FROM tmdb_cache WHERE tmdb_id = ? AND media_type = ?')
    .get(Number(tmdbId), mediaType);
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) - row.fetched_at > TMDB_CACHE_TTL) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function setTmdbCache(tmdbId, mediaType, data) {
  db.prepare('INSERT OR REPLACE INTO tmdb_cache (tmdb_id, media_type, data, fetched_at) VALUES (?, ?, ?, ?)')
    .run(Number(tmdbId), mediaType, JSON.stringify(data), Math.floor(Date.now() / 1000));
}

function getItemsByGenre(mediaType, genreName) {
  const rows = db.prepare(`SELECT data FROM tmdb_cache WHERE media_type = ?`)
    .all(mediaType);
  if (!rows || !rows.length) return [];
  const items = rows.map(r => {
    try {
      const item = JSON.parse(r.data);
      if (item.genres && Array.isArray(item.genres) && item.genres.some(g => g === genreName)) {
        return item;
      }
      return null;
    } catch { return null; }
  }).filter(Boolean);
  // Sort by TMDB popularity score (popularity field, descending) so most popular shows first
  items.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return items;
}

function deleteTmdbCache(tmdbId, mediaType) {
  db.prepare('DELETE FROM tmdb_cache WHERE tmdb_id = ? AND media_type = ?')
    .run(Number(tmdbId), mediaType);
}

// ── Library TMDB IDs ──────────────────────────────────────────────────────────

function getLibraryTmdbIds() {
  const rows = db.prepare('SELECT tmdb_id FROM library_items WHERE tmdb_id IS NOT NULL').all();
  return new Set(rows.map(r => String(r.tmdb_id)));
}

// Normalized "title|year" strings for title+year fallback filtering
// Used when TMDB IDs aren't populated yet
function getLibraryTitleYearSet() {
  const rows = db.prepare('SELECT title, year FROM library_items').all();
  const set = new Set();
  for (const r of rows) {
    if (r.title) {
      // Normalize: lowercase, strip punctuation, collapse spaces
      const norm = r.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      set.add(norm + '|' + (r.year || ''));
      // Also add without year for fuzzy fallback
      set.add(norm + '|');
    }
  }
  return set;
}

// ── Discover requests log ─────────────────────────────────────────────────────

function addDiscoverRequest(userId, tmdbId, mediaType, title, service, seasonsCount) {
  db.prepare(`
    INSERT INTO discover_requests (user_id, tmdb_id, media_type, title, service, seasons_count, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(String(userId), Number(tmdbId), mediaType, title, service,
         (typeof seasonsCount === 'number' && seasonsCount > 0) ? seasonsCount : 1,
         Math.floor(Date.now() / 1000));
}

function getRequestedTmdbIds(userId) {
  const rows = db.prepare('SELECT tmdb_id, media_type FROM discover_requests WHERE user_id = ?').all(String(userId));
  return new Set(rows.map(r => `${r.tmdb_id}:${r.media_type}`));
}

function getAllRequestedTmdbIds() {
  const rows = db.prepare('SELECT tmdb_id, media_type FROM discover_requests').all();
  return new Set(rows.map(r => `${r.tmdb_id}:${r.media_type}`));
}

function getRecentRequests(userId, limit = 20) {
  return db.prepare(
    'SELECT tmdb_id, media_type, title FROM discover_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT ?'
  ).all(String(userId), limit);
}

// ── Discover pool cache (persists across restarts) ────────────────────────────

function getDiscoverPool(userId) {
  const row = db.prepare('SELECT pools, built_at FROM discover_pool_cache WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  try { return { pools: JSON.parse(row.pools), builtAt: row.built_at }; } catch { return null; }
}

function setDiscoverPool(userId, pools, builtAt) {
  db.prepare('INSERT OR REPLACE INTO discover_pool_cache (user_id, pools, built_at) VALUES (?, ?, ?)')
    .run(String(userId), JSON.stringify(pools), builtAt);
}

function getKnownUserIds() {
  return db.prepare('SELECT DISTINCT user_id FROM discover_pool_cache').all().map(r => r.user_id);
}

// ── Shared discover candidates cache ─────────────────────────────────────────

function getDiscoverCandidates(poolKey) {
  const row = db.prepare('SELECT candidate_ids, updated_at FROM discover_candidates_cache WHERE pool_key = ?').get(poolKey);
  if (!row) return null;
  try { return { items: JSON.parse(row.candidate_ids), updatedAt: row.updated_at }; } catch { return null; }
}

function setDiscoverCandidates(poolKey, items) {
  db.prepare('INSERT OR REPLACE INTO discover_candidates_cache (pool_key, candidate_ids, updated_at) VALUES (?, ?, ?)')
    .run(poolKey, JSON.stringify(items), Date.now());
}

// Returns all distinct pref combos across known users (for background pool refresh)
function getAllUserPrefsForDiscover() {
  const rows = db.prepare(`
    SELECT DISTINCT url.region, url.language, url.show_mature
    FROM known_users ku
    LEFT JOIN user_request_limits url ON url.user_id = ku.user_id
  `).all();
  // Always include the default (no prefs) combo so pool is available before first login
  const combos = rows.map(r => ({
    region: r.region || null,
    language: r.language || null,
    show_mature: !!r.show_mature,
  }));
  if (!combos.some(c => !c.region && !c.language && !c.show_mature)) {
    combos.push({ region: null, language: null, show_mature: false });
  }
  return combos;
}

function isIndividualSeasonsEnabled() {
  return getSetting('individual_seasons_enabled', '0') === '1';
}

function getLandingPage() {
  return getSetting('landing_page', 'home'); // 'home' or 'explore'
}

function getDirectRequestAccess() {
  return getSetting('direct_request_access', 'all'); // 'all' or 'admin'
}

// ── Request queue management ──────────────────────────────────────────────────

function getPendingRequests() {
  return db.prepare(`
    SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username, ku.thumb AS user_thumb
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    WHERE dr.status = 'pending'
    ORDER BY dr.requested_at ASC
  `).all();
}

function getAllRequests(limit = 20, offset = 0, statusFilter = null, orderBy = 'requested_at', orderDir = 'DESC') {
  const ALLOWED_COLS = { title: 'dr.title', username: 'COALESCE(ku.username, dr.user_id)', media_type: 'dr.media_type', requested_at: 'dr.requested_at', status: 'dr.status' };
  const col = ALLOWED_COLS[orderBy] || 'dr.requested_at';
  const dir = orderDir === 'ASC' ? 'ASC' : 'DESC';
  const where = statusFilter && statusFilter !== 'all' ? `WHERE dr.status = '${statusFilter}'` : '';
  const rows = db.prepare(`
    SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username, ku.thumb AS user_thumb
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ${where}
    ORDER BY ${col} ${dir}
    LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset));
  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM discover_requests dr ${where}
  `).get();
  return { rows, total: countRow?.cnt || 0 };
}

function updateRequestStatus(id, status, denialNote = null) {
  db.prepare('UPDATE discover_requests SET status = ?, denial_note = ? WHERE id = ?')
    .run(status, denialNote || null, Number(id));
}

function deleteRequest(id) {
  db.prepare('DELETE FROM discover_requests WHERE id = ?').run(Number(id));
}

function deleteRequestsByUser(userId) {
  db.prepare('DELETE FROM discover_requests WHERE user_id = ?').run(String(userId));
}

function getEffectiveAutoApprove(userId, mediaType) {
  // Check user-level override first
  const row = db.prepare('SELECT auto_approve_movies, auto_approve_tv FROM user_request_limits WHERE user_id = ?')
    .get(String(userId));
  const col = mediaType === 'movie' ? 'auto_approve_movies' : 'auto_approve_tv';
  if (row && row[col] !== null && row[col] !== undefined) {
    return row[col] === 1;
  }
  // Fall back to global setting (default true)
  const globalKey = mediaType === 'movie' ? 'auto_approve_movies' : 'auto_approve_tv';
  return getSetting(globalKey, '1') === '1';
}

function setUserAdmin(userId, isAdmin) {
  db.prepare('UPDATE known_users SET is_admin = ? WHERE user_id = ?')
    .run(isAdmin ? 1 : 0, String(userId));
}

function isAdminUser(userId) {
  const row = db.prepare('SELECT is_admin FROM known_users WHERE user_id = ?').get(String(userId));
  return row ? !!row.is_admin : false;
}

function getUserSettings(userId) {
  const limits = db.prepare('SELECT * FROM user_request_limits WHERE user_id = ?').get(String(userId));
  const user = db.prepare('SELECT is_admin FROM known_users WHERE user_id = ?').get(String(userId));
  return {
    movieLimit: limits?.movie_limit ?? 0,
    seasonLimit: limits?.season_limit ?? 0,
    movieWindowDays: limits?.movie_window_days ?? 7,
    tvWindowDays: limits?.season_window_days ?? 7,
    overrideGlobal: limits ? !!limits.override_enabled : false,
    auto_approve_movies: limits?.auto_approve_movies ?? null,
    auto_approve_tv: limits?.auto_approve_tv ?? null,
    is_admin: user ? !!user.is_admin : false,
    region: limits?.region || null,
    language: limits?.language || null,
    auto_request_movies: limits ? !!limits.auto_request_movies : false,
    auto_request_tv: limits ? !!limits.auto_request_tv : false,
    landing_page: limits?.landing_page || null,
  };
}

function saveUserSettings(userId, settings) {
  const {
    movieLimit = 0,
    seasonLimit = 0,
    movieWindowDays = 7,
    tvWindowDays = 7,
    overrideGlobal = false,
    auto_approve_movies = null,
    auto_approve_tv = null,
    is_admin = false,
    region = null,
    language = null,
    auto_request_movies = false,
    auto_request_tv = false,
    landing_page = null,
  } = settings;

  db.prepare(`
    INSERT OR REPLACE INTO user_request_limits
      (user_id, override_enabled, movie_limit, movie_window_days, season_limit, season_window_days, auto_approve_movies, auto_approve_tv, region, language, auto_request_movies, auto_request_tv, landing_page)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(userId),
    overrideGlobal ? 1 : 0,
    Number(movieLimit) || 0,
    Number(movieWindowDays) || 7,
    Number(seasonLimit) || 0,
    Number(tvWindowDays) || 7,
    auto_approve_movies === null ? null : (auto_approve_movies ? 1 : 0),
    auto_approve_tv === null ? null : (auto_approve_tv ? 1 : 0),
    region || null,
    language || null,
    auto_request_movies ? 1 : 0,
    auto_request_tv ? 1 : 0,
    landing_page || null,
  );

  // Ensure user row exists in known_users before updating is_admin
  const exists = db.prepare('SELECT 1 FROM known_users WHERE user_id = ?').get(String(userId));
  if (exists) {
    db.prepare('UPDATE known_users SET is_admin = ? WHERE user_id = ?')
      .run(is_admin ? 1 : 0, String(userId));
  }
}

function addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title, service, seasonsCount, status = 'approved', seasonsArray = null, posterUrl = null) {
  db.prepare(`
    INSERT INTO discover_requests (user_id, tmdb_id, media_type, title, service, seasons_count, requested_at, status, seasons_json, poster_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(userId), Number(tmdbId), mediaType, title, service,
         (typeof seasonsCount === 'number' && seasonsCount > 0) ? seasonsCount : 1,
         Math.floor(Date.now() / 1000),
         status,
         seasonsArray ? JSON.stringify(seasonsArray) : null,
         posterUrl || null);
}

function updateRequest(id, { service, seasonsJson, seasonsCount }) {
  db.prepare('UPDATE discover_requests SET service=?, seasons_json=?, seasons_count=? WHERE id=?')
    .run(service, seasonsJson || null, seasonsCount || 1, Number(id));
}

function getRequestById(id) {
  return db.prepare(`
    SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    WHERE dr.id = ?
  `).get(Number(id));
}

function getUserPreferences(userId) {
  const row = db.prepare('SELECT region, language, auto_request_movies, auto_request_tv, landing_page, show_mature FROM user_request_limits WHERE user_id = ?').get(String(userId));
  return {
    region: row?.region || null,
    language: row?.language || null,
    auto_request_movies: row ? !!row.auto_request_movies : false,
    auto_request_tv: row ? !!row.auto_request_tv : false,
    landing_page: row?.landing_page || null,
    show_mature: row ? !!row.show_mature : false,
  };
}

function setUserPreferences(userId, { region, language, auto_request_movies, auto_request_tv, landing_page, show_mature }) {
  // Ensure row exists first
  db.prepare('INSERT OR IGNORE INTO user_request_limits (user_id) VALUES (?)').run(String(userId));
  db.prepare('UPDATE user_request_limits SET region = ?, language = ?, auto_request_movies = ?, auto_request_tv = ?, landing_page = ?, show_mature = ? WHERE user_id = ?')
    .run(region || null, language || null, auto_request_movies ? 1 : 0, auto_request_tv ? 1 : 0, landing_page || null, show_mature ? 1 : 0, String(userId));
}

function getUserRequests(userId, limit = 20, offset = 0, statusFilter = null, orderBy = 'requested_at', orderDir = 'DESC') {
  const ALLOWED_COLS = { title: 'dr.title', username: 'COALESCE(ku.username, dr.user_id)', media_type: 'dr.media_type', requested_at: 'dr.requested_at', status: 'dr.status' };
  const col = ALLOWED_COLS[orderBy] || 'dr.requested_at';
  const dir = orderDir === 'ASC' ? 'ASC' : 'DESC';
  const where = statusFilter && statusFilter !== 'all'
    ? `WHERE dr.user_id = ? AND dr.status = '${statusFilter}'`
    : 'WHERE dr.user_id = ?';
  const rows = db.prepare(`
    SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username, ku.thumb AS user_thumb
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ${where}
    ORDER BY ${col} ${dir}
    LIMIT ? OFFSET ?
  `).all(String(userId), Number(limit), Number(offset));
  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM discover_requests dr ${where}`).get(String(userId));
  return { rows, total: countRow?.cnt || 0 };
}

// ── Notifications ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    data TEXT,
    bundle_key TEXT,
    bundle_count INTEGER DEFAULT 1,
    read INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at);

  CREATE TABLE IF NOT EXISTS user_notification_prefs (
    user_id TEXT PRIMARY KEY,
    notify_approved INTEGER DEFAULT 1,
    notify_denied INTEGER DEFAULT 1,
    notify_available INTEGER DEFAULT 1,
    discord_webhook TEXT DEFAULT NULL,
    discord_enabled INTEGER DEFAULT 0,
    pushover_user_key TEXT DEFAULT NULL,
    pushover_enabled INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notification_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER,
    agent TEXT NOT NULL,
    user_id TEXT,
    payload TEXT,
    send_after INTEGER,
    sent INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    title TEXT NOT NULL,
    media_type TEXT NOT NULL,
    poster_path TEXT,
    scope TEXT NOT NULL DEFAULT 'series',
    scope_season INTEGER,
    scope_episode INTEGER,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    admin_note TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_issues_user ON issues(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, created_at);

  CREATE TABLE IF NOT EXISTS issue_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    comment TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at);
`);

for (const col of [
  'notify_pending INTEGER DEFAULT 1',
  'notify_auto_approved INTEGER DEFAULT 1',
  'notify_process_failed INTEGER DEFAULT 1',
  'discord_user_id TEXT DEFAULT NULL',
  'notify_issue_new INTEGER DEFAULT 1',
  'notify_issue_update INTEGER DEFAULT 1',
  'notify_issue_comment INTEGER DEFAULT 1',
]) {
  try { db.prepare(`ALTER TABLE user_notification_prefs ADD COLUMN ${col}`).run(); } catch {}
}

function createOrBundleNotification({ userId, type, title, body, data }) {
  const hour = Math.floor(Date.now() / 1000 / 3600);
  const bundleKey = `${type}:${userId || 'admin'}:${hour}`;
  const existing = db.prepare('SELECT id, bundle_count FROM notifications WHERE bundle_key = ? AND read = 0').get(bundleKey);
  if (existing) {
    const newCount = existing.bundle_count + 1;
    const newTitle = newCount === 2 ? title + ' and 1 other title' : title.replace(/ and \d+ other title/, '') + ` and ${newCount - 1} other titles`;
    db.prepare('UPDATE notifications SET bundle_count = ?, title = ? WHERE id = ?')
      .run(newCount, newTitle, existing.id);
    return existing.id;
  }
  const result = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, data, bundle_key) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId || null, type, title, body || null, data ? JSON.stringify(data) : null, bundleKey);
  return result.lastInsertRowid;
}

function getUnreadNotificationCount(userId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 0').get(String(userId));
  return row?.cnt || 0;
}

function getNotifications(userId, limit = 20) {
  return db.prepare('SELECT * FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 0 ORDER BY created_at DESC LIMIT ?')
    .all(String(userId), Number(limit));
}

function markNotificationsRead(userId, ids) {
  if (!ids || ids.length === 0) {
    db.prepare('UPDATE notifications SET read = 1 WHERE (user_id = ? OR user_id IS NULL)').run(String(userId));
  } else {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders}) AND (user_id = ? OR user_id IS NULL)`)
      .run(...ids.map(Number), String(userId));
  }
}

function deleteNotification(userId, id) {
  db.prepare('DELETE FROM notifications WHERE id = ? AND (user_id = ? OR user_id IS NULL)').run(Number(id), String(userId));
}

function getUserNotificationPrefs(userId) {
  const row = db.prepare('SELECT * FROM user_notification_prefs WHERE user_id = ?').get(String(userId));
  return {
    notify_approved: row ? !!row.notify_approved : true,
    notify_denied: row ? !!row.notify_denied : true,
    notify_available: row ? !!row.notify_available : true,
    discord_webhook: row?.discord_webhook || null,
    discord_enabled: row ? !!row.discord_enabled : false,
    discord_user_id: row?.discord_user_id || null,
    pushover_user_key: row?.pushover_user_key || null,
    pushover_enabled: row ? !!row.pushover_enabled : false,
    notify_pending: row ? (row.notify_pending !== null ? !!row.notify_pending : true) : true,
    notify_auto_approved: row ? (row.notify_auto_approved !== null ? !!row.notify_auto_approved : true) : true,
    notify_process_failed: row ? (row.notify_process_failed !== null ? !!row.notify_process_failed : true) : true,
    notify_issue_new:     row ? (row.notify_issue_new     !== null ? !!row.notify_issue_new     : true) : true,
    notify_issue_update:  row ? (row.notify_issue_update  !== null ? !!row.notify_issue_update  : true) : true,
    notify_issue_comment: row ? (row.notify_issue_comment !== null ? !!row.notify_issue_comment : true) : true,
  };
}

function setUserNotificationPrefs(userId, prefs) {
  db.prepare(`
    INSERT OR REPLACE INTO user_notification_prefs
      (user_id, notify_approved, notify_denied, notify_available, discord_webhook, discord_enabled, discord_user_id, pushover_user_key, pushover_enabled,
       notify_pending, notify_auto_approved, notify_process_failed, notify_issue_new, notify_issue_update, notify_issue_comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(userId),
    prefs.notify_approved !== false ? 1 : 0,
    prefs.notify_denied !== false ? 1 : 0,
    prefs.notify_available !== false ? 1 : 0,
    prefs.discord_webhook || null,
    prefs.discord_enabled ? 1 : 0,
    prefs.discord_user_id || null,
    prefs.pushover_user_key || null,
    prefs.pushover_enabled ? 1 : 0,
    prefs.notify_pending !== false ? 1 : 0,
    prefs.notify_auto_approved !== false ? 1 : 0,
    prefs.notify_process_failed !== false ? 1 : 0,
    prefs.notify_issue_new !== false ? 1 : 0,
    prefs.notify_issue_update !== false ? 1 : 0,
    prefs.notify_issue_comment !== false ? 1 : 0,
  );
}

function getAdminUserIds() {
  const rows = db.prepare("SELECT user_id FROM known_users WHERE is_admin = 1").all();
  return rows.map(r => r.user_id);
}

function getPrivilegedUserIds() {
  const admins = db.prepare('SELECT user_id FROM known_users WHERE is_admin = 1').all().map(r => r.user_id);
  const owner = getSetting('owner_plex_user_id', null);
  return [...new Set([...admins, ...(owner ? [owner] : [])])];
}

function getNotificationById(id) {
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(id));
}

function getRecentReadNotifications(userId, limit = 5) {
  return db.prepare('SELECT * FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 1 ORDER BY created_at DESC LIMIT ?')
    .all(String(userId), Number(limit));
}

function enqueueNotification({ notificationId, agent, userId, payload, sendAfter }) {
  db.prepare('INSERT INTO notification_queue (notification_id, agent, user_id, payload, send_after) VALUES (?, ?, ?, ?, ?)')
    .run(notificationId || null, agent, userId || null, JSON.stringify(payload), sendAfter || Math.floor(Date.now()/1000) + 120);
}

function getPendingQueuedNotifications() {
  return db.prepare('SELECT * FROM notification_queue WHERE sent = 0 AND send_after <= ? ORDER BY id ASC LIMIT 50')
    .all(Math.floor(Date.now()/1000));
}

function markQueueItemSent(id) {
  db.prepare('UPDATE notification_queue SET sent = 1 WHERE id = ?').run(Number(id));
}

function deleteQueueItem(id) {
  db.prepare('DELETE FROM notification_queue WHERE id = ?').run(Number(id));
}

// ── Issue reporting ────────────────────────────────────────────────────────────

function createIssue({ userId, ratingKey, title, mediaType, posterPath, scope, scopeSeason, scopeEpisode, description }) {
  const result = db.prepare(`
    INSERT INTO issues (user_id, rating_key, title, media_type, poster_path, scope, scope_season, scope_episode, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(userId), String(ratingKey), title, mediaType, posterPath || null,
    scope || 'series',
    scopeSeason != null ? Number(scopeSeason) : null,
    scopeEpisode != null ? Number(scopeEpisode) : null,
    description || null
  );
  return result.lastInsertRowid;
}

function getIssueById(id) {
  return db.prepare(`
    SELECT i.*, COALESCE(ku.username, i.user_id) AS username
    FROM issues i LEFT JOIN known_users ku ON ku.user_id = i.user_id
    WHERE i.id = ?
  `).get(Number(id));
}

function getAllIssues(limit, offset, statusFilter) {
  const where = statusFilter && statusFilter !== 'all' ? 'WHERE i.status = ?' : '';
  const params = statusFilter && statusFilter !== 'all'
    ? [statusFilter, Number(limit), Number(offset)]
    : [Number(limit), Number(offset)];
  const rows = db.prepare(`
    SELECT i.*, COALESCE(ku.username, i.user_id) AS username
    FROM issues i LEFT JOIN known_users ku ON ku.user_id = i.user_id
    ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `).all(...params);
  const cntParams = statusFilter && statusFilter !== 'all' ? [statusFilter] : [];
  const { cnt } = db.prepare(`SELECT COUNT(*) as cnt FROM issues i ${where}`).get(...cntParams);
  return { rows, total: cnt || 0 };
}

function getUserIssues(userId, limit, offset, statusFilter) {
  const extraWhere = statusFilter && statusFilter !== 'all' ? 'AND i.status = ?' : '';
  const params = statusFilter && statusFilter !== 'all'
    ? [String(userId), statusFilter, Number(limit), Number(offset)]
    : [String(userId), Number(limit), Number(offset)];
  const rows = db.prepare(`
    SELECT i.*, COALESCE(ku.username, i.user_id) AS username
    FROM issues i LEFT JOIN known_users ku ON ku.user_id = i.user_id
    WHERE i.user_id = ? ${extraWhere} ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `).all(...params);
  const cntParams = statusFilter && statusFilter !== 'all'
    ? [String(userId), statusFilter] : [String(userId)];
  const { cnt } = db.prepare(`SELECT COUNT(*) as cnt FROM issues i WHERE i.user_id = ? ${extraWhere}`)
    .get(...cntParams);
  return { rows, total: cnt || 0 };
}

function updateIssueStatus(id, status, adminNote) {
  db.prepare('UPDATE issues SET status = ?, admin_note = ?, updated_at = unixepoch() WHERE id = ?')
    .run(status, adminNote !== undefined ? adminNote : null, Number(id));
}

function deleteIssue(id) {
  db.prepare('DELETE FROM issues WHERE id = ?').run(Number(id));
}

// ── Issue comments ─────────────────────────────────────────────────────────────

function addIssueComment(issueId, userId, comment, isAdmin) {
  const result = db.prepare(
    'INSERT INTO issue_comments (issue_id, user_id, is_admin, comment) VALUES (?, ?, ?, ?)'
  ).run(Number(issueId), String(userId), isAdmin ? 1 : 0, comment);
  db.prepare('UPDATE issues SET updated_at = unixepoch() WHERE id = ?').run(Number(issueId));
  return result.lastInsertRowid;
}

function getIssueComments(issueId) {
  return db.prepare(`
    SELECT ic.*, COALESCE(ku.username, ic.user_id) AS display_name
    FROM issue_comments ic
    LEFT JOIN known_users ku ON ku.user_id = ic.user_id
    WHERE ic.issue_id = ?
    ORDER BY ic.created_at ASC
  `).all(Number(issueId));
}

function deleteIssueComment(commentId, requesterId, isAdmin) {
  if (isAdmin) {
    db.prepare('DELETE FROM issue_comments WHERE id = ?').run(Number(commentId));
  } else {
    db.prepare('DELETE FROM issue_comments WHERE id = ? AND user_id = ?').run(Number(commentId), String(requesterId));
  }
}

// ── Request fulfillment notifications ─────────────────────────────────────────

function getUnnotifiedFulfilledRequests(libraryTmdbIds) {
  const rows = db.prepare(`
    SELECT * FROM discover_requests
    WHERE status != 'denied'
    AND notified_available_at IS NULL
  `).all();
  return rows.filter(r => libraryTmdbIds.has(`${r.tmdb_id}:${r.media_type}`));
}

function markRequestsNotifiedAvailable(ids) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare('UPDATE discover_requests SET notified_available_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(now, id);
}

// ── API Apps (Agregarr / external integrations) ───────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS api_apps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    api_key     TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL DEFAULT 'generic',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT 0,
    notes       TEXT
  );

  CREATE TABLE IF NOT EXISTS app_service_users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id              INTEGER NOT NULL REFERENCES api_apps(id),
    overseerr_user_id   INTEGER NOT NULL,
    user_id             TEXT NOT NULL,
    api_key             TEXT UNIQUE NOT NULL,
    email               TEXT,
    username            TEXT NOT NULL,
    permissions         INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_svc_user_overseerr ON app_service_users(app_id, overseerr_user_id);
`);

function createApiApp(name, type = 'generic') {
  const { randomBytes } = require('crypto');
  const key = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    'INSERT INTO api_apps (name, api_key, type, enabled, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(name, key, type, now);
  return db.prepare('SELECT * FROM api_apps WHERE id = ?').get(result.lastInsertRowid);
}

function getApiApp(id) {
  return db.prepare('SELECT * FROM api_apps WHERE id = ?').get(Number(id));
}

function getApiAppByKey(apiKey) {
  return db.prepare('SELECT * FROM api_apps WHERE api_key = ? AND enabled = 1').get(apiKey);
}

function listApiApps() {
  return db.prepare('SELECT * FROM api_apps ORDER BY created_at DESC').all();
}

function updateApiApp(id, { name, enabled, notes } = {}) {
  const app = getApiApp(id);
  if (!app) return null;
  db.prepare('UPDATE api_apps SET name = ?, enabled = ?, notes = ? WHERE id = ?')
    .run(name !== undefined ? name : app.name,
         enabled !== undefined ? (enabled ? 1 : 0) : app.enabled,
         notes !== undefined ? notes : app.notes,
         Number(id));
  return getApiApp(id);
}

function regenerateApiAppKey(id) {
  const { randomBytes } = require('crypto');
  const key = randomBytes(32).toString('hex');
  db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(key, Number(id));
  return key;
}

function deleteApiApp(id) {
  // Remove all service users first (and their known_users entries)
  const users = getServiceUsersByApp(id);
  for (const u of users) {
    db.prepare('DELETE FROM known_users WHERE user_id = ?').run(u.user_id);
  }
  db.prepare('DELETE FROM app_service_users WHERE app_id = ?').run(Number(id));
  db.prepare('DELETE FROM api_apps WHERE id = ?').run(Number(id));
}

function createServiceUser(appId, { username, email, permissions = 0 }) {
  const { randomBytes } = require('crypto');
  const apiKey = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  // Stable fake Overseerr user ID: start at 100 to avoid colliding with Overseerr admin (id=1)
  const maxRow = db.prepare('SELECT MAX(overseerr_user_id) as m FROM app_service_users WHERE app_id = ?').get(Number(appId));
  const overseerrUserId = (maxRow?.m || 99) + 1;
  const userId = `__svc_${appId}_${overseerrUserId}__`;
  // Insert into known_users so the request system can resolve a display name
  db.prepare('INSERT OR REPLACE INTO known_users (user_id, username, thumb, seen_at) VALUES (?, ?, NULL, ?)')
    .run(userId, username, now);
  const result = db.prepare(`
    INSERT INTO app_service_users (app_id, overseerr_user_id, user_id, api_key, email, username, permissions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(appId), overseerrUserId, userId, apiKey, email || null, username, permissions, now);
  return db.prepare('SELECT * FROM app_service_users WHERE id = ?').get(result.lastInsertRowid);
}

function getServiceUserByKey(apiKey) {
  return db.prepare('SELECT * FROM app_service_users WHERE api_key = ?').get(apiKey);
}

function getServiceUserById(appId, overseerrUserId) {
  return db.prepare('SELECT * FROM app_service_users WHERE app_id = ? AND overseerr_user_id = ?')
    .get(Number(appId), Number(overseerrUserId));
}

function getServiceUsersByApp(appId) {
  return db.prepare('SELECT * FROM app_service_users WHERE app_id = ? ORDER BY overseerr_user_id ASC').all(Number(appId));
}

function deleteServiceUser(id) {
  const u = db.prepare('SELECT * FROM app_service_users WHERE id = ?').get(Number(id));
  if (!u) return;
  db.prepare('DELETE FROM known_users WHERE user_id = ?').run(u.user_id);
  db.prepare('DELETE FROM app_service_users WHERE id = ?').run(Number(id));
}

module.exports = {
  addDismissal, getDismissals, removeDismissal,
  addToWatchlistDb, removeFromWatchlistDb, getWatchlistFromDb,
  updateWatchlistPlexIds, getWatchlistPlexIds, updateWatchlistPlexGuid,
  upsertKnownUser, touchKnownUser, getKnownUsers, getAllKnownUsersWithTokens, getLibraryItemByTmdbId,
  upsertManyItems, getLibraryItemsFromDb, getLibraryItemByKey,
  replaceWatchedBatch, getWatchedKeysFromDb,
  upsertUserRatings, getUserRatingsFromDb,
  getSyncTime, setSyncTime,
  getAdminStats, clearUserWatched, clearAllUserWatched,
  clearLibraryDb, clearUserDismissals,
  getThemeColor, setThemeColor,
  getAdminWatchlistMode, setAdminWatchlistMode,
  getOwnerUserId, setOwnerUserId,
  getSetting, setSetting, getConnectionSettings, isDiscoverEnabled, hasTmdbKey,
  getTmdbCache, setTmdbCache, deleteTmdbCache, getItemsByGenre,
  getLibraryTmdbIds, getLibraryTitleYearSet,
  addDiscoverRequest, getRequestedTmdbIds, getAllRequestedTmdbIds, getRecentRequests,
  addExploreDismissal, getExploreDismissedIds,
  getDiscoverPool, setDiscoverPool, getKnownUserIds,
  getDiscoverCandidates, setDiscoverCandidates, getAllUserPrefsForDiscover,
  isIndividualSeasonsEnabled,
  getLandingPage,
  getDirectRequestAccess,
  getGlobalRequestLimits, setGlobalRequestLimits,
  getUserRequestLimitOverride, setUserRequestLimitOverride, getAllUserRequestLimitOverrides,
  getEffectiveLimits, countRecentMovieRequests, countRecentSeasonRequests,
  getPendingRequests, getAllRequests, updateRequestStatus, deleteRequest, deleteRequestsByUser,
  getEffectiveAutoApprove, setUserAdmin, isAdminUser,
  getUserSettings, saveUserSettings,
  getUserPreferences, setUserPreferences,
  getUserRequests,
  addDiscoverRequestWithStatus, updateRequest, getRequestById,
  createOrBundleNotification, getUnreadNotificationCount, getNotifications,
  markNotificationsRead, deleteNotification, getNotificationById, getRecentReadNotifications,
  getUserNotificationPrefs, setUserNotificationPrefs,
  getAdminUserIds, getPrivilegedUserIds,
  enqueueNotification, getPendingQueuedNotifications, markQueueItemSent, deleteQueueItem,
  createIssue, getIssueById, getAllIssues, getUserIssues, updateIssueStatus, deleteIssue,
  addIssueComment, getIssueComments, deleteIssueComment,
  getUnnotifiedFulfilledRequests, markRequestsNotifiedAvailable,
  // API apps (Agregarr / external integrations)
  createApiApp, getApiApp, getApiAppByKey, listApiApps, updateApiApp, regenerateApiAppKey, deleteApiApp,
  createServiceUser, getServiceUserByKey, getServiceUserById, getServiceUsersByApp, deleteServiceUser,
  // Raw prepare — used by overseerrShim for ad-hoc queries not worth a dedicated function
  prepare: (sql) => db.prepare(sql),
};
