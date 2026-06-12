const db = require('../db/database');
const tautulliService = require('./tautulli');

function getPlexUrl()      { return db.getSetting('plex_url', null)   || process.env.PLEX_URL; }
function getPlexToken()    { return db.getSetting('plex_token', null) || process.env.PLEX_TOKEN; }
function getPlexServerId() { return process.env.PLEX_SERVER_ID; }

function getMoviesSection() { return process.env.PLEX_MOVIES_SECTION_ID || '1'; }
function getTvSection()     { return process.env.PLEX_TV_SECTION_ID     || '2'; }

// In-memory L1 cache on top of DB — avoids repeat DB reads within same cycle
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const libraryCache = new Map(); // sectionId -> { data, fetchedAt }

// Per-user watched sync: userId -> Promise (prevents parallel syncs)
const watchedSyncInProgress = new Map();
const WATCHED_SYNC_TTL = 30 * 60; // 30 minutes (seconds)

// Per-section library sync: sectionId -> Promise (prevents parallel fetches)
const libSyncInProgress = new Map();

const PLEX_HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': 'diskovarr-app',
  'X-Plex-Product': 'Diskovarr',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Web',
};

async function plexFetch(path, token) {
  const url = `${getPlexUrl()}${path}`;
  const headers = { ...PLEX_HEADERS, 'X-Plex-Token': token || getPlexToken() };
  const timeout = path.includes('/sections/') ? 180000 : 15000;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Plex API error ${res.status} for ${path}`);
  return res.json();
}

const tags = arr => (arr || []).map(t => t.tag).filter(t => t && String(t).trim());

function parseMediaItem(video) {
  const genres = tags(video.Genre);
  const directors = tags(video.Director);
  const cast = (video.Role || []).slice(0, 10).map(r => r.tag).filter(Boolean);
  const year = video.year || parseInt((video.originallyAvailableAt || '').slice(0, 4)) || 0;
  // Extract TMDB ID from Guid array (present when includeGuids=1 is passed)
  const guids = video.Guid || [];
  const tmdbGuid = guids.find(g => g.id && g.id.startsWith('tmdb://'));
  const tmdbId = tmdbGuid ? tmdbGuid.id.replace('tmdb://', '') : null;
  // Media is only present on movies in the bulk listing (shows carry per-episode
  // media), so resolution/size stay null for shows.
  const media = video.Media || [];
  const videoResolution = media[0]?.videoResolution
    ? String(media[0].videoResolution).toLowerCase() : null;
  let fileSize = 0;
  for (const m of media) for (const p of (m.Part || [])) fileSize += parseInt(p.size) || 0;
  return {
    ratingKey: String(video.ratingKey),
    title: video.title,
    year,
    thumb: video.thumb || null,
    art: video.art || null,
    type: video.type, // 'movie' or 'show'
    genres,
    directors,
    cast,
    audienceRating: parseFloat(video.audienceRating) || 0,
    contentRating: video.contentRating || '',
    addedAt: video.addedAt || 0,
    summary: video.summary || '',
    rating: parseFloat(video.rating) || 0,
    ratingImage: video.ratingImage || '',
    audienceRatingImage: video.audienceRatingImage || '',
    studio: video.studio || '',
    tmdbId,
    leafCount: video.type === 'show' ? (parseInt(video.leafCount) || null) : null,
    // Expanded filter/sort fields. Writers/Country/Collection are in the bulk listing;
    // Producer/Label only appear on /library/metadata detail payloads (empty on bulk).
    writers: tags(video.Writer),
    producers: tags(video.Producer),
    countries: tags(video.Country),
    collections: tags(video.Collection),
    labels: tags(video.Label),
    edition: video.editionTitle || '',
    releaseDate: video.originallyAvailableAt || '',
    duration: parseInt(video.duration) || 0,
    videoResolution,
    fileSize: fileSize || null,
  };
}

async function fetchSection(sectionId) {
  const cached = libraryCache.get(sectionId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  // Try DB — if we have any items, return them immediately and sync in background
  const dbSyncTime = db.getSyncTime(`library_${sectionId}`);
  const dbAge = Math.floor(Date.now() / 1000) - dbSyncTime;
  const dbItems = dbSyncTime > 0 ? db.getLibraryItemsFromDb(sectionId) : [];
  if (dbItems.length > 0) {
    libraryCache.set(sectionId, { data: dbItems, fetchedAt: dbAge < 7200 ? Date.now() : Date.now() - CACHE_TTL + 5 * 60 * 1000 });
    if (dbAge >= 7200) console.log(`Loaded ${dbItems.length} stale items for section ${sectionId} from DB (age: ${Math.round(dbAge/60)}m), syncing in background`);
    else console.log(`Loaded ${dbItems.length} items for section ${sectionId} from DB (age: ${Math.round(dbAge/60)}m)`);
    // Kick off background refresh if stale, but don't block
    if (dbAge >= 7200 && !libSyncInProgress.has(sectionId)) {
      const p = syncLibrarySection(sectionId)
        .catch(err => {
          console.warn(`Background sync failed for section ${sectionId} (${err.message}), keeping stale items`);
          libraryCache.set(sectionId, { data: dbItems, fetchedAt: Date.now() - CACHE_TTL + 5 * 60 * 1000 });
          return dbItems;
        })
        .finally(() => libSyncInProgress.delete(sectionId));
      libSyncInProgress.set(sectionId, p);
    }
    return dbItems;
  }

  // No DB items at all — must wait for sync
  if (!libSyncInProgress.has(sectionId)) {
    const p = syncLibrarySection(sectionId)
      .catch(err => {
        const stale = db.getLibraryItemsFromDb(sectionId);
        if (stale.length > 0) {
          console.warn(`Sync failed for section ${sectionId} (${err.message}), serving ${stale.length} stale items from DB`);
          libraryCache.set(sectionId, { data: stale, fetchedAt: Date.now() - CACHE_TTL + 5 * 60 * 1000 }); // retry in 5 min
          return stale;
        }
        throw err;
      })
      .finally(() => libSyncInProgress.delete(sectionId));
    libSyncInProgress.set(sectionId, p);
  }
  return libSyncInProgress.get(sectionId);
}

async function syncLibrarySection(sectionId) {
  console.log(`Syncing library section ${sectionId} from Plex...`);
  const json = await plexFetch(
    `/library/sections/${sectionId}/all?X-Plex-Container-Size=99999&includeGuids=1&X-Plex-Token=${getPlexToken()}`
  );

  const videos = json.MediaContainer?.Metadata || [];
  const items = videos.map(v => ({ ...parseMediaItem(v), sectionId }));

  // Write to DB
  db.upsertManyItems(items);
  // This fetch is the full section (Container-Size=99999), so it's the authoritative
  // set — prune cached rows for items Plex no longer has (deleted / re-keyed), which
  // otherwise linger and serve dead poster paths + phantom recommendations.
  const pruned = db.pruneLibrarySectionItems(sectionId, items.map(i => i.ratingKey));
  db.setSyncTime(`library_${sectionId}`);

  // Update in-memory cache
  libraryCache.set(sectionId, { data: items, fetchedAt: Date.now() });
  console.log(`Synced ${items.length} items for section ${sectionId} to DB${pruned ? ` (pruned ${pruned} stale)` : ''}`);

  // For the TV section, compute each show's most-recent-episode-added date with one
  // bounded episode query (not per-show). Best-effort — never fails the library sync.
  if (String(sectionId) === String(getTvSection())) {
    syncLastEpisodeAdded(sectionId).catch(err =>
      console.warn(`Last-episode-added sync failed for section ${sectionId}: ${err.message}`));
  }
  return items;
}

// One bounded query for the newest episodes; first occurrence per show (sorted desc) is its
// last-episode-added timestamp. Patches both the DB and the in-memory cache.
async function syncLastEpisodeAdded(sectionId) {
  const json = await plexFetch(
    `/library/sections/${sectionId}/all?type=4&sort=addedAt:desc&X-Plex-Container-Size=5000&X-Plex-Token=${getPlexToken()}`
  );
  const episodes = json.MediaContainer?.Metadata || [];
  const latestByShow = new Map();
  for (const ep of episodes) {
    const showKey = ep.grandparentRatingKey;
    if (!showKey) continue;
    const key = String(showKey);
    const added = ep.addedAt || 0;
    if (!latestByShow.has(key) || added > latestByShow.get(key)) latestByShow.set(key, added);
  }
  for (const [showKey, added] of latestByShow) db.updateLastEpisodeAdded(showKey, added);

  const cached = libraryCache.get(String(sectionId));
  if (cached) {
    for (const item of cached.data) {
      const added = latestByShow.get(String(item.ratingKey));
      if (added) item.lastEpisodeAddedAt = added;
    }
  }
  console.log(`Synced last-episode-added for ${latestByShow.size} shows in section ${sectionId}`);
}

async function getLibraryItems(sectionId) {
  return fetchSection(String(sectionId));
}

// Fetch a single item by ratingKey and upsert it into the DB + in-memory cache.
// Used by the Plex WebSocket handler to process individual new items exactly as
// Tautulli does — no full library scan, just the specific item that was added.
// For episodes, fetches the parent show instead (library_items stores shows, not episodes).
async function fetchAndUpsertItem(ratingKey, sectionId) {
  const data = await plexFetch(`/library/metadata/${ratingKey}?includeGuids=1`);
  const item = data?.MediaContainer?.Metadata?.[0];
  if (!item) return null;

  // Episode → fetch the parent show instead, and bump the show's last-episode-added date
  if (item.type === 'episode') {
    const showKey = item.grandparentRatingKey;
    if (!showKey) return null;
    const result = await fetchAndUpsertItem(String(showKey), sectionId);
    const epAdded = item.addedAt || 0;
    if (epAdded) {
      const existing = db.getLibraryItemByKey(String(showKey));
      if (!existing || epAdded > (existing.lastEpisodeAddedAt || 0)) {
        db.updateLastEpisodeAdded(String(showKey), epAdded);
        const cached = libraryCache.get(String(sectionId || item.librarySectionID));
        const cachedItem = cached?.data.find(i => i.ratingKey === String(showKey));
        if (cachedItem) cachedItem.lastEpisodeAddedAt = epAdded;
      }
    }
    return result;
  }

  // Season → fetch the parent show
  if (item.type === 'season') {
    const showKey = item.parentRatingKey;
    if (!showKey) return null;
    return fetchAndUpsertItem(String(showKey), sectionId);
  }

  if (item.type !== 'movie' && item.type !== 'show') return null;

  const sid = sectionId || String(item.librarySectionID);
  const parsed = { ...parseMediaItem(item), sectionId: sid };

  db.upsertManyItems([parsed]);
  // This is a detail payload (/library/metadata), so it carries producers/labels — persist
  // them and stamp detail_synced_at so the background backfill skips this item.
  db.updateItemDetailFields(parsed.ratingKey, { producers: parsed.producers, labels: parsed.labels });

  // Update in-memory cache in place so getLibraryItems returns the latest data
  const cached = libraryCache.get(sid);
  if (cached) {
    const idx = cached.data.findIndex(i => i.ratingKey === parsed.ratingKey);
    if (idx >= 0) cached.data[idx] = parsed;
    else cached.data.push(parsed);
  }

  // Check if this item fulfills any approved requests
  if (parsed.tmdbId) {
    try {
      const libraryTmdbIds = db.getLibraryTmdbIds();
      const fulfilled = db.getUnnotifiedFulfilledRequests(libraryTmdbIds);
      if (fulfilled.length > 0) {
        const notifiedIds = [];
        for (const req of fulfilled) {
          const prefs = db.getUserNotificationPrefs(req.user_id);
          if (prefs.notify_available) {
            const title = req.title || 'Unknown';
            const notifId = db.createOrBundleNotification({
              userId: req.user_id,
              type: 'request_available',
              title: `"${title}" is now available`,
              body: 'Your requested content has been added to the library.',
              data: { requestId: req.id, tmdbId: req.tmdb_id, mediaType: req.media_type, title },
            });
            db.enqueueNotification({
              notificationId: notifId, agent: 'discord', userId: req.user_id,
              payload: { type: 'request_available', title: `"${title}" is now available`, body: 'Your requested content has been added to the library.', posterUrl: req.poster_url },
            });
            db.enqueueNotification({
              notificationId: notifId, agent: 'pushover', userId: req.user_id,
              payload: { type: 'request_available', title: `"${title}" is now available`, body: 'Your requested content has been added to the library.', posterUrl: req.poster_url },
            });
            try {
              const failedNotifs = db.prepare(
                "SELECT id FROM notifications WHERE type = 'request_process_failed' AND (user_id = ? OR user_id IS NULL)"
              ).all(String(req.user_id));
              for (const n of failedNotifs) {
                const nData = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
                if (nData && nData.tmdbId === req.tmdb_id) {
                  db.prepare('DELETE FROM notifications WHERE id = ?').run(n.id);
                }
              }
            } catch {}
          }
          notifiedIds.push(req.id);
        }
        db.markRequestsNotifiedAvailable(notifiedIds);
        console.log(`[plex] Fulfilled ${notifiedIds.length} requests via Plex item detection`);
      }
    } catch (err) {
      console.warn('[plex] Fulfillment check failed:', err.message);
    }
  }

  return parsed;
}

async function warmCache(sectionIds = null) {
  if (sectionIds && sectionIds.length > 0) {
    await Promise.all(sectionIds.map(id => fetchSection(String(id))));
  } else {
    await Promise.all([fetchSection(getMoviesSection()), fetchSection(getTvSection())]);
  }
}

// Force a full re-sync of every library section straight from Plex (bypassing the
// cache/DB shortcut in fetchSection). syncLibrarySection prunes items Plex no longer
// has, so this reconciles deletions and rating-key changes without a restart. Sections
// run sequentially to avoid two large Plex fetches at once; each is guarded against
// overlapping with an in-flight sync.
async function resyncAllSections() {
  for (const id of [getMoviesSection(), getTvSection()]) {
    const sid = String(id);
    if (libSyncInProgress.has(sid)) continue;
    const p = syncLibrarySection(sid)
      .catch(err => console.warn(`Periodic library re-sync failed for section ${sid}: ${err.message}`))
      .finally(() => libSyncInProgress.delete(sid));
    libSyncInProgress.set(sid, p);
    await p;
  }
}

/**
 * Fetch all Plex library sections, filtered to Movie and Show types only.
 * Returns array of { id, title, type, MediaType } objects.
 */
async function getPlexSections() {
  const json = await plexFetch('/library/sections');
  const all = json.MediaContainer?.Directory || [];
  return all
    .filter(s => s.type === 'movie' || s.type === 'show')
    .map(s => ({
      id: String(s.key),
      title: s.title,
      type: s.type,
      MediaType: s.MediaType || s.type,
    }));
}

// ── Producer/Label backfill ──────────────────────────────────────────────────
// Producer and Label are not in the bulk /sections/all listing — only in the per-item
// /library/metadata detail. New items get them free via the websocket handler
// (fetchAndUpsertItem); this drains the existing backlog gradually in small throttled
// batches so it never pins Plex. Restart-safe via library_items.detail_synced_at.
let _detailBackfillRunning = false;

async function backfillItemDetails(batchSize = 50, concurrency = 3) {
  if (_detailBackfillRunning) return { processed: 0, remaining: -1 };
  _detailBackfillRunning = true;
  let processed = 0;
  try {
    const batch = db.getItemsNeedingDetailSync(batchSize);
    if (batch.length === 0) return { processed: 0, remaining: 0 };

    for (let i = 0; i < batch.length; i += concurrency) {
      const slice = batch.slice(i, i + concurrency);
      await Promise.all(slice.map(async ({ ratingKey, sectionId }) => {
        try {
          const data = await plexFetch(`/library/metadata/${ratingKey}?includeGuids=1`);
          const item = data?.MediaContainer?.Metadata?.[0];
          if (!item) {
            // Item gone from Plex — stamp it so we don't retry forever.
            db.updateItemDetailFields(ratingKey, { producers: [], labels: [] });
            return;
          }
          const parsed = parseMediaItem(item);
          db.updateItemDetailFields(ratingKey, { producers: parsed.producers, labels: parsed.labels });
          const cached = libraryCache.get(String(sectionId));
          const cachedItem = cached?.data.find(it => it.ratingKey === String(ratingKey));
          if (cachedItem) { cachedItem.producers = parsed.producers; cachedItem.labels = parsed.labels; }
          processed++;
        } catch (err) {
          console.warn(`[plex] detail backfill failed for ${ratingKey}: ${err.message}`);
        }
      }));
      // Small breather between sub-batches to stay gentle on Plex.
      await new Promise(r => setTimeout(r, 250));
    }
    const remaining = db.getItemsNeedingDetailSync(1).length;
    if (processed > 0) console.log(`[plex] detail backfill: enriched ${processed} items (${remaining ? 'more remaining' : 'backlog drained'})`);
    return { processed, remaining };
  } finally {
    _detailBackfillRunning = false;
  }
}

function invalidateCache(sectionId) {
  if (sectionId) {
    libraryCache.delete(String(sectionId));
  } else {
    libraryCache.clear();
  }
}

/**
 * Sync watched status for a user into the local DB.
 *
 * Uses two sources and takes the UNION for best coverage:
 *   Plex (admin token + accountID) — accurate viewCount for movies; fully-watched shows
 *   Tautulli per-user history       — shows where ANY episode watched; catches plays Plex misses
 *
 * Also extracts Plex star ratings for recommendation weighting.
 */
async function syncUserWatched(userId, userToken) {
  const syncKey = `watched_${userId}`;
  try {
    const safeFetch = (url, timeoutMs) =>
      fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
        .then(r => r.ok ? r.json() : { MediaContainer: {} })
        .catch(err => {
          console.warn(`syncUserWatched fetch failed (${err.message}): ${url.split('?')[0]}`);
          return { MediaContainer: {} };
        });

    // Resolve token: provided > stored in DB > admin token (last resort)
    const providedToken = userToken;
    let resolvedToken = providedToken;
    let usingAccountParam = false;

    if (!resolvedToken) {
      const storedUser = db.prepare('SELECT plex_token FROM known_users WHERE user_id = ?').get(String(userId));
      if (storedUser && storedUser.plex_token) {
        resolvedToken = storedUser.plex_token;
        console.log(`[watchedSync] Using stored token for user ${userId}`);
      } else {
        resolvedToken = getPlexToken();
        usingAccountParam = true;
        console.warn(`[watchedSync] No stored token for user ${userId}, falling back to admin token + accountID (may return global data)`);
      }
    }

    const fetchToken = resolvedToken;
    const accountParam = usingAccountParam ? `&accountID=${userId}` : '';

    // Fetch Plex + Tautulli in parallel
    const [plexMoviesJson, plexTVJson, deckJson, tautulliMovieKeys, tautulliShowKeys] = await Promise.all([
      safeFetch(`${getPlexUrl()}/library/sections/${getMoviesSection()}/all?unwatched=0${accountParam}&X-Plex-Container-Size=99999&X-Plex-Token=${fetchToken}`, 45000),
      safeFetch(`${getPlexUrl()}/library/sections/${getTvSection()}/all?unwatched=0${accountParam}&X-Plex-Container-Size=99999&X-Plex-Token=${fetchToken}`, 45000),
      safeFetch(`${getPlexUrl()}/library/onDeck?${accountParam}&X-Plex-Container-Size=9999&X-Plex-Token=${fetchToken}`, 20000),
      tautulliService.getWatchedMovieKeys(userId),
      tautulliService.getWatchedShowKeys(userId),
    ]);

    const watchedKeys = new Set();

    // Plex: fully-watched movies (viewCount > 0)
    for (const item of (plexMoviesJson.MediaContainer?.Metadata || [])) {
      watchedKeys.add(String(item.ratingKey));
    }

    // Plex: fully-watched TV shows (all episodes watched)
    for (const show of (plexTVJson.MediaContainer?.Metadata || [])) {
      watchedKeys.add(String(show.ratingKey));
    }

    // Plex: in-progress content from onDeck
    for (const item of (deckJson.MediaContainer?.Metadata || [])) {
      if (item.type === 'movie') {
        watchedKeys.add(String(item.ratingKey));
      } else if (item.grandparentRatingKey) {
        watchedKeys.add(String(item.grandparentRatingKey));
      }
    }

    // Tautulli: union in movie + show keys (catches plays Plex misses + shows with any episode watched)
    for (const k of tautulliMovieKeys) watchedKeys.add(k);
    for (const k of tautulliShowKeys) watchedKeys.add(k);

    db.replaceWatchedBatch(userId, watchedKeys);
    db.setSyncTime(syncKey);

    // Extract star ratings from Plex watched movies + TV shows for recommendation weighting
    const ratedItems = [];
    for (const item of [...(plexMoviesJson.MediaContainer?.Metadata || []), ...(plexTVJson.MediaContainer?.Metadata || [])]) {
      if (item.userRating) {
        ratedItems.push({ ratingKey: String(item.ratingKey), userRating: parseFloat(item.userRating) });
      }
    }
    if (ratedItems.length > 0) {
      db.upsertUserRatings(userId, ratedItems);
      console.log(`Stored ${ratedItems.length} user ratings for user ${userId}`);
    }

    const plexMovieCount = (plexMoviesJson.MediaContainer?.Metadata || []).length;
    const plexTVCount = (plexTVJson.MediaContainer?.Metadata || []).length;
    console.log(`Synced ${watchedKeys.size} watched items for user ${userId} (Plex movies: ${plexMovieCount}, Plex TV: ${plexTVCount}, Tautulli movies: ${tautulliMovieKeys.size}, Tautulli shows: ${tautulliShowKeys.size})`);
  } catch (err) {
    console.warn(`syncUserWatched(${userId}) error:`, err.message);
  } finally {
    watchedSyncInProgress.delete(userId);
  }
}

/**
 * Set (or clear) a user's personal Plex rating for an item.
 * Plex uses a 0–10 scale (10 = 5 stars); pass -1 to clear the rating.
 * Uses the user's own Plex token (falls back to their stored token, then the admin
 * token) so the rating is attributed to that user. Best-effort: logs and returns
 * false on failure rather than throwing.
 */
async function setUserRating(userId, ratingKey, rating, userToken = null) {
  try {
    if (!ratingKey) return false;
    let token = userToken;
    if (!token) {
      const stored = db.prepare('SELECT plex_token FROM known_users WHERE user_id = ?').get(String(userId));
      token = (stored && stored.plex_token) || getPlexToken();
    }
    if (!token) return false;
    const url = `${getPlexUrl()}/:/rate?key=${encodeURIComponent(ratingKey)}&identifier=com.plexapp.plugins.library&rating=${rating}&X-Plex-Token=${token}`;
    const res = await fetch(url, { method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      console.warn(`setUserRating(${userId}, ${ratingKey}, ${rating}) failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`setUserRating(${userId}, ${ratingKey}) error:`, err.message);
    return false;
  }
}

