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

function parseMediaItem(video) {
  const genres = (video.Genre || []).map(g => g.tag);
  const directors = (video.Director || []).map(d => d.tag);
  const cast = (video.Role || []).slice(0, 10).map(r => r.tag);
  const year = video.year || parseInt((video.originallyAvailableAt || '').slice(0, 4)) || 0;
  // Extract TMDB ID from Guid array (present when includeGuids=1 is passed)
  const guids = video.Guid || [];
  const tmdbGuid = guids.find(g => g.id && g.id.startsWith('tmdb://'));
  const tmdbId = tmdbGuid ? tmdbGuid.id.replace('tmdb://', '') : null;
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
  };
}

async function fetchSection(sectionId) {
  const cached = libraryCache.get(sectionId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  // Try DB first — use it if synced recently enough
  const dbSyncTime = db.getSyncTime(`library_${sectionId}`);
  const dbAge = Math.floor(Date.now() / 1000) - dbSyncTime;
  if (dbSyncTime > 0 && dbAge < 7200) {
    const items = db.getLibraryItemsFromDb(sectionId);
    if (items.length > 0) {
      libraryCache.set(sectionId, { data: items, fetchedAt: Date.now() });
      console.log(`Loaded ${items.length} items for section ${sectionId} from DB (age: ${Math.round(dbAge/60)}m)`);
      return items;
    }
  }

  // Deduplicate concurrent syncs — only one fetch per sectionId at a time
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
  db.setSyncTime(`library_${sectionId}`);

  // Update in-memory cache
  libraryCache.set(sectionId, { data: items, fetchedAt: Date.now() });
  console.log(`Synced ${items.length} items for section ${sectionId} to DB`);
  return items;
}

async function getLibraryItems(sectionId) {
  return fetchSection(String(sectionId));
}

async function warmCache() {
  await Promise.all([fetchSection(getMoviesSection()), fetchSection(getTvSection())]);
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

    const accountParam = `&accountID=${userId}`;

    // Fetch Plex + Tautulli in parallel
    const [plexMoviesJson, plexTVJson, deckJson, tautulliMovieKeys, tautulliShowKeys] = await Promise.all([
      safeFetch(`${getPlexUrl()}/library/sections/${getMoviesSection()}/all?unwatched=0${accountParam}&X-Plex-Container-Size=99999&X-Plex-Token=${getPlexToken()}`, 45000),
      safeFetch(`${getPlexUrl()}/library/sections/${getTvSection()}/all?unwatched=0${accountParam}&X-Plex-Container-Size=99999&X-Plex-Token=${getPlexToken()}`, 45000),
      safeFetch(`${getPlexUrl()}/library/onDeck?${accountParam}&X-Plex-Container-Size=9999&X-Plex-Token=${getPlexToken()}`, 20000),
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

module.exports = {
  get MOVIES_SECTION() { return getMoviesSection(); },
  get TV_SECTION()     { return getTvSection(); },
  getLibraryItems,
  getLibraryMap,
  getWatchedKeys,
  syncUserWatched,
  syncLibrarySection,
  warmCache,
  invalidateCache,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  addToPlexTvWatchlist,
  addToPlexTvWatchlistByGuid,
  removeFromPlexTvWatchlist,
  resolvePlaylistKey,
  getRelated,
  getDeepLink,
  getAppLink,
  getPlexUrl,
  getPlexToken,
  getPlexServerId,
};
