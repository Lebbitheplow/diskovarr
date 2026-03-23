const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discordAgent = require('../services/discordAgent');
const pushoverAgent = require('../services/pushoverAgent');
const discoverRecommender = require('../services/discoverRecommender');
const tmdbService = require('../services/tmdb');
const overseerrService = require('../services/overseerr');
const db = require('../db/database');
const logger = require('../services/logger');

router.use(requireAuth);

// Resolve a publicly-accessible TMDB poster URL from a Plex rating key.
// Plex thumb paths (/library/metadata/.../thumb) require auth and can't be used
// in Discord embeds. Tries the TMDB cache first; falls back to a live fetch.
async function getPublicPosterUrl(ratingKey) {
  const item = db.getLibraryItemByKey(ratingKey);
  if (!item?.tmdbId) return null;
  const mediaType = item.type === 'show' ? 'tv' : 'movie';
  const cached = db.getTmdbCache(item.tmdbId, mediaType);
  if (cached?.posterUrl) return cached.posterUrl;
  // Cache miss — fetch from TMDB (also populates cache for future calls)
  try {
    const details = await tmdbService.getItemDetails(item.tmdbId, mediaType);
    return details?.posterUrl || null;
  } catch {
    return null;
  }
}

// GET /api/trailer?tmdbId=X&mediaType=movie|tv
// Lazy-fetches and caches trailer key from TMDB. Works for both library and explore items.
router.get('/trailer', async (req, res) => {
  const { tmdbId, mediaType } = req.query;
  if (!tmdbId || !['movie', 'tv'].includes(mediaType)) return res.json({ trailerKey: null });
  try {
    // Check existing DB cache first
    const cached = db.getTmdbCache(tmdbId, mediaType);
    if (cached && cached.trailerKey !== undefined) return res.json({ trailerKey: cached.trailerKey });

    // Fetch just the videos endpoint to get trailer key without re-fetching full details
    const json = await tmdbService.tmdbFetchPublic(`/${mediaType}/${tmdbId}/videos`);
    const trailerKey = (json?.results || [])
      .filter(v => v.site === 'YouTube' && v.type === 'Trailer')
      .sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0))[0]?.key || null;

    // Patch the cache entry if it exists so future calls are instant
    if (cached) {
      cached.trailerKey = trailerKey;
      db.setTmdbCache(tmdbId, mediaType, cached);
    }
    res.json({ trailerKey });
  } catch {
    res.json({ trailerKey: null });
  }
});

// GET /api/recommendations
router.get('/recommendations', async (req, res) => {
  try {
    const { id: userId, token: userToken } = req.session.plexUser;
    const data = await recommender.getRecommendations(userId, userToken);
    // Attach deepLink to every item so the client can open them in Plex
    const addDeepLinks = items => items.map(item => ({
      ...item,
      deepLink: item.ratingKey ? plexService.getDeepLink(item.ratingKey) : null,
      plexAppLink: item.ratingKey ? plexService.getAppLink(item.ratingKey) : null,
    }));
    res.json({
      ...data,
      topPicks: addDeepLinks(data.topPicks || []),
      movies:   addDeepLinks(data.movies   || []),
      tvShows:  addDeepLinks(data.tvShows  || []),
      anime:    addDeepLinks(data.anime    || []),
    });
  } catch (err) {
    logger.error('recommendations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// GET /api/poster?path=/library/metadata/...
// Proxies Plex poster through server — browser never sees Plex token
router.get('/poster', async (req, res) => {
  const { path: posterPath } = req.query;

  // Security: only allow /library/ paths to prevent SSRF
  if (!posterPath || !posterPath.startsWith('/library/')) {
    return res.status(400).json({ error: 'Invalid poster path' });
  }

  try {
    const url = `${plexService.getPlexUrl()}${posterPath}?X-Plex-Token=${plexService.getPlexToken()}`;
    const imgRes = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) {
      return res.status(imgRes.status).send('Poster not found');
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const buffer = await imgRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('poster proxy error:', err);
    res.status(500).send('Failed to fetch poster');
  }
});

// GET /api/watchlist
router.get('/watchlist', (req, res) => {
  const { id: userId } = req.session.plexUser;
  const keys = db.getWatchlistFromDb(userId);
  const watchedKeys = db.getWatchedKeysFromDb(userId);
  const items = keys.map(k => ({
    ratingKey: k,
    isWatched: watchedKeys.has(String(k)),
  }));
  res.json({ items });
});

// POST /api/watchlist/add
router.post('/watchlist/add', (req, res) => {
  const { ratingKey } = req.body;
  if (!ratingKey) return res.status(400).json({ error: 'ratingKey required' });
  if (!/^\d+$/.test(String(ratingKey))) return res.status(400).json({ error: 'Invalid ratingKey' });

  const { id: userId, token: userToken, serverToken } = req.session.plexUser;
  const isOwner = userId === db.getOwnerUserId();
  const usePlaylist = isOwner && db.getAdminWatchlistMode() === 'playlist';
  db.addToWatchlistDb(userId, ratingKey);
  res.json({ success: true });

  if (usePlaylist) {
    // Admin: sync to server playlist (needed for pd_zurg watchlist monitoring)
    const plexToken = serverToken || userToken;
    plexService.addToWatchlist(plexToken, String(ratingKey))
      .then(() => Promise.all([
        plexService.getWatchlist(plexToken),
        plexService.resolvePlaylistKey(String(ratingKey)),
      ]))
      .then(([playlist, playlistKey]) => {
        if (!playlist.playlistId) return;
        const item = playlist.items.find(i => i.ratingKey === playlistKey);
        if (item) db.updateWatchlistPlexIds(userId, ratingKey, playlist.playlistId, item.playlistItemId);
        console.log(`Plex playlist synced for user ${userId}: added ratingKey ${ratingKey}`);
      })
      .catch(err => console.warn(`Plex playlist add failed for user ${userId}:`, err.message));
  } else {
    // All other users (and admin in watchlist mode): add to plex.tv Watchlist
    plexService.addToPlexTvWatchlist(userToken, String(ratingKey))
      .then(guid => {
        db.updateWatchlistPlexGuid(userId, ratingKey, guid);
        console.log(`Plex.tv watchlist synced for user ${userId}: added ratingKey ${ratingKey} (guid ${guid})`);
      })
      .catch(err => console.warn(`Plex.tv watchlist add failed for user ${userId}:`, err.message));
  }
});

// POST /api/watchlist/remove
router.post('/watchlist/remove', (req, res) => {
  const { ratingKey } = req.body;
  if (!ratingKey) return res.status(400).json({ error: 'ratingKey required' });
  if (!/^\d+$/.test(String(ratingKey))) return res.status(400).json({ error: 'Invalid ratingKey' });

  const { id: userId, token: userToken, serverToken } = req.session.plexUser;
  const isOwner = userId === db.getOwnerUserId();
  const usePlaylist = isOwner && db.getAdminWatchlistMode() === 'playlist';
  // Read Plex IDs before deleting the row
  const plexIds = db.getWatchlistPlexIds(userId, ratingKey);
  db.removeFromWatchlistDb(userId, ratingKey);
  res.json({ success: true });

  if (usePlaylist) {
    // Admin: remove from server playlist
    const plexToken = serverToken || userToken;
    if (plexIds?.plex_playlist_id && plexIds?.plex_item_id) {
      plexService.removeFromWatchlist(plexToken, plexIds.plex_playlist_id, plexIds.plex_item_id)
        .catch(err => console.warn(`Plex playlist remove failed for user ${userId}:`, err.message));
    } else {
      Promise.all([
        plexService.getWatchlist(plexToken),
        plexService.resolvePlaylistKey(String(ratingKey)),
      ])
        .then(([playlist, playlistKey]) => {
          if (!playlist.playlistId) return;
          const item = playlist.items.find(i => i.ratingKey === playlistKey);
          if (item) return plexService.removeFromWatchlist(plexToken, playlist.playlistId, item.playlistItemId);
        })
        .catch(err => console.warn(`Plex playlist remove failed for user ${userId}:`, err.message));
    }
  } else {
    // All other users (and admin in watchlist mode): remove from plex.tv Watchlist using stored guid
    plexService.removeFromPlexTvWatchlist(userToken, plexIds?.plex_guid)
      .catch(err => console.warn(`Plex.tv watchlist remove failed for user ${userId}:`, err.message));
  }
});

// GET /api/discover — filtered library browse
// Query: type (movie|show|anime|all), genres (comma list), decade, minRating, sort, page
router.get('/discover', async (req, res) => {
  try {
    const { id: userId, token: userToken } = req.session.plexUser;
    const {
      type = 'all',
      genres = '',
      decade = '',
      minRating = '0',
      sort = 'recommended',
      page = '1',
      q = '',
    } = req.query;

    const PAGE_SIZE = 40;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const minRatingNum = parseFloat(minRating) || 0;
    const genreList = genres ? genres.split(',').map(g => g.trim().toLowerCase()).filter(Boolean) : [];
    const searchQuery = q.trim().toLowerCase();

    const [movies, tv, dismissedKeys] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
      Promise.resolve(db.getDismissals(userId)),
    ]);
    const watchedKeys = db.getWatchedKeysFromDb(String(userId));

    // Categorise TV
    const animeItems = tv.filter(i => i.genres.some(g => g.toLowerCase() === 'anime'));
    const tvOnlyItems = tv.filter(i => !i.genres.some(g => g.toLowerCase() === 'anime'));

    let pool = [];
    if (type === 'movie') pool = movies;
    else if (type === 'show') pool = tvOnlyItems;
    else if (type === 'anime') pool = animeItems;
    else pool = [...movies, ...tvOnlyItems, ...animeItems];

    // Apply filters
    let filtered = pool.filter(item => {
      if (dismissedKeys.has(item.ratingKey)) return false;
      if (searchQuery && !item.title.toLowerCase().includes(searchQuery)) return false;
      if (item.audienceRating < minRatingNum) return false;
      if (genreList.length > 0) {
        const itemGenres = item.genres.map(g => g.toLowerCase());
        if (!genreList.some(g => itemGenres.includes(g))) return false;
      }
      if (decade) {
        const d = parseInt(decade);
        if (!item.year || Math.floor(item.year / 10) * 10 !== d) return false;
      }
      return true;
    });

    // Sort
    if (sort === 'rating') {
      filtered.sort((a, b) => b.audienceRating - a.audienceRating);
    } else if (sort === 'year_desc') {
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sort === 'year_asc') {
      filtered.sort((a, b) => (a.year || 0) - (b.year || 0));
    } else if (sort === 'added') {
      filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else if (sort === 'title') {
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      // 'recommended' — sort by audience rating as proxy when no personal profile applied
      filtered.sort((a, b) => b.audienceRating - a.audienceRating);
    }

    const total = filtered.length;
    const items = filtered.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE);

    // Get all available genres from the pool for the filter UI
    const allGenres = [...new Set(pool.flatMap(i => i.genres))].sort();

    // Attach watchlist and watched status from local DB (no Plex API needed)
    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));

    const itemsWithWatchlist = items.map(item => ({
      ...item,
      deepLink: plexService.getDeepLink(item.ratingKey),
      plexAppLink: plexService.getAppLink(item.ratingKey),
      isInWatchlist: watchlistKeys.has(item.ratingKey),
      isWatched: watchedKeys.has(item.ratingKey),
    }));

    res.json({
      items: itemsWithWatchlist,
      total,
      page: pageNum,
      pages: Math.ceil(total / PAGE_SIZE),
      availableGenres: allGenres,
    });
  } catch (err) {
    console.error('discover error:', err);
    res.status(500).json({ error: 'Failed to fetch discover results' });
  }
});

