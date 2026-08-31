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

// Mirror one Jellyfin user's played state into user_watched + watch_history.
function historyRowsOf(jfUserId, canonicalId, userName, userThumb, movies, episodes) {
  const rows = [];
  for (const m of movies) {
    const watchedAt = tsOf(m.UserData?.LastPlayedDate);
    rows.push({
      historyId: `jf:${jfUserId}:${m.Id}:${watchedAt}`,
      userId: canonicalId,
      ratingKey: String(m.Id),
      grandparentRatingKey: null,
      parentRatingKey: null,
      title: m.Name || 'Unknown',
      parentTitle: null,
      year: m.ProductionYear || null,
      mediaType: 'movie',
      thumb: m.ImageTags?.Primary ? `/Items/${m.Id}/Images/Primary` : null,
      watchedAt,
      // No per-session length in the core API — runtime stands in when played.
      duration: m.UserData?.Played && m.RunTimeTicks ? Math.round(m.RunTimeTicks / 10_000_000) : 0,
      percentComplete: percentOf(m.UserData, m.RunTimeTicks),
      watchedStatus: m.UserData?.Played ? 'complete' : 'incomplete',
      userName,
      userThumb,
      seasonNumber: null,
      episodeNumber: null,
      bitrate: null,
      resolution: null,
      source: 'jellyfin',
    });
  }
  for (const e of episodes) {
    const watchedAt = tsOf(e.UserData?.LastPlayedDate);
    rows.push({
      historyId: `jf:${jfUserId}:${e.Id}:${watchedAt}`,
      userId: canonicalId,
      ratingKey: String(e.Id),
      grandparentRatingKey: e.SeriesId ? String(e.SeriesId) : null,
      parentRatingKey: e.SeasonId ? String(e.SeasonId) : null,
      title: e.Name || 'Unknown',
      parentTitle: e.SeriesName || null,
      year: e.ProductionYear || null,
      mediaType: 'episode',
      thumb: e.SeriesId ? `/Items/${e.SeriesId}/Images/Primary` : null,
      watchedAt,
      duration: e.UserData?.Played && e.RunTimeTicks ? Math.round(e.RunTimeTicks / 10_000_000) : 0,
      percentComplete: percentOf(e.UserData, e.RunTimeTicks),
      watchedStatus: e.UserData?.Played ? 'complete' : 'incomplete',
      userName,
      userThumb,
      seasonNumber: e.ParentIndexNumber ?? null,
      episodeNumber: e.IndexNumber ?? null,
      bitrate: null,
      resolution: null,
      source: 'jellyfin',
    });
  }
  return rows;
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

  db.upsertWatchHistoryBatch(historyRowsOf(jfUserId, canonicalId, jfUser.name, userThumb, movies, episodes));

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
  getPlayedItems, syncUserData, syncAllUsers, syncFavoritesWatchlist,
  setFavorite, setLikes, syncReviewRating, getFullHistoryFromDb,
};
