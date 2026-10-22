const db = require('../../db/database');
const client = require('./client');

// Per-user watch data from the Jellyfin core API. Unlike Plex (which needs
// Tautulli), Jellyfin tracks played state, play counts and last-played dates
// natively, so the admin API key can mirror every user's data — the same way
// the Tautulli sync mirrors all Plex users — into user_watched, watch_history
// (source='jellyfin') and user_ratings. Rows are keyed by the canonical user id
// so linked accounts accumulate one merged profile.
//
// watch_history rows carry an `origin`:
//   'snapshot' — a stand-in derived from the item-level played/resume state
//                (LastPlayedDate, runtime as duration). It may be a manual
//                "mark played", and a real play always replaces it.
//   'session'  — a play the websocket tracker (socket.js) observed.
//   'plugin'   — a Playback Reporting record. Where it and a websocket row
//                describe the same play, the plugin row wins.

// Every list read pages to completion: callers treat the result as the user's
// full state (watched keys, ratings and favorites are reconciled against it),
// so an incomplete read throws instead of looking like "the rest were removed".
const PAGE_SIZE = 1000;

async function queryUserItems(jfUserId, params) {
  const items = [];
  const seen = new Set();
  for (let start = 0; ; start += PAGE_SIZE) {
    const qs = new URLSearchParams({
      Recursive: 'true',
      EnableUserData: 'true',
      // A name sort stays stable while the sync pages through; DatePlayed
      // would reshuffle under a user who is watching something right now.
      SortBy: 'SortName',
      ...params,
      StartIndex: String(start),
      Limit: String(PAGE_SIZE),
    });
    const page = await client.jfFetch(`/Users/${jfUserId}/Items?${qs}`);
    if (!Array.isArray(page?.Items)) throw new Error(`Jellyfin returned no item list for user ${jfUserId}`);
    for (const item of page.Items) {
      const id = String(item?.Id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
    const total = Number(page.TotalRecordCount);
    const hasTotal = page.TotalRecordCount != null && Number.isFinite(total);
    if (page.Items.length < PAGE_SIZE) {
      if (hasTotal && items.length < total) {
        throw new Error(`Incomplete Jellyfin listing for user ${jfUserId} (${items.length}/${total})`);
      }
      return items;
    }
    if (hasTotal && start + page.Items.length >= total) return items;
  }
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

// A play counts as complete past this share of the runtime (Tautulli's default).
const COMPLETE_PERCENT = 85;
// An in-progress (resumable) movie counts as watched past this share — the
// Tautulli rule the Plex sync applies to movies (getWatchedMovieKeys). Like
// Plex's onDeck, a resumable episode counts its series at any position.
const IN_PROGRESS_PERCENT = 10;

// Played movies + episodes, plus the in-progress (resumable) ones. Jellyfin
// clears Played when a rewatch starts, so the two lists don't overlap.
async function getPlayedItems(jfUserId) {
  const [movies, episodes, resumable] = await Promise.all([
    queryUserItems(jfUserId, { IncludeItemTypes: 'Movie', Filters: 'IsPlayed', Fields: 'ProviderIds' }),
    queryUserItems(jfUserId, { IncludeItemTypes: 'Episode', Filters: 'IsPlayed' }),
    queryUserItems(jfUserId, { IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable', Fields: 'ProviderIds' }),
  ]);
  return { movies, episodes, resumable };
}

// One watch_history row for a Jellyfin item. `play` (optional) is a real
// per-play record { ts, duration, origin, historyId? } from the Playback
// Reporting plugin or the websocket session tracker; without it the item-level
// state stands in (origin 'snapshot'): LastPlayedDate as the timestamp, the
// runtime as duration for a played item, the resume position for one in progress.
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
    const positionSec = Math.round((Number(item.UserData?.PlaybackPositionTicks) || 0) / 10_000_000);
    duration = played ? runtimeSec : (runtimeSec ? Math.min(positionSec, runtimeSec) : positionSec);
    percent = percentOf(item.UserData, item.RunTimeTicks);
  }
  return {
    historyId: play?.historyId || `jf:${jfUserId}:${item.Id}:${watchedAt}`,
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
    origin: play ? (play.origin || 'plugin') : 'snapshot',
  };
}

// Playback Reporting names episodes "<Series> - s01e02 - <Episode>".
const PLUGIN_EPISODE_NAME = /^(.*) - s(\d+)e(\d+) - (.*)$/i;

// Item stand-in for a plugin play whose item Jellyfin no longer returns (a
// removed title): what the plugin row itself recorded. Runtime is unknown, so
// the row's completion stays 0%.
function pluginFallbackItem(play) {
  const type = play.itemType === 'Episode' ? 'Episode' : 'Movie';
  const item = { Id: play.itemId, Name: play.itemName || 'Unknown', Type: type };
  const m = type === 'Episode' ? PLUGIN_EPISODE_NAME.exec(play.itemName || '') : null;
  if (m) Object.assign(item, { SeriesName: m[1], ParentIndexNumber: Number(m[2]), IndexNumber: Number(m[3]), Name: m[4] });
  return item;
}

// Rows for one Jellyfin user: one per Playback Reporting play (`plays`,
// [{ itemId, ts, duration, itemType?, itemName? }]) — independent records, so
// a play of an item missing from the played lists still produces a row, its
// metadata taken from `itemsById` or the plugin row — plus one snapshot
// stand-in per played/in-progress item. writeHistoryRows decides which
// stand-ins a real play already covers.
function historyRowsOf(jfUserId, canonicalId, userName, userThumb, movies, episodes, plays = null, itemsById = null) {
  const items = [
    ...movies.map(m => ({ ...m, Type: 'Movie', SeriesId: null })),
    ...episodes.map(e => ({ ...e, Type: 'Episode' })),
  ];
  const known = new Map(itemsById || []);
  for (const item of items) known.set(String(item.Id), item);

  const rows = [];
  const seenPlays = new Set();
  for (const p of (plays || [])) {
    if (!p?.itemId || !p.ts) continue;
    const key = `${p.itemId}|${p.ts}`;
    if (seenPlays.has(key)) continue; // two plugin rows on the same second collapse
    seenPlays.add(key);
    const item = known.get(String(p.itemId)) || pluginFallbackItem(p);
    rows.push(historyRowFor(jfUserId, canonicalId, userName, userThumb, item, { ts: p.ts, duration: p.duration, origin: 'plugin' }));
  }
  for (const item of items) {
    // An in-progress item with no play date has nothing to place in history.
    if (!item.UserData?.Played && !item.UserData?.LastPlayedDate) continue;
    rows.push(historyRowFor(jfUserId, canonicalId, userName, userThumb, item));
  }
  return rows;
}

// ── Reconciling stand-ins, websocket plays and plugin plays ─────────────────
// A snapshot stand-in sits within ±DEDUPE_WINDOW_SEC of the play it stands for
// (LastPlayedDate is set when playback starts). Real plays of the same item —
// two devices, a rewatch an hour later — are separate rows; only a websocket
// row and a plugin row whose play spans overlap (within OVERLAP_SLACK_SEC)
// describe one play.
const DEDUPE_WINDOW_SEC = 6 * 3600;
const OVERLAP_SLACK_SEC = 10 * 60;

// True when a real (websocket or plugin) play of this user+item sits within
// ±windowSec of `ts` — a snapshot stand-in there would count it twice.
function hasRealJellyfinPlay(userId, itemId, ts, windowSec = DEDUPE_WINDOW_SEC) {
  const row = db.prepare(`
    SELECT 1 FROM watch_history
    WHERE user_id = ? AND rating_key = ? AND source = 'jellyfin' AND origin IN ('session', 'plugin')
      AND watched_at BETWEEN ? AND ?
    LIMIT 1
  `).get(String(userId), String(itemId), ts - windowSec, ts + windowSec);
  return !!row;
}

function deleteStandIns(userId, itemId, ts, windowSec = DEDUPE_WINDOW_SEC) {
  db.prepare(`
    DELETE FROM watch_history
    WHERE user_id = ? AND rating_key = ? AND source = 'jellyfin' AND COALESCE(origin, 'snapshot') = 'snapshot'
      AND watched_at BETWEEN ? AND ?
  `).run(String(userId), String(itemId), ts - windowSec, ts + windowSec);
}

// Rows of `origin` for the same user+item whose play span overlaps `row`'s.
function overlappingPlaySql(origin) {
  return `
    FROM watch_history
    WHERE user_id = ? AND rating_key = ? AND source = 'jellyfin' AND origin = '${origin}'
      AND history_id != ? AND watched_at <= ? AND watched_at + duration >= ?`;
}
function overlapParams(row) {
  const start = Number(row.watchedAt) || 0;
  const end = start + (Number(row.duration) || 0);
  return [String(row.userId), String(row.ratingKey), String(row.historyId), end + OVERLAP_SLACK_SEC, start - OVERLAP_SLACK_SEC];
}

// The websocket tracker's write. It replaces a stand-in of the same play but
// never another real play; a play Playback Reporting already holds is skipped.
function replaceJellyfinHistoryRow(row, windowSec = DEDUPE_WINDOW_SEC) {
  if (db.prepare(`SELECT 1 ${overlappingPlaySql('plugin')} LIMIT 1`).get(...overlapParams(row))) return 0;
  deleteStandIns(row.userId, row.ratingKey, row.watchedAt, windowSec);
  return db.upsertWatchHistoryBatch([{ ...row, origin: 'session' }]);
}

// Persist one sync's rows. Plugin plays first: a new one displaces the
// websocket row of the same play and nearby stand-ins. Then the stand-ins no
// real play covers; each supersedes older in-progress stand-ins of its item
// (a resumed viewing is one viewing, not one per resume).
function writeHistoryRows(rows, knownPluginIds = new Set()) {
  const plugin = rows.filter(r => r.origin === 'plugin');
  db.withTransaction(() => {
    const dropSessionCopy = db.prepare(`DELETE ${overlappingPlaySql('session')}`);
    for (const r of plugin) {
      if (knownPluginIds.has(r.historyId)) continue; // reconciled when first imported
      dropSessionCopy.run(...overlapParams(r));
      deleteStandIns(r.userId, r.ratingKey, r.watchedAt);
    }
  });
  db.upsertWatchHistoryBatch(plugin);

  const standIns = [];
  db.withTransaction(() => {
    const supersede = db.prepare(`
      DELETE FROM watch_history
      WHERE user_id = ? AND rating_key = ? AND source = 'jellyfin' AND COALESCE(origin, 'snapshot') = 'snapshot'
        AND watched_status = 'incomplete' AND watched_at < ? AND history_id != ?
    `);
    for (const r of rows) {
      if (r.origin !== 'snapshot' || hasRealJellyfinPlay(r.userId, r.ratingKey, r.watchedAt)) continue;
      supersede.run(String(r.userId), String(r.ratingKey), r.watchedAt, r.historyId);
      standIns.push(r);
    }
  });
  db.upsertWatchHistoryBatch(standIns);
  return plugin.length + standIns.length;
}

// Series/movie keys the user's real plays put on the watched list — the
// Jellyfin counterpart of the Tautulli history the Plex sync unions in.
function realPlayWatchedKeys(canonicalId) {
  return db.prepare(`
    SELECT DISTINCT CASE WHEN media_type = 'episode' THEN grandparent_rating_key ELSE rating_key END AS k
    FROM watch_history
    WHERE user_id = ? AND source = 'jellyfin' AND origin IN ('session', 'plugin')
      AND (media_type = 'episode' OR watched_status = 'complete' OR percent_complete > ?)
  `).all(String(canonicalId), IN_PROGRESS_PERCENT).map(r => r.k).filter(Boolean).map(String);
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

// Per-play records for one user: [{ itemId, ts, duration, itemType, itemName }]
// (duration in seconds).
async function getPlaybackReportingPlays(jfUserId) {
  const guid = String(jfUserId).replace(/[^0-9a-fA-F-]/g, '');
  const rows = await customQuery(
    "SELECT DateCreated, ItemId, PlayDuration, UserId, ItemType, ItemName FROM PlaybackActivity " +
    `WHERE ItemType IN ('Movie','Episode') AND REPLACE(UserId, '-', '') = REPLACE('${guid}', '-', '')`
  );
  return rows
    .map(r => ({
      itemId: String(r.ItemId || ''), ts: tsOf(r.DateCreated), duration: Number(r.PlayDuration) || 0,
      itemType: r.ItemType ? String(r.ItemType) : null, itemName: r.ItemName ? String(r.ItemName) : null,
    }))
    .filter(r => r.itemId && r.ts > 0);
}

// Metadata for plugin-played items absent from the user's played/resume lists
// (rewatch in progress, marked unplayed, removed). Batched; a failure leaves
// those plays on the plugin row's own name/type.
const LOOKUP_BATCH = 100;
async function lookupItems(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const params = new URLSearchParams({ Ids: ids.slice(i, i + LOOKUP_BATCH).join(','), Recursive: 'true', Fields: 'ProviderIds' });
    try {
      const page = await client.jfFetch(`/Items?${params}`);
      for (const item of (page?.Items || [])) if (item?.Id) found.set(String(item.Id), item);
    } catch (err) {
      console.warn(`[jellyfin] Item lookup for plugin plays failed: ${err.message}`);
    }
  }
  return found;
}

async function syncUserData(jfUser) {
  const jfUserId = jfUser.id;
  const diskovarrId = `jf_${jfUserId}`;
  const canonicalId = db.resolveCanonicalUserId(diskovarrId);
  const userThumb = client.getAvatarPath(jfUserId, jfUser.primaryImageTag);

  // Throws on any incomplete read — nothing below runs on partial state.
  const { movies, episodes, resumable } = await getPlayedItems(jfUserId);
  const playedIds = new Set([...movies, ...episodes].map(i => String(i.Id)));
  const inProgress = resumable.filter(i => !playedIds.has(String(i.Id)));
  const resumeMovies = inProgress.filter(i => i.Type !== 'Episode' && !i.SeriesId);
  const resumeEpisodes = inProgress.filter(i => i.Type === 'Episode' || i.SeriesId);

  // Per-play rows from Playback Reporting when the plugin is installed, plus
  // one snapshot stand-in per played/in-progress item that no real play covers.
  let plays = null;
  if (await probePlaybackReporting()) {
    try { plays = await getPlaybackReportingPlays(jfUserId); }
    catch (err) { console.warn(`[jellyfin] Playback Reporting query failed for ${jfUser.name}: ${err.message}`); }
  }
  const knownPluginIds = new Set(db.prepare(
    "SELECT history_id FROM watch_history WHERE user_id = ? AND source = 'jellyfin' AND origin = 'plugin'"
  ).all(String(canonicalId)).map(r => String(r.history_id)));
  const listedIds = new Set([...playedIds, ...inProgress.map(i => String(i.Id))]);
  let itemsById = null;
  if (plays?.length) {
    // A stored plugin row keeps its metadata when the item has left the lists;
    // only new plays of unlisted items need a lookup.
    const isNew = (p) => !knownPluginIds.has(`jf:${jfUserId}:${p.itemId}:${p.ts}`);
    plays = plays.filter(p => listedIds.has(p.itemId) || isNew(p));
    const unknown = [...new Set(plays.filter(p => !listedIds.has(p.itemId)).map(p => p.itemId))];
    if (unknown.length) itemsById = await lookupItems(unknown);
  }
  const rows = historyRowsOf(jfUserId, canonicalId, jfUser.name, userThumb,
    [...movies, ...resumeMovies], [...episodes, ...resumeEpisodes], plays, itemsById);
  writeHistoryRows(rows, knownPluginIds);

  // Watched keys: movies by their own id, episodes roll up to the series id
  // (library_items stores shows, never episodes) — matching the Plex sync,
  // which unions played state, onDeck and Tautulli history.
  const watchedKeys = new Set();
  for (const m of movies) watchedKeys.add(String(m.Id));
  for (const e of episodes) if (e.SeriesId) watchedKeys.add(String(e.SeriesId));
  for (const m of resumeMovies) {
    if (percentOf(m.UserData, m.RunTimeTicks) > IN_PROGRESS_PERCENT) watchedKeys.add(String(m.Id));
  }
  for (const e of resumeEpisodes) if (e.SeriesId) watchedKeys.add(String(e.SeriesId));
  for (const key of realPlayWatchedKeys(canonicalId)) watchedKeys.add(key);
  db.replaceWatchedBatch(canonicalId, [...watchedKeys], 'jellyfin');

  // Likes/dislikes → the 0–10 user_ratings scale the recommender consumes.
  // Both lists are complete reads, so a rating missing from them was cleared
  // in Jellyfin and is dropped here (Plex-imported ratings are untouched).
  try {
    const [liked, disliked] = await Promise.all([
      queryUserItems(jfUserId, { IncludeItemTypes: 'Movie,Series', Filters: 'Likes' }),
      queryUserItems(jfUserId, { IncludeItemTypes: 'Movie,Series', Filters: 'Dislikes' }),
    ]);
    const ratings = new Map();
    for (const i of liked) ratings.set(String(i.Id), 7.5);
    for (const i of disliked) ratings.set(String(i.Id), 2.5);
    db.replaceUserRatings(canonicalId, [...ratings].map(([ratingKey, userRating]) => ({ ratingKey, userRating })), 'jellyfin');
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
// Concurrent callers (the 15-min job, boot, a connection save, the admin
// history refresh) share the in-flight run and its count.
let _syncInFlight = null;

function syncAllUsers() {
  if (!client.isEnabled()) return Promise.resolve(0);
  if (!_syncInFlight) _syncInFlight = runUserSync().finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}

async function runUserSync() {
  let count = 0;
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
  // Library access: re-snapshot users whose Jellyfin policy changed (never throws)
  await require('../libraryAccess').syncJellyfinPolicies(users);
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
  queryUserItems, getPlayedItems, historyRowsOf, historyRowFor, syncUserData, syncAllUsers, syncFavoritesWatchlist,
  setFavorite, setLikes, syncReviewRating, getFullHistoryFromDb,
  hasRealJellyfinPlay, replaceJellyfinHistoryRow, writeHistoryRows, probePlaybackReporting, getPlaybackReportingPlays,
  COMPLETE_PERCENT, IN_PROGRESS_PERCENT, DEDUPE_WINDOW_SEC,
};