// GET /api/discover/genres — all unique genres in library
router.get('/discover/genres', async (req, res) => {
  try {
    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);
    const genres = [...new Set([...movies, ...tv].flatMap(i => i.genres))].sort();
    res.json({ genres });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

// GET /api/clients — list Plex player clients for the logged-in user
// Uses plex.tv cloud sources only (user's own token) so each user sees their own devices.
// Server-side sources (PMS /clients, GDM UDP) are intentionally excluded — they discover
// devices on the server's LAN and would expose the admin's devices to all users.
router.get('/clients', async (req, res) => {
  try {
    const { token: userToken } = req.session.plexUser;
    const clients = [];
    const seenIds = new Set();

    const [resourcesResult, devicesXmlResult] = await Promise.allSettled([
      fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1', {
        headers: {
          'X-Plex-Token': userToken,
          'X-Plex-Client-Identifier': 'diskovarr-app',
          'X-Plex-Product': 'Diskovarr',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      }),
      fetch('https://plex.tv/devices.xml', {
        headers: {
          'X-Plex-Token': userToken,
          'X-Plex-Client-Identifier': 'diskovarr-app',
        },
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    // Primary: plex.tv/api/v2/resources — cloud-registered clients with relay connection info
    if (resourcesResult.status === 'fulfilled' && resourcesResult.value?.ok) {
      const resources = await resourcesResult.value.json().catch(() => []);
      for (const r of (Array.isArray(resources) ? resources : [])) {
        const provides = (r.provides || '').split(',').map(s => s.trim());
        if ((provides.includes('player') || provides.includes('pubsub-player'))
            && !provides.includes('server') && r.clientIdentifier && !seenIds.has(r.clientIdentifier)) {
          clients.push({ name: r.name, machineIdentifier: r.clientIdentifier, product: r.product || '', platform: r.platform || '' });
          seenIds.add(r.clientIdentifier);
        }
      }
    } else {
      logger.warn('/api/clients: resources fetch failed:', resourcesResult.reason?.message || resourcesResult.value?.status);
    }

    // Fallback: devices.xml — catches TV-type devices that register as provides=controller
    // TV-product filter avoids pulling in Plexamp, Plex Dash, phones, etc.
    const TV_PRODUCT_RE = /\(TV\)|HTPC|Roku|Apple TV/i;
    if (devicesXmlResult.status === 'fulfilled' && devicesXmlResult.value?.ok) {
      const xml = await devicesXmlResult.value.text().catch(() => '');
      for (const match of xml.matchAll(/<Device\s([^>]*?)(?:\/>|>)/gs)) {
        const attrs = {};
        for (const a of match[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        const id = attrs.clientIdentifier;
        const product = attrs.product || '';
        if (id && TV_PRODUCT_RE.test(product) && !seenIds.has(id)) {
          clients.push({ name: attrs.name || id, machineIdentifier: id, product, platform: attrs.platform || '' });
          seenIds.add(id);
        }
      }
    } else {
      logger.debug('/api/clients: devices.xml fetch skipped or failed:', devicesXmlResult.reason?.message || devicesXmlResult.value?.status);
    }

    logger.debug(`/api/clients: user=${req.session.plexUser.id} total=${clients.length}`);
    res.json({ clients });
  } catch (err) {
    logger.error('/api/clients error:', err.message);
    res.json({ clients: [] });
  }
});

// POST /api/cast — body: { ratingKey, clientId }
// Protocol: create PlayQueue on PMS, look up player relay via plex.tv resources, send playMedia.
// Uses the user's own token throughout so commands reach the user's own devices.
router.post('/cast', async (req, res) => {
  try {
    const { ratingKey, clientId } = req.body;
    if (!ratingKey || !clientId) return res.status(400).json({ error: 'ratingKey and clientId required' });
    if (!/^\d+$/.test(String(ratingKey))) return res.status(400).json({ error: 'Invalid ratingKey' });

    const { serverToken, token: userToken } = req.session.plexUser;
    const plexUrl = plexService.getPlexUrl();
    const serverId = plexService.getPlexServerId ? plexService.getPlexServerId() : process.env.PLEX_SERVER_ID;
    const urlObj = new URL(plexUrl);
    const pmsAddress = urlObj.hostname;
    const pmsPort = urlObj.port || '32400';

    // Step 1: Create a PlayQueue on the PMS (content lives here, use server token)
    let containerKey = null;
    try {
      const pqParams = new URLSearchParams({
        type: 'video',
        uri: `server://${serverId}/com.plexapp.plugins.library/library/metadata/${ratingKey}`,
        shuffle: '0', repeat: '0', continuous: '0', own: '1', includeChapters: '1',
      });
      const pqRes = await fetch(`${plexUrl}/playQueues?${pqParams}`, {
        method: 'POST',
        headers: { 'X-Plex-Token': serverToken || userToken, 'X-Plex-Client-Identifier': 'DISKOVARR', 'Accept': 'application/xml' },
        signal: AbortSignal.timeout(8000),
      });
      if (pqRes.ok) {
        const pqXml = await pqRes.text();
        const m = pqXml.match(/playQueueID="(\d+)"/);
        if (m) containerKey = `/playQueues/${m[1]}?window=200&own=1`;
      }
    } catch (e) {
      logger.debug('/api/cast: PlayQueue creation failed, continuing without:', e.message);
    }

    // Step 2: Look up the player's connection URI via plex.tv resources (user's token)
    // Relay connections work cross-network for all users; local connections are tried second
    // as a fallback for users on the same LAN as their device.
    let playerUri = null;
    try {
      const resRes = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
        headers: { 'X-Plex-Token': userToken, 'X-Plex-Client-Identifier': 'DISKOVARR', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (resRes.ok) {
        const resources = await resRes.json().catch(() => []);
        for (const r of (Array.isArray(resources) ? resources : [])) {
          if (r.clientIdentifier === clientId && Array.isArray(r.connections) && r.connections.length) {
            // Relay first (works from any network), local second (same-LAN only)
            const sorted = [...r.connections].sort((a, b) => (b.relay ? 1 : 0) - (a.relay ? 1 : 0));
            playerUri = sorted[0].uri;
            break;
          }
        }
      }
    } catch (e) {
      logger.debug('/api/cast: resources lookup failed:', e.message);
    }

    if (!playerUri) {
      return res.status(400).json({ error: 'Player not found. Make sure your Plex app is open on your TV.' });
    }

    // Step 3: Send playMedia to the player using the user's token
    const params = new URLSearchParams({
      key: `/library/metadata/${ratingKey}`,
      ratingKey: String(ratingKey),
      machineIdentifier: serverId,
      address: pmsAddress,
      port: pmsPort,
      offset: '0',
      type: 'video',
      commandID: '1',
    });
    if (containerKey) params.set('containerKey', containerKey);

    const castUrl = `${playerUri}/player/playback/playMedia?${params}`;
    const r = await fetch(castUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Plex-Token': userToken,
        'X-Plex-Target-Client-Identifier': clientId,
        'X-Plex-Client-Identifier': 'DISKOVARR',
      },
      signal: AbortSignal.timeout(10000),
    });

    logger.debug(`/api/cast: ${castUrl} → ${r.status}`);
    if (r.ok) return res.json({ success: true });
    res.status(400).json({ error: `Cast failed (status ${r.status})` });
  } catch (err) {
    logger.error('/api/cast error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dismiss — body: { ratingKey }
router.post('/dismiss', (req, res) => {
  const { ratingKey } = req.body;
  if (!ratingKey) return res.status(400).json({ error: 'ratingKey required' });
  if (!/^\d+$/.test(String(ratingKey))) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }

  const { id: userId } = req.session.plexUser;
  db.addDismissal(userId, ratingKey);
  recommender.invalidateUserCache(userId);
  res.json({ success: true });
});

// DELETE /api/dismiss — body: { ratingKey }
router.delete('/dismiss', (req, res) => {
  const { ratingKey } = req.body;
  if (!ratingKey) return res.status(400).json({ error: 'ratingKey required' });
  if (!/^\d+$/.test(String(ratingKey))) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }

  const { id: userId } = req.session.plexUser;
  db.removeDismissal(userId, ratingKey);
  res.json({ success: true });
});

// ── TMDB Search ───────────────────────────────────────────────────────────────

// GET /api/search/suggest?q=term — fast autocomplete (no details fetch)
router.get('/search/suggest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });
  if (!db.hasTmdbKey()) return res.json({ results: [] });
  try {
    const json = await tmdbService.tmdbFetchPublic(
      `/search/multi?query=${encodeURIComponent(q)}&page=1&include_adult=false`
    );
    const results = (json?.results || [])
      .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, 6)
      .map(r => ({
        tmdbId: r.id,
        mediaType: r.media_type,
        title: r.title || r.name,
        year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || null,
        posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
      }));
    res.json({ results });
  } catch {
    res.json({ results: [] });
  }
});

// GET /api/search/details?tmdbId=X&type=movie|tv — full item details for modal
router.get('/search/details', async (req, res) => {
  const { tmdbId, type } = req.query;
  if (!tmdbId || !['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'Invalid params' });
  if (!db.hasTmdbKey()) return res.status(503).json({ error: 'no_tmdb_key' });
  try {
    const { id: userId } = req.session.plexUser;
    const item = await tmdbService.getItemDetails(Number(tmdbId), type);
    if (!item) return res.status(404).json({ error: 'Not found' });

    // Cross-reference with library
    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);
    const libraryByTmdb = new Map();
    for (const i of [...movies, ...tv]) {
      if (i.tmdbId) libraryByTmdb.set(String(i.tmdbId), i);
    }

    const libItem = libraryByTmdb.get(String(tmdbId));
    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));
    const requestedIds = db.getAllRequestedTmdbIds();
    const isRequested = requestedIds.has(`${tmdbId}:${type}`);

    const result = {
      ...item,
      inLibrary: !!libItem,
      ratingKey: libItem?.ratingKey || null,
      deepLink: libItem ? plexService.getDeepLink(libItem.ratingKey) : null,
      plexAppLink: libItem ? plexService.getAppLink(libItem.ratingKey) : null,
      isInWatchlist: libItem ? watchlistKeys.has(libItem.ratingKey) : false,
      isRequested,
    };
    res.json(result);
  } catch (err) {
    console.error('search/details error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search/seasons?tmdbId=X — returns season numbers for a TV show
router.get('/search/seasons', async (req, res) => {
  const { tmdbId } = req.query;
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' });
  if (!db.hasTmdbKey()) return res.json({ seasons: [] });
  try {
    // Check TMDB cache for already-fetched details that include seasons
    const cached = db.getTmdbCache(tmdbId, 'tv');
    if (cached && cached.seasonNumbers) {
      return res.json({ seasons: cached.seasonNumbers });
    }
    // Fetch base TV details — always includes seasons array
    const json = await tmdbService.tmdbFetchPublic(`/tv/${tmdbId}`);
    const seasons = (json?.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => s.season_number)
      .sort((a, b) => a - b);
    res.json({ seasons });
  } catch (err) {
    console.error('seasons error:', err);
    res.json({ seasons: [] });
  }
});

// GET /api/search?q=term&page=N — full search results with library cross-ref
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  if (!q) return res.json({ results: [], total: 0, pages: 0, page: 1, query: '' });

  // Library-only search when discover/TMDB is not configured
  if (!db.hasTmdbKey() || !db.isDiscoverEnabled()) {
    try {
      const { id: userId } = req.session.plexUser;
      const [movies, tv] = await Promise.all([
        plexService.getLibraryItems(plexService.MOVIES_SECTION),
        plexService.getLibraryItems(plexService.TV_SECTION),
      ]);
      const watchlistKeys = new Set(db.getWatchlistFromDb(userId));
      const watchedKeys = db.getWatchedKeysFromDb(String(userId));
      const ql = q.toLowerCase();
      const matched = [...movies, ...tv]
        .filter(item => (item.title || '').toLowerCase().includes(ql))
        .map(item => ({
          tmdbId: item.tmdbId || null,
          mediaType: item.type === 'show' ? 'tv' : 'movie',
          title: item.title,
          year: item.year || null,
          overview: item.summary || '',
          posterUrl: item.ratingKey ? `/api/poster?path=${encodeURIComponent(`/library/metadata/${item.ratingKey}/thumb`)}` : null,
          voteAverage: 0,
          inLibrary: true,
          ratingKey: item.ratingKey,
          deepLink: plexService.getDeepLink(item.ratingKey),
          plexAppLink: plexService.getAppLink(item.ratingKey),
          isInWatchlist: watchlistKeys.has(item.ratingKey),
          isWatched: watchedKeys.has(item.ratingKey),
          isRequested: false,
        }));
      return res.json({ results: matched, total: matched.length, pages: 1, page: 1, query: q });
    } catch (err) {
      console.error('search error:', err);
      return res.status(500).json({ error: 'Search failed: ' + err.message });
    }
  }

  try {
    const { id: userId } = req.session.plexUser;

    const [json, movies, tv] = await Promise.all([
      tmdbService.tmdbFetchPublic(
        `/search/multi?query=${encodeURIComponent(q)}&page=${page}&include_adult=false`
      ),
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);

    const libraryByTmdb = new Map();
    for (const item of [...movies, ...tv]) {
      if (item.tmdbId) libraryByTmdb.set(String(item.tmdbId), item);
    }

    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));
    const watchedKeys = db.getWatchedKeysFromDb(String(userId));
    const requestedIds = db.getAllRequestedTmdbIds();

    const results = (json?.results || [])
      .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
      .map(r => {
        const tmdbId = String(r.id);
        const libItem = libraryByTmdb.get(tmdbId);
        return {
          tmdbId: r.id,
          mediaType: r.media_type,
          title: r.title || r.name,
          year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || null,
          overview: r.overview || '',
          posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
          voteAverage: r.vote_average || 0,
          inLibrary: !!libItem,
          ratingKey: libItem?.ratingKey || null,
          deepLink: libItem ? plexService.getDeepLink(libItem.ratingKey) : null,
          plexAppLink: libItem ? plexService.getAppLink(libItem.ratingKey) : null,
          isInWatchlist: libItem ? watchlistKeys.has(libItem.ratingKey) : false,
          isWatched: libItem ? watchedKeys.has(libItem.ratingKey) : false,
          isRequested: !libItem && requestedIds.has(`${r.id}:${r.media_type}`),
        };
      });

    res.json({
      results,
      total: json?.total_results || results.length,
      pages: Math.min(json?.total_pages || 1, 10),
      page,
      query: q,
    });
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// ── Explore (external content) recommendations ────────────────────────────────

// GET /api/explore/services — which request services are enabled
router.get('/explore/services', (req, res) => {
  const c = db.getConnectionSettings();
  const hasOverseerr = c.overseerrEnabled && !!c.overseerrUrl;
  const hasRadarr    = c.radarrEnabled    && !!c.radarrUrl;
  const hasSonarr    = c.sonarrEnabled    && !!c.sonarrUrl;
  const hasRiven     = c.rivenEnabled && !!c.rivenUrl;
  // Default only applies when both sides are configured; otherwise the available service wins
  const hasBothSides = (hasOverseerr || hasRiven) && (hasRadarr || hasSonarr);
  const defaultService = hasBothSides ? (c.defaultRequestService || 'overseerr') : null;
  res.json({ overseerr: hasOverseerr, radarr: hasRadarr, sonarr: hasSonarr, riven: hasRiven, defaultService });
});

// GET /api/explore/recommendations
router.get('/explore/recommendations', async (req, res) => {
  if (!db.isDiscoverEnabled()) {
    return res.status(403).json({ error: 'Discover feature not enabled' });
  }
  if (!db.hasTmdbKey()) {
    return res.status(503).json({ error: 'no_tmdb_key', message: 'TMDB API key not configured. Add one in Admin → Connections.' });
  }
  try {
    const { id: userId, token: userToken } = req.session.plexUser;
    const mature = req.query.mature === 'true';
    const hideRequested = req.query.hideRequested === 'true';
    const data = await discoverRecommender.getDiscoverRecommendations(userId, userToken, { mature, hideRequested });
    res.json(data);
  } catch (err) {
    logger.error('explore/recommendations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch discover recommendations' });
  }
});

// POST /api/explore/dismiss — body: { tmdbId, mediaType }
router.post('/explore/dismiss', (req, res) => {
  const { tmdbId, mediaType } = req.body;
  if (!tmdbId || !mediaType) return res.status(400).json({ error: 'tmdbId and mediaType required' });
  if (!['movie', 'tv'].includes(mediaType)) return res.status(400).json({ error: 'Invalid mediaType' });
  if (!/^\d+$/.test(String(tmdbId))) return res.status(400).json({ error: 'Invalid tmdbId' });

  const { id: userId } = req.session.plexUser;
  db.addExploreDismissal(userId, tmdbId, mediaType);
  res.json({ success: true });
});

// POST /api/explore/follow — "notify me when available" for already-requested items
// Creates a request record for this user so they receive a fulfillment notification.
// Does not re-submit to any download service (item is already being fetched).
router.post('/explore/follow', async (req, res) => {
  if (!db.isDiscoverEnabled()) return res.status(403).json({ error: 'Discover not enabled' });
  const { tmdbId, mediaType, title } = req.body;
  if (!tmdbId || !mediaType) return res.status(400).json({ error: 'tmdbId and mediaType required' });
  if (!['movie', 'tv'].includes(mediaType)) return res.status(400).json({ error: 'Invalid mediaType' });
  const { id: userId } = req.session.plexUser;
  // Check if this user already has a request for this item
  const existing = db.getRequestedTmdbIds(userId);
  if (existing.has(`${tmdbId}:${mediaType}`)) {
    return res.json({ success: true, alreadyFollowing: true });
  }
  db.addDiscoverRequestWithStatus(userId, Number(tmdbId), mediaType, title || '', 'none', 1, 'approved', null, null);
  logger.info(`Follow request created: user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}"`);
  res.json({ success: true });
});

// ── Reusable request submission function ─────────────────────────────────────

async function submitRequestToService(requestData) {
  const { tmdbId, mediaType, title, service, seasons } = requestData;
  const c = db.getConnectionSettings();

  if (service === 'overseerr') {
    if (!c.overseerrEnabled || !c.overseerrUrl || !c.overseerrApiKey) {
      throw new Error('Overseerr not configured');
    }
    let agentUserId = null;
    try {
      agentUserId = await overseerrService.getOrCreateAgentUserId(c.overseerrUrl, c.overseerrApiKey);
    } catch (e) {
      console.warn('[overseerr] Could not resolve agent user, falling back to admin:', e.message);
    }
    const r = await fetch(`${c.overseerrUrl.replace(/\/$/, '')}/api/v1/request`, {
      method: 'POST',
      headers: {
        'X-Api-Key': c.overseerrApiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        mediaType,
        mediaId: Number(tmdbId),
        ...(agentUserId ? { userId: agentUserId } : {}),
        ...(mediaType === 'tv' ? { seasons: (Array.isArray(seasons) && seasons.length > 0) ? seasons.map(Number) : 'all' } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Overseerr error: ${body}`);
    }
  } else if (service === 'radarr') {
    if (!c.radarrEnabled || !c.radarrUrl || !c.radarrApiKey) {
      throw new Error('Radarr not configured');
    }
    const [profilesRes, foldersRes] = await Promise.all([
      fetch(`${c.radarrUrl.replace(/\/$/, '')}/api/v3/qualityprofile`, {
        headers: { 'X-Api-Key': c.radarrApiKey }, signal: AbortSignal.timeout(8000),
      }),
      fetch(`${c.radarrUrl.replace(/\/$/, '')}/api/v3/rootfolder`, {
        headers: { 'X-Api-Key': c.radarrApiKey }, signal: AbortSignal.timeout(8000),
      }),
    ]);
    const profiles = await profilesRes.json();
    const folders = await foldersRes.json();
    const savedProfileId = Number(db.getSetting('radarr_quality_profile_id', '')) || null;
    const qualityProfileId = (savedProfileId && profiles.some(p => p.id === savedProfileId))
      ? savedProfileId
      : profiles[0]?.id;
    const rootFolderPath = folders[0]?.path;
    if (!qualityProfileId || !rootFolderPath) {
      throw new Error('Could not determine Radarr quality profile or root folder');
    }
    const r = await fetch(`${c.radarrUrl.replace(/\/$/, '')}/api/v3/movie`, {
      method: 'POST',
      headers: { 'X-Api-Key': c.radarrApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tmdbId: Number(tmdbId),
        title: title || '',
        qualityProfileId,
        rootFolderPath,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Radarr error: ${body}`);
    }
  } else if (service === 'sonarr') {
    if (!c.sonarrEnabled || !c.sonarrUrl || !c.sonarrApiKey) {
      throw new Error('Sonarr not configured');
    }
    const [profilesRes, foldersRes, langRes] = await Promise.all([
      fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/qualityprofile`, {
        headers: { 'X-Api-Key': c.sonarrApiKey }, signal: AbortSignal.timeout(8000),
      }),
      fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/rootfolder`, {
        headers: { 'X-Api-Key': c.sonarrApiKey }, signal: AbortSignal.timeout(8000),
      }),
      fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/languageprofile`, {
        headers: { 'X-Api-Key': c.sonarrApiKey }, signal: AbortSignal.timeout(8000),
      }).catch(() => ({ json: () => ([]) })),
    ]);
    const profiles = await profilesRes.json();
    const folders = await foldersRes.json();
    const langs = langRes.ok ? await langRes.json() : [];
    const savedSonarrProfileId = Number(db.getSetting('sonarr_quality_profile_id', '')) || null;
    const qualityProfileId = (savedSonarrProfileId && profiles.some(p => p.id === savedSonarrProfileId))
      ? savedSonarrProfileId
      : profiles[0]?.id;
    const rootFolderPath = folders[0]?.path;
    const languageProfileId = langs[0]?.id || 1;
    if (!qualityProfileId || !rootFolderPath) {
      throw new Error('Could not determine Sonarr quality profile or root folder');
    }
    const externalIds = await tmdbService.tmdbFetchPublic(`/tv/${tmdbId}/external_ids`).catch(() => ({}));
    const tvdbId = externalIds?.tvdb_id;
    if (!tvdbId) {
      throw new Error('Could not resolve TVDB ID for this show. TMDB may not have a TVDB mapping yet.');
    }
    let seasonsPayload = undefined;
    if (Array.isArray(seasons) && seasons.length > 0) {
      try {
        const lookupRes = await fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/series/lookup?term=tvdb:${tvdbId}`, {
          headers: { 'X-Api-Key': c.sonarrApiKey },
          signal: AbortSignal.timeout(8000),
        });
        const lookupData = lookupRes.ok ? await lookupRes.json() : [];
        const seriesInfo = lookupData[0];
        if (seriesInfo?.seasons) {
          const selectedNums = new Set(seasons.map(Number));
          seasonsPayload = seriesInfo.seasons.map(s => ({
            ...s,
            monitored: selectedNums.has(s.seasonNumber),
          }));
        }
      } catch { /* fall back to default behaviour */ }
    }

    const sonarrBody = {
      tvdbId,
      title: title || '',
      qualityProfileId,
      languageProfileId,
      rootFolderPath,
      monitored: true,
      addOptions: { searchForMissingEpisodes: true },
    };
    if (seasonsPayload) sonarrBody.seasons = seasonsPayload;

    const r = await fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/series`, {
      method: 'POST',
      headers: { 'X-Api-Key': c.sonarrApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(sonarrBody),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Sonarr error: ${body}`);
    }
  } else if (service === 'riven') {
    // DUMB pull mode: skip the push — DUMB polls /api/v1/request?filter=approved instead
    if (db.getSetting('riven_enabled', '0') === '1' && db.getSetting('dumb_request_mode', 'pull') === 'pull') {
      logger.info(`[riven] DUMB pull mode active — skipping push for tmdbId=${tmdbId}`);
      return;
    }
    if (!c.rivenEnabled || !c.rivenUrl) {
      throw new Error('Riven requests not configured');
    }
    // Resolve API key — stored override or auto-read from DUMB settings.json
    const fs = require('fs');
    const RIVEN_SETTINGS_PATH = '/home/lebbi/docker/DUMB/data/riven/settings.json';
    let rivenApiKey = c.rivenApiKey;
    if (!rivenApiKey) {
      try {
        const raw = fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8');
        rivenApiKey = JSON.parse(raw)?.api_key || '';
      } catch { /* fall through */ }
    }
    if (!rivenApiKey) throw new Error('Riven API key not configured');

    // Riven uses IMDB IDs — resolve from TMDB
    const apiKey = db.getSetting('tmdb_api_key', '') || process.env.TMDB_API_KEY || '';
    if (!apiKey) throw new Error('TMDB API key required to look up IMDB ID for Riven');
    const base = 'https://api.themoviedb.org/3';
    const extPath = mediaType === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}/external_ids`;
    const tmdbRes = await fetch(`${base}${extPath}?api_key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
    if (!tmdbRes.ok) throw new Error(`TMDB lookup failed: ${tmdbRes.status}`);
    const tmdbData = await tmdbRes.json();
    const imdbId = tmdbData.imdb_id;
    if (!imdbId) throw new Error('Could not resolve IMDB ID for this title — TMDB may not have a mapping yet');

    const rivenBase = c.rivenUrl.replace(/\/$/, '');
    const r = await fetch(`${rivenBase}/api/v1/items/add?imdb_ids=${encodeURIComponent(imdbId)}`, {
      method: 'POST',
      headers: { 'X-API-KEY': rivenApiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Riven error: ${body}`);
    }
  } else {
    throw new Error('Invalid service');
  }
}

// POST /api/request — submit a request via Overseerr, Radarr, or Sonarr
router.post('/request', async (req, res) => {
  if (!db.isDiscoverEnabled() || !db.hasTmdbKey()) {
    return res.status(403).json({ error: 'Discover feature not enabled' });
  }
  const { tmdbId, mediaType, title, year, service, seasons } = req.body;
  if (!tmdbId || !mediaType || !service) {
    return res.status(400).json({ error: 'tmdbId, mediaType, and service are required' });
  }
  if (!['overseerr', 'radarr', 'sonarr', 'riven', 'none'].includes(service)) {
    return res.status(400).json({ error: 'Invalid service' });
  }
  if (!['movie', 'tv'].includes(mediaType)) {
    return res.status(400).json({ error: 'Invalid mediaType' });
  }

  const { id: userId, token: userToken } = req.session.plexUser;

  // Enforce per-user request limits (if enabled globally)
  const limits = db.getEffectiveLimits(userId);
  if (limits) {
    if (mediaType === 'movie' && limits.movieLimit > 0) {
      const recentCount = db.countRecentMovieRequests(userId, limits.movieWindowDays);
      if (recentCount >= limits.movieLimit) {
        return res.status(429).json({
          error: `Movie request limit reached: ${limits.movieLimit} per ${limits.movieWindowDays} day${limits.movieWindowDays !== 1 ? 's' : ''}. Try again later.`,
        });
      }
    }
    if (mediaType === 'tv' && limits.seasonLimit > 0) {
      const requestedSeasons = Array.isArray(seasons) && seasons.length > 0 ? seasons.length : 1;
      const recentCount = db.countRecentSeasonRequests(userId, limits.seasonWindowDays);
      if (recentCount + requestedSeasons > limits.seasonLimit) {
        const remaining = Math.max(0, limits.seasonLimit - recentCount);
        return res.status(429).json({
          error: `Season request limit reached: ${limits.seasonLimit} per ${limits.seasonWindowDays} day${limits.seasonWindowDays !== 1 ? 's' : ''}. You can request ${remaining} more season${remaining !== 1 ? 's' : ''}.`,
        });
      }
    }
  }

  try {
    const seasonsCount = mediaType === 'tv'
      ? (Array.isArray(seasons) && seasons.length > 0 ? seasons.length : 1)
      : 1;

    // Check auto-approve setting
    const autoApprove = db.getEffectiveAutoApprove(userId, mediaType);

    const cachedItem = db.getTmdbCache(tmdbId, mediaType);
    const storedPosterUrl = cachedItem?.posterUrl || null;

    if (!autoApprove) {
      // Store as pending — do NOT submit to service
      db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title || '', service, seasonsCount, 'pending', seasons || null, storedPosterUrl);
      logger.info(`Request queued (pending approval): user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}" service=${service}`);
      // Notify admins of new pending request
      try {
        const username = req.session.plexUser.username || userId;
        const adminIds = db.getPrivilegedUserIds();
        for (const adminId of adminIds) {
          const prefs = db.getUserNotificationPrefs(adminId);
          if (prefs.notify_pending) {
            const notifId = db.createOrBundleNotification({
              userId: adminId,
              type: 'request_pending',
              title: `New request: "${title}"`,
              body: `${username} requested ${mediaType === 'movie' ? 'a movie' : 'a TV show'}.`,
              data: { tmdbId, mediaType, title },
            });
            db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: adminId, payload: { type: 'request_pending', title: `New request: "${title}"`, body: `${username} requested ${mediaType === 'movie' ? 'a movie' : 'a TV show'}.`, posterUrl: storedPosterUrl } });
            db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: adminId, payload: { type: 'request_pending', title: `New request: "${title}"`, body: `${username} requested ${mediaType === 'movie' ? 'a movie' : 'a TV show'}.`, posterUrl: storedPosterUrl } });
          }
        }
      } catch (e) { logger.warn('notification error:', e.message); }
      return res.json({ success: true, pending: true });
    }

    // Auto-approve: submit to service immediately (skip if no service configured)
    if (service !== 'none') await submitRequestToService({ tmdbId, mediaType, title, service, seasons });

    db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title || '', service, seasonsCount, 'approved', seasons || null, storedPosterUrl);
    logger.info(`Request submitted: user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}" service=${service}`);


    // Add the item to the user's native Plex.tv Watchlist so they can track it
    // in the Plex app while waiting for the download.
    const watchlistMode = db.getAdminWatchlistMode();
    const ownerUserId = db.getOwnerUserId();
    const isOwnerInPlaylistMode = watchlistMode === 'playlist' && userId === ownerUserId;

    if (!isOwnerInPlaylistMode) {
      fetch(`https://discover.provider.plex.tv/library/search?query=${encodeURIComponent(title || '')}&limit=10&X-Plex-Token=${userToken}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
        .then(r => r.ok ? r.json() : null)
        .then(async data => {
          const hits = data?.MediaContainer?.SearchResult || [];
          const hit = hits.find(h => {
            const guids = h.Metadata?.Guid || [];
            const hasTmdb = guids.some(g => g.id === `tmdb://${tmdbId}`);
            const titleMatch = h.Metadata?.title === title && String(h.Metadata?.year) === String(year);
            return hasTmdb || titleMatch;
          });
          if (!hit?.Metadata?.ratingKey) return;
          const plexGuid = String(hit.Metadata.ratingKey);
          await plexService.addToPlexTvWatchlistByGuid(userToken, plexGuid);
        })
        .catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error('request error:', err);
    try {
      for (const adminId of db.getPrivilegedUserIds()) {
        const prefs = db.getUserNotificationPrefs(adminId);
        if (prefs.notify_process_failed) {
          db.createOrBundleNotification({
            userId: adminId, type: 'request_process_failed',
            title: `Request failed: "${title}"`,
            body: err.message,
            data: { tmdbId, mediaType, title },
          });
        }
      }
    } catch (e) { logger.warn('notification error:', e.message); }
    res.status(500).json({ error: 'Request failed: ' + err.message });
  }
});

