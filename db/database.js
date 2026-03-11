const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'diskovarr.db'));

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
    "SELECT COUNT(*) as cnt FROM discover_requests WHERE user_id = ? AND media_type = 'movie' AND requested_at > ?"
  ).get(String(userId), since);
  return row?.cnt || 0;
}

function countRecentSeasonRequests(userId, windowDays) {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const row = db.prepare(
    "SELECT COALESCE(SUM(seasons_count), 0) as cnt FROM discover_requests WHERE user_id = ? AND media_type = 'tv' AND requested_at > ?"
  ).get(String(userId), since);
  return row?.cnt || 0;
}

// ── Migrate: add columns if this is an existing DB ────────────────────────────
[
  'ALTER TABLE library_items ADD COLUMN rating REAL DEFAULT 0',
  "ALTER TABLE library_items ADD COLUMN rating_image TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN audience_rating_image TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN studio TEXT DEFAULT ''",
  'ALTER TABLE library_items ADD COLUMN tmdb_id TEXT DEFAULT NULL',
  'ALTER TABLE library_items ADD COLUMN art TEXT DEFAULT NULL',
  'ALTER TABLE discover_requests ADD COLUMN seasons_count INTEGER DEFAULT 1',
].forEach(sql => { try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column')) throw e; } });

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
     rating, rating_image, audience_rating_image, studio, tmdb_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        item.tmdbId || null
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
    tmdbId: r.tmdb_id || null,
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
].forEach(sql => { try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column')) throw e; } });

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
    tmdbApiKey: getSetting('tmdb_api_key', ''),
    discoverEnabled: getSetting('discover_enabled', '0') === '1',
    overseerrUrl: getSetting('overseerr_url', ''),
    overseerrApiKey: getSetting('overseerr_api_key', ''),
    overseerrEnabled: getSetting('overseerr_enabled', '0') === '1',
    radarrUrl: getSetting('radarr_url', ''),
    radarrApiKey: getSetting('radarr_api_key', ''),
    radarrEnabled: getSetting('radarr_enabled', '0') === '1',
    radarrQualityProfileId: getSetting('radarr_quality_profile_id', ''),
    sonarrUrl: getSetting('sonarr_url', ''),
    sonarrApiKey: getSetting('sonarr_api_key', ''),
    sonarrEnabled: getSetting('sonarr_enabled', '0') === '1',
    sonarrQualityProfileId: getSetting('sonarr_quality_profile_id', ''),
    defaultRequestService: getSetting('default_request_service', 'overseerr'),
  };
}

// Tab is visible if the toggle is on (TMDB key checked separately at recommendation time)
function isDiscoverEnabled() {
  return getSetting('discover_enabled', '0') === '1';
}

function hasTmdbKey() {
  return !!getSetting('tmdb_api_key', '');
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

db.exec(`
  CREATE TABLE IF NOT EXISTS discover_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    title TEXT,
    service TEXT,
    requested_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_discover_requests_user ON discover_requests(user_id);
`);

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

function isIndividualSeasonsEnabled() {
  return getSetting('individual_seasons_enabled', '0') === '1';
}

function getLandingPage() {
  return getSetting('landing_page', 'home'); // 'home' or 'explore'
}

function getDirectRequestAccess() {
  return getSetting('direct_request_access', 'all'); // 'all' or 'admin'
}

module.exports = {
  addDismissal, getDismissals, removeDismissal,
  addToWatchlistDb, removeFromWatchlistDb, getWatchlistFromDb,
  updateWatchlistPlexIds, getWatchlistPlexIds, updateWatchlistPlexGuid,
  upsertKnownUser, getKnownUsers,
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
  getTmdbCache, setTmdbCache,
  getLibraryTmdbIds, getLibraryTitleYearSet,
  addDiscoverRequest, getRequestedTmdbIds, getAllRequestedTmdbIds, getRecentRequests,
  addExploreDismissal, getExploreDismissedIds,
  getDiscoverPool, setDiscoverPool, getKnownUserIds,
  isIndividualSeasonsEnabled,
  getLandingPage,
  getDirectRequestAccess,
  getGlobalRequestLimits, setGlobalRequestLimits,
  getUserRequestLimitOverride, setUserRequestLimitOverride, getAllUserRequestLimitOverrides,
  getEffectiveLimits, countRecentMovieRequests, countRecentSeasonRequests,
};
