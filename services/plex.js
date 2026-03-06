const db = require('../db/database');

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_SERVER_ID = process.env.PLEX_SERVER_ID;
const MOVIES_SECTION = process.env.PLEX_MOVIES_SECTION_ID || '1';
const TV_SECTION = process.env.PLEX_TV_SECTION_ID || '2';

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
  'X-Plex-Token': PLEX_TOKEN,
};

async function plexFetch(path, token) {
  const url = `${PLEX_URL}${path}`;
  const headers = { ...PLEX_HEADERS };
  if (token && token !== PLEX_TOKEN) {
    headers['X-Plex-Token'] = token;
  }
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
  return {
    ratingKey: String(video.ratingKey),
    title: video.title,
    year,
    thumb: video.thumb || null,
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
    `/library/sections/${sectionId}/all?X-Plex-Container-Size=99999&X-Plex-Token=${PLEX_TOKEN}`
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
  await Promise.all([fetchSection(MOVIES_SECTION), fetchSection(TV_SECTION)]);
}

function invalidateCache(sectionId) {
  if (sectionId) {
    libraryCache.delete(String(sectionId));
  } else {
    libraryCache.clear();
  }
}

/**
 * Sync watched status for a user from Plex into the local DB.
 * Uses `unwatched=0` (fast, small result) + onDeck for in-progress.
 * This runs in the background — callers always get data from DB.
 */
async function syncUserWatched(userId, userToken) {
  const syncKey = `watched_${userId}`;
  try {
    // Use admin token + accountID to query user-specific watch data.
    // The user's own token may return 401 on direct server library endpoints
    // (common with Plex Friends who authenticate via plex.tv but aren't managed users).
    const accountParam = `&accountID=${userId}`;
    const adminToken = PLEX_TOKEN;

    // Helper: fetch with timeout, never rejects — returns empty on any failure
    const safeFetch = (url, timeoutMs) =>
      fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
        .then(r => r.ok ? r.json() : { MediaContainer: {} })
        .catch(err => {
          console.warn(`syncUserWatched fetch failed (${err.message}): ${url.split('?')[0]}`);
          return { MediaContainer: {} };
        });

    const [moviesJson, tvWatchedJson, deckJson] = await Promise.all([
      safeFetch(`${PLEX_URL}/library/sections/${MOVIES_SECTION}/all?unwatched=0${accountParam}&X-Plex-Container-Size=99999&X-Plex-Token=${adminToken}`, 45000),
      safeFetch(`${PLEX_URL}/library/sections/${TV_SECTION}/all?unwatched=0${accountParam}&X-Plex-Container-Size=99999&X-Plex-Token=${adminToken}`, 45000),
      safeFetch(`${PLEX_URL}/library/onDeck?${accountParam}&X-Plex-Container-Size=9999&X-Plex-Token=${adminToken}`, 20000),
    ]);

    const watchedKeys = new Set();

    // Fully-watched movies
    for (const item of (moviesJson.MediaContainer?.Metadata || [])) {
      watchedKeys.add(String(item.ratingKey));
    }

    // Fully-watched TV shows
    for (const show of (tvWatchedJson.MediaContainer?.Metadata || [])) {
      watchedKeys.add(String(show.ratingKey));
    }

    // In-progress content from global on-deck
    for (const item of (deckJson.MediaContainer?.Metadata || [])) {
      if (item.type === 'movie') {
        // Started but not finished movie — exclude from recommendations
        watchedKeys.add(String(item.ratingKey));
      } else if (item.grandparentRatingKey) {
        // In-progress episode — mark the parent show as seen
        watchedKeys.add(String(item.grandparentRatingKey));
      }
    }

    db.replaceWatchedBatch(userId, watchedKeys);
    db.setSyncTime(syncKey);

    // Extract and store any user star ratings from watched movies
    const ratedItems = [];
    for (const item of (moviesJson.MediaContainer?.Metadata || [])) {
      if (item.userRating) {
        ratedItems.push({ ratingKey: String(item.ratingKey), userRating: parseFloat(item.userRating) });
      }
    }
    if (ratedItems.length > 0) {
      db.upsertUserRatings(userId, ratedItems);
      console.log(`Stored ${ratedItems.length} user ratings for user ${userId}`);
    }

    console.log(`Synced ${watchedKeys.size} watched items for user ${userId} (movies: ${(moviesJson.MediaContainer?.Metadata || []).length}, tv shows: ${(tvWatchedJson.MediaContainer?.Metadata || []).length}, on-deck: ${(deckJson.MediaContainer?.Metadata || []).length})`);
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
    getLibraryItems(MOVIES_SECTION),
    getLibraryItems(TV_SECTION),
  ]);
  const map = new Map();
  for (const item of [...movies, ...tv]) {
    map.set(item.ratingKey, item);
  }
  return map;
}

// Watchlist / Playlist management
async function getDiskovarrPlaylist(userToken) {
  try {
    const json = await plexFetch(
      `/playlists/all?playlistType=video&X-Plex-Token=${userToken}`,
      userToken
    );
    const playlists = json.MediaContainer?.Metadata || [];
    const playlist = playlists.find(p => p.title === 'Diskovarr');
    if (!playlist) return null;

    const itemsJson = await plexFetch(
      `/playlists/${playlist.ratingKey}/items?X-Plex-Token=${userToken}`,
      userToken
    );
    const items = (itemsJson.MediaContainer?.Metadata || []).map(i => ({
      ratingKey: String(i.ratingKey),
      playlistItemId: String(i.playlistItemId),
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

async function addToWatchlist(userToken, ratingKey) {
  const existing = await getDiskovarrPlaylist(userToken);
  const uri = `server://${PLEX_SERVER_ID}/com.plexapp.plugins.library/library/metadata/${ratingKey}`;

  if (!existing) {
    // Create new playlist
    const createUrl = `${PLEX_URL}/playlists?type=video&title=Diskovarr&smart=0&uri=${encodeURIComponent(uri)}&X-Plex-Token=${userToken}`;
    const res = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Failed to create playlist: ${res.status}`);
    return res.json();
  }

  // Add to existing playlist
  const putUrl = `${PLEX_URL}/playlists/${existing.playlistId}/items?uri=${encodeURIComponent(uri)}&X-Plex-Token=${userToken}`;
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Failed to add to playlist: ${res.status}`);
  return res.json();
}

async function removeFromWatchlist(userToken, playlistId, playlistItemId) {
  const url = `${PLEX_URL}/playlists/${playlistId}/items/${playlistItemId}?X-Plex-Token=${userToken}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Failed to remove from playlist: ${res.status}`);
  return true;
}

function getDeepLink(ratingKey) {
  return `https://app.plex.tv/desktop#!/server/${PLEX_SERVER_ID}/details?key=/library/metadata/${ratingKey}`;
}

module.exports = {
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
  getDeepLink,
  PLEX_URL,
  PLEX_TOKEN,
  MOVIES_SECTION,
  TV_SECTION,
};