// ── Queue management endpoints (Plex admin users) ─────────────────────────────

function requirePlexAdmin(req, res, next) {
  if (req.session && (req.session.isAdmin || req.session.isPlexAdminUser)) return next();
  res.status(403).json({ error: 'Admin access required' });
}

function requirePrivileged(req, res, next) {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.isAdmin || req.session.isPlexAdminUser) return next();
  const userId = String(req.session.plexUser.id);
  if (db.getPrivilegedUserIds().includes(userId)) return next();
  res.status(403).json({ error: 'Privileged access required' });
}

// GET /api/queue
router.get('/queue', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const userId = req.session.plexUser.id;
  const { status = 'all', page = '1', limit: limitParam = '25', sort: sortParam = 'requested_at', sortDir: sortDirParam = 'DESC' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(limitParam) || 25));
  const pageNum = Math.max(1, parseInt(page) || 1);
  const ALLOWED_SORT_COLS = ['title', 'username', 'media_type', 'requested_at', 'status'];
  const sortCol = ALLOWED_SORT_COLS.includes(sortParam) ? sortParam : 'requested_at';
  const sortDir = sortDirParam === 'ASC' ? 'ASC' : 'DESC';

  // 'requested' and 'available' are computed displayStatuses derived from approved rows:
  //   requested = approved + NOT in library
  //   available = approved + IN library
  // Both require fetching all approved and filtering in memory.
  const libraryTmdbIds = db.getLibraryTmdbIds();
  const isComputedFilter = status === 'requested' || status === 'available';
  const dbStatus = isComputedFilter ? 'approved' : status;

  let rows, total;
  if (isComputedFilter) {
    const all = isAdmin ? db.getAllRequests(10000, 0, 'approved', sortCol, sortDir) : db.getUserRequests(userId, 10000, 0, 'approved', sortCol, sortDir);
    const filtered = all.rows.filter(r =>
      status === 'available' ? libraryTmdbIds.has(String(r.tmdb_id)) : !libraryTmdbIds.has(String(r.tmdb_id))
    );
    total = filtered.length;
    rows = filtered.slice((pageNum - 1) * limit, pageNum * limit);
  } else {
    ({ rows, total } = isAdmin ? db.getAllRequests(limit, (pageNum - 1) * limit, dbStatus, sortCol, sortDir) : db.getUserRequests(userId, limit, (pageNum - 1) * limit, dbStatus, sortCol, sortDir));
  }

  // Fetch TMDB details on-demand for rows with no cache entry, or TV rows whose
  // cache predates the numberOfSeasons field (identified by having no seasons_json
  // and a cache entry that lacks numberOfSeasons — evict so getItemDetails re-fetches).
  const needsFetch = rows.filter(r => {
    const cached = db.getTmdbCache(r.tmdb_id, r.media_type);
    if (!cached) return true;
    if (r.media_type === 'tv' && r.seasons_json === null && cached.numberOfSeasons === undefined) {
      db.deleteTmdbCache(r.tmdb_id, r.media_type);
      return true;
    }
    return false;
  });
  if (needsFetch.length > 0) {
    await Promise.all(needsFetch.map(r => tmdbService.getItemDetails(r.tmdb_id, r.media_type)));
  }

  const enriched = rows.map(r => {
    const cached = db.getTmdbCache(r.tmdb_id, r.media_type);
    const isAvailable = libraryTmdbIds.has(String(r.tmdb_id));
    let displayStatus = r.status;
    if (r.status === 'approved') displayStatus = isAvailable ? 'available' : 'requested';
    // Backfill seasons_json for TV requests that predate the seasons feature.
    // If TMDB has numberOfSeasons, build the array. If it doesn't (obscure show),
    // write '[]' so we stop re-fetching on every queue load.
    let seasons_json = r.seasons_json;
    if (!seasons_json && r.media_type === 'tv') {
      if (cached?.numberOfSeasons > 0) {
        seasons_json = JSON.stringify(Array.from({ length: cached.numberOfSeasons }, (_, i) => i + 1));
      } else if (cached) {
        seasons_json = '[]'; // TMDB confirmed no season count — stop retrying
      }
      if (seasons_json !== null) {
        db.prepare('UPDATE discover_requests SET seasons_json = ? WHERE id = ?').run(seasons_json, r.id);
      }
    }
    return {
      ...r,
      seasons_json,
      posterUrl: r.poster_url || cached?.posterUrl || null,
      year: cached?.releaseDate ? parseInt(cached.releaseDate.slice(0, 4)) || null : null,
      contentRating: cached?.contentRating || null,
      displayStatus,
    };
  });

  res.json({
    requests: enriched,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limit),
  });
});

