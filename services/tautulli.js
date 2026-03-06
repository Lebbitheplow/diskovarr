const db = require('../db/database');

function getTautulliUrl() {
  return db.getSetting('tautulli_url', null) || process.env.TAUTULLI_URL;
}
function getTautulliKey() {
  return db.getSetting('tautulli_api_key', null) || process.env.TAUTULLI_API_KEY;
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
        });
      }
    }

    return [...movies, ...shows];
  } catch (err) {
    console.warn('getFullHistory error:', err.message);
    return [];
  }
}

module.exports = { getWatchedMovieKeys, getWatchedShowKeys, getFullHistory };
