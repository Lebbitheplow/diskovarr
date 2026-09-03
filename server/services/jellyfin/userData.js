const db = require('../../db/database');
const client = require('./client');

// Per-user watch data from the Jellyfin core API. Unlike Plex (which needs
// Tautulli), Jellyfin tracks played state, play counts and last-played dates
// natively, so the admin API key can mirror every user's data — the same way
// the Tautulli sync mirrors all Plex users — into user_watched, watch_history
// (source='jellyfin') and user_ratings. Rows are keyed by the canonical user id
// so linked accounts accumulate one merged profile.

async function queryUserItems(jfUserId, params) {
  const qs = new URLSearchParams({
    Recursive: 'true',
    EnableUserData: 'true',
    Limit: '5000',
    ...params,
  });
  const page = await client.jfFetch(`/Users/${jfUserId}/Items?${qs}`);
  return page?.Items || [];
}

function tsOf(dateStr) {
  const t = dateStr ? Date.parse(dateStr) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function percentOf(userData, runTimeTicks) {
  if (userData?.Played) return 100;
  if (userData?.PlaybackPositionTicks && runTimeTicks) {
    return Math.min(100, Math.round((userData.PlaybackPositionTicks / runTimeTicks) * 100));
  }
  return 0;
}

// Played movies + episodes with the fields the history/recommendation layers need.
async function getPlayedItems(jfUserId) {
  const [movies, episodes] = await Promise.all([
    queryUserItems(jfUserId, { IncludeItemTypes: 'Movie', Filters: 'IsPlayed', Fields: 'ProviderIds', SortBy: 'DatePlayed', SortOrder: 'Descending' }),
    queryUserItems(jfUserId, { IncludeItemTypes: 'Episode', Filters: 'IsPlayed', SortBy: 'DatePlayed', SortOrder: 'Descending' }),
  ]);
  return { movies, episodes };
}

// One watch_history row for a Jellyfin item. `play` (optional) is a real
// per-play record { ts, duration } from the Playback Reporting plugin or the
// websocket session tracker; without it the item-level played state stands in
// (runtime as duration, LastPlayedDate as the timestamp).
function historyRowFor(jfUserId, canonicalId, userName, userThumb, item, play = null) {
  const isEpisode = item.Type === 'Episode' || !!item.SeriesId;
  const runtimeSec = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000_000) : 0;
  const played = !!item.UserData?.Played;
  const watchedAt = play ? play.ts : tsOf(item.UserData?.LastPlayedDate);
  let duration, percent;
  if (play) {
    duration = Math.max(0, Math.round(play.duration || 0));
    percent = runtimeSec ? Math.min(100, Math.round((duration / runtimeSec) * 100)) : (played ? 100 : 0);
  } else {
    duration = played && runtimeSec ? runtimeSec : 0;
    percent = percentOf(item.UserData, item.RunTimeTicks);
  }
  return {
    historyId: `jf:${jfUserId}:${item.Id}:${watchedAt}`,
    userId: canonicalId,
    ratingKey: String(item.Id),
    grandparentRatingKey: isEpisode && item.SeriesId ? String(item.SeriesId) : null,
    parentRatingKey: isEpisode && item.SeasonId ? String(item.SeasonId) : null,
    title: item.Name || 'Unknown',
    parentTitle: isEpisode ? (item.SeriesName || null) : null,
    year: item.ProductionYear || null,
    mediaType: isEpisode ? 'episode' : 'movie',
    thumb: isEpisode
      ? (item.SeriesId ? `/Items/${item.SeriesId}/Images/Primary` : null)
      : (item.ImageTags?.Primary ? `/Items/${item.Id}/Images/Primary` : null),
    watchedAt,
    duration,
    percentComplete: percent,
    watchedStatus: play ? (percent >= COMPLETE_PERCENT ? 'complete' : 'incomplete') : (played ? 'complete' : 'incomplete'),
    userName,
    userThumb,
    seasonNumber: isEpisode ? (item.ParentIndexNumber ?? null) : null,
    episodeNumber: isEpisode ? (item.IndexNumber ?? null) : null,
    bitrate: null,
    resolution: null,
    source: 'jellyfin',
  };
}