// PUT /api/queue/:id — edit a pending request
router.put('/queue/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (!isAdmin && request.user_id !== req.session.plexUser.id) return res.status(403).json({ error: 'Forbidden' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const { service, seasons } = req.body;
  const seasonsJson = Array.isArray(seasons) && seasons.length > 0 ? JSON.stringify(seasons.map(Number)) : null;
  const seasonsCount = Array.isArray(seasons) && seasons.length > 0 ? seasons.length : 1;
  db.updateRequest(request.id, {
    service: service || request.service,
    seasonsJson,
    seasonsCount,
  });
  res.json({ success: true, request: db.getRequestById(request.id) });
});

// POST /api/queue/:id/approve
router.post('/queue/:id/approve', requirePrivileged, async (req, res) => {
  try {
    const request = db.getRequestById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const storedSeasons = request.seasons_json ? JSON.parse(request.seasons_json) : null;
    // If service is 'none' (e.g. queued via shim), pick the best available service now
    const service = (!request.service || request.service === 'none')
      ? (request.media_type === 'movie'
          ? (db.getConnectionSettings().radarrEnabled ? 'radarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')
          : (db.getConnectionSettings().sonarrEnabled ? 'sonarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven'))
      : request.service;
    await submitRequestToService({
      tmdbId: request.tmdb_id,
      mediaType: request.media_type,
      title: request.title,
      service,
      seasons: storedSeasons,
    });

    db.updateRequestStatus(request.id, 'approved', null);
    logger.info(`Request approved by admin: id=${request.id} tmdbId=${request.tmdb_id} title="${request.title}"`);
    // Notify the requester
    try {
      const prefs = db.getUserNotificationPrefs(request.user_id);
      if (prefs.notify_approved) {
        const notifId = db.createOrBundleNotification({
          userId: request.user_id,
          type: 'request_approved',
          title: `"${request.title}" approved`,
          body: 'Your request has been approved and submitted.',
          data: { requestId: request.id, tmdbId: request.tmdb_id, mediaType: request.media_type, title: request.title },
        });
        db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: request.user_id, payload: { type: 'request_approved', title: `"${request.title}" approved`, body: 'Your request has been approved and submitted.', posterUrl: request.poster_url } });
        db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: request.user_id, payload: { type: 'request_approved', title: `"${request.title}" approved`, body: 'Your request has been approved and submitted.', posterUrl: request.poster_url } });
      }
    } catch (e) { logger.warn('notification error:', e.message); }
    res.json({ success: true, request: db.getRequestById(request.id) });
  } catch (err) {
    console.error('queue approve error:', err);
    try {
      const request = db.getRequestById(req.params.id);
      const title = request?.title || 'Unknown';
      const tmdbId = request?.tmdb_id;
      const mediaType = request?.media_type;
      for (const adminId of db.getPrivilegedUserIds()) {
        const prefs = db.getUserNotificationPrefs(adminId);
        if (prefs.notify_process_failed) {
          db.createOrBundleNotification({
            userId: adminId, type: 'request_process_failed',
            title: `Request failed: "${title}"`,
            body: err.message,
            data: { tmdbId, mediaType, title },
          });
        }
      }
    } catch (e) { logger.warn('notification error:', e.message); }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/:id/deny
router.post('/queue/:id/deny', requirePrivileged, (req, res) => {
  const { note } = req.body;
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  db.updateRequestStatus(request.id, 'denied', note || null);
  logger.info(`Request denied by admin: id=${request.id} tmdbId=${request.tmdb_id} title="${request.title}"`);
  // Notify the requester
  try {
    const prefs = db.getUserNotificationPrefs(request.user_id);
    if (prefs.notify_denied) {
      const denyBody = note ? `Reason: ${note}` : 'Your request has been declined.';
      const notifId = db.createOrBundleNotification({
        userId: request.user_id,
        type: 'request_denied',
        title: `"${request.title}" declined`,
        body: denyBody,
        data: { requestId: request.id, tmdbId: request.tmdb_id, mediaType: request.media_type, title: request.title },
      });
      db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: request.user_id, payload: { type: 'request_denied', title: `"${request.title}" declined`, body: denyBody, posterUrl: request.poster_url } });
      db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: request.user_id, payload: { type: 'request_denied', title: `"${request.title}" declined`, body: denyBody, posterUrl: request.poster_url } });
    }
  } catch (e) { logger.warn('notification error:', e.message); }
  res.json({ success: true, request: db.getRequestById(request.id) });
});

