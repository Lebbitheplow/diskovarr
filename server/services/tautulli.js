const db = require('../db/database');

function getTautulliUrl() {
  return db.getSetting('tautulli_url', null) || process.env.TAUTULLI_URL;
}
function getTautulliKey() {
  return db.getSetting('tautulli_api_key', null) || process.env.TAUTULLI_API_KEY;
}

// Cache of valid Plex user IDs known to Tautulli (refreshed hourly)
let _tautulliUserIds = null;
let _tautulliUserIdsFetchedAt = 0;
const TAUTULLI_USERS_TTL = 3600 * 1000;

async function getValidTautulliUserIds() {
  if (_tautulliUserIds && Date.now() - _tautulliUserIdsFetchedAt < TAUTULLI_USERS_TTL) {
    return _tautulliUserIds;
  }
  try {
    const data = await tautulliGet('get_users');
    const users = Array.isArray(data) ? data : [];
    // Tautulli's get_users returns objects with a user_id that matches the Plex account ID
    _tautulliUserIds = new Set(users.map(u => String(u.user_id)).filter(Boolean));
    _tautulliUserIdsFetchedAt = Date.now();
    return _tautulliUserIds;
  } catch {
    return null; // null means "skip the check, allow all"
  }
}

async function tautulliGet(cmd, params = {}) {
  const query = new URLSearchParams({
    apikey: getTautulliKey(),
    cmd,
    ...params,
  });
  const url = `${getTautulliUrl()}/api/v2?${query}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Tautulli error ${res.status} for cmd=${cmd}`);
  const json = await res.json();
  if (json.response?.result !== 'success') {
    throw new Error(`Tautulli API failure: ${json.response?.message || 'unknown'}`);
  }
  return json.response.data;
}

/**
 * Returns Set of movie rating_keys the user has watched (≥90% completion)
 */
async function getWatchedMovieKeys(userId) {
  try {
    const validIds = await getValidTautulliUserIds();
    if (validIds && !validIds.has(String(userId))) return new Set();
    const data = await tautulliGet('get_history', {
      user_id: String(userId),
      length: 10000,
      media_type: 'movie',
    });
    const rows = data.data || [];
    const keys = new Set();
    for (const row of rows) {
      // watched_status: 1 = fully watched, also check percent_complete
      if (row.watched_status >= 1 || (row.percent_complete && row.percent_complete >= 90)) {
        if (row.rating_key) keys.add(String(row.rating_key));
      }
    }
    return keys;
  } catch (err) {
    console.warn('getWatchedMovieKeys error:', err.message);
    return new Set();
  }
}

/**
 * Returns Set of show-level rating_keys (grandparent_rating_key) the user has watched any episode of
 */
async function getWatchedShowKeys(userId) {
  try {
    const validIds = await getValidTautulliUserIds();
    if (validIds && !validIds.has(String(userId))) return new Set();
    const data = await tautulliGet('get_history', {
      user_id: String(userId),
      length: 20000,
      media_type: 'episode',
    });
    const rows = data.data || [];
    const keys = new Set();
    for (const row of rows) {
      if (row.grandparent_rating_key) {
        keys.add(String(row.grandparent_rating_key));
      }
    }
    return keys;
  } catch (err) {
    console.warn('getWatchedShowKeys error:', err.message);
    return new Set();
  }
}

/**
 * Get full watch history for building preference profile
 * Returns array of { rating_key, watched_at, percent_complete, media_type }
 */
async function getFullHistory(userId) {
  try {
    const validIds = await getValidTautulliUserIds();
    if (validIds && !validIds.has(String(userId))) return [];
    const [movieData, episodeData] = await Promise.all([
      tautulliGet('get_history', {
        user_id: String(userId),
        length: 1000,
        media_type: 'movie',
        order_column: 'date',
        order_dir: 'desc',
      }),
      tautulliGet('get_history', {
        user_id: String(userId),
        length: 2000,
        media_type: 'episode',
        order_column: 'date',
        order_dir: 'desc',
      }),
    ]);

    const movies = (movieData.data || []).map(r => ({
      rating_key: String(r.rating_key),
      grandparent_rating_key: null,
      watched_at: r.date || 0,
      percent_complete: r.percent_complete || 0,
      media_type: 'movie',
    }));

    // For episodes, use grandparent (show) as the entity to build show preferences
    // Count how many episodes were watched per show for weighting purposes
    const showEpisodeCounts = new Map();
    for (const r of (episodeData.data || [])) {
      const key = String(r.grandparent_rating_key);
      showEpisodeCounts.set(key, (showEpisodeCounts.get(key) || 0) + 1);
    }
    const seenShows = new Set();
    const shows = [];
    for (const r of (episodeData.data || [])) {
      const key = String(r.grandparent_rating_key);
      if (!seenShows.has(key)) {
        seenShows.add(key);
        shows.push({
          rating_key: key,
          grandparent_rating_key: key,
          watched_at: r.date || 0,
          percent_complete: 100,
          media_type: 'show',
          episodeCount: showEpisodeCounts.get(key) || 1,
        });
      }
    }

    return [...movies, ...shows];
  } catch (err) {
    console.warn('getFullHistory error:', err.message);
    return [];
  }
}