// A play counts as complete past this share of the runtime (Tautulli's default).
const COMPLETE_PERCENT = 85;

// Mirror one Jellyfin user's played state into watch_history rows. With
// `plays` ([{ itemId, ts, duration }] from Playback Reporting), items that have
// real plays emit one row per play instead of the item-level stand-in.
function historyRowsOf(jfUserId, canonicalId, userName, userThumb, movies, episodes, plays = null) {
  const playsByItem = new Map();
  for (const p of (plays || [])) {
    if (!p?.itemId || !p.ts) continue;
    const list = playsByItem.get(String(p.itemId)) || [];
    list.push(p);
    playsByItem.set(String(p.itemId), list);
  }
  const rows = [];
  const emit = (item) => {
    const itemPlays = playsByItem.get(String(item.Id));
    if (itemPlays?.length) {
      const seen = new Set();
      for (const play of itemPlays) {
        if (seen.has(play.ts)) continue; // two plugin rows on the same second collapse
        seen.add(play.ts);
        rows.push(historyRowFor(jfUserId, canonicalId, userName, userThumb, item, play));
      }
    } else {
      rows.push(historyRowFor(jfUserId, canonicalId, userName, userThumb, item));
    }
  };
  for (const m of movies) emit({ ...m, Type: 'Movie', SeriesId: null });
  for (const e of episodes) emit({ ...e, Type: 'Episode' });
  return rows;
}

// True when a Jellyfin history row for this user+item already sits within
// ±windowSec of `ts` — the websocket tracker and the item-level sync would
// otherwise each add their own row for the same play.
const DEDUPE_WINDOW_SEC = 6 * 3600;
function hasRecentJellyfinHistory(userId, itemId, ts, windowSec = DEDUPE_WINDOW_SEC) {
  const row = db.prepare(`
    SELECT 1 FROM watch_history
    WHERE user_id = ? AND rating_key = ? AND source = 'jellyfin' AND watched_at BETWEEN ? AND ?
    LIMIT 1
  `).get(String(userId), String(itemId), ts - windowSec, ts + windowSec);
  return !!row;
}

// Replace any Jellyfin rows for the same user+item inside the window with
// `row` (used by the websocket tracker, whose durations are the real ones).
function replaceJellyfinHistoryRow(row, windowSec = DEDUPE_WINDOW_SEC) {
  db.prepare(`
    DELETE FROM watch_history
    WHERE user_id = ? AND rating_key = ? AND source = 'jellyfin' AND watched_at BETWEEN ? AND ?
  `).run(String(row.userId), String(row.ratingKey), row.watchedAt - windowSec, row.watchedAt + windowSec);
  return db.upsertWatchHistoryBatch([row]);
}

// ── Playback Reporting plugin (optional per-play backfill) ───────────────────
// When installed, the plugin answers POST /user_usage_stats/submit_custom_query
// with real per-session rows. Probed at most once per PROBE_TTL; absence is
// cached too so unsupported servers aren't hit every sync.
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;
let _playbackReporting = { available: null, at: 0 };