// DELETE /api/queue/:id
router.delete('/queue/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (!isAdmin) {
    if (request.user_id !== req.session.plexUser.id) return res.status(403).json({ error: 'Forbidden' });
    if (request.status !== 'pending') return res.status(403).json({ error: 'Can only delete pending requests' });
  }
  db.deleteRequest(request.id);
  res.json({ success: true });
});

// ── Issue reporting endpoints ──────────────────────────────────────────────────

// POST /api/issues — report an issue with a library item
router.post('/issues', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const { ratingKey, title, mediaType, posterPath, scope, scopeSeason, scopeEpisode, description } = req.body;
  if (!ratingKey || !title || !mediaType) return res.status(400).json({ error: 'Missing required fields' });
  const id = db.createIssue({
    userId, ratingKey, title, mediaType,
    posterPath: posterPath || null,
    scope: scope || 'series',
    scopeSeason: scopeSeason != null ? Number(scopeSeason) : null,
    scopeEpisode: scopeEpisode != null ? Number(scopeEpisode) : null,
    description: description || null,
  });
  try {
    const shortDesc = description ? description.slice(0, 120) : 'A user has reported an issue.';
    for (const adminId of db.getPrivilegedUserIds()) {
      const prefs = db.getUserNotificationPrefs(adminId);
      if (!prefs.notify_issue_new) continue;
      const notifId = db.createOrBundleNotification({
        userId: adminId, type: 'issue_new',
        title: `Issue reported: "${title}"`, body: shortDesc,
        data: { issueId: id, ratingKey, mediaType },
      });
      const posterUrl = await getPublicPosterUrl(ratingKey);
      db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: adminId,
        payload: { type: 'issue_new', title: `Issue reported: "${title}"`, body: shortDesc, posterUrl, userId: adminId } });
      db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: adminId,
        payload: { type: 'issue_new', title: `Issue reported: "${title}"`, body: shortDesc } });
    }
  } catch (e) { logger.warn('Issue notification error:', e.message); }
  res.json({ success: true, id });
});