/**
 * Per-user view stats keyed by library_items rating_key (movies by their own key, shows by
 * grandparent/show key — matching what library_items stores). Used for the Date Viewed and
 * Plays sorts on the Filter page, and reusable for future history-based features.
 *
 * Returns { ratingKey: { lastViewedAt, plays } }. Empty when Tautulli isn't configured.
 * Cached briefly per-user so repeated discover requests don't hammer Tautulli.
 */
const _viewStatsCache = new Map(); // userId -> { stats, at }
const VIEW_STATS_TTL = 10 * 60 * 1000; // 10 minutes

async function getViewStats(userId) {
  const cached = _viewStatsCache.get(String(userId));
  if (cached && Date.now() - cached.at < VIEW_STATS_TTL) return cached.stats;

  const stats = {};
  try {
    const history = await getFullHistory(userId);
    for (const row of history) {
      // Movies → keyed by rating_key (one entry per play); shows → keyed by show key with
      // episodeCount as the play count (getFullHistory already de-dups shows).
      const key = row.media_type === 'show'
        ? String(row.grandparent_rating_key || row.rating_key)
        : String(row.rating_key);
      if (!key || key === 'null') continue;
      const plays = row.media_type === 'show' ? (row.episodeCount || 1) : 1;
      const watchedAt = row.watched_at || 0;
      const entry = stats[key] || (stats[key] = { lastViewedAt: 0, plays: 0 });
      entry.plays += plays;
      if (watchedAt > entry.lastViewedAt) entry.lastViewedAt = watchedAt;
    }
  } catch (err) {
    console.warn('getViewStats error:', err.message);
  }
  _viewStatsCache.set(String(userId), { stats, at: Date.now() });
  return stats;
}

/**
 * Fetch cross-user aggregate popularity from Tautulli's home stats.
 * Returns { movies: [{ ratingKey, totalPlays }], tvShows: [{ ratingKey, totalPlays }] }
 * sorted by total plays in the last 90 days. Cached for 30 minutes.
 */
const _popularCache = new Map();
const POPULAR_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function findRowsInStats(stats, statId) {
  if (Array.isArray(stats)) {
    for (const section of stats) {
      if (section.stat_id === statId) return section.rows || [];
    }
  }
  if (stats && stats.stat_id === statId) return stats.rows || [];
  return [];
}

async function getPopularItems() {
  const cached = _popularCache.get('all');
  if (cached && Date.now() - cached.at < POPULAR_CACHE_TTL) return cached.items;

  try {
    // Request a deep pool: Tautulli's raw top stats are polluted by Live TV / DVR plays
    // (broadcasts that aren't real library items), so we over-fetch and filter those out
    // below to leave enough genuine library content to populate the carousels.
    const [moviesStats, tvStats] = await Promise.all([
      tautulliGet('get_home_stats', { stat_id: 'top_movies', stats_count: 50, time_range: 90 }),
      tautulliGet('get_home_stats', { stat_id: 'top_tv', stats_count: 50, time_range: 90 }),
    ]);

    const moviesRows = findRowsInStats(moviesStats, 'top_movies');
    const tvRows = findRowsInStats(tvStats, 'top_tv');

    // Live TV / DVR plays use an xmltv guid and/or the `live` flag; they have no library
    // rating_key or TMDB metadata, so they can never enrich into a clickable card.
    const isLive = (r) =>
      r.live === 1 || r.live === '1' ||
      String(r.guid || '').startsWith('tv.plex.xmltv://');

    // top_tv rows are episode-level; roll up to the show via grandparent_rating_key
    // (library_items stores shows, not episodes) and sum plays across episodes.
    const showPlays = new Map(); // grandparentRatingKey -> summed plays
    for (const r of (tvRows || [])) {
      if (isLive(r)) continue;
      const showKey = String(r.grandparent_rating_key || r.rating_key);
      if (!showKey || showKey === 'null') continue;
      showPlays.set(showKey, (showPlays.get(showKey) || 0) + (r.total_plays || 0));
    }

    const items = {
      movies: (moviesRows || [])
        .filter(r => !isLive(r))
        .map(r => ({
          ratingKey: String(r.rating_key),
          totalPlays: r.total_plays || 0,
        })),
      tvShows: [...showPlays.entries()]
        .map(([ratingKey, totalPlays]) => ({ ratingKey, totalPlays }))
        .sort((a, b) => b.totalPlays - a.totalPlays),
    };

    _popularCache.set('all', { items, at: Date.now() });
    return items;
  } catch (err) {
    console.warn('getPopularItems error:', err.message);
    return { movies: [], tvShows: [] };
  }
}