async function customQuery(sql) {
  const res = await client.jfFetch('/user_usage_stats/submit_custom_query', {
    method: 'POST', body: { CustomQueryString: sql, ReplaceUserId: false }, timeout: 30000,
  });
  const cols = (res?.colums || res?.columns || []).map(c => String(c));
  return (res?.results || []).map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

async function probePlaybackReporting(force = false) {
  if (!force && _playbackReporting.available !== null && Date.now() - _playbackReporting.at < PROBE_TTL_MS) {
    return _playbackReporting.available;
  }
  let available = false;
  try {
    await customQuery("SELECT COUNT(*) AS c FROM PlaybackActivity WHERE ItemType IN ('Movie','Episode') LIMIT 1");
    available = true;
  } catch { available = false; }
  _playbackReporting = { available, at: Date.now() };
  return available;
}

// Per-play records for one user: [{ itemId, ts, duration }] (duration in seconds).
async function getPlaybackReportingPlays(jfUserId) {
  const guid = String(jfUserId).replace(/[^0-9a-fA-F-]/g, '');
  const rows = await customQuery(
    "SELECT DateCreated, ItemId, PlayDuration, UserId FROM PlaybackActivity " +
    `WHERE ItemType IN ('Movie','Episode') AND REPLACE(UserId, '-', '') = REPLACE('${guid}', '-', '')`
  );
  return rows
    .map(r => ({ itemId: String(r.ItemId || ''), ts: tsOf(r.DateCreated), duration: Number(r.PlayDuration) || 0 }))
    .filter(r => r.itemId && r.ts > 0);
}

async function syncUserData(jfUser) {
  const jfUserId = jfUser.id;
  const diskovarrId = `jf_${jfUserId}`;
  const canonicalId = db.resolveCanonicalUserId(diskovarrId);
  const userThumb = client.getAvatarPath(jfUserId, jfUser.primaryImageTag);

  const { movies, episodes } = await getPlayedItems(jfUserId);

  // Watched keys: movies by their own id, episodes roll up to the series id
  // (library_items stores shows, never episodes) — matching the Plex sync.
  const watchedKeys = new Set();
  for (const m of movies) watchedKeys.add(String(m.Id));
  for (const e of episodes) if (e.SeriesId) watchedKeys.add(String(e.SeriesId));
  db.replaceWatchedBatch(canonicalId, [...watchedKeys], 'jellyfin');

  // Per-play rows from Playback Reporting when the plugin is installed; else
  // one item-level row. Either way, plays the websocket tracker already wrote
  // (real durations) win over a same-window item-level stand-in.
  let plays = null;
  if (await probePlaybackReporting()) {
    try { plays = await getPlaybackReportingPlays(jfUserId); }
    catch (err) { console.warn(`[jellyfin] Playback Reporting query failed for ${jfUser.name}: ${err.message}`); }
  }
  const rows = historyRowsOf(jfUserId, canonicalId, jfUser.name, userThumb, movies, episodes, plays)
    .filter(r => plays?.length || !hasRecentJellyfinHistory(canonicalId, r.ratingKey, r.watchedAt));
  db.upsertWatchHistoryBatch(rows);

  // Likes/dislikes → the 0–10 user_ratings scale the recommender consumes.
  try {
    const [liked, disliked] = await Promise.all([
      queryUserItems(jfUserId, { IncludeItemTypes: 'Movie,Series', Filters: 'Likes' }),
      queryUserItems(jfUserId, { IncludeItemTypes: 'Movie,Series', Filters: 'Dislikes' }),
    ]);
    const ratings = [
      ...liked.map(i => ({ ratingKey: String(i.Id), userRating: 7.5 })),
      ...disliked.map(i => ({ ratingKey: String(i.Id), userRating: 2.5 })),
    ];
    if (ratings.length) db.upsertUserRatings(canonicalId, ratings);
  } catch (err) {
    console.warn(`[jellyfin] Ratings sync failed for ${jfUser.name}: ${err.message}`);
  }

  await syncFavoritesWatchlist(jfUserId, canonicalId);
  db.setSyncTime(`jf_watched_${jfUserId}`);
}

// Jellyfin has no watchlist; Favorites are the analog. Reconcile them into the
// watchlist table (source='jellyfin') both ways, honoring the same 5-minute
// grace window the plex.tv reconciler uses so a just-added row can't be
// removed before the favorite call lands.
const WATCHLIST_GRACE_SECONDS = 300;

async function syncFavoritesWatchlist(jfUserId, canonicalId) {
  try {
    const favs = await queryUserItems(jfUserId, { IncludeItemTypes: 'Movie,Series', Filters: 'IsFavorite' });
    const favIds = new Set(favs.map(f => String(f.Id)));
    const rows = db.getWatchlistRows(canonicalId, 'jellyfin');
    const known = new Set(rows.map(r => String(r.rating_key)));
    for (const id of favIds) {
      if (!known.has(id)) db.addToWatchlistDb(canonicalId, id, 'jellyfin');
    }
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      if (!favIds.has(String(row.rating_key)) && now - (row.added_at || 0) > WATCHLIST_GRACE_SECONDS) {
        db.removeFromWatchlistDb(canonicalId, row.rating_key);
      }
    }
  } catch (err) {
    console.warn(`[jellyfin] Favorites sync failed for jf user ${jfUserId}: ${err.message}`);
  }
}