// GET /api/issues — paginated list (admin sees all, users see own)
router.get('/issues', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const userId = String(req.session.plexUser.id);
  const { status = 'all', page = '1', limit: lp = '25' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(lp) || 25));
  const pageNum = Math.max(1, parseInt(page) || 1);
  const { rows, total } = isAdmin
    ? db.getAllIssues(limit, (pageNum - 1) * limit, status)
    : db.getUserIssues(userId, limit, (pageNum - 1) * limit, status);
  res.json({ issues: rows, total, page: pageNum, totalPages: Math.ceil(total / limit) || 1 });
});

// POST /api/issues/:id/resolve — mark resolved with optional note
router.post('/issues/:id/resolve', requirePrivileged, async (req, res) => {
  const issue = db.getIssueById(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  const note = req.body.note || null;
  db.updateIssueStatus(issue.id, 'resolved', note);
  try {
    const prefs = db.getUserNotificationPrefs(issue.user_id);
    if (prefs.notify_issue_update) {
      const body = note ? `Note: ${note}` : 'Your reported issue has been marked resolved.';
      const notifId = db.createOrBundleNotification({
        userId: issue.user_id, type: 'issue_updated',
        title: `Issue resolved: "${issue.title}"`, body,
        data: { issueId: issue.id },
      });
      const posterUrl = await getPublicPosterUrl(issue.rating_key);
      db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: issue.user_id,
        payload: { type: 'issue_updated', title: `Issue resolved: "${issue.title}"`, body, posterUrl, userId: issue.user_id } });
      db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: issue.user_id,
        payload: { type: 'issue_updated', title: `Issue resolved: "${issue.title}"`, body } });
    }
  } catch (e) { logger.warn('Issue notification error:', e.message); }
  res.json({ success: true });
});

