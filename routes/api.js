const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discoverRecommender = require('../services/discoverRecommender');
const tmdbService = require('../services/tmdb');
const overseerrService = require('../services/overseerr');
const db = require('../db/database');
const logger = require('../services/logger');

router.use(requireAuth);

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
  res.json({ items: keys.map(k => ({ ratingKey: k })) });
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
      includeWatched = 'false',
      q = '',
    } = req.query;

    const PAGE_SIZE = 40;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const minRatingNum = parseFloat(minRating) || 0;
    const genreList = genres ? genres.split(',').map(g => g.trim().toLowerCase()).filter(Boolean) : [];
    const searchQuery = q.trim().toLowerCase();

    const [movies, tv, watchedKeys, dismissedKeys] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
      includeWatched === 'true' ? Promise.resolve(new Set()) : plexService.getWatchedKeys(userId, userToken),
      Promise.resolve(db.getDismissals(userId)),
    ]);

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
      if (watchedKeys.has(item.ratingKey)) return false;
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

    // Attach watchlist status from local DB (no Plex API needed)
    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));

    const itemsWithWatchlist = items.map(item => ({
      ...item,
      deepLink: plexService.getDeepLink(item.ratingKey),
      plexAppLink: plexService.getAppLink(item.ratingKey),
      isInWatchlist: watchlistKeys.has(item.ratingKey),
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

// GET /api/clients — list Plex player clients (local + remote via plex.tv resources)
router.get('/clients', async (req, res) => {
  try {
    const { token: userToken } = req.session.plexUser;

    // Query plex.tv resources — returns all clients registered to the account
    // including remote devices, not just LAN-local ones
    const r = await fetch(
      `https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&X-Plex-Token=${userToken}`,
      {
        headers: { Accept: 'application/json', 'X-Plex-Client-Identifier': 'DISKOVARR' },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!r.ok) return res.json({ clients: [] });
    const resources = await r.json();

    // Filter to player-capable clients only (exclude servers, relays, etc.)
    const clients = resources
      .filter(d => d.provides && d.provides.split(',').includes('player'))
      .map(d => ({
        name: d.name,
        machineIdentifier: d.clientIdentifier,
        product: d.product || '',
        platform: d.platform || '',
      }));

    res.json({ clients });
  } catch {
    res.json({ clients: [] });
  }
});

// POST /api/cast — body: { ratingKey, clientId }
router.post('/cast', async (req, res) => {
  try {
    const { ratingKey, clientId } = req.body;
    if (!ratingKey || !clientId) return res.status(400).json({ error: 'ratingKey and clientId required' });
    if (!/^\d+$/.test(String(ratingKey))) return res.status(400).json({ error: 'Invalid ratingKey' });

    const { token: userToken } = req.session.plexUser;
    const plexUrl = plexService.getPlexUrl();
    const serverId = plexService.getPlexServerId ? plexService.getPlexServerId() : process.env.PLEX_SERVER_ID;
    const urlObj = new URL(plexUrl);
    const address = urlObj.hostname;
    const port = urlObj.port || '32400';

    const params = new URLSearchParams({
      key: `/library/metadata/${ratingKey}`,
      ratingKey: String(ratingKey),
      machineIdentifier: serverId,
      address,
      port,
      offset: '0',
    });

    const r = await fetch(`${plexUrl}/player/playback/playMedia?${params}`, {
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': userToken,
        'X-Plex-Target-Client-Identifier': clientId,
        'X-Plex-Client-Identifier': 'DISKOVARR',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) return res.status(400).json({ error: `Plex returned ${r.status}` });
    res.json({ success: true });
  } catch (err) {
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
  if (!db.hasTmdbKey()) return res.status(503).json({ error: 'no_tmdb_key' });
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
          isRequested: !libItem && requestedIds.has(`${r.id}:${r.media_type}`),
        };
      });

    res.json({
      results,
      total: json?.total_results || results.length,
      pages: Math.min(json?.total_pages || 1, 10), // cap at 10 pages
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
  // Default only applies when both sides are configured; otherwise the available service wins
  const hasBothSides = hasOverseerr && (hasRadarr || hasSonarr);
  const defaultService = hasBothSides ? (c.defaultRequestService || 'overseerr') : null;
  res.json({ overseerr: hasOverseerr, radarr: hasRadarr, sonarr: hasSonarr, defaultService });
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
    const data = await discoverRecommender.getDiscoverRecommendations(userId, userToken, { mature });
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

// POST /api/request — submit a request via Overseerr, Radarr, or Sonarr
router.post('/request', async (req, res) => {
  if (!db.isDiscoverEnabled() || !db.hasTmdbKey()) {
    return res.status(403).json({ error: 'Discover feature not enabled' });
  }

  const { tmdbId, mediaType, title, year, service, seasons } = req.body;
  if (!tmdbId || !mediaType || !service) {
    return res.status(400).json({ error: 'tmdbId, mediaType, and service are required' });
  }
  if (!['overseerr', 'radarr', 'sonarr'].includes(service)) {
    return res.status(400).json({ error: 'Invalid service' });
  }
  if (!['movie', 'tv'].includes(mediaType)) {
    return res.status(400).json({ error: 'Invalid mediaType' });
  }

  const { id: userId, token: userToken } = req.session.plexUser;
  const c = db.getConnectionSettings();

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
    if (service === 'overseerr') {
      if (!c.overseerrEnabled || !c.overseerrUrl || !c.overseerrApiKey) {
        return res.status(400).json({ error: 'Overseerr not configured' });
      }
      // Ensure the "Diskovarr Agent" user exists and get its ID so requests
      // are attributed to it rather than the admin account.
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
        return res.status(r.status).json({ error: `Overseerr error: ${body}` });
      }
    } else if (service === 'radarr') {
      if (!c.radarrEnabled || !c.radarrUrl || !c.radarrApiKey) {
        return res.status(400).json({ error: 'Radarr not configured' });
      }
      // Get first quality profile and root folder
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
        return res.status(500).json({ error: 'Could not determine Radarr quality profile or root folder' });
      }
      const r = await fetch(`${c.radarrUrl.replace(/\/$/, '')}/api/v3/movie`, {
        method: 'POST',
        headers: {
          'X-Api-Key': c.radarrApiKey,
          'Content-Type': 'application/json',
        },
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
        return res.status(r.status).json({ error: `Radarr error: ${body}` });
      }
    } else if (service === 'sonarr') {
      if (!c.sonarrEnabled || !c.sonarrUrl || !c.sonarrApiKey) {
        return res.status(400).json({ error: 'Sonarr not configured' });
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
        return res.status(500).json({ error: 'Could not determine Sonarr quality profile or root folder' });
      }
      const externalIds = await tmdbService.tmdbFetchPublic(`/tv/${tmdbId}/external_ids`).catch(() => ({}));
      const tvdbId = externalIds?.tvdb_id;
      if (!tvdbId) {
        return res.status(400).json({ error: 'Could not resolve TVDB ID for this show. TMDB may not have a TVDB mapping yet.' });
      }
      let seasonsPayload = undefined;
      if (Array.isArray(seasons) && seasons.length > 0) {
        // Individual seasons: look up series from Sonarr to get full season list
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
        headers: {
          'X-Api-Key': c.sonarrApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sonarrBody),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const body = await r.text();
        return res.status(r.status).json({ error: `Sonarr error: ${body}` });
      }
    }

    // Log the request so it shows as "Already Requested" in the UI.
    // No pool rebuild needed — isRequested is applied dynamically on every
    // getDiscoverRecommendations() call by reading db.getAllRequestedTmdbIds().
    const seasonsCount = mediaType === 'tv'
      ? (Array.isArray(seasons) && seasons.length > 0 ? seasons.length : 1)
      : 1;
    db.addDiscoverRequest(userId, tmdbId, mediaType, title || '', service, seasonsCount);
    logger.info(`Request submitted: user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}" service=${service}`);

    // Add the item to the user's native Plex.tv Watchlist so they can track it
    // in the Plex app while waiting for the download.
    // Exception: skip for the server owner when in playlist mode — the playlist
    // is monitored by download automation (e.g. pd_zurg) and the request already
    // handles the download; adding to the playlist would trigger a duplicate attempt.
    const watchlistMode = db.getAdminWatchlistMode();
    const ownerUserId = db.getOwnerUserId();
    const isOwnerInPlaylistMode = watchlistMode === 'playlist' && userId === ownerUserId;

    if (!isOwnerInPlaylistMode) {
      // Requested items are not yet in the library — find them on Plex Discover
      // by TMDB ID match and add to the user's plex.tv Watchlist. Best-effort.
      const userToken = req.session.plexUser.token;
      fetch(`https://discover.provider.plex.tv/library/search?query=${encodeURIComponent(title || '')}&limit=10&X-Plex-Token=${userToken}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
        .then(r => r.ok ? r.json() : null)
        .then(async data => {
          const hits = data?.MediaContainer?.SearchResult || [];
          const hit = hits.find(h => {
            // Guid array: [{ id: "tmdb://12345" }, ...]
            const guids = h.Metadata?.Guid || [];
            const hasTmdb = guids.some(g => g.id === `tmdb://${tmdbId}`);
            const titleMatch = h.Metadata?.title === title && String(h.Metadata?.year) === String(year);
            return hasTmdb || titleMatch;
          });
          if (!hit?.Metadata?.ratingKey) return;
          // ratingKey from discover.provider.plex.tv is already the plex GUID hash
          const plexGuid = String(hit.Metadata.ratingKey);
          await plexService.addToPlexTvWatchlistByGuid(userToken, plexGuid);
        })
        .catch(() => {}); // best-effort
    }

    res.json({ success: true });
  } catch (err) {
    console.error('request error:', err);
    res.status(500).json({ error: 'Request failed: ' + err.message });
  }
});

module.exports = router;