// Mirror every Jellyfin user (like the Tautulli all-users history sync).
let _syncInProgress = false;

async function syncAllUsers() {
  if (!client.isEnabled() || _syncInProgress) return 0;
  _syncInProgress = true;
  let count = 0;
  try {
    const users = await client.getUsers();
    for (const u of users) {
      if (u.isDisabled) continue;
      db.seedJellyfinUser(`jf_${u.id}`, u.name, client.getAvatarPath(u.id, u.primaryImageTag));
      try {
        await syncUserData(u);
        count++;
      } catch (err) {
        console.warn(`[jellyfin] User data sync failed for ${u.name}: ${err.message}`);
      }
    }
  } finally {
    _syncInProgress = false;
  }
  return count;
}

// ── Write-backs (watchlist + reviews) ────────────────────────────────────────

async function setFavorite(jfUserId, itemId, on) {
  await client.jfFetch(`/Users/${jfUserId}/FavoriteItems/${itemId}`, { method: on ? 'POST' : 'DELETE' });
}

// likes: true (like), false (dislike), or null to clear.
async function setLikes(jfUserId, itemId, likes) {
  if (likes === null) {
    await client.jfFetch(`/Users/${jfUserId}/Items/${itemId}/Rating`, { method: 'DELETE' });
  } else {
    await client.jfFetch(`/Users/${jfUserId}/Items/${itemId}/Rating?Likes=${likes ? 'true' : 'false'}`, { method: 'POST' });
  }
}

// Diskovarr review (0.5–5) → Jellyfin like/dislike. Mid ratings clear the flag.
async function syncReviewRating(jfUserId, itemId, rating) {
  if (rating == null) return setLikes(jfUserId, itemId, null);
  if (rating >= 3.5) return setLikes(jfUserId, itemId, true);
  if (rating <= 2.0) return setLikes(jfUserId, itemId, false);
  return setLikes(jfUserId, itemId, null);
}

// ── History for the recommenders ─────────────────────────────────────────────

// Same shape tautulli.getFullHistory returns, read from the mirrored table:
// movies one row per play-date, shows de-duped with an episodeCount.
function getFullHistoryFromDb(userId) {
  const rows = db.prepare(`
    SELECT rating_key, grandparent_rating_key, media_type, watched_at, percent_complete
    FROM watch_history WHERE user_id = ? AND source = 'jellyfin'
    ORDER BY watched_at DESC
  `).all(String(userId));
  const movies = [];
  const showCounts = new Map();
  const showLatest = new Map();
  for (const r of rows) {
    if (r.media_type === 'episode') {
      const key = r.grandparent_rating_key ? String(r.grandparent_rating_key) : null;
      if (!key) continue;
      showCounts.set(key, (showCounts.get(key) || 0) + 1);
      if (!showLatest.has(key)) showLatest.set(key, r.watched_at || 0);
    } else {
      movies.push({
        rating_key: String(r.rating_key),
        grandparent_rating_key: null,
        watched_at: r.watched_at || 0,
        percent_complete: r.percent_complete || 0,
        media_type: 'movie',
      });
    }
  }
  const shows = [...showCounts.entries()].map(([key, episodeCount]) => ({
    rating_key: key,
    grandparent_rating_key: key,
    watched_at: showLatest.get(key) || 0,
    percent_complete: 100,
    media_type: 'show',
    episodeCount,
  }));
  return [...movies, ...shows];
}

module.exports = {
  getPlayedItems, historyRowsOf, historyRowFor, syncUserData, syncAllUsers, syncFavoritesWatchlist,
  setFavorite, setLikes, syncReviewRating, getFullHistoryFromDb,
  hasRecentJellyfinHistory, replaceJellyfinHistoryRow, probePlaybackReporting, getPlaybackReportingPlays,
  COMPLETE_PERCENT, DEDUPE_WINDOW_SEC,
};