// POST /api/issues/:id/close — mark closed with optional note
router.post('/issues/:id/close', requirePrivileged, async (req, res) => {
  const issue = db.getIssueById(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  const note = req.body.note || null;
  db.updateIssueStatus(issue.id, 'closed', note);
  try {
    const prefs = db.getUserNotificationPrefs(issue.user_id);
    if (prefs.notify_issue_update) {
      const body = note ? `Note: ${note}` : 'Your reported issue has been closed.';
      const notifId = db.createOrBundleNotification({
        userId: issue.user_id, type: 'issue_updated',
        title: `Issue closed: "${issue.title}"`, body,
        data: { issueId: issue.id },
      });
      const posterUrl = await getPublicPosterUrl(issue.rating_key);
      db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: issue.user_id,
        payload: { type: 'issue_updated', title: `Issue closed: "${issue.title}"`, body, posterUrl, userId: issue.user_id } });
      db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: issue.user_id,
        payload: { type: 'issue_updated', title: `Issue closed: "${issue.title}"`, body } });
    }
  } catch (e) { logger.warn('Issue notification error:', e.message); }
  res.json({ success: true });
});

// DELETE /api/issues/:id
router.delete('/issues/:id', requirePrivileged, (req, res) => {
  const issue = db.getIssueById(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  db.deleteIssue(issue.id);
  res.json({ success: true });
});

// GET /api/issues/:id/comments
router.get('/issues/:id/comments', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const isPriv = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(userId);
  const issue = db.getIssueById(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (!isPriv && issue.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
  const comments = db.getIssueComments(issue.id);
  res.json({ comments });
});

// POST /api/issues/:id/comments
router.post('/issues/:id/comments', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const isPriv = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(userId);
  const issue = db.getIssueById(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (!isPriv && issue.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
  const { comment } = req.body;
  if (!comment || typeof comment !== 'string' || !comment.trim()) return res.status(400).json({ error: 'Comment is required' });
  if (comment.trim().length > 1000) return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });
  const commentId = db.addIssueComment(issue.id, userId, comment.trim(), isPriv);
  try {
    if (isPriv) {
      // Admin commented — notify the issue reporter (if they are not admin)
      if (issue.user_id !== userId) {
        const prefs = db.getUserNotificationPrefs(issue.user_id);
        if (prefs.notify_issue_comment) {
          const notifTitle = `Admin replied to your issue: "${issue.title}"`;
          const notifBody = comment.trim().slice(0, 200);
          const notifId = db.createOrBundleNotification({ userId: issue.user_id, type: 'issue_comment_added_user', title: notifTitle, body: notifBody, data: { issueId: issue.id } });
          const posterUrl = await getPublicPosterUrl(issue.rating_key);
          db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: issue.user_id, payload: { type: 'issue_comment_added_user', title: notifTitle, body: notifBody, posterUrl, userId: issue.user_id } });
          db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: issue.user_id, payload: { type: 'issue_comment_added_user', title: notifTitle, body: notifBody } });
        }
      }
    } else {
      // User commented — notify all admins
      for (const adminId of db.getPrivilegedUserIds()) {
        const prefs = db.getUserNotificationPrefs(adminId);
        if (!prefs.notify_issue_comment) continue;
        const notifTitle = `Comment on issue: "${issue.title}"`;
        const notifBody = comment.trim().slice(0, 200);
        const notifId = db.createOrBundleNotification({ userId: adminId, type: 'issue_comment_added_admin', title: notifTitle, body: notifBody, data: { issueId: issue.id } });
        const posterUrl = await getPublicPosterUrl(issue.rating_key);
        db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: adminId, payload: { type: 'issue_comment_added_admin', title: notifTitle, body: notifBody, posterUrl, userId: adminId } });
        db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: adminId, payload: { type: 'issue_comment_added_admin', title: notifTitle, body: notifBody } });
      }
    }
  } catch (e) { logger.warn('Issue comment notification error:', e.message); }
  res.json({ success: true, id: commentId });
});