// ── Watch History (cached in DB, served from there) ─────────────────────────────

// Map a raw Tautulli get_history row to our normalized (camelCase) shape.
function mapTautulliHistoryRow(r) {
  return {
    historyId: r.id,
    ratingKey: r.rating_key != null ? String(r.rating_key) : null,
    grandparentRatingKey: r.grandparent_rating_key ? String(r.grandparent_rating_key) : null,
    parentRatingKey: r.parent_rating_key ? String(r.parent_rating_key) : null,
    title: r.full_title || r.title || 'Unknown',
    parentTitle: r.grandparent_title || r.parent_title || null,
    year: r.year || null,
    mediaType: r.media_type === 'episode' ? 'episode' : 'movie',
    thumb: r.thumb || null,
    watchedAt: r.date || 0,
    // Tautulli get_history `duration` is the actual session/play length in seconds.
    duration: r.duration || 0,
    percentComplete: r.percent_complete || 0,
    watchedStatus: r.watched_status >= 1 ? 'complete' : 'incomplete',
    userId: r.user_id != null ? String(r.user_id) : null,
    userName: r.friendly_name || r.username || r.user || null,
    userThumb: r.user_thumb || null,
    // Tautulli get_history exposes season/episode as parent_media_index / media_index.
    seasonNumber: r.parent_media_index ?? null,
    episodeNumber: r.media_index ?? null,
    bitrate: r.bitrate || null,
    resolution: r.resolution || null,
  };
}

/**
 * Pull recent watch history for ALL users from Tautulli and upsert it into the
 * local `watch_history` table. Runs on a schedule (see server.js) so the Watch
 * History page can be served entirely from the DB instead of calling Tautulli on
 * every request. Upserts are keyed by Tautulli's history id, so new plays are
 * added and in-progress rows are refreshed without duplicating anything.
 */
async function syncWatchHistory({ length = 10000 } = {}) {
  const rows = [];
  for (const type of ['movie', 'episode']) {
    try {
      const data = await tautulliGet('get_history', {
        length,
        media_type: type,
        order_column: 'date',
        order_dir: 'desc',
      });
      for (const r of (data.data || [])) rows.push(mapTautulliHistoryRow(r));
    } catch (err) {
      console.warn(`syncWatchHistory (${type}) error:`, err.message);
    }
  }
  const count = db.upsertWatchHistoryBatch(rows);
  db.setSyncTime('watch_history');
  return count;
}

/**
 * Cross-user view stats from the locally cached watch_history table (synced from
 * Tautulli every 15 min): { ratingKey: { lastPlayedAt, plays } }, movies keyed by
 * their own rating_key and shows by the show (grandparent) key — matching
 * library_items. Used by deletion profiles for last-played / never-played
 * criteria, so it deliberately reads the DB instead of hitting Tautulli live.
 */
function getGlobalViewStats() {
  const stats = {};
  for (const row of db.prepare(`
    SELECT rating_key AS key, MAX(watched_at) AS last, COUNT(*) AS plays
    FROM watch_history WHERE media_type = 'movie' AND rating_key IS NOT NULL
    GROUP BY rating_key
  `).all()) {
    stats[String(row.key)] = { lastPlayedAt: row.last || 0, plays: row.plays || 0 };
  }
  for (const row of db.prepare(`
    SELECT grandparent_rating_key AS key, MAX(watched_at) AS last, COUNT(*) AS plays
    FROM watch_history WHERE media_type = 'episode' AND grandparent_rating_key IS NOT NULL
    GROUP BY grandparent_rating_key
  `).all()) {
    stats[String(row.key)] = { lastPlayedAt: row.last || 0, plays: row.plays || 0 };
  }
  return stats;
}

// Whether watch history has ever synced. Deletion profiles that use watch-based
// criteria must refuse to run without it — an empty history would make
// "never played" match the entire library.
function hasWatchHistoryData() {
  return (db.getWatchHistoryCount() || 0) > 0;
}

module.exports = { getWatchedMovieKeys, getWatchedShowKeys, getFullHistory, getViewStats, getPopularItems, syncWatchHistory, getGlobalViewStats, hasWatchHistoryData };