/**
 * Get watched keys from DB for a user.
 * Triggers a background sync if data is stale (>30 min) or missing.
 * Returns whatever is in DB immediately — never blocks recommendations.
 */
async function getWatchedKeys(userId, userToken) {
  const syncKey = `watched_${userId}`;
  const lastSync = db.getSyncTime(syncKey);
  const age = Math.floor(Date.now() / 1000) - lastSync;
  const hasData = lastSync > 0;

  if (!hasData) {
    // First time for this user — sync now and wait (first request only)
    if (!watchedSyncInProgress.has(userId)) {
      const p = syncUserWatched(userId, userToken);
      watchedSyncInProgress.set(userId, p);
      await p;
    } else {
      await watchedSyncInProgress.get(userId);
    }
  } else if (age > WATCHED_SYNC_TTL) {
    // Stale — return current DB data immediately, refresh in background
    if (!watchedSyncInProgress.has(userId)) {
      const p = syncUserWatched(userId, userToken);
      watchedSyncInProgress.set(userId, p);
      // Don't await — let it run in background
    }
  }

  return db.getWatchedKeysFromDb(userId);
}

// Build a lookup map by ratingKey for fast scoring
async function getLibraryMap() {
  const [movies, tv] = await Promise.all([
    getLibraryItems(getMoviesSection()),
    getLibraryItems(getTvSection()),
  ]);
  const map = new Map();
  for (const item of [...movies, ...tv]) {
    map.set(item.ratingKey, item);
  }
  return map;
}