// DELETE /api/issues/:id/comments/:commentId
router.delete('/issues/:id/comments/:commentId', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const isPriv = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(userId);
  const issue = db.getIssueById(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  db.deleteIssueComment(req.params.commentId, userId, isPriv);
  res.json({ success: true });
});

// POST /api/user/settings — save user's own content preferences + notification prefs
router.post('/user/settings', (req, res) => {
  const userId = req.session.plexUser.id;
  const { region, language, landing_page, show_mature,
          notify_approved, notify_denied, notify_available,
          discord_webhook, discord_enabled, discord_user_id, pushover_user_key, pushover_enabled,
          notify_pending, notify_auto_approved, notify_process_failed,
          notify_issue_new, notify_issue_update, notify_issue_comment } = req.body;
  // Read current prefs so partial updates (e.g. only show_mature) don't reset other fields
  const oldPrefs = db.getUserPreferences(userId);
  const newRegion      = region      !== undefined ? (region      || null) : oldPrefs.region;
  const newLanguage    = language    !== undefined ? (language    || null) : oldPrefs.language;
  const newLandingPage = landing_page !== undefined ? (landing_page || null) : oldPrefs.landing_page;
  const newShowMature  = show_mature !== undefined
    ? (show_mature === true || show_mature === 'true' || show_mature === 1)
    : oldPrefs.show_mature;
  db.setUserPreferences(userId, {
    region: newRegion, language: newLanguage, landing_page: newLandingPage, show_mature: newShowMature,
  });
  // Invalidate discover pool cache if any pref that affects pool selection changed
  const poolChanged = oldPrefs.show_mature !== newShowMature
    || oldPrefs.region   !== newRegion
    || oldPrefs.language !== newLanguage;
  if (poolChanged) {
    try { require('../services/discoverRecommender').invalidateUserCache(userId); } catch {}
  }
  db.setUserNotificationPrefs(userId, {
    notify_approved:      notify_approved      !== false && notify_approved      !== 'false',
    notify_denied:        notify_denied        !== false && notify_denied        !== 'false',
    notify_available:     notify_available     !== false && notify_available     !== 'false',
    discord_webhook:      discord_webhook       || null,
    discord_enabled:      discord_enabled       === true || discord_enabled       === 'true',
    discord_user_id:      discord_user_id       || null,
    pushover_user_key:    pushover_user_key     || null,
    pushover_enabled:     pushover_enabled      === true || pushover_enabled      === 'true',
    notify_pending:       notify_pending        !== false && notify_pending        !== 'false',
    notify_auto_approved: notify_auto_approved  !== false && notify_auto_approved  !== 'false',
    notify_process_failed: notify_process_failed !== false && notify_process_failed !== 'false',
    notify_issue_new:     notify_issue_new     !== false && notify_issue_new     !== 'false',
    notify_issue_update:  notify_issue_update  !== false && notify_issue_update  !== 'false',
    notify_issue_comment: notify_issue_comment !== false && notify_issue_comment !== 'false',
  });
  res.json({ ok: true });
});

// ── Notification endpoints ─────────────────────────────────────────────────────

router.get('/notifications', (req, res) => {
  const userId = req.session.plexUser.id;
  const countOnly = req.query.countOnly === '1';
  const unreadCount = db.getUnreadNotificationCount(userId);
  if (countOnly) return res.json({ unreadCount });
  const notifications = db.getNotifications(userId, 20);
  const recentRead = db.getRecentReadNotifications(userId, 5);
  res.json({ notifications, recentRead, unreadCount });
});

router.post('/notifications/read', (req, res) => {
  const userId = req.session.plexUser.id;
  const { ids, all } = req.body;
  db.markNotificationsRead(userId, all ? null : (ids || []));
  res.json({ ok: true });
});

router.delete('/notifications/:id', (req, res) => {
  const userId = req.session.plexUser.id;
  db.deleteNotification(userId, req.params.id);
  res.json({ ok: true });
});

router.post('/user/pushover/test', async (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.json({ ok: false, error: 'No Pushover user key provided' });
  const config = pushoverAgent.getConfig();
  if (!config || !config.enabled) return res.json({ ok: false, error: 'Pushover is not enabled' });
  try {
    await pushoverAgent.sendTest(config.appToken, userKey);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/user/discord/test', async (req, res) => {
  const { discordUserId } = req.body;
  if (!discordUserId) return res.json({ ok: false, error: 'No Discord User ID provided' });
  const config = discordAgent.getConfig();
  if (!config || !config.enabled || config.mode !== 'bot') {
    return res.json({ ok: false, error: 'Discord bot mode is not enabled' });
  }
  try {
    await discordAgent.sendTest({ mode: 'bot', botToken: config.botToken, discordUserId, botUsername: config.botUsername });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.submitRequestToService = submitRequestToService;
