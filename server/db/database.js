const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'diskovarr.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
// Enforce ON DELETE CASCADE (reviews→reactions/comments, comment→replies). Without
// this, foreign_keys defaults to OFF and deletes orphan their child rows. Migrations
// that rebuild tables pause/restore this pragma themselves.
db.exec('PRAGMA foreign_keys=ON;');

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

function getUserDismissalRows(userId) {
  return db.prepare('SELECT rating_key, dismissed_at FROM dismissals WHERE plex_user_id = ? ORDER BY dismissed_at DESC')
    .all(String(userId));
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

function getUserExploreDismissalRows(userId) {
  return db.prepare('SELECT tmdb_id, media_type, dismissed_at FROM explore_dismissals WHERE plex_user_id = ? ORDER BY dismissed_at DESC')
    .all(String(userId));
}

function removeExploreDismissal(userId, tmdbId, mediaType) {
  db.prepare('DELETE FROM explore_dismissals WHERE plex_user_id = ? AND tmdb_id = ? AND media_type = ?')
    .run(String(userId), String(tmdbId), String(mediaType));
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
  // Expanded filter/sort fields (Plex parity)
  "ALTER TABLE library_items ADD COLUMN writers TEXT DEFAULT '[]'",
  "ALTER TABLE library_items ADD COLUMN producers TEXT DEFAULT '[]'",
  "ALTER TABLE library_items ADD COLUMN countries TEXT DEFAULT '[]'",
  "ALTER TABLE library_items ADD COLUMN collections TEXT DEFAULT '[]'",
  "ALTER TABLE library_items ADD COLUMN labels TEXT DEFAULT '[]'",
  "ALTER TABLE library_items ADD COLUMN edition TEXT DEFAULT ''",
  "ALTER TABLE library_items ADD COLUMN release_date TEXT DEFAULT ''",
  'ALTER TABLE library_items ADD COLUMN duration INTEGER DEFAULT 0',
  'ALTER TABLE library_items ADD COLUMN last_episode_added_at INTEGER DEFAULT 0',
  'ALTER TABLE library_items ADD COLUMN detail_synced_at INTEGER DEFAULT 0',
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
  'ALTER TABLE known_users ADD COLUMN followers_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE known_users ADD COLUMN following_count INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE user_request_limits ADD COLUMN review_privacy TEXT NOT NULL DEFAULT 'public'",
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
  {
    name: 'reviews_table_v1',
    sql: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          tmdb_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          year INTEGER,
          rating REAL NOT NULL CHECK (rating >= 0.5 AND rating <= 5.0 AND rating % 0.5 = 0),
          review_text TEXT DEFAULT '',
          spoiler INTEGER DEFAULT 0,
          rewatch INTEGER DEFAULT 0,
          watched_date INTEGER NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          UNIQUE(user_id, media_type, tmdb_id)
        );
        CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_tmdb ON reviews(media_type, tmdb_id);
      `);
    },
  },
  {
    // Persisted Tautulli watch history so the page reads from the DB instead of
    // hitting Tautulli live on every load. Keyed by Tautulli's history id so a
    // periodic background sync can upsert (new plays + updated in-progress rows).
    name: 'watch_history_table_v1',
    sql: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS watch_history (
          history_id INTEGER PRIMARY KEY,
          user_id TEXT,
          rating_key TEXT,
          grandparent_rating_key TEXT,
          parent_rating_key TEXT,
          title TEXT,
          parent_title TEXT,
          year INTEGER,
          media_type TEXT,
          thumb TEXT,
          watched_at INTEGER DEFAULT 0,
          duration INTEGER DEFAULT 0,
          percent_complete INTEGER DEFAULT 0,
          watched_status TEXT,
          user_name TEXT,
          user_thumb TEXT,
          season_number INTEGER,
          episode_number INTEGER,
          bitrate TEXT,
          resolution TEXT,
          synced_at INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_wh_user ON watch_history(user_id);
        CREATE INDEX IF NOT EXISTS idx_wh_date ON watch_history(watched_at);
      `);
    },
 },
  {
    name: 'tmdb_connections_table_v1',
    sql: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tmdb_connections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'connected',
          connected_at INTEGER NOT NULL,
          last_verified_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tmdb_conn_user ON tmdb_connections(user_id);
      `);
    },
  },
  {
    // Track the star rating last successfully pushed to TMDB per review.
    // NULL = never synced. Lets the UI show a "pushed" (locked) vs "update"
    // state by comparing the current rating against this value.
    name: 'reviews_tmdb_synced_rating_v1',
    sql: () => {
      db.exec('ALTER TABLE reviews ADD COLUMN tmdb_synced_rating REAL');
    },
  },
  {
    name: 'review_reactions_table_v1',
    sql: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          UNIQUE(review_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_reactions_review ON review_reactions(review_id);
      `);
    },
  },
  {
    name: 'review_comments_table_v1',
    sql: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          parent_id INTEGER REFERENCES review_comments(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_comments_review ON review_comments(review_id);
      `);
    },
  },
  {
    name: 'user_follows_table_v1',
    sql: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_follows (
          follower_id TEXT NOT NULL,
          followee_id TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (follower_id, followee_id)
        );
        CREATE INDEX IF NOT EXISTS idx_follows_follower ON user_follows(follower_id);
        CREATE INDEX IF NOT EXISTS idx_follows_followee ON user_follows(followee_id);
      `);
    },
  },
  {
    // Allow reviews for library items that have no TMDB match (e.g. YouTube /
    // abridged content). tmdb_id becomes nullable, a rating_key column is added,
    // and uniqueness is enforced by two partial indexes (one per identity kind).
    // FK enforcement is paused for the table swap; ids are preserved so existing
    // review_reactions / review_comments references stay valid.
    name: 'reviews_rating_key_fallback_v1',
    sql: () => {
      db.exec('PRAGMA foreign_keys=OFF;');
      db.exec(`
        BEGIN;
        CREATE TABLE reviews_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          tmdb_id INTEGER,
          rating_key TEXT,
          title TEXT NOT NULL,
          year INTEGER,
          rating REAL NOT NULL CHECK (rating >= 0.5 AND rating <= 5.0 AND rating % 0.5 = 0),
          review_text TEXT DEFAULT '',
          spoiler INTEGER DEFAULT 0,
          rewatch INTEGER DEFAULT 0,
          watched_date INTEGER NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          tmdb_synced_rating REAL,
          CHECK (tmdb_id IS NOT NULL OR rating_key IS NOT NULL)
        );
        INSERT INTO reviews_new (id, user_id, media_type, tmdb_id, rating_key, title, year, rating, review_text, spoiler, rewatch, watched_date, created_at, updated_at, tmdb_synced_rating)
          SELECT id, user_id, media_type, tmdb_id, NULL, title, year, rating, review_text, spoiler, rewatch, watched_date, created_at, updated_at, tmdb_synced_rating FROM reviews;
        DROP TABLE reviews;
        ALTER TABLE reviews_new RENAME TO reviews;
        CREATE INDEX idx_reviews_user ON reviews(user_id);
        CREATE INDEX idx_reviews_tmdb ON reviews(media_type, tmdb_id);
        CREATE UNIQUE INDEX idx_reviews_uniq_tmdb ON reviews(user_id, media_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_reviews_uniq_ratingkey ON reviews(user_id, rating_key) WHERE rating_key IS NOT NULL;
        COMMIT;
      `);
      db.exec('PRAGMA foreign_keys=ON;');
    },
  },
  {
    // Denormalized reaction/comment counts on each review so the feed avoids a
    // correlated COUNT() subquery per row (mirrors known_users.followers_count).
    // Maintained in the reaction/comment DB helpers; backfilled here.
    name: 'reviews_denormalized_counts_v1',
    sql: () => {
      db.exec('ALTER TABLE reviews ADD COLUMN reaction_count INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE reviews ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        UPDATE reviews SET
          reaction_count = (SELECT COUNT(*) FROM review_reactions rr WHERE rr.review_id = reviews.id),
          comment_count  = (SELECT COUNT(*) FROM review_comments rc WHERE rc.review_id = reviews.id)
      `);
    },
  },
   {
     // Profile fields on known_users for bio, favorite genres, and favorite media.
     name: 'user_profile_v1',
     sql: () => {
       db.exec("ALTER TABLE known_users ADD COLUMN bio TEXT DEFAULT ''");
       db.exec("ALTER TABLE known_users ADD COLUMN favorite_genres TEXT DEFAULT '[]'");
       db.exec("ALTER TABLE known_users ADD COLUMN favorite_media TEXT DEFAULT '[]'");
     },
   },
   {
      // The Cast & Crew tab added structuredCast/structuredCrew to the tmdb
      // normalizers; entries cached before that lack those fields, so the modal's
      // credits come back empty. Clear the cache once to force a re-fetch.
      name: 'structured_credits_v1',
      sql: () => {
        db.prepare('DELETE FROM tmdb_cache').run();
      },
    },
    {
      // Content monitoring system — users create monitors with criteria that
      // match against new content. When content matches, a notification fires.
      name: 'monitors_v1',
      sql: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS monitors (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id              TEXT NOT NULL,
            name                 TEXT NOT NULL,
            enabled              INTEGER NOT NULL DEFAULT 1,
            match_mode           TEXT NOT NULL DEFAULT 'ALL' CHECK(match_mode IN ('ALL', 'ANY')),
            notify_plex          INTEGER NOT NULL DEFAULT 1,
            notify_requestable   INTEGER NOT NULL DEFAULT 1,
            created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id, enabled);
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS monitor_criteria (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            monitor_id    INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
            type          TEXT NOT NULL,
            entity_id     TEXT,
            entity_name   TEXT NOT NULL,
            metadata      TEXT,
            created_at    INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX IF NOT EXISTS idx_criteria_monitor ON monitor_criteria(monitor_id);
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS monitor_notifications (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            monitor_id        INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
            user_id           TEXT NOT NULL,
            content_tmdb_id   TEXT NOT NULL,
            content_type      TEXT NOT NULL,
            notification_type TEXT NOT NULL,
            created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
            UNIQUE(monitor_id, content_tmdb_id, content_type, notification_type)
          );
          CREATE INDEX IF NOT EXISTS idx_monitor_notif_monitor ON monitor_notifications(monitor_id);
        `);
        try { db.exec('ALTER TABLE user_notification_prefs ADD COLUMN notify_monitor INTEGER DEFAULT 1'); } catch {}
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

// Bulk upsert from the Plex section/all listing. Uses ON CONFLICT DO UPDATE (not
// INSERT OR REPLACE) so it updates only bulk-sourced columns and never clobbers the
// detail-only columns (producers, labels, detail_synced_at) populated by the per-item
// backfill, nor last_episode_added_at which is computed separately.
const stmtUpsertItem = db.prepare(`
  INSERT INTO library_items
    (rating_key, section_id, title, year, thumb, art, type, genres, directors, cast,
     audience_rating, content_rating, added_at, summary, synced_at,
     rating, rating_image, audience_rating_image, studio, tmdb_id, leaf_count,
     writers, countries, collections, edition, release_date, duration)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(rating_key) DO UPDATE SET
    section_id=excluded.section_id, title=excluded.title, year=excluded.year,
    thumb=excluded.thumb, art=excluded.art, type=excluded.type, genres=excluded.genres,
    directors=excluded.directors, cast=excluded.cast, audience_rating=excluded.audience_rating,
    content_rating=excluded.content_rating, added_at=excluded.added_at, summary=excluded.summary,
    synced_at=excluded.synced_at, rating=excluded.rating, rating_image=excluded.rating_image,
    audience_rating_image=excluded.audience_rating_image, studio=excluded.studio,
    tmdb_id=excluded.tmdb_id, leaf_count=excluded.leaf_count, writers=excluded.writers,
    countries=excluded.countries, collections=excluded.collections, edition=excluded.edition,
    release_date=excluded.release_date, duration=excluded.duration
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
        item.tmdbId || null, item.leafCount ?? null,
        JSON.stringify(item.writers || []), JSON.stringify(item.countries || []),
        JSON.stringify(item.collections || []), item.edition || '',
        item.releaseDate || '', item.duration || 0
      );
    }
  });
}

// Remove cached items in a section that are no longer present in Plex. `validRatingKeys`
// is the authoritative full set from a section sync. Prevents stale rows (deleted /
// re-keyed items) from lingering — those serve dead poster paths and phantom results.
// Returns the number of rows pruned.
function pruneLibrarySectionItems(sectionId, validRatingKeys) {
  if (!validRatingKeys || validRatingKeys.length === 0) return 0; // never wipe on an empty/failed fetch
  const keep = new Set(validRatingKeys.map(String));
  const existing = db.prepare('SELECT rating_key FROM library_items WHERE section_id = ?').all(String(sectionId));
  const stale = existing.filter(r => !keep.has(String(r.rating_key))).map(r => r.rating_key);
  if (stale.length === 0) return 0;
  withTransaction(() => {
    const del = db.prepare('DELETE FROM library_items WHERE rating_key = ?');
    for (const key of stale) del.run(key);
  });
  return stale.length;
}

// Update detail-only fields (producers, labels) fetched from /library/metadata, and stamp
// detail_synced_at so the backfill is restart-safe and one-time. Optionally accepts the
// bulk fields too (the websocket detail path has the full payload).
const stmtUpdateItemDetail = db.prepare(`
  UPDATE library_items SET producers = ?, labels = ?, detail_synced_at = ?
  WHERE rating_key = ?
`);

function updateItemDetailFields(ratingKey, { producers = [], labels = [] } = {}) {
  stmtUpdateItemDetail.run(
    JSON.stringify(producers || []), JSON.stringify(labels || []),
    Math.floor(Date.now() / 1000), String(ratingKey)
  );
}

const stmtUpdateLastEpisode = db.prepare(
  'UPDATE library_items SET last_episode_added_at = ? WHERE rating_key = ?'
);

function updateLastEpisodeAdded(showKey, ts) {
  stmtUpdateLastEpisode.run(ts || 0, String(showKey));
}

// Items that still need the per-item detail backfill (producers/labels). Movies + shows only.
function getItemsNeedingDetailSync(limit = 50) {
  return db.prepare(
    "SELECT rating_key, section_id FROM library_items WHERE detail_synced_at = 0 LIMIT ?"
  ).all(limit).map(r => ({ ratingKey: r.rating_key, sectionId: r.section_id }));
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
    writers: JSON.parse(r.writers || '[]'),
    producers: JSON.parse(r.producers || '[]'),
    countries: JSON.parse(r.countries || '[]'),
    collections: JSON.parse(r.collections || '[]'),
    labels: JSON.parse(r.labels || '[]'),
    edition: r.edition || '',
    releaseDate: r.release_date || '',
    duration: r.duration || 0,
    lastEpisodeAddedAt: r.last_episode_added_at || 0,
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

// ── Watch history (cached Tautulli history) ─────────────────────────────────────

const stmtUpsertWatchHistory = db.prepare(`
  INSERT INTO watch_history
    (history_id, user_id, rating_key, grandparent_rating_key, parent_rating_key,
     title, parent_title, year, media_type, thumb, watched_at, duration,
     percent_complete, watched_status, user_name, user_thumb, season_number,
     episode_number, bitrate, resolution, synced_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(history_id) DO UPDATE SET
    user_id=excluded.user_id, rating_key=excluded.rating_key,
    grandparent_rating_key=excluded.grandparent_rating_key,
    parent_rating_key=excluded.parent_rating_key, title=excluded.title,
    parent_title=excluded.parent_title, year=excluded.year, media_type=excluded.media_type,
    thumb=excluded.thumb, watched_at=excluded.watched_at, duration=excluded.duration,
    percent_complete=excluded.percent_complete, watched_status=excluded.watched_status,
    user_name=excluded.user_name, user_thumb=excluded.user_thumb,
    season_number=excluded.season_number, episode_number=excluded.episode_number,
    bitrate=excluded.bitrate, resolution=excluded.resolution, synced_at=excluded.synced_at
`);

// Bulk upsert mapped history rows (camelCase, as produced by the Tautulli service).
function upsertWatchHistoryBatch(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  let count = 0;
  withTransaction(() => {
    for (const r of rows) {
      if (r.historyId == null) continue;
      stmtUpsertWatchHistory.run(
        Number(r.historyId),
        r.userId != null ? String(r.userId) : null,
        r.ratingKey != null ? String(r.ratingKey) : null,
        r.grandparentRatingKey || null,
        r.parentRatingKey || null,
        r.title || null,
        r.parentTitle || null,
        r.year != null ? Number(r.year) : null,
        r.mediaType || null,
        r.thumb || null,
        r.watchedAt ? Number(r.watchedAt) : 0,
        r.duration ? Number(r.duration) : 0,
        r.percentComplete ? Number(r.percentComplete) : 0,
        r.watchedStatus || null,
        r.userName || null,
        r.userThumb || null,
        r.seasonNumber != null ? Number(r.seasonNumber) : null,
        r.episodeNumber != null ? Number(r.episodeNumber) : null,
        r.bitrate || null,
        r.resolution || null,
        now
      );
      count++;
    }
  });
  return count;
}

function rowToWatchHistoryItem(r) {
  return {
    historyId: r.history_id,
    userId: r.user_id != null ? String(r.user_id) : null,
    ratingKey: r.rating_key != null ? String(r.rating_key) : null,
    grandparentRatingKey: r.grandparent_rating_key || null,
    parentRatingKey: r.parent_rating_key || null,
    title: r.title || 'Unknown',
    parentTitle: r.parent_title || null,
    year: r.year || null,
    mediaType: r.media_type === 'episode' ? 'episode' : 'movie',
    thumb: r.thumb || null,
    watchedAt: r.watched_at || 0,
    duration: r.duration || 0,
    percentComplete: r.percent_complete || 0,
    watchedStatus: r.watched_status || 'incomplete',
    userName: r.user_name || null,
    userThumb: r.user_thumb || null,
    seasonNumber: r.season_number || null,
    episodeNumber: r.episode_number || null,
    bitrate: r.bitrate || null,
    resolution: r.resolution || null,
  };
}

// Filter/sort/paginate cached history entirely in SQL. `ownUserId` locks results
// to one user (standard users); `includeUserIds` narrows an admin's aggregate view.
//
// Episodes of the same show watched by the same user on the same calendar day are
// collapsed into a single parent "group" (with a `children` array); everything else
// is its own single row. Pagination is over groups, so a binge counts as one entry.
function queryWatchHistory(opts = {}) {
  const {
    ownUserId = null,
    includeUserIds = null,
    mediaType = 'all',
    startDate = null,
    endDate = null,
    watchedStatus = 'all',
    search = '',
    sortBy = 'date',
    sortDir = 'desc',
    page = 1,
    perPage = 25,
    // When set, restrict to rows the given user has reviewed. Reviews attach to the
    // matched library item (the movie itself, or an episode's parent show) by tmdb
    // id, falling back to rating_key — mirroring the per-item enrichment in the API.
    reviewedByUserId = null,
  } = opts;

  const where = [];
  const params = [];

  if (ownUserId != null) {
    where.push('user_id = ?');
    params.push(String(ownUserId));
  } else if (Array.isArray(includeUserIds) && includeUserIds.length) {
    where.push(`user_id IN (${includeUserIds.map(() => '?').join(',')})`);
    params.push(...includeUserIds.map(String));
  }

  if (mediaType === 'movie') { where.push('media_type = ?'); params.push('movie'); }
  else if (mediaType === 'show' || mediaType === 'episode') { where.push('media_type = ?'); params.push('episode'); }

  if (startDate) { where.push('watched_at >= ?'); params.push(Number(startDate)); }
  if (endDate) { where.push('watched_at <= ?'); params.push(Number(endDate)); }

  if (watchedStatus === 'complete') { where.push('watched_status = ?'); params.push('complete'); }
  else if (watchedStatus === 'incomplete') { where.push('watched_status = ?'); params.push('incomplete'); }

  if (search) {
    where.push('(title LIKE ? OR parent_title LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like);
  }

  if (reviewedByUserId != null) {
    where.push(`EXISTS (
      SELECT 1 FROM library_items li
      JOIN reviews r ON r.user_id = ?
        AND (
          (li.tmdb_id IS NOT NULL
            AND r.tmdb_id = CAST(li.tmdb_id AS INTEGER)
            AND r.media_type = CASE WHEN li.type = 'show' THEN 'tv' ELSE 'movie' END)
          OR r.rating_key = li.rating_key
        )
      WHERE li.rating_key = CASE
        WHEN watch_history.media_type = 'episode' THEN watch_history.grandparent_rating_key
        ELSE watch_history.rating_key END
    )`);
    params.push(String(reviewedByUserId));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Group key: same show + same user + same local calendar day → one group.
  const grpExpr = `CASE
      WHEN media_type = 'episode' AND grandparent_rating_key IS NOT NULL
        THEN 'g|' || grandparent_rating_key || '|' || COALESCE(user_id,'') || '|' || strftime('%Y-%m-%d', watched_at, 'unixepoch', 'localtime')
      ELSE 's|' || history_id
    END`;

  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const groupOrder = sortBy === 'title'
    ? `grp_title COLLATE NOCASE ${dir}`
    : sortBy === 'duration'
      ? `grp_duration ${dir}`
      : `grp_date ${dir}`;

  const perPageNum = Math.min(100, Math.max(1, Number(perPage) || 25));
  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * perPageNum;

  // Total number of groups (drives pagination).
  const total = db.prepare(`
    WITH matched AS (SELECT (${grpExpr}) AS grp FROM watch_history ${whereSql})
    SELECT COUNT(*) AS c FROM (SELECT grp FROM matched GROUP BY grp)
  `).get(...params)?.c || 0;

  const pages = Math.max(1, Math.ceil(total / perPageNum));

  // One page of groups with their aggregate/representative fields.
  const groupRows = db.prepare(`
    WITH matched AS (SELECT *, (${grpExpr}) AS grp FROM watch_history ${whereSql})
    SELECT
      grp,
      COUNT(*) AS cnt,
      MAX(watched_at) AS grp_date,
      SUM(duration) AS grp_duration,
      MAX(COALESCE(parent_title, title)) AS grp_title,
      MAX(grandparent_rating_key) AS grp_show_key,
      MAX(year) AS grp_year,
      MAX(user_id) AS grp_user_id,
      MAX(user_name) AS grp_user_name,
      MAX(user_thumb) AS grp_user_thumb
    FROM matched
    GROUP BY grp
    ORDER BY ${groupOrder}
    LIMIT ? OFFSET ?
  `).all(...params, perPageNum, offset);

  if (groupRows.length === 0) return { items: [], total, page: pageNum, pages };

  // All child rows for the groups on this page (single rows included).
  const keys = groupRows.map(g => g.grp);
  const childRows = db.prepare(`
    WITH matched AS (SELECT *, (${grpExpr}) AS grp FROM watch_history ${whereSql})
    SELECT * FROM matched WHERE grp IN (${keys.map(() => '?').join(',')})
    ORDER BY watched_at DESC, history_id DESC
  `).all(...params, ...keys);

  const childrenByGrp = new Map();
  for (const r of childRows) {
    if (!childrenByGrp.has(r.grp)) childrenByGrp.set(r.grp, []);
    childrenByGrp.get(r.grp).push(r);
  }

  const items = groupRows.map(g => {
    const rows = childrenByGrp.get(g.grp) || [];
    if (g.cnt <= 1) {
      const item = rowToWatchHistoryItem(rows[0] || {});
      item.isGroup = false;
      return item;
    }
    const showKey = g.grp_show_key != null ? String(g.grp_show_key) : null;
    return {
      isGroup: true,
      groupKey: g.grp,
      historyId: g.grp,
      ratingKey: showKey,
      grandparentRatingKey: showKey,
      title: g.grp_title || 'Unknown',
      parentTitle: null,
      year: g.grp_year || null,
      mediaType: 'episode',
      thumb: showKey ? `/library/metadata/${showKey}/thumb` : null,
      watchedAt: g.grp_date || 0,
      duration: g.grp_duration || 0,
      percentComplete: 0,
      watchedStatus: 'complete',
      episodeCount: g.cnt,
      userId: g.grp_user_id != null ? String(g.grp_user_id) : null,
      userName: g.grp_user_name || null,
      userThumb: g.grp_user_thumb || null,
      children: rows.map(rowToWatchHistoryItem),
    };
  });

  return { items, total, page: pageNum, pages };
}

// Distinct users that appear in cached history (for the admin filter list).
function getWatchHistoryUsers() {
  const rows = db.prepare(`
    SELECT user_id AS id, user_name AS name, user_thumb AS thumb
    FROM watch_history
    WHERE user_id IS NOT NULL
    GROUP BY user_id
    ORDER BY name COLLATE NOCASE ASC
  `).all();
  return rows.map(r => ({ id: String(r.id), name: r.name || `User ${r.id}`, thumb: r.thumb || null }));
}

function getWatchHistoryCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM watch_history').get()?.c || 0;
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
  const movieCount = db.prepare("SELECT COUNT(*) as c FROM library_items WHERE type = 'movie'").get()?.c || 0;
  const tvCount = db.prepare("SELECT COUNT(*) as c FROM library_items WHERE type = 'show'").get()?.c || 0;
  const dismissalCount = db.prepare("SELECT COUNT(*) as c FROM dismissals").get()?.c || 0;

  // Per-user watched counts — all known users, counts all watched items (not filtered by current library)
  const watchedStats = db.prepare(`
    SELECT
      ku.user_id,
      ku.username,
      ku.thumb,
      ku.seen_at AS last_login,
      COALESCE(w.watched_count, 0) AS watched_count,
      COALESCE(sl.last_sync, 0) AS last_sync,
      COALESCE(r.request_count, 0) AS request_count
    FROM known_users ku
    LEFT JOIN (
      SELECT uw.user_id, COUNT(*) as watched_count, MAX(uw.synced_at) as last_sync
      FROM user_watched uw
      GROUP BY uw.user_id
    ) w ON w.user_id = ku.user_id
    LEFT JOIN (
      SELECT SUBSTR(key, 9) AS uid, last_sync
      FROM sync_log WHERE key LIKE 'watched_%'
    ) sl ON sl.uid = ku.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as request_count
      FROM discover_requests GROUP BY user_id
    ) r ON r.user_id = ku.user_id
    ORDER BY ku.seen_at DESC
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

function upsertKnownUser(userId, username, thumb, token) {
  db.prepare(`
    INSERT OR REPLACE INTO known_users (user_id, username, thumb, seen_at, plex_token)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(userId), username, thumb || null, Math.floor(Date.now() / 1000), token || null);
}

// Seed from sessions on startup — updates token/name/thumb but preserves seen_at
function seedKnownUser(userId, username, thumb, token) {
  db.prepare(`
    INSERT INTO known_users (user_id, username, thumb, seen_at, plex_token)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      thumb = excluded.thumb,
      plex_token = excluded.plex_token
  `).run(String(userId), username, thumb || null, token || null);
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

// Rows with timestamps — used by the plex.tv watchlist reconciler to honor a grace window.
function getWatchlistRows(userId) {
  return db.prepare('SELECT rating_key, added_at FROM watchlist WHERE user_id = ?')
    .all(String(userId));
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
    rivenEnabled: ['1', 'true'].includes(getSetting('riven_enabled', '0')),
    dumbEnabled: ['1', 'true'].includes(getSetting('dumb_enabled', '0')),
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

function getAllTmdbCacheItems() {
  const rows = db.prepare('SELECT data FROM tmdb_cache').all();
  if (!rows || !rows.length) return [];
  const items = [];
  for (const row of rows) {
    try { items.push(JSON.parse(row.data)); } catch { /* skip corrupt */ }
  }
  return items;
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

function getAllRequests(limit = 20, offset = 0, statusFilter = null, orderBy = 'requested_at', orderDir = 'DESC', search = null, userIdFilter = null, dateFrom = null, dateTo = null) {
  const ALLOWED_COLS = { title: 'dr.title', username: 'COALESCE(ku.username, dr.user_id)', media_type: 'dr.media_type', requested_at: 'dr.requested_at', status: 'dr.status' };
  const col = ALLOWED_COLS[orderBy] || 'dr.requested_at';
  const dir = orderDir === 'ASC' ? 'ASC' : 'DESC';
  const clauses = [];
  const params = [];
  if (statusFilter && statusFilter !== 'all') {
    clauses.push('dr.status = ?');
    params.push(statusFilter);
  }
  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    clauses.push('(dr.title LIKE ? OR COALESCE(ku.username, dr.user_id) LIKE ?)');
    params.push(like, like);
  }
  if (userIdFilter) {
    clauses.push('dr.user_id = ?');
    params.push(String(userIdFilter));
  }
  if (Number.isFinite(dateFrom)) {
    clauses.push('dr.requested_at >= ?');
    params.push(Number(dateFrom));
  }
  if (Number.isFinite(dateTo)) {
    clauses.push('dr.requested_at <= ?');
    params.push(Number(dateTo));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username, ku.thumb AS user_thumb
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ${where}
    ORDER BY ${col} ${dir}
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ${where}
  `).get(...params);
  return { rows, total: countRow?.cnt || 0 };
}

function getRequestUsers() {
  return db.prepare(`
    SELECT DISTINCT dr.user_id AS id, COALESCE(ku.username, dr.user_id) AS name
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ORDER BY name COLLATE NOCASE ASC
  `).all();
}

function updateRequestStatus(id, status, denialNote = null) {
  db.prepare('UPDATE discover_requests SET status = ?, denial_note = ? WHERE id = ?')
    .run(status, denialNote || null, Number(id));
}

function deleteRequest(id) {
  db.prepare('DELETE FROM discover_requests WHERE id = ?').run(Number(id));
}

function deleteRequestsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM discover_requests WHERE id = ?');
  const tx = db.transaction((rows) => {
    let count = 0;
    for (const id of rows) {
      const r = stmt.run(Number(id));
      count += r.changes;
    }
    return count;
  });
  return tx(ids);
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
  const row = db.prepare('SELECT region, language, auto_request_movies, auto_request_tv, landing_page, show_mature, review_privacy FROM user_request_limits WHERE user_id = ?').get(String(userId));
  return {
    region: row?.region || null,
    language: row?.language || null,
    auto_request_movies: row ? !!row.auto_request_movies : false,
    auto_request_tv: row ? !!row.auto_request_tv : false,
    landing_page: row?.landing_page || null,
    show_mature: row ? !!row.show_mature : false,
    review_privacy: row?.review_privacy || 'public',
  };
}

function setUserPreferences(userId, { region, language, auto_request_movies, auto_request_tv, landing_page, show_mature, review_privacy }) {
  // Ensure row exists first
  db.prepare('INSERT OR IGNORE INTO user_request_limits (user_id) VALUES (?)').run(String(userId));
  const rp = (review_privacy === 'private') ? 'private' : 'public';
  db.prepare('UPDATE user_request_limits SET region = ?, language = ?, auto_request_movies = ?, auto_request_tv = ?, landing_page = ?, show_mature = ?, review_privacy = ? WHERE user_id = ?')
    .run(region || null, language || null, auto_request_movies ? 1 : 0, auto_request_tv ? 1 : 0, landing_page || null, show_mature ? 1 : 0, rp, String(userId));
}

// ── User Profile ──────────────────────────────────────────────────────────────

function getUserProfile(userId) {
  const row = db.prepare('SELECT user_id, username, thumb, bio, favorite_genres, favorite_media, followers_count, following_count FROM known_users WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  let favoriteGenres = [];
  let favoriteMedia = [];
  try { favoriteGenres = JSON.parse(row.favorite_genres || '[]'); } catch { favoriteGenres = []; }
  try { favoriteMedia = JSON.parse(row.favorite_media || '[]'); } catch { favoriteMedia = []; }
  const reviewCount = getUserReviewsCount(userId);
  return {
    userId: row.user_id,
    username: row.username,
    thumb: row.thumb || null,
    bio: row.bio || '',
    favoriteGenres,
    favoriteMedia,
    followersCount: row.followers_count || 0,
    followingCount: row.following_count || 0,
    reviewCount,
  };
}

function updateUserProfile(userId, { bio, favoriteGenres, favoriteMedia }) {
  const fields = [];
  const params = [];
  if (bio !== undefined) {
    fields.push('bio = ?');
    params.push(bio?.length > 500 ? bio.substring(0, 500) : (bio || ''));
  }
  if (favoriteGenres !== undefined) {
    fields.push('favorite_genres = ?');
    params.push(JSON.stringify(favoriteGenres.slice(0, 5)));
  }
  if (favoriteMedia !== undefined) {
    fields.push('favorite_media = ?');
    params.push(JSON.stringify(favoriteMedia.slice(0, 5)));
  }
  if (fields.length === 0) return;
  params.push(String(userId));
  db.prepare(`UPDATE known_users SET ${fields.join(', ')} WHERE user_id = ?`).run(...params);
}

function getUserPublicReviews(userId, limit = 20, offset = 0) {
  const strUserId = String(userId);
  const clauses = ['r.user_id = ?'];
  const params = [strUserId];
  clauses.push("(urp.review_privacy IS NULL OR urp.review_privacy != 'private')");
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT r.*, ku.username, ku.thumb
    FROM reviews r
    LEFT JOIN known_users ku ON ku.user_id = r.user_id
    LEFT JOIN user_request_limits urp ON urp.user_id = r.user_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  for (const r of rows) {
    const lib = r.tmdb_id != null ? getLibraryItemByTmdbId(r.tmdb_id) : null;
    const thumbPath = lib?.thumb || lib?.art || null;
    r.poster_url = thumbPath
      ? (thumbPath.startsWith('http') ? thumbPath : `/api/poster?path=${encodeURIComponent(thumbPath)}`)
      : null;
    r.content_rating = lib?.content_rating || '';
  }
  return rows;
}

function getUserPublicReviewsCount(userId) {
  const strUserId = String(userId);
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM reviews r
    LEFT JOIN user_request_limits urp ON urp.user_id = r.user_id
    WHERE r.user_id = ? AND (urp.review_privacy IS NULL OR urp.review_privacy != 'private')
  `).get(strUserId);
  return row?.cnt || 0;
}

function getUserRequests(userId, limit = 20, offset = 0, statusFilter = null, orderBy = 'requested_at', orderDir = 'DESC', search = null, dateFrom = null, dateTo = null) {
  const ALLOWED_COLS = { title: 'dr.title', username: 'COALESCE(ku.username, dr.user_id)', media_type: 'dr.media_type', requested_at: 'dr.requested_at', status: 'dr.status' };
  const col = ALLOWED_COLS[orderBy] || 'dr.requested_at';
  const dir = orderDir === 'ASC' ? 'ASC' : 'DESC';
  const clauses = ['dr.user_id = ?'];
  const params = [String(userId)];
  if (statusFilter && statusFilter !== 'all') {
    clauses.push('dr.status = ?');
    params.push(statusFilter);
  }
  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    clauses.push('(dr.title LIKE ? OR COALESCE(ku.username, dr.user_id) LIKE ?)');
    params.push(like, like);
  }
  if (Number.isFinite(dateFrom)) {
    clauses.push('dr.requested_at >= ?');
    params.push(Number(dateFrom));
  }
  if (Number.isFinite(dateTo)) {
    clauses.push('dr.requested_at <= ?');
    params.push(Number(dateTo));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db.prepare(`
    SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username, ku.thumb AS user_thumb
    FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ${where}
    ORDER BY ${col} ${dir}
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM discover_requests dr
    LEFT JOIN known_users ku ON ku.user_id = dr.user_id
    ${where}
  `).get(...params);
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
  // New notification agent columns
  'telegram_chat_id TEXT DEFAULT NULL',
  'telegram_message_thread_id TEXT DEFAULT NULL',
  'telegram_send_silently INTEGER DEFAULT 0',
  'telegram_enabled INTEGER DEFAULT 0',
  'pushbullet_access_token TEXT DEFAULT NULL',
  'pushbullet_enabled INTEGER DEFAULT 0',
  'pushover_application_token TEXT DEFAULT NULL',
  'pushover_sound TEXT DEFAULT NULL',
  'email_enabled INTEGER DEFAULT 0',
  'pgp_key TEXT DEFAULT NULL',
]) {
  try { db.prepare(`ALTER TABLE user_notification_prefs ADD COLUMN ${col}`).run(); } catch {}
}

// Create WebPush subscriptions table
db.exec(`
  CREATE TABLE IF NOT EXISTS user_push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    auth TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    UNIQUE(user_id, endpoint)
  );
`);

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
    pushover_application_token: row?.pushover_application_token || null,
    pushover_sound: row?.pushover_sound || null,
    telegram_chat_id: row?.telegram_chat_id || null,
    telegram_message_thread_id: row?.telegram_message_thread_id || null,
    telegram_send_silently: row ? !!row.telegram_send_silently : false,
    telegram_enabled: row ? !!row.telegram_enabled : false,
    pushbullet_access_token: row?.pushbullet_access_token || null,
    pushbullet_enabled: row ? !!row.pushbullet_enabled : false,
    email_enabled: row ? !!row.email_enabled : false,
    pgp_key: row?.pgp_key || null,
    notify_pending: row ? (row.notify_pending !== null ? !!row.notify_pending : true) : true,
    notify_auto_approved: row ? (row.notify_auto_approved !== null ? !!row.notify_auto_approved : true) : true,
    notify_process_failed: row ? (row.notify_process_failed !== null ? !!row.notify_process_failed : true) : true,
    notify_issue_new:     row ? (row.notify_issue_new     !== null ? !!row.notify_issue_new     : true) : true,
    notify_issue_update:  row ? (row.notify_issue_update  !== null ? !!row.notify_issue_update  : true) : true,
    notify_issue_comment: row ? (row.notify_issue_comment !== null ? !!row.notify_issue_comment : true) : true,
    notify_monitor:       row ? (row.notify_monitor       !== null ? !!row.notify_monitor       : true) : true,
  };
}

function setUserNotificationPrefs(userId, prefs) {
  // Use individual UPDATE statements for flexibility (not all columns may be present in all versions)
  const baseSet = [
    `notify_approved = ${prefs.notify_approved !== false ? 1 : 0}`,
    `notify_denied = ${prefs.notify_denied !== false ? 1 : 0}`,
    `notify_available = ${prefs.notify_available !== false ? 1 : 0}`,
    `notify_pending = ${prefs.notify_pending !== false ? 1 : 0}`,
    `notify_auto_approved = ${prefs.notify_auto_approved !== false ? 1 : 0}`,
    `notify_process_failed = ${prefs.notify_process_failed !== false ? 1 : 0}`,
    `notify_issue_new = ${prefs.notify_issue_new !== false ? 1 : 0}`,
    `notify_issue_update = ${prefs.notify_issue_update !== false ? 1 : 0}`,
    `notify_issue_comment = ${prefs.notify_issue_comment !== false ? 1 : 0}`,
    `discord_webhook = ${sqlValue(prefs.discord_webhook)}`,
    `discord_enabled = ${prefs.discord_enabled ? 1 : 0}`,
    `discord_user_id = ${sqlValue(prefs.discord_user_id)}`,
    `pushover_user_key = ${sqlValue(prefs.pushover_user_key)}`,
    `pushover_enabled = ${prefs.pushover_enabled ? 1 : 0}`,
    `pushover_application_token = ${sqlValue(prefs.pushover_application_token)}`,
    `pushover_sound = ${sqlValue(prefs.pushover_sound)}`,
    `telegram_chat_id = ${sqlValue(prefs.telegram_chat_id)}`,
    `telegram_message_thread_id = ${sqlValue(prefs.telegram_message_thread_id)}`,
    `telegram_send_silently = ${prefs.telegram_send_silently ? 1 : 0}`,
    `telegram_enabled = ${prefs.telegram_enabled ? 1 : 0}`,
    `pushbullet_access_token = ${sqlValue(prefs.pushbullet_access_token)}`,
    `pushbullet_enabled = ${prefs.pushbullet_enabled ? 1 : 0}`,
    `email_enabled = ${prefs.email_enabled ? 1 : 0}`,
    `pgp_key = ${sqlValue(prefs.pgp_key)}`,
    `notify_monitor = ${prefs.notify_monitor !== false ? 1 : 0}`,
  ];

  db.prepare(`
    INSERT OR REPLACE INTO user_notification_prefs (user_id) VALUES (?)
  `).run(String(userId));

  // Update each field individually to handle missing columns gracefully
  for (const set of baseSet) {
    try {
      db.prepare(`UPDATE user_notification_prefs SET ${set} WHERE user_id = ?`).run(String(userId));
    } catch {
      // Column may not exist yet — skip
    }
  }
}

// Helper: convert a value to SQL literal
function sqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
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

function getAllIssues(limit, offset, statusFilter, search = null, userIdFilter = null, dateFrom = null, dateTo = null) {
  const clauses = [];
  const params = [];
  if (statusFilter && statusFilter !== 'all') {
    clauses.push('i.status = ?');
    params.push(statusFilter);
  }
  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    clauses.push('(i.title LIKE ? OR i.description LIKE ? OR COALESCE(ku.username, i.user_id) LIKE ?)');
    params.push(like, like, like);
  }
  if (userIdFilter) {
    clauses.push('i.user_id = ?');
    params.push(String(userIdFilter));
  }
  if (Number.isFinite(dateFrom)) {
    clauses.push('i.created_at >= ?');
    params.push(Number(dateFrom));
  }
  if (Number.isFinite(dateTo)) {
    clauses.push('i.created_at <= ?');
    params.push(Number(dateTo));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT i.*, COALESCE(ku.username, i.user_id) AS username
    FROM issues i LEFT JOIN known_users ku ON ku.user_id = i.user_id
    ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  const { cnt } = db.prepare(`
    SELECT COUNT(*) as cnt FROM issues i
    LEFT JOIN known_users ku ON ku.user_id = i.user_id
    ${where}
  `).get(...params);
  return { rows, total: cnt || 0 };
}

function getUserIssues(userId, limit, offset, statusFilter, search = null, dateFrom = null, dateTo = null) {
  const clauses = ['i.user_id = ?'];
  const params = [String(userId)];
  if (statusFilter && statusFilter !== 'all') {
    clauses.push('i.status = ?');
    params.push(statusFilter);
  }
  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    clauses.push('(i.title LIKE ? OR i.description LIKE ? OR COALESCE(ku.username, i.user_id) LIKE ?)');
    params.push(like, like, like);
  }
  if (Number.isFinite(dateFrom)) {
    clauses.push('i.created_at >= ?');
    params.push(Number(dateFrom));
  }
  if (Number.isFinite(dateTo)) {
    clauses.push('i.created_at <= ?');
    params.push(Number(dateTo));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db.prepare(`
    SELECT i.*, COALESCE(ku.username, i.user_id) AS username
    FROM issues i LEFT JOIN known_users ku ON ku.user_id = i.user_id
    ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  const { cnt } = db.prepare(`
    SELECT COUNT(*) as cnt FROM issues i
    LEFT JOIN known_users ku ON ku.user_id = i.user_id
    ${where}
  `).get(...params);
  return { rows, total: cnt || 0 };
}

function getIssueUsers() {
  return db.prepare(`
    SELECT DISTINCT i.user_id AS id, COALESCE(ku.username, i.user_id) AS name
    FROM issues i
    LEFT JOIN known_users ku ON ku.user_id = i.user_id
    ORDER BY name COLLATE NOCASE ASC
  `).all();
}

function updateIssueStatus(id, status, adminNote) {
  db.prepare('UPDATE issues SET status = ?, admin_note = ?, updated_at = unixepoch() WHERE id = ?')
    .run(status, adminNote !== undefined ? adminNote : null, Number(id));
}

function deleteIssue(id) {
  db.prepare('DELETE FROM issues WHERE id = ?').run(Number(id));
}

function deleteIssuesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM issues WHERE id = ?');
  const tx = db.transaction((rows) => {
    let count = 0;
    for (const id of rows) {
      const r = stmt.run(Number(id));
      count += r.changes;
    }
    return count;
  });
  return tx(ids);
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

// ── Reviews (user-written, Letterboxd-style) ──────────────────────────────────

function createReview({ userId, mediaType, tmdbId, ratingKey, title, year, rating, reviewText, spoiler, rewatch, watchedDate }) {
  const common = [
    title || '', year != null ? Number(year) : null,
    Number(rating), reviewText || '',
    spoiler ? 1 : 0, rewatch ? 1 : 0,
    Number(watchedDate),
  ];
  // TMDB-keyed review (item has a TMDB match) vs rating_key-keyed review (library
  // item with no TMDB id). Each upserts against its own partial unique index.
  if (tmdbId != null) {
    return db.prepare(`
      INSERT INTO reviews (user_id, media_type, tmdb_id, title, year, rating, review_text, spoiler, rewatch, watched_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, media_type, tmdb_id) WHERE tmdb_id IS NOT NULL DO UPDATE SET
        title=excluded.title, year=excluded.year, rating=excluded.rating,
        review_text=excluded.review_text, spoiler=excluded.spoiler, rewatch=excluded.rewatch,
        watched_date=excluded.watched_date, updated_at=unixepoch()
    `).run(String(userId), String(mediaType), Number(tmdbId), ...common);
  }
  return db.prepare(`
    INSERT INTO reviews (user_id, media_type, rating_key, title, year, rating, review_text, spoiler, rewatch, watched_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, rating_key) WHERE rating_key IS NOT NULL DO UPDATE SET
      title=excluded.title, year=excluded.year, rating=excluded.rating,
      review_text=excluded.review_text, spoiler=excluded.spoiler, rewatch=excluded.rewatch,
      watched_date=excluded.watched_date, updated_at=unixepoch()
  `).run(String(userId), String(mediaType), String(ratingKey), ...common);
}

function getReview(userId, mediaType, tmdbId) {
  return db.prepare('SELECT * FROM reviews WHERE user_id = ? AND media_type = ? AND tmdb_id = ?')
    .get(String(userId), String(mediaType), Number(tmdbId));
}

function getReviewByRatingKey(userId, ratingKey) {
  return db.prepare('SELECT * FROM reviews WHERE user_id = ? AND rating_key = ?')
    .get(String(userId), String(ratingKey));
}

function getUserReviews(userId, limit = 50, offset = 0) {
  return db.prepare(
    'SELECT * FROM reviews WHERE user_id = ? ORDER BY watched_date DESC LIMIT ? OFFSET ?'
  ).all(String(userId), Number(limit), Number(offset));
}

function getUserReviewsCount(userId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM reviews WHERE user_id = ?').get(String(userId));
  return row?.cnt || 0;
}

function updateReview(id, userId, { title, year, rating, reviewText, spoiler, rewatch }) {
  const fields = [];
  const params = [];
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (year !== undefined) { fields.push('year = ?'); params.push(year); }
  if (rating !== undefined) { fields.push('rating = ?'); params.push(Number(rating)); }
  if (reviewText !== undefined) { fields.push('review_text = ?'); params.push(reviewText); }
  if (spoiler !== undefined) { fields.push('spoiler = ?'); params.push(spoiler ? 1 : 0); }
  if (rewatch !== undefined) { fields.push('rewatch = ?'); params.push(rewatch ? 1 : 0); }
  if (fields.length === 0) return;
  fields.push('updated_at = unixepoch()');
  params.push(Number(id), String(userId));
  db.prepare(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
}

function deleteReview(id, userId) {
  db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(Number(id), String(userId));
}

function getReviewById(id) {
  return db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(id));
}

// Record the star rating last pushed to TMDB (or null to clear when the remote
// rating is removed). Used to drive the review modal's "pushed/update" state.
function setReviewTmdbSyncedRating(reviewId, userId, rating) {
  db.prepare('UPDATE reviews SET tmdb_synced_rating = ? WHERE id = ? AND user_id = ?')
    .run(rating == null ? null : Number(rating), Number(reviewId), String(userId));
}

function getReviewsForRecommendation(userId) {
  return db.prepare('SELECT * FROM reviews WHERE user_id = ?').all(String(userId));
}

// ── Review Reactions ──────────────────────────────────────────────────────────

function getReviewReactionCount(reviewId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM review_reactions WHERE review_id = ?').get(Number(reviewId));
  return row?.cnt || 0;
}

function hasUserReacted(reviewId, userId) {
  const row = db.prepare('SELECT 1 FROM review_reactions WHERE review_id = ? AND user_id = ?').get(Number(reviewId), String(userId));
  return !!row;
}

// Batch lookup of which of the given reviews a user has reacted to. Lets the feed
// overlay each row's hasReacted flag in one query instead of one per row.
function getUserReactedReviewIds(userId, reviewIds) {
  if (!reviewIds || reviewIds.length === 0) return [];
  const placeholders = reviewIds.map(() => '?').join(',');
  return db.prepare(`SELECT review_id FROM review_reactions WHERE user_id = ? AND review_id IN (${placeholders})`)
    .all(String(userId), ...reviewIds.map(Number))
    .map(r => r.review_id);
}

// Recompute the denormalized counts on a review from the source tables. Called after
// every reaction/comment mutation so the cached columns the feed reads stay correct
// (also captures FK cascade deletes of replies).
function recountReviewReactions(reviewId) {
  db.prepare('UPDATE reviews SET reaction_count = (SELECT COUNT(*) FROM review_reactions WHERE review_id = ?) WHERE id = ?')
    .run(Number(reviewId), Number(reviewId));
}

function recountReviewComments(reviewId) {
  db.prepare('UPDATE reviews SET comment_count = (SELECT COUNT(*) FROM review_comments WHERE review_id = ?) WHERE id = ?')
    .run(Number(reviewId), Number(reviewId));
}

function addReaction(reviewId, userId) {
  db.prepare('INSERT OR IGNORE INTO review_reactions (review_id, user_id) VALUES (?, ?)').run(Number(reviewId), String(userId));
  recountReviewReactions(reviewId);
}

function removeReaction(reviewId, userId) {
  db.prepare('DELETE FROM review_reactions WHERE review_id = ? AND user_id = ?').run(Number(reviewId), String(userId));
  recountReviewReactions(reviewId);
}

function toggleReaction(reviewId, userId) {
  const exists = hasUserReacted(reviewId, userId);
  if (exists) {
    removeReaction(reviewId, userId);
    return false;
  } else {
    addReaction(reviewId, userId);
    return true;
  }
}

// ── Review Comments ───────────────────────────────────────────────────────────

function getReviewComments(reviewId) {
  return db.prepare('SELECT * FROM review_comments WHERE review_id = ? ORDER BY created_at ASC').all(Number(reviewId));
}

function getReviewCommentCount(reviewId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM review_comments WHERE review_id = ?').get(Number(reviewId));
  return row?.cnt || 0;
}

function createReviewComment(reviewId, userId, body, parentId) {
  const result = db.prepare(
    'INSERT INTO review_comments (review_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)'
  ).run(Number(reviewId), String(userId), String(body).substring(0, 1000), parentId ? Number(parentId) : null);
  recountReviewComments(reviewId);
  return result;
}

function getReviewComment(commentId) {
  return db.prepare('SELECT * FROM review_comments WHERE id = ?').get(Number(commentId));
}

function updateReviewComment(commentId, userId, body) {
  db.prepare('UPDATE review_comments SET body = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?')
    .run(String(body).substring(0, 1000), Number(commentId), String(userId));
}

function deleteReviewComment(commentId, userId) {
  const row = db.prepare('SELECT review_id FROM review_comments WHERE id = ?').get(Number(commentId));
  db.prepare('DELETE FROM review_comments WHERE id = ? AND user_id = ?').run(Number(commentId), String(userId));
  // FK ON DELETE CASCADE also removes replies; recount captures the true total.
  if (row?.review_id != null) recountReviewComments(row.review_id);
}

// ── User Follows ──────────────────────────────────────────────────────────────

function followUser(followerId, followeeId) {
  followerId = String(followerId);
  followeeId = String(followeeId);
  if (followerId === followeeId) return;
  db.prepare('INSERT OR IGNORE INTO user_follows (follower_id, followee_id) VALUES (?, ?)').run(followerId, followeeId);
  updateFollowCounts(followerId);
  updateFollowCounts(followeeId);
}

function unfollowUser(followerId, followeeId) {
  followerId = String(followerId);
  followeeId = String(followeeId);
  db.prepare('DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?').run(followerId, followeeId);
  updateFollowCounts(followerId);
  updateFollowCounts(followeeId);
}

function isFollowing(followerId, followeeId) {
  const row = db.prepare('SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?').get(String(followerId), String(followeeId));
  return !!row;
}

function getFollowedUserIds(userId) {
  return db.prepare('SELECT followee_id FROM user_follows WHERE follower_id = ?').all(String(userId)).map(r => r.followee_id);
}

function getFollowers(userId) {
  return db.prepare('SELECT follower_id FROM user_follows WHERE followee_id = ?').all(String(userId)).map(r => r.follower_id);
}

function getFollowing(userId) {
  return db.prepare('SELECT followee_id FROM user_follows WHERE follower_id = ?').all(String(userId)).map(r => r.followee_id);
}

function getFollowerCount(userId) {
  const row = db.prepare('SELECT followers_count FROM known_users WHERE user_id = ?').get(String(userId));
  return row?.followers_count || 0;
}

function getFollowingCount(userId) {
  const row = db.prepare('SELECT following_count FROM known_users WHERE user_id = ?').get(String(userId));
  return row?.following_count || 0;
}

function updateFollowCounts(userId) {
  userId = String(userId);
  const fc = db.prepare('SELECT COUNT(*) as cnt FROM user_follows WHERE followee_id = ?').get(userId);
  const sc = db.prepare('SELECT COUNT(*) as cnt FROM user_follows WHERE follower_id = ?').get(userId);
  db.prepare('UPDATE known_users SET followers_count = ?, following_count = ? WHERE user_id = ?').run(fc?.cnt || 0, sc?.cnt || 0, userId);
}

function seedDefaultFollows(userId) {
  userId = String(userId);
  const allUsers = db.prepare('SELECT user_id FROM known_users WHERE user_id != ?').all(userId);
  for (const { user_id } of allUsers) {
    followUser(userId, user_id);
  }
}

function getFollowStats(userIds) {
  const result = {};
  for (const uid of userIds) {
    const u = String(uid);
    result[u] = {
      followers: getFollowerCount(u),
      following: getFollowingCount(u),
    };
  }
  return result;
}

// ── Public Reviews Feed ───────────────────────────────────────────────────────

function getPublicReviews(limit, offset, followedUserIds) {
  limit = Number(limit) || 20;
  offset = Number(offset) || 0;
  const clauses = [];
  const params = [];

  // Exclude private reviews
  clauses.push("(urp.review_privacy IS NULL OR urp.review_privacy != 'private')");

  // If followedUserIds provided, filter to only those users
  if (followedUserIds && followedUserIds.length > 0) {
    const placeholders = followedUserIds.map(() => '?').join(',');
    clauses.push(`r.user_id IN (${placeholders})`);
    params.push(...followedUserIds);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  // reaction_count / comment_count are denormalized columns (maintained on every
  // reaction/comment mutation) — no per-row COUNT() subquery needed here.
  const sql = `
    SELECT r.*, ku.username, ku.thumb
    FROM reviews r
    LEFT JOIN known_users ku ON ku.user_id = r.user_id
    LEFT JOIN user_request_limits urp ON urp.user_id = r.user_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params);
  // Resolve poster + content rating from the matching library item so the feed card
  // can show artwork and a maturity badge. Done here so cached rows carry it.
  for (const r of rows) {
    const lib = r.tmdb_id != null ? getLibraryItemByTmdbId(r.tmdb_id) : null;
    const thumbPath = lib?.thumb || lib?.art || null;
    r.poster_url = thumbPath
      ? (thumbPath.startsWith('http') ? thumbPath : `/api/poster?path=${encodeURIComponent(thumbPath)}`)
      : null;
    r.content_rating = lib?.content_rating || '';
  }
  return rows;
}

function getPublicReviewsCount(followedUserIds) {
  const clauses = [];
  const params = [];

  clauses.push("(urp.review_privacy IS NULL OR urp.review_privacy != 'private')");

  if (followedUserIds && followedUserIds.length > 0) {
    const placeholders = followedUserIds.map(() => '?').join(',');
    clauses.push(`r.user_id IN (${placeholders})`);
    params.push(...followedUserIds);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM reviews r LEFT JOIN user_request_limits urp ON urp.user_id = r.user_id ${where}`).get(...params);
  return row?.cnt || 0;
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

// ── TMDB Per-User Connections ─────────────────────────────────────────────────

function getTmdbConnection(userId) {
  return db.prepare('SELECT * FROM tmdb_connections WHERE user_id = ?').get(String(userId));
}

function createTmdbConnection(userId, encryptedSessionId, accountId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT OR REPLACE INTO tmdb_connections (user_id, session_id, account_id, status, connected_at, last_verified_at)
    VALUES (?, ?, ?, 'connected', ?, ?)
  `).run(String(userId), String(encryptedSessionId), Number(accountId), now, now);
  return getTmdbConnection(userId);
}

function updateTmdbConnectionStatus(userId, status) {
  db.prepare('UPDATE tmdb_connections SET status = ? WHERE user_id = ?')
    .run(status, String(userId));
}

function updateTmdbConnectionVerified(userId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE tmdb_connections SET last_verified_at = ?, status = 'connected' WHERE user_id = ?")
    .run(now, String(userId));
}

function deleteTmdbConnection(userId) {
  db.prepare('DELETE FROM tmdb_connections WHERE user_id = ?').run(String(userId));
}

function getTmdbConnectionByAccountId(accountId) {
  return db.prepare('SELECT * FROM tmdb_connections WHERE account_id = ?').get(Number(accountId));
}

// ── Sync Library Section Management ──────────────────────────────────────────

/**
 * Get the list of enabled sync sections.
 * Returns array of { id, enabled } objects.
 *
 * On first call (setting doesn't exist), auto-initializes from DB sync data:
 * any section that has a sync timestamp > 0 is marked enabled for backward compatibility.
 */
function getSyncEnabledSections() {
  const raw = getSetting('sync_enabled_sections', null);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through to auto-init */ }
  }
  // Auto-init: find sections that have sync data in the DB
  const rows = db.prepare("SELECT key, last_sync FROM sync_log WHERE key LIKE ? AND last_sync > 0").all('library_%');
  if (rows.length > 0) {
    const sections = rows.map(r => ({ id: String(r.key.replace('library_', '')), enabled: true }));
    setSetting('sync_enabled_sections', JSON.stringify(sections));
    return sections;
  }
  return [];
}

/**
 * Save the list of enabled sync sections.
 * @param {Array<{id: string, enabled: boolean}>} sectionConfigs
 */
function setSyncEnabledSections(sectionConfigs) {
  setSetting('sync_enabled_sections', JSON.stringify(sectionConfigs));
}

/**
 * Get IDs of sections currently enabled for sync.
 */
function getEnabledSectionIds() {
  return getSyncEnabledSections()
    .filter(s => s.enabled)
    .map(s => String(s.id));
}

/**
 * Get item count for a specific library section.
 */
function getLibraryItemCount(sectionId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM library_items WHERE section_id = ?').get(String(sectionId));
  return row?.cnt || 0;
}

/**
 * Delete all items from library_items for a given section.
 * Also clears the sync timestamp and removes from watched data.
 */
function deleteLibraryItems(sectionId) {
  const sid = String(sectionId);
  // Remove watched rows for this section's items before deleting the items themselves
  db.prepare('DELETE FROM user_watched WHERE rating_key IN (SELECT rating_key FROM library_items WHERE section_id = ?)').run(sid);
  db.prepare('DELETE FROM library_items WHERE section_id = ?').run(sid);
  db.prepare('DELETE FROM sync_log WHERE key = ?').run(`library_${sid}`);
  console.log(`[db] Deleted library items and watched rows for section ${sid}`);
}

// ── Monitors ──────────────────────────────────────────────────────────────────

function createMonitor({ userId, name, enabled, matchMode, notifyPlex, notifyRequestable }) {
  const result = db.prepare(
    'INSERT INTO monitors (user_id, name, enabled, match_mode, notify_plex, notify_requestable) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    String(userId), name, enabled ? 1 : 0,
    matchMode === 'ANY' ? 'ANY' : 'ALL',
    notifyPlex ? 1 : 0, notifyRequestable ? 1 : 0
  );
  return result.lastInsertRowid;
}

function getMonitors(userId) {
  return db.prepare('SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at DESC').all(String(userId)).map(r => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    enabled: !!r.enabled,
    matchMode: r.match_mode,
    notifyPlex: !!r.notify_plex,
    notifyRequestable: !!r.notify_requestable,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function getMonitor(id, userId) {
  const r = db.prepare('SELECT * FROM monitors WHERE id = ? AND user_id = ?').get(Number(id), String(userId));
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    enabled: !!r.enabled,
    matchMode: r.match_mode,
    notifyPlex: !!r.notify_plex,
    notifyRequestable: !!r.notify_requestable,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function updateMonitor(id, userId, { name, enabled, matchMode, notifyPlex, notifyRequestable }) {
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (matchMode !== undefined) { updates.push('match_mode = ?'); params.push(matchMode === 'ANY' ? 'ANY' : 'ALL'); }
  if (notifyPlex !== undefined) { updates.push('notify_plex = ?'); params.push(notifyPlex ? 1 : 0); }
  if (notifyRequestable !== undefined) { updates.push('notify_requestable = ?'); params.push(notifyRequestable ? 1 : 0); }
  updates.push('updated_at = ?');
  params.push(Math.floor(Date.now() / 1000));
  params.push(Number(id));
  params.push(String(userId));
  db.prepare(`UPDATE monitors SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
}

function deleteMonitor(id, userId) {
  db.prepare('DELETE FROM monitors WHERE id = ? AND user_id = ?').run(Number(id), String(userId));
}

function toggleMonitor(id, userId, enabled) {
  db.prepare('UPDATE monitors SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(enabled ? 1 : 0, Math.floor(Date.now() / 1000), Number(id), String(userId));
}

function getAllEnabledMonitors() {
  return db.prepare('SELECT * FROM monitors WHERE enabled = 1').all().map(r => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    enabled: !!r.enabled,
    matchMode: r.match_mode,
    notifyPlex: !!r.notify_plex,
    notifyRequestable: !!r.notify_requestable,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function createCriteria({ monitorId, type, entityId, entityName, metadata }) {
  const result = db.prepare(
    'INSERT INTO monitor_criteria (monitor_id, type, entity_id, entity_name, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(Number(monitorId), type, entityId || null, entityName, metadata ? JSON.stringify(metadata) : null);
  return result.lastInsertRowid;
}

function getCriteria(monitorId) {
  return db.prepare('SELECT * FROM monitor_criteria WHERE monitor_id = ? ORDER BY id ASC').all(Number(monitorId)).map(r => ({
    id: r.id,
    monitorId: r.monitor_id,
    type: r.type,
    entityId: r.entity_id,
    entityName: r.entity_name,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    createdAt: r.created_at,
  }));
}

function deleteCriteria(id, monitorId) {
  db.prepare('DELETE FROM monitor_criteria WHERE id = ? AND monitor_id = ?').run(Number(id), Number(monitorId));
}

function hasNotified(monitorId, contentTmdbId, contentType, notificationType) {
  const r = db.prepare(
    'SELECT 1 FROM monitor_notifications WHERE monitor_id = ? AND content_tmdb_id = ? AND content_type = ? AND notification_type = ?'
  ).get(Number(monitorId), String(contentTmdbId), String(contentType), String(notificationType));
  return !!r;
}

function recordNotification({ monitorId, userId, contentTmdbId, contentType, notificationType }) {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO monitor_notifications (monitor_id, user_id, content_tmdb_id, content_type, notification_type) VALUES (?, ?, ?, ?, ?)'
    ).run(Number(monitorId), String(userId), String(contentTmdbId), String(contentType), String(notificationType));
  } catch {}
}

module.exports = {
  addDismissal, getDismissals, removeDismissal, getUserDismissalRows,
  addToWatchlistDb, removeFromWatchlistDb, getWatchlistFromDb, getWatchlistRows,
  updateWatchlistPlexIds, getWatchlistPlexIds, updateWatchlistPlexGuid,
  upsertKnownUser, seedKnownUser, touchKnownUser, getKnownUsers, getAllKnownUsersWithTokens, getLibraryItemByTmdbId,
  upsertManyItems, pruneLibrarySectionItems, getLibraryItemsFromDb, getLibraryItemByKey,
  updateItemDetailFields, updateLastEpisodeAdded, getItemsNeedingDetailSync,
  replaceWatchedBatch, getWatchedKeysFromDb,
  upsertWatchHistoryBatch, queryWatchHistory, getWatchHistoryUsers, getWatchHistoryCount,
  upsertUserRatings, getUserRatingsFromDb,
  getSyncTime, setSyncTime,
  getAdminStats, clearUserWatched, clearAllUserWatched,
  clearLibraryDb, clearUserDismissals,
  getThemeColor, setThemeColor,
  getAdminWatchlistMode, setAdminWatchlistMode,
  getOwnerUserId, setOwnerUserId,
  getSetting, setSetting, getConnectionSettings, isDiscoverEnabled, hasTmdbKey,
  getTmdbCache, setTmdbCache, deleteTmdbCache, getAllTmdbCacheItems, getItemsByGenre,
  getLibraryTmdbIds, getLibraryTitleYearSet,
  addDiscoverRequest, getRequestedTmdbIds, getAllRequestedTmdbIds, getRecentRequests,
  addExploreDismissal, getExploreDismissedIds, getUserExploreDismissalRows, removeExploreDismissal,
  getDiscoverPool, setDiscoverPool, getKnownUserIds,
  getDiscoverCandidates, setDiscoverCandidates, getAllUserPrefsForDiscover,
  isIndividualSeasonsEnabled,
  getLandingPage,
  getDirectRequestAccess,
  getGlobalRequestLimits, setGlobalRequestLimits,
  getUserRequestLimitOverride, setUserRequestLimitOverride, getAllUserRequestLimitOverrides,
  getEffectiveLimits, countRecentMovieRequests, countRecentSeasonRequests,
  getPendingRequests, getAllRequests, getRequestUsers, updateRequestStatus, deleteRequest, deleteRequestsByIds, deleteRequestsByUser,
  getEffectiveAutoApprove, setUserAdmin, isAdminUser,
  getUserSettings, saveUserSettings,
  getUserPreferences, setUserPreferences,
  getUserProfile, updateUserProfile, getUserPublicReviews, getUserPublicReviewsCount,
  getUserRequests,
  addDiscoverRequestWithStatus, updateRequest, getRequestById,
  createOrBundleNotification, getUnreadNotificationCount, getNotifications,
  markNotificationsRead, deleteNotification, getNotificationById, getRecentReadNotifications,
  getUserNotificationPrefs, setUserNotificationPrefs,
  getAdminUserIds, getPrivilegedUserIds,
  enqueueNotification, getPendingQueuedNotifications, markQueueItemSent, deleteQueueItem,
  createIssue, getIssueById, getAllIssues, getUserIssues, getIssueUsers, updateIssueStatus, deleteIssue, deleteIssuesByIds,
  addIssueComment, getIssueComments, deleteIssueComment,
  getUnnotifiedFulfilledRequests, markRequestsNotifiedAvailable,
  // Reviews
  createReview, getReview, getReviewByRatingKey, getUserReviews, getUserReviewsCount, updateReview, deleteReview, getReviewById, setReviewTmdbSyncedRating, getReviewsForRecommendation,
  // Review social features
  getReviewReactionCount, hasUserReacted, getUserReactedReviewIds, addReaction, removeReaction, toggleReaction,
  getReviewComments, getReviewCommentCount, createReviewComment, getReviewComment, updateReviewComment, deleteReviewComment,
  followUser, unfollowUser, isFollowing, getFollowedUserIds, getFollowers, getFollowing,
  getFollowerCount, getFollowingCount, seedDefaultFollows, getFollowStats,
  getPublicReviews, getPublicReviewsCount,
  // API apps (Agregarr / external integrations)
  createApiApp, getApiApp, getApiAppByKey, listApiApps, updateApiApp, regenerateApiAppKey, deleteApiApp,
  createServiceUser, getServiceUserByKey, getServiceUserById, getServiceUsersByApp, deleteServiceUser,
  // TMDB per-user connections
  getTmdbConnection, createTmdbConnection, updateTmdbConnectionStatus, updateTmdbConnectionVerified, deleteTmdbConnection, getTmdbConnectionByAccountId,
  // Sync section management
  getSyncEnabledSections, setSyncEnabledSections, getEnabledSectionIds, getLibraryItemCount, deleteLibraryItems,
  // Monitors
  createMonitor, getMonitors, getMonitor, updateMonitor, deleteMonitor, toggleMonitor, getAllEnabledMonitors,
  createCriteria, getCriteria, deleteCriteria,
  hasNotified, recordNotification,
  // Raw prepare — used by overseerrShim for ad-hoc queries not worth a dedicated function
  prepare: (sql) => db.prepare(sql),
};