// Watchlist / Playlist management
// Always uses local Plex URL — the server validates Friend tokens against plex.tv locally.
// Relay URLs are for external clients reaching the server, not server-to-server calls.
async function getDiskovarrPlaylist(userToken) {
  const base = getPlexUrl();
  try {
    const res = await fetch(`${base}/playlists/all?playlistType=video&X-Plex-Token=${userToken}`, {
      headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Plex API error ${res.status}`);
    const json = await res.json();

    const playlists = json.MediaContainer?.Metadata || [];
    const playlist = playlists.find(p => p.title === 'Diskovarr');
    if (!playlist) return null;

    const itemsRes = await fetch(`${base}/playlists/${playlist.ratingKey}/items?X-Plex-Token=${userToken}`, {
      headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
      signal: AbortSignal.timeout(15000),
    });
    if (!itemsRes.ok) throw new Error(`Plex API error ${itemsRes.status}`);
    const itemsJson = await itemsRes.json();
    const items = (itemsJson.MediaContainer?.Metadata || []).map(i => ({
      ratingKey: String(i.ratingKey),
      playlistItemId: String(i.playlistItemID ?? i.playlistItemId),
    }));

    return {
      playlistId: String(playlist.ratingKey),
      items,
    };
  } catch (err) {
    console.warn('getDiskovarrPlaylist error:', err.message);
    return null;
  }
}

async function getWatchlist(userToken) {
  const playlist = await getDiskovarrPlaylist(userToken);
  return playlist || { playlistId: null, items: [] };
}

/**
 * For TV shows, return the ratingKey of the first episode (S01E01).
 * This keeps the Plex playlist clean — watching the episode puts the show
 * into Continue Watching rather than flooding the playlist with all episodes.
 */
async function resolvePlaylistKey(ratingKey) {
  const item = db.getLibraryItemByKey(ratingKey);
  if (!item || item.type !== 'show') return ratingKey;

  try {
    const res = await fetch(
      `${getPlexUrl()}/library/metadata/${ratingKey}/allLeaves?X-Plex-Container-Start=0&X-Plex-Container-Size=1&X-Plex-Token=${getPlexToken()}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return ratingKey;
    const json = await res.json();
    const first = json.MediaContainer?.Metadata?.[0];
    return first ? String(first.ratingKey) : ratingKey;
  } catch {
    return ratingKey;
  }
}

async function addToWatchlist(userToken, ratingKey) {
  const base = getPlexUrl();
  const existing = await getDiskovarrPlaylist(userToken);
  // For shows, use first episode so Plex doesn't expand the entire series
  const playlistKey = await resolvePlaylistKey(ratingKey);
  const uri = `server://${getPlexServerId()}/com.plexapp.plugins.library/library/metadata/${playlistKey}`;

  if (!existing) {
    const createUrl = `${base}/playlists?type=video&title=Diskovarr&smart=0&uri=${encodeURIComponent(uri)}&X-Plex-Token=${userToken}`;
    const res = await fetch(createUrl, {
      method: 'POST',
      headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Failed to create playlist: ${res.status}`);
    return res.json();
  }

  const putUrl = `${base}/playlists/${existing.playlistId}/items?uri=${encodeURIComponent(uri)}&X-Plex-Token=${userToken}`;
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Failed to add to playlist: ${res.status}`);
  return res.json();
}

async function removeFromWatchlist(userToken, playlistId, playlistItemId) {
  const base = getPlexUrl();
  const url = `${base}/playlists/${playlistId}/items/${playlistItemId}?X-Plex-Token=${userToken}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Failed to remove from playlist: ${res.status}`);
  return true;
}

/**
 * Fetch Plex's /related hubs for a library item.
 * Returns an array of { context, title, items: [{ ratingKey, tmdbId, title, year, type }] }
 * Useful contexts: hub.movie.same.director, hub.movie.same.actor, hub.tv.same.director, etc.
 */
async function getRelated(ratingKey) {
  try {
    const url = `${getPlexUrl()}/library/metadata/${ratingKey}/related?X-Plex-Token=${getPlexToken()}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...PLEX_HEADERS },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const hubs = json.MediaContainer?.Hub || [];
    return hubs.map(hub => ({
      context: hub.context || '',
      title: hub.title || '',
      items: (hub.Metadata || []).map(m => ({
        ratingKey: m.ratingKey,
        title: m.title || m.name,
        year: m.year || null,
        type: m.type,
      })),
    }));
  } catch (err) {
    console.warn('[plex] getRelated error:', err.message);
    return [];
  }
}

function getDeepLink(ratingKey) {
  return `https://app.plex.tv/desktop#!/server/${getPlexServerId()}/details?key=/library/metadata/${ratingKey}`;
}

// Returns a plex:// URI that triggers the native Plex app to open the item.
// Key is fully URL-encoded so plex://preplay can parse it correctly.
function getAppLink(ratingKey) {
  const key = encodeURIComponent('/library/metadata/' + ratingKey);
  return `plex://preplay?server=${getPlexServerId()}&key=${key}`;
}

/**
 * Fetch the plex:// GUID for a server item (e.g. "plex://movie/5d7768ba...").
 * Returns the hash portion needed for plex.tv Watchlist API calls.
 */
async function getPlexGuid(ratingKey) {
  try {
    const res = await fetch(`${getPlexUrl()}/library/metadata/${ratingKey}?X-Plex-Token=${getPlexToken()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const item = json.MediaContainer?.Metadata?.[0];
    const guid = item?.guid || '';
    // guid looks like "plex://movie/5d7768ba96b655001fdc0b35" — extract hash
    const hash = guid.split('/').pop();
    return hash || null;
  } catch (err) {
    console.warn('[plexGuid] fetch error:', err.message);
    return null;
  }
}

/**
 * Add an item to the user's plex.tv Watchlist (Discover → Watchlist in Plex app).
 * Uses plex.tv metadata API — works for all users including Friends.
 * Returns the plex GUID so it can be stored for later removal.
 */
async function addToPlexTvWatchlist(userToken, ratingKey) {
  const guid = await getPlexGuid(ratingKey);
  if (!guid) throw new Error('Could not resolve plex GUID for ratingKey ' + ratingKey);
  return addToPlexTvWatchlistByGuid(userToken, guid);
}

/**
 * Add an item to the user's plex.tv Watchlist using a plex GUID hash directly.
 * Used for non-library items (discover recommendations) where the GUID is already known
 * from the discover search API response.
 */
async function addToPlexTvWatchlistByGuid(userToken, guid) {
  const res = await fetch(`https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=${guid}&X-Plex-Token=${userToken}`, {
    method: 'PUT',
    headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Plex.tv watchlist add failed: ${res.status}`);
  return guid;
}

/**
 * Remove an item from the user's plex.tv Watchlist.
 */
async function removeFromPlexTvWatchlist(userToken, plexGuid) {
  if (!plexGuid) throw new Error('No plex GUID stored for this item');
  const res = await fetch(`https://discover.provider.plex.tv/actions/removeFromWatchlist?ratingKey=${plexGuid}&X-Plex-Token=${userToken}`, {
    method: 'PUT',
    headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Plex.tv watchlist remove failed: ${res.status}`);
  return true;
}

// Don't reconcile away items added within this window — gives the async plex.tv push
// (api.js POST /watchlist/add) time to land before we treat plex.tv as the source of truth.
const WATCHLIST_GRACE_SECONDS = 5 * 60;

async function syncPlexTvWatchlist(userId, userToken) {
  // 1. Collect all watchlist ratingKeys from discover.provider.plex.tv.
  //    Track fetchFailed so a network/HTTP error never looks like an empty watchlist —
  //    that distinction is what keeps the remove pass from wiping the DB on a transient error.
  const plexKeys = [];
  let offset = 0;
  const size = 100;
  let fetchFailed = false;

  while (true) {
    let res;
    try {
      res = await fetch(
        `https://discover.provider.plex.tv/library/sections/watchlist/all?X-Plex-Token=${userToken}&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${size}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
      );
    } catch (err) {
      console.warn(`[watchlist] Watchlist fetch failed for user ${userId}:`, err.message);
      fetchFailed = true;
      break;
    }
    if (!res.ok) { fetchFailed = true; break; }
    const data = await res.json();
    const items = data?.MediaContainer?.Metadata || [];
    if (!items.length) break;
    for (const item of items) {
      if (item.ratingKey) plexKeys.push(item.ratingKey);
    }
    offset += items.length;
    if (items.length < size) break;
  }

  // Couldn't reliably read the watchlist — do nothing rather than risk false removals.
  if (fetchFailed) {
    console.warn(`[watchlist] Skipping sync for user ${userId} (incomplete watchlist fetch)`);
    return 0;
  }

  // 2. Batch-fetch full metadata from metadata.provider.plex.tv to resolve TMDB IDs, then
  //    map each to a local-library rating_key. keepKeys is the set we mirror the DB against.
  //    metaFailed guards the remove pass: an incomplete map must not delete real entries.
  const BATCH = 50;
  const keepKeys = new Set();
  let metaFailed = false;

  for (let i = 0; i < plexKeys.length; i += BATCH) {
    const batch = plexKeys.slice(i, i + BATCH);
    try {
      const metaRes = await fetch(
        `https://metadata.provider.plex.tv/library/metadata/${batch.join(',')}?X-Plex-Token=${userToken}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
      );
      if (!metaRes.ok) { metaFailed = true; continue; }
      const metaData = await metaRes.json();
      const metaItems = metaData?.MediaContainer?.Metadata || [];

      for (const item of metaItems) {
        const guids = item.Guid || [];
        const tmdbGuid = guids.find(g => g.id?.startsWith('tmdb://'));
        if (!tmdbGuid) continue;
        const tmdbId = tmdbGuid.id.replace('tmdb://', '');
        const libItem = db.getLibraryItemByTmdbId(tmdbId);
        if (libItem) keepKeys.add(String(libItem.rating_key));
      }
    } catch (err) {
      metaFailed = true;
      console.warn(`[watchlist] Metadata batch fetch failed:`, err.message);
    }
  }

  // 3. ADD pass — ensure everything currently on the plex.tv watchlist is in the DB.
  for (const key of keepKeys) {
    db.addToWatchlistDb(userId, key);
  }

  // 4. REMOVE pass — mirror plex.tv: drop local rows no longer on the watchlist.
  //    Skipped when the metadata map is incomplete (could under-count keepKeys), or for the
  //    owner in playlist mode (their manual adds live in a local playlist, not plex.tv).
  const playlistMode = userId === db.getOwnerUserId() && db.getAdminWatchlistMode() === 'playlist';
  let removed = 0;
  let removeSkipped = false;
  if (metaFailed || playlistMode) {
    removeSkipped = true;
  } else {
    const cutoff = Math.floor(Date.now() / 1000) - WATCHLIST_GRACE_SECONDS;
    for (const row of db.getWatchlistRows(userId)) {
      if (keepKeys.has(String(row.rating_key))) continue;
      if ((row.added_at || 0) > cutoff) continue; // within grace window — leave it alone
      db.removeFromWatchlistDb(userId, row.rating_key);
      removed++;
    }
  }

  console.log(
    `[watchlist] User ${userId}: ${keepKeys.size} in plex.tv watchlist, -${removed} removed` +
    (removeSkipped ? ' (removal skipped)' : '')
  );
  return keepKeys.size;
}

async function syncAllUserWatchlists() {
  const users = db.getAllKnownUsersWithTokens();
  for (const { user_id, plex_token } of users) {
    try {
      await syncPlexTvWatchlist(user_id, plex_token);
    } catch (err) {
      console.warn(`[watchlist] Sync failed for user ${user_id}:`, err.message);
    }
  }
}

module.exports = {
  get MOVIES_SECTION() { return getMoviesSection(); },
  get TV_SECTION()     { return getTvSection(); },
  getLibraryItems,
  getLibraryMap,
  getWatchedKeys,
  syncUserWatched,
  setUserRating,
  syncLibrarySection,
  backfillItemDetails,
  warmCache,
  resyncAllSections,
  getPlexSections,
  invalidateCache,
  fetchAndUpsertItem,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  addToPlexTvWatchlist,
  addToPlexTvWatchlistByGuid,
  removeFromPlexTvWatchlist,
  resolvePlaylistKey,
  getRelated,
  getDeepLink,
  syncPlexTvWatchlist,
  syncAllUserWatchlists,
  getAppLink,
  getPlexUrl,
  getPlexToken,
  getPlexServerId,
  startWebSocket,
};

// ── Plex SSE — real-time new-content detection ───────────────────────────────
// Connects to PMS /:/eventsource/notifications (Server-Sent Events), the same
// endpoint Tautulli uses. Fires onNewItem for fully-analyzed items (state 5).
function startWebSocket(onNewItem) {
  const logger = require('./logger');
  let dead = false;
  let abortCtrl = null;

  async function connect() {
    if (dead) return;
    const plexUrl   = getPlexUrl();
    const plexToken = getPlexToken();
    if (!plexUrl || !plexToken) {
      logger.warn('[plex sse] Plex URL or token not configured — skipping');
      return;
    }
    const sseUrl = `${plexUrl}/:/eventsource/notifications?X-Plex-Token=${plexToken}`;
    abortCtrl = new AbortController();
    try {
      const res = await fetch(sseUrl, { signal: abortCtrl.signal });
      if (!res.ok) {
        logger.warn(`[plex sse] HTTP ${res.status} — retrying in 30 s`);
        if (!dead) setTimeout(connect, 30000);
        return;
      }
      logger.info('[plex sse] Connected to Plex notification stream');
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        if (dead) break;
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          // The eventsource endpoint carries the notification type in the SSE
          // `event:` line and a bare container object in `data:` — unlike the
          // websocket endpoint (Tautulli), which wraps it in NotificationContainer.
          if (line.startsWith('event:')) continue;
          if (!line.startsWith('data:')) continue;
          try {
            const msg = JSON.parse(line.slice(5).trim());
            const container = msg.NotificationContainer || msg; // handle both shapes
            const entries = container.TimelineEntry;
            if (!Array.isArray(entries)) continue;              // not a timeline event
            for (const entry of entries) {
              if (entry.identifier !== 'com.plexapp.plugins.library') continue;
              if (entry.state !== 5) continue;
              const ratingKey = String(entry.itemID || '');
              const sectionId = String(entry.sectionID || entry.librarySectionID || '');
              if (!ratingKey) continue;
              logger.info(`[plex sse] library.new ratingKey=${ratingKey} type=${entry.type} title="${entry.title || ''}"`);
              onNewItem(ratingKey, sectionId);
            }
          } catch { /* ignore malformed lines */ }
        }
      }
    } catch (err) {
      if (dead) return;
      logger.warn('[plex sse] Stream error:', err.message);
    }
    if (!dead) {
      logger.info('[plex sse] Disconnected — reconnecting in 30 s');
      setTimeout(connect, 30000);
    }
  }

  connect();

  return { close: () => { dead = true; try { abortCtrl?.abort(); } catch {} } };
}
