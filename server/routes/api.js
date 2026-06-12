const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discordAgent = require('../services/discordAgent');
const pushoverAgent = require('../services/pushoverAgent');
const discoverRecommender = require('../services/discoverRecommender');
const tmdbService = require('../services/tmdb');
const tmdbIntegration = require('../services/tmdbIntegration');
const tautulliService = require('../services/tautulli');
const overseerrService = require('../services/overseerr');
const reviewFeed = require('../services/reviewFeed');
const reviewCardCache = require('../services/reviewCardCache');
const db = require('../db/database');
const logger = require('../services/logger');
const cryptoUtil = require('../utils/crypto');
const { mapReviewToTmdb } = require('../services/integrationCapabilities');
const monitorMatcher = require('../services/monitorMatcher');
const monitorNotifier = require('../services/monitorNotifier');

// Reverse maps: TMDB genre ID → genre name (built once at startup)
const MOVIE_ID_TO_GENRE = {};
const TV_ID_TO_GENRE = {};
for (const [name, ids] of Object.entries(tmdbService.MOVIE_GENRE_MAP || {})) {
  for (const id of ids) MOVIE_ID_TO_GENRE[id] = name;
}
for (const [name, ids] of Object.entries(tmdbService.TV_GENRE_MAP || {})) {
  for (const id of ids) { if (!TV_ID_TO_GENRE[id]) TV_ID_TO_GENRE[id] = name; }
}

router.use(requireAuth);

// Abuse guards for compute/TMDB-heavy endpoints. Limits are far above normal
// browsing rates — they only stop a user or leaked key from hammering routes
// that fan out to TMDB/Tautulli or rebuild recommendations.
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});
// Posters load per-card (a page can request 100+ at once), so this ceiling is high.
const posterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});
router.use('/recommendations', heavyLimiter);
router.use('/search', heavyLimiter);
router.use('/trailer', heavyLimiter);
router.use('/poster', posterLimiter);

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

// GET /api/popular
// Returns most popular movies and TV shows from Tautulli (last 90 days),
// enriched with library metadata and TMDB cache.
router.get('/popular', async (req, res) => {
  try {
    const { id: userId } = req.session.plexUser;
    const tautulliData = await tautulliService.getPopularItems();

    const POPULAR_LIMIT = 20; // display up to this many genuine library items per section
    const enrichItems = async (items, mediaType) => {
      const result = [];
      for (const entry of items) {
        if (result.length >= POPULAR_LIMIT) break;
        const libItem = db.getLibraryItemByKey(entry.ratingKey);
        if (!libItem) continue;

        const tmdbCached = libItem.tmdbId ? db.getTmdbCache(libItem.tmdbId, mediaType) : null;

        result.push({
          ...libItem,
          posterUrl: tmdbCached?.posterUrl || libItem.thumb || null,
          backdropUrl: tmdbCached?.backdropUrl || libItem.art || null,
          audienceRating: tmdbCached?.voteAverage || libItem.audienceRating || 0,
          contentRating: tmdbCached?.contentRating || libItem.contentRating || '',
          deepLink: libItem.ratingKey ? plexService.getDeepLink(libItem.ratingKey) : null,
          plexAppLink: libItem.ratingKey ? plexService.getAppLink(libItem.ratingKey) : null,
        });
      }
      return result;
    };

    const watchlistKeys = new Set(db.getWatchlistFromDb(userId)); // array -> Set of ratingKey strings
    const watchedKeys = db.getWatchedKeysFromDb(userId);          // already a Set

    const [movies, tvShows] = await Promise.all([
      enrichItems(tautulliData.movies, 'movie'),
      enrichItems(tautulliData.tvShows, 'tv'),
    ]);

    const markStatus = (items) => items.map(item => ({
      ...item,
      isInWatchlist: watchlistKeys.has(item.ratingKey),
      isWatched: watchedKeys.has(item.ratingKey),
    }));

    res.json({
      movies: markStatus(movies),
      tvShows: markStatus(tvShows),
    });
  } catch (err) {
    logger.error('popular error:', err.message);
    res.json({ movies: [], tvShows: [] });
  }
});

// GET /api/poster?path=/library/metadata/...
// Proxies Plex poster through server — browser never sees Plex token
router.get('/poster', async (req, res) => {
  const { path: posterPath } = req.query;

  // Security: only Plex /library/ paths with no traversal segments — blocks
  // SSRF to other hosts and stops '..' from reaching non-library Plex
  // endpoints (e.g. /library/../status/sessions) with the server token.
  if (!posterPath || !posterPath.startsWith('/library/') || posterPath.split('/').includes('..')) {
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
  const items = keys.map(k => {
    const libItem = db.getLibraryItemByKey(k);
    return {
      ratingKey: k,
      isWatched: watchedKeys.has(String(k)),
      isInWatchlist: true,
      ...(libItem || {}),
    };
  });
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
    const { id: userId } = req.session.plexUser;
    const {
      type = 'all',
      genres = '',
      decade = '',
      minScore = '0',
      sort = 'recommended',
      page = '1',
      q = '',
      contentRatings = '',
      directors = '',
      actors = '',
      writers = '',
      producers = '',
      countries = '',
      collections = '',
      studios = '',
      editions = '',
      labels = '',
      year = '',
      releaseFrom = '',
      releaseTo = '',
      durationMin = '',
      durationMax = '',
    } = req.query;

    const PAGE_SIZE = 40;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const minScoreNum = parseFloat(minScore) || 0;
    const searchQuery = q.trim().toLowerCase();
    // Comma-separated multi-value filters → lowercase lists for case-insensitive matching.
    const csv = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
    const csvLower = s => csv(s).map(x => x.toLowerCase());
    const genreList = csvLower(genres);
    const contentRatingList = csv(contentRatings);
    const directorList = csvLower(directors);
    const actorList = csvLower(actors);
    const writerList = csvLower(writers);
    const producerList = csvLower(producers);
    const countryList = csvLower(countries);
    const collectionList = csvLower(collections);
    const studioList = csvLower(studios);
    const editionList = csvLower(editions);
    const labelList = csvLower(labels);
    const yearNum = parseInt(year) || 0;
    // Release date range (YYYY-MM-DD strings, lexicographically comparable).
    const relFrom = releaseFrom.trim();
    const relTo = releaseTo.trim();
    // Duration range in minutes (UI) → milliseconds (stored).
    const durMinMs = durationMin ? parseInt(durationMin) * 60000 : 0;
    const durMaxMs = durationMax ? parseInt(durationMax) * 60000 : 0;
    // Match a lowercased filter list against an item's multi-value array (any-of).
    const someMatch = (list, arr) => {
      if (list.length === 0) return true;
      const lower = (arr || []).map(v => String(v).toLowerCase());
      return list.some(v => lower.includes(v));
    };

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

    // Pool minus dismissed — basis for the available-options chips
    const visiblePool = pool.filter(item => !dismissedKeys.has(item.ratingKey));

    // Apply filters
    let filtered = visiblePool.filter(item => {
      if (searchQuery && !item.title.toLowerCase().includes(searchQuery)) return false;
      if (item.audienceRating < minScoreNum) return false;
      if (!someMatch(genreList, item.genres)) return false;
      if (decade) {
        const d = parseInt(decade);
        if (!item.year || Math.floor(item.year / 10) * 10 !== d) return false;
      }
      if (yearNum && item.year !== yearNum) return false;
      if (contentRatingList.length > 0 && !contentRatingList.includes(item.contentRating)) return false;
      if (!someMatch(directorList, item.directors)) return false;
      if (!someMatch(actorList, item.cast)) return false;
      if (!someMatch(writerList, item.writers)) return false;
      if (!someMatch(producerList, item.producers)) return false;
      if (!someMatch(countryList, item.countries)) return false;
      if (!someMatch(collectionList, item.collections)) return false;
      if (!someMatch(labelList, item.labels)) return false;
      if (studioList.length > 0 && !studioList.includes(String(item.studio || '').toLowerCase())) return false;
      if (editionList.length > 0 && !editionList.includes(String(item.edition || '').toLowerCase())) return false;
      if (relFrom && (!item.releaseDate || item.releaseDate < relFrom)) return false;
      if (relTo && (!item.releaseDate || item.releaseDate > relTo)) return false;
      if (durMinMs && (item.duration || 0) < durMinMs) return false;
      if (durMaxMs && (item.duration || 0) > durMaxMs) return false;
      return true;
    });

    // Sort — fetch the extra per-user data sources only for the sorts that need them.
    let userRatings = null;
    let viewStats = null;
    if (sort === 'user_rating') {
      userRatings = db.getUserRatingsFromDb(String(userId)); // Map<ratingKey, rating>
    } else if (sort === 'date_viewed' || sort === 'plays') {
      viewStats = await tautulliService.getViewStats(userId); // { ratingKey: {lastViewedAt, plays} }
    }

    if (sort === 'rating') {
      filtered.sort((a, b) => b.audienceRating - a.audienceRating);
    } else if (sort === 'critic_rating') {
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sort === 'content_rating') {
      const idx = r => { const i = CONTENT_RATING_ORDER_SERVER.indexOf(r); return i === -1 ? 999 : i; };
      filtered.sort((a, b) => idx(a.contentRating) - idx(b.contentRating));
    } else if (sort === 'year_desc') {
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sort === 'year_asc') {
      filtered.sort((a, b) => (a.year || 0) - (b.year || 0));
    } else if (sort === 'release_desc') {
      filtered.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
    } else if (sort === 'release_asc') {
      filtered.sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));
    } else if (sort === 'added') {
      filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else if (sort === 'last_episode') {
      filtered.sort((a, b) => (b.lastEpisodeAddedAt || 0) - (a.lastEpisodeAddedAt || 0));
    } else if (sort === 'duration_desc') {
      filtered.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    } else if (sort === 'duration_asc') {
      filtered.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    } else if (sort === 'unwatched') {
      // Unwatched first, then by audience rating within each group.
      filtered.sort((a, b) => {
        const aw = watchedKeys.has(a.ratingKey) ? 1 : 0;
        const bw = watchedKeys.has(b.ratingKey) ? 1 : 0;
        return aw - bw || b.audienceRating - a.audienceRating;
      });
    } else if (sort === 'user_rating') {
      filtered.sort((a, b) => (userRatings.get(b.ratingKey) || 0) - (userRatings.get(a.ratingKey) || 0));
    } else if (sort === 'date_viewed') {
      filtered.sort((a, b) => (viewStats[b.ratingKey]?.lastViewedAt || 0) - (viewStats[a.ratingKey]?.lastViewedAt || 0));
    } else if (sort === 'plays') {
      filtered.sort((a, b) => (viewStats[b.ratingKey]?.plays || 0) - (viewStats[a.ratingKey]?.plays || 0));
    } else if (sort === 'title') {
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      // 'recommended' — sort by audience rating as proxy when no personal profile applied
      filtered.sort((a, b) => b.audienceRating - a.audienceRating);
    }

    const total = filtered.length;
    const items = filtered.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE);

    // Get all available genres and content ratings from the visible pool for the filter UI
    const allGenres = [...new Set(visiblePool.flatMap(i => i.genres))].sort();
    const ratingSet = new Set(visiblePool.map(i => i.contentRating).filter(Boolean));
    const availableContentRatings = CONTENT_RATING_ORDER_SERVER.filter(r => ratingSet.has(r));

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
      availableContentRatings,
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

// GET /api/discover/facets?field=<f>&q=<text>&limit=<n>
// Distinct filter values computed in-memory from the cached library (no Plex call).
// Small fields return the full (optionally q-filtered) list; high-cardinality person fields
// (actor/director/writer/producer) require q and return the top matches for type-ahead.
const FACET_MULTI = {
  genre: 'genres', country: 'countries', collection: 'collections',
  label: 'labels', actor: 'cast', director: 'directors',
  writer: 'writers', producer: 'producers',
};
const FACET_SCALAR = { studio: 'studio', edition: 'edition', contentRating: 'contentRating' };
const FACET_HIGH_CARDINALITY = new Set(['actor', 'director', 'writer', 'producer']);

router.get('/discover/facets', async (req, res) => {
  try {
    const field = String(req.query.field || '');
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));

    if (field === 'decade') {
      const [movies, tv] = await Promise.all([
        plexService.getLibraryItems(plexService.MOVIES_SECTION),
        plexService.getLibraryItems(plexService.TV_SECTION),
      ]);
      const decades = [...new Set([...movies, ...tv]
        .map(i => i.year ? Math.floor(i.year / 10) * 10 : null).filter(Boolean))]
        .sort((a, b) => b - a).map(d => String(d));
      return res.json({ values: decades });
    }

    const multiKey = FACET_MULTI[field];
    const scalarKey = FACET_SCALAR[field];
    if (!multiKey && !scalarKey) return res.status(400).json({ error: 'Unknown facet field' });

    // High-cardinality person fields need a query to avoid returning tens of thousands of names.
    if (FACET_HIGH_CARDINALITY.has(field) && !q) return res.json({ values: [] });

    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);
    const pool = [...movies, ...tv];

    const set = new Set();
    for (const item of pool) {
      if (multiKey) {
        for (const v of (item[multiKey] || [])) { if (v && String(v).trim()) set.add(String(v)); }
      } else {
        const v = item[scalarKey];
        if (v && String(v).trim()) set.add(String(v));
      }
    }

    let values = [...set];
    if (q) values = values.filter(v => v.toLowerCase().includes(q));
    values.sort((a, b) => a.localeCompare(b));
    if (FACET_HIGH_CARDINALITY.has(field)) values = values.slice(0, limit);

    res.json({ values });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch facet values' });
  }
});

// GET /api/clients — list Plex player clients for the logged-in user
// Uses plex.tv cloud sources only (user's own token) so each user sees their own devices.
// Server-side sources (PMS /clients, GDM UDP) are intentionally excluded — they discover
// devices on the server's LAN and would expose the admin's devices to all users.
// Both plex.tv calls below are slow (~1-2s); device lists change rarely, so a
// short per-user cache makes reopening the cast picker instant.
const _clientsCache = new Map(); // userId -> { clients, at }
const CLIENTS_CACHE_TTL = 5 * 60 * 1000;

router.get('/clients', async (req, res) => {
  try {
    const { token: userToken, id: clientsUserId } = req.session.plexUser;
    const cachedClients = _clientsCache.get(String(clientsUserId));
    if (cachedClients && Date.now() - cachedClients.at < CLIENTS_CACHE_TTL) {
      return res.json({ clients: cachedClients.clients });
    }
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
            && !provides.includes('server')
            && r.owned === true
            && r.clientIdentifier && !seenIds.has(r.clientIdentifier)) {
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
        if (id && attrs.owned === '1' && TV_PRODUCT_RE.test(product) && !seenIds.has(id)) {
          clients.push({ name: attrs.name || id, machineIdentifier: id, product, platform: attrs.platform || '' });
          seenIds.add(id);
        }
      }
    } else {
      logger.debug('/api/clients: devices.xml fetch skipped or failed:', devicesXmlResult.reason?.message || devicesXmlResult.value?.status);
    }

    logger.debug(`/api/clients: user=${req.session.plexUser.id} total=${clients.length}`);
    _clientsCache.set(String(req.session.plexUser.id), { clients, at: Date.now() });
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
          if (r.clientIdentifier === clientId && r.owned === true && Array.isArray(r.connections) && r.connections.length) {
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

// ── Blacklist (unified dismissals view) ───────────────────────────────────────

// GET /api/blacklist — current user's blacklisted items enriched with metadata
router.get('/blacklist', async (req, res) => {
  const { id: userId } = req.session.plexUser;
  const items = [];

  try {
    // Library dismissals — join with library_items for metadata
    const libRows = db.getUserDismissalRows(userId);
    for (const row of libRows) {
      const lib = db.getLibraryItemByKey(row.rating_key);
      if (lib) {
        const thumbPath = lib.thumb || lib.art;
        let posterUrl = null;
        if (thumbPath) {
          posterUrl = thumbPath.startsWith('http') ? thumbPath : `/api/poster?path=${encodeURIComponent(thumbPath)}`;
        }
        items.push({
          ratingKey: row.rating_key,
          title: lib.title || 'Unknown',
          year: lib.year || null,
          posterUrl,
          type: lib.type === 'show' ? 'show' : 'movie',
          source: 'library',
          dismissed_at: row.dismissed_at,
        });
      }
    }

    // Explore dismissals — enrich via TMDB cache, fallback to live fetch
    const exploreRows = db.getUserExploreDismissalRows(userId);
    for (const row of exploreRows) {
      const tmdbId = row.tmdb_id;
      const mediaType = row.media_type;
      let title = null;
      let year = null;
      let posterUrl = null;

      // Try cache first
      const cached = db.getTmdbCache(tmdbId, mediaType);
      if (cached) {
        try {
          const data = JSON.parse(cached);
          title = data.title || data.name;
          const dateStr = data.release_date || data.first_air_date || '';
          year = dateStr ? parseInt(dateStr.slice(0, 4)) : null;
          if (data.poster_path) posterUrl = `https://image.tmdb.org/t/p/w200${data.poster_path}`;
        } catch { /* ignore parse error */ }
      }

      // Fallback to live TMDB fetch
      if (!title && db.hasTmdbKey()) {
        try {
          const json = await tmdbService.tmdbFetchPublic(`/${mediaType}/${tmdbId}`);
          title = json.title || json.name;
          const dateStr = json.release_date || json.first_air_date || '';
          year = dateStr ? parseInt(dateStr.slice(0, 4)) : null;
          if (json.poster_path) posterUrl = `https://image.tmdb.org/t/p/w200${json.poster_path}`;
          // Cache it
          db.setTmdbCache(tmdbId, mediaType, JSON.stringify(json));
        } catch { /* ignore fetch error */ }
      }

      items.push({
        tmdbId,
        mediaType,
        title: title || `TMDB ${tmdbId}`,
        year,
        posterUrl,
        type: mediaType === 'tv' ? 'show' : 'movie',
        source: 'explore',
        dismissed_at: row.dismissed_at,
      });
    }
  } catch (err) {
    logger.error('blacklist fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch blacklist' });
  }

  res.json({ items });
});

// DELETE /api/blacklist/library/:ratingKey — remove library dismissal
router.delete('/blacklist/library/:ratingKey', (req, res) => {
  const { ratingKey } = req.params;
  if (!/^\d+$/.test(String(ratingKey))) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }

  const { id: userId } = req.session.plexUser;
  db.removeDismissal(userId, ratingKey);
  recommender.invalidateUserCache(userId);
  try { require('../services/discoverRecommender').invalidateUserCache(userId); } catch {}
  res.json({ success: true });
});

// DELETE /api/blacklist/explore/:tmdbId/:mediaType — remove explore dismissal
router.delete('/blacklist/explore/:tmdbId/:mediaType', (req, res) => {
  const { tmdbId, mediaType } = req.params;
  if (!/^\d+$/.test(String(tmdbId))) {
    return res.status(400).json({ error: 'Invalid tmdbId' });
  }
  if (!['movie', 'tv'].includes(mediaType)) {
    return res.status(400).json({ error: 'Invalid mediaType' });
  }

  const { id: userId } = req.session.plexUser;
  db.removeExploreDismissal(userId, tmdbId, mediaType);
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
      // Rotten Tomatoes critic/audience scores live only on the Plex library item
      // (not TMDB), so surface them from the cross-referenced match. Lets the detail
      // modal show the Tomatometer/Audience badges on any page that builds items
      // from this endpoint (Reviews, profiles, deep links…), matching the library grid.
      rating: libItem?.rating || null,
      ratingImage: libItem?.ratingImage || null,
      audienceRating: libItem?.audienceRating || null,
      audienceRatingImage: libItem?.audienceRatingImage || null,
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

// GET /api/search?q=term&genre=name&type=movie|tv&page=N
//        &contentRatings=PG,PG-13&filterGenres=Action,Drama
//        &yearFrom=2000&yearTo=2010&minScore=7
// Supports text search (q) and genre-based browsing (genre + type), with
// server-side filtering applied uniformly so the total count, pagination,
// and availableContentRatings/availableGenres all reflect the filtered set.
const SEARCH_PAGE_SIZE = 40;
const CONTENT_RATING_ORDER_SERVER = ['G','PG','PG-13','R','NC-17','TV-G','TV-PG','TV-14','TV-MA'];
const TEXT_SEARCH_MAX_TMDB_PAGES = 3;

// In-memory cache of the TMDB-derived pool per (query, lang, region). Keeps
// filter changes instant — they re-slice this pool instead of re-hitting TMDB.
// Pool contains user-independent data only; per-user fields (inLibrary,
// watchlist, etc.) are layered on at request time.
const SEARCH_POOL_TTL_MS = 10 * 60 * 1000;
const SEARCH_POOL_MAX_ENTRIES = 100;
const _searchPoolCache = new Map();

function getSearchPool(key) {
  const entry = _searchPoolCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_POOL_TTL_MS) {
    _searchPoolCache.delete(key);
    return null;
  }
  // Refresh LRU position
  _searchPoolCache.delete(key);
  _searchPoolCache.set(key, entry);
  return entry.items;
}

function setSearchPool(key, items) {
  if (_searchPoolCache.size >= SEARCH_POOL_MAX_ENTRIES) {
    const firstKey = _searchPoolCache.keys().next().value;
    if (firstKey !== undefined) _searchPoolCache.delete(firstKey);
  }
  _searchPoolCache.set(key, { items, ts: Date.now() });
}

function parseCsv(v) {
  if (!v) return [];
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function applySearchFilters(pool, { filterGenres, contentRatings, yearFrom, yearTo, minScore }) {
  return pool.filter(item => {
    if (filterGenres.length > 0) {
      const itemGenres = (item.genres || []);
      if (!filterGenres.every(g => itemGenres.includes(g))) return false;
    }
    if (contentRatings.length > 0) {
      if (!contentRatings.includes(item.contentRating)) return false;
    }
    if (yearFrom != null && (item.year || 0) < yearFrom) return false;
    if (yearTo != null && (item.year || Infinity) > yearTo) return false;
    if (minScore != null && (item.voteAverage || 0) < minScore) return false;
    return true;
  });
}

function computeAvailable(pool) {
  const ratingSet = new Set();
  const genreSet = new Set();
  for (const item of pool) {
    if (item.contentRating) ratingSet.add(item.contentRating);
    for (const g of (item.genres || [])) if (g) genreSet.add(g);
  }
  return {
    availableContentRatings: CONTENT_RATING_ORDER_SERVER.filter(r => ratingSet.has(r)),
    availableGenres: [...genreSet].sort(),
  };
}

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const genre = (req.query.genre || '').trim();
  const type = (req.query.type || 'movie').toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const filterGenres = parseCsv(req.query.filterGenres);
  const contentRatings = parseCsv(req.query.contentRatings);
  const yearFrom = req.query.yearFrom ? parseInt(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? parseInt(req.query.yearTo) : null;
  const minScore = req.query.minScore ? parseFloat(req.query.minScore) : null;
  const filterOpts = { filterGenres, contentRatings, yearFrom, yearTo, minScore };

  if (!q && !genre) {
    return res.json({ results: [], total: 0, pages: 0, page: 1, query: '', availableContentRatings: [], availableGenres: [] });
  }

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
      return res.json({ results: matched, total: matched.length, pages: 1, page: 1, query: q, availableContentRatings: [], availableGenres: [] });
    } catch (err) {
      console.error('search error:', err);
      return res.status(500).json({ error: 'Search failed: ' + err.message });
    }
  }

  try {
    const { id: userId } = req.session.plexUser;
    const isGenreSearch = !!genre;
    const userPrefs = db.getUserPreferences(userId);
    const userLanguage = userPrefs?.language || null;
    const userRegion = userPrefs?.region || null;

    // Fetch library items for cross-referencing
    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);

    const libraryTmdbIds = new Set([...movies, ...tv].filter(i => i.tmdbId).map(i => String(i.tmdbId)));
    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));
    const watchedKeys = db.getWatchedKeysFromDb(String(userId));
    const requestedIds = db.getAllRequestedTmdbIds();

    const poolKey = isGenreSearch
      ? `g:${genre.toLowerCase()}:${userLanguage || ''}:${userRegion || ''}:${type}`
      : `q:${q.toLowerCase()}:${userLanguage || ''}:${userRegion || ''}`;

    let externalResults = getSearchPool(poolKey);

    if (!externalResults) {
      if (isGenreSearch) {
        let cachedMovies = db.getItemsByGenre('movie', genre);
        let cachedTV = db.getItemsByGenre('tv', genre);

        if (userLanguage) {
          cachedMovies = cachedMovies.filter(item => item.originalLanguage === userLanguage);
          cachedTV = cachedTV.filter(item => item.originalLanguage === userLanguage);
        }

        if (cachedMovies.length > 0 || cachedTV.length > 0) {
          externalResults = [...cachedMovies, ...cachedTV];
          console.log(`[search] Genre "${genre}": ${cachedMovies.length} movies + ${cachedTV.length} tv from db cache`);
        } else {
          const MAX_CANDIDATE_PAGES = 5;
          const allCandidates = [];
          const fetchType = ['movie', 'tv'].includes(type) ? type : 'movie';
          const discoverOpts = {};
          if (userRegion) discoverOpts.region = userRegion;
          if (userLanguage) discoverOpts.language = userLanguage;
          for (let p = 1; p <= MAX_CANDIDATE_PAGES; p++) {
            const pageResults = await tmdbService.discoverByGenreName(genre, fetchType, p, { includeAdult: true, ...discoverOpts });
            if (!pageResults.length) break;
            allCandidates.push(...pageResults);
          }
          const enriched = await tmdbService.batchGetDetails(
            allCandidates.map(r => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }))
          );
          externalResults = enriched.filter(item => item !== null);
          if (userLanguage) {
            externalResults = externalResults.filter(item => item.originalLanguage === userLanguage);
          }
        }
      } else {
        const allMatches = [];
        for (let p = 1; p <= TEXT_SEARCH_MAX_TMDB_PAGES; p++) {
          const json = await tmdbService.tmdbFetchPublic(
            `/search/multi?query=${encodeURIComponent(q)}&page=${p}&include_adult=false`
          );
          const pageItems = (json?.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
          if (!pageItems.length) break;
          allMatches.push(...pageItems);
          if (p >= (json?.total_pages || 1)) break;
        }
        const enriched = await tmdbService.batchGetDetails(
          allMatches.map(r => ({ tmdbId: r.id, mediaType: r.media_type }))
        );
        externalResults = enriched.filter(item => item !== null);
      }

      setSearchPool(poolKey, externalResults);
    } else {
      console.log(`[search] pool cache hit "${poolKey}" (${externalResults.length} items)`);
    }

    // Common path: enrich, filter, paginate (works for both genre and text search)
    const libraryByTmdb = new Map();
    for (const item of [...movies, ...tv]) {
      if (item.tmdbId) libraryByTmdb.set(String(item.tmdbId), item);
    }

    // For genre search we historically hide items already in library; preserve that.
    // Text search keeps in-library items so users can find what they own.
    const visiblePool = isGenreSearch
      ? externalResults.filter(item => !libraryTmdbIds.has(String(item.tmdbId)))
      : externalResults;

    let filteredPool = applySearchFilters(visiblePool, filterOpts);
    const { availableContentRatings, availableGenres } = computeAvailable(visiblePool);

    // Sort by popularity (fallback voteAverage) so highest-signal items lead.
    filteredPool.sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || (b.voteAverage || 0) - (a.voteAverage || 0));

    const total = filteredPool.length;
    // Genre browsing needs the full set so the Movies/TV tabs are accurate and
    // the user sees the same depth as before. Text search paginates to avoid
    // shipping hundreds of unrelated TMDB hits at once.
    const usePagination = !isGenreSearch;
    const pages = usePagination ? Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE)) : 1;
    const pageItems = usePagination
      ? filteredPool.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE)
      : filteredPool;

    const results = pageItems.map(item => {
      const libItem = libraryByTmdb.get(String(item.tmdbId));
      const inLibrary = isGenreSearch ? false : !!libItem;
      return {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        title: item.title,
        year: item.year,
        releaseDate: item.releaseDate || null,
        overview: item.overview || '',
        posterUrl: item.posterUrl,
        voteAverage: item.voteAverage || 0,
        genres: item.genres || [],
        contentRating: item.contentRating || null,
        inLibrary,
        ratingKey: inLibrary ? libItem.ratingKey : null,
        deepLink: inLibrary ? plexService.getDeepLink(libItem.ratingKey) : null,
        plexAppLink: inLibrary ? plexService.getAppLink(libItem.ratingKey) : null,
        isInWatchlist: inLibrary ? watchlistKeys.has(libItem.ratingKey) : false,
        isWatched: inLibrary ? watchedKeys.has(libItem.ratingKey) : false,
        isRequested: !inLibrary && requestedIds.has(`${item.tmdbId}:${item.mediaType}`),
      };
    });

    res.json({
      results,
      total,
      pages,
      page,
      query: isGenreSearch ? genre : q,
      availableContentRatings,
      availableGenres,
    });
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// ── "More Like This" ──────────────────────────────────────────────────────────
// GET /api/search/similar?tmdbId=X&type=movie|tv&hideLibrary=false
// Returns up to 20 similar items (cross-type) based on TMDB similarity + local
// metadata overlap.  Enforces request permission and hide-in-library filters.
router.get('/search/similar', async (req, res) => {
  const { tmdbId, type, hideLibrary } = req.query;
  if (!tmdbId || !['movie', 'tv'].includes(type)) {
    return res.status(400).json({ error: 'tmdbId and type are required' });
  }
  if (!/^\d+$/.test(String(tmdbId))) {
    return res.status(400).json({ error: 'Invalid tmdbId' });
  }
  const numericTmdbId = Number(tmdbId);
  const hideLib = hideLibrary === 'true';
  const { id: userId } = req.session.plexUser;
  const discoverEnabled = db.isDiscoverEnabled();
  const requestedIds = db.getAllRequestedTmdbIds();
  const dismissedKeys = db.getDismissals(userId);

  try {
    // Fetch library items for cross-referencing inLibrary status
    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);
    const libraryByTmdb = new Map();
    for (const item of [...movies, ...tv]) {
      if (item.tmdbId) libraryByTmdb.set(String(item.tmdbId), item);
    }
    const watchedKeys = db.getWatchedKeysFromDb(String(userId));
    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));

    // Helper to build a result item from a TMDB-enriched candidate
    function buildResult(candidate) {
      const libItem = libraryByTmdb.get(String(candidate.tmdbId));
      if (hideLib && libItem) return null;
      if (!discoverEnabled && !libItem) return null;
      return {
        tmdbId: candidate.tmdbId,
        mediaType: candidate.mediaType,
        title: candidate.title,
        year: candidate.year || null,
        releaseDate: candidate.releaseDate || null,
        overview: candidate.overview || '',
        posterUrl: candidate.posterUrl,
        voteAverage: candidate.voteAverage || 0,
        genres: candidate.genres || [],
        contentRating: candidate.contentRating || null,
        inLibrary: !!libItem,
        ratingKey: libItem?.ratingKey || null,
        deepLink: libItem ? plexService.getDeepLink(libItem.ratingKey) : null,
        plexAppLink: libItem ? plexService.getAppLink(libItem.ratingKey) : null,
        isInWatchlist: libItem ? watchlistKeys.has(libItem.ratingKey) : false,
        isWatched: libItem ? watchedKeys.has(libItem.ratingKey) : false,
        isRequested: !libItem && requestedIds.has(`${candidate.tmdbId}:${candidate.mediaType}`),
        _popularity: candidate.popularity || 0,
        _rank: candidate._rank ?? 9999,
      };
    }

    // ── TMDB path ──────────────────────────────────────────────────────────
    if (db.hasTmdbKey()) {
      // Get source item details (for title)
      const sourceDetails = await tmdbService.getItemDetails(numericTmdbId, type).catch(() => null);
      if (!sourceDetails) {
        return res.json({ sourceTitle: null, similar: [] });
      }

      const sourceTitle = sourceDetails.title;
      const allCandidates = [];
      const seenKeys = new Set();
      seenKeys.add(`${numericTmdbId}:${type}`); // exclude the source item itself

      // Use /recommendations (3 pages) as the candidate pool.
      // /similar is intentionally excluded: it uses naive genre/keyword bag-matching and
      // consistently returns unrelated content. /recommendations is editorially curated
      // and produces meaningfully related results.
      const fetches = [
        tmdbService.getRecommendations(numericTmdbId, type, 1).catch(() => []),
        tmdbService.getRecommendations(numericTmdbId, type, 2).catch(() => []),
        tmdbService.getRecommendations(numericTmdbId, type, 3).catch(() => []),
      ];
      const [recs1, recs2, recs3] = await Promise.all(fetches);
      const raw = [...recs1, ...recs2, ...recs3];

      // Deduplicate by (tmdbId, mediaType) — movies and TV share the same integer space
      for (const r of raw) {
        const key = `${r.tmdbId}:${r.mediaType}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        allCandidates.push(r);
      }

      // Enrich from cache (fast — most items already cached from pool builds).
      // Preserve insertion rank so TMDB's relevance ordering (similar > recs p1 > recs p2)
      // is not destroyed by a raw popularity re-sort later.
      const enriched = [];
      for (let i = 0; i < allCandidates.length; i++) {
        const c = allCandidates[i];
        const cached = db.getTmdbCache(c.tmdbId, c.mediaType);
        if (cached) {
          enriched.push({ ...cached, _rank: i });
        } else {
          // Fetch details for uncached items
          const details = await tmdbService.getItemDetails(c.tmdbId, c.mediaType).catch(() => null);
          if (details) enriched.push({ ...details, _rank: i });
        }
      }

      // Content-safety filter: block Kids TV (10762) and Reality/Talk (10764, 10767)
      // from appearing in results unless the source item is itself in that category.
      const KIDS_TV_GENRE_ID = 10762;
      const REALITY_GENRE_IDS = new Set([10764, 10767]);
      const sourceGenreIdSet = new Set(sourceDetails.genreIds || []);
      const sourceIsKidsTV = sourceGenreIdSet.has(KIDS_TV_GENRE_ID);
      const sourceIsReality = [...sourceGenreIdSet].some(id => REALITY_GENRE_IDS.has(id));

      const safeEnriched = enriched.filter(candidate => {
        const candIds = new Set(candidate.genreIds || []);
        if (candIds.has(KIDS_TV_GENRE_ID) !== sourceIsKidsTV) return false;
        const candIsReality = [...candIds].some(id => REALITY_GENRE_IDS.has(id));
        if (candIsReality !== sourceIsReality) return false;
        return true;
      });

      // Local metadata scoring: rerank TMDB recommendations by verified metadata overlap.
      // TMDB ordering is used as a tiebreaker, so items TMDB rates highly but with
      // no local overlap still appear — but items with strong overlap float to the top.
      function computeLocalScore(src, cand) {
        let s = 0;
        // Franchise / collection match (strongest signal)
        if (src.collection && cand.collection && src.collection === cand.collection) s += 50;
        // Director / creator overlap
        const srcDirs = new Set(src.directors || []);
        for (const d of (cand.directors || [])) if (srcDirs.has(d)) s += 20;
        // Top-5 cast overlap (avoid minor-role noise)
        const srcCast = new Set((src.cast || []).slice(0, 5));
        for (const a of (cand.cast || []).slice(0, 5)) if (srcCast.has(a)) s += 8;
        // Genre overlap: primary genre (index 0) worth more than secondary
        const candGids = new Set(cand.genreIds || []);
        (src.genreIds || []).forEach((id, i) => { if (candGids.has(id)) s += i === 0 ? 10 : 5; });
        // Keyword / theme overlap
        const srcKws = new Set(src.keywords || []);
        for (const kw of (cand.keywords || [])) if (srcKws.has(kw)) s += 2;
        // Same original language
        if (src.originalLanguage && src.originalLanguage === cand.originalLanguage) s += 3;
        return s;
      }

      // Sort: local metadata score first, TMDB position as tiebreaker, popularity last
      const scoredEnriched = safeEnriched.map(c => ({ ...c, _localScore: computeLocalScore(sourceDetails, c) }));
      scoredEnriched.sort((a, b) => b._localScore - a._localScore || a._rank - b._rank || b.popularity - a.popularity);

      const results = scoredEnriched
        .map(buildResult)
        .filter(Boolean)
        .filter(item => !dismissedKeys.has(item.ratingKey))
        .slice(0, 20)
        .map(item => {
          delete item._popularity;
          delete item._rank;
          return item;
        });

      return res.json({ sourceTitle, similar: results });
    }

    // ── No-TMDB fallback: local metadata-based scoring ─────────────────────
    // Look up source item from cache
    const sourceCached = db.getTmdbCache(numericTmdbId, type);
    if (!sourceCached) {
      return res.json({ sourceTitle: null, similar: [] });
    }

    const sourceGenres = new Set(sourceCached.genres || []);
    const sourceCast = new Set(sourceCached.cast || []);
    const sourceDirectors = new Set(sourceCached.directors || []);
    const sourceStudio = sourceCached.studio ? new Set(sourceCached.studio.split(',').map(s => s.trim())) : new Set();
    const sourceKeywords = sourceCached.keywords || [];

    // Get all cached TMDB items (both movie and TV)
    const allCached = db.getAllTmdbCacheItems();

    // Score each candidate by overlap
    const FALLBACK_THRESHOLD = 12; // raised from 5: 2 genres alone (6 pts) no longer qualifies
    const sourceIsKidsTV = (sourceCached.genreIds || []).includes(10762);
    const scored = [];
    for (const item of allCached) {
      if (item.tmdbId === numericTmdbId) continue;
      let score = 0;

      for (const g of (item.genres || [])) if (sourceGenres.has(g)) score += 3;

      // Limit cast to top 5 to avoid minor-role contamination
      for (const a of (item.cast || []).slice(0, 5)) if (sourceCast.has(a)) score += 5;

      for (const d of (item.directors || [])) if (sourceDirectors.has(d)) score += 8;
      if (item.studio) {
        for (const s of item.studio.split(',').map(x => x.trim())) {
          if (sourceStudio.has(s)) score += 4;
        }
      }
      for (const kw of (item.keywords || [])) {
        if (sourceKeywords.includes(kw)) score += 2;
      }

      // Same media type bonus
      if (item.mediaType === type) score += 3;

      // Heavy penalty for kids/adult mismatch
      const itemIsKidsTV = (item.genreIds || []).includes(10762);
      if (itemIsKidsTV !== sourceIsKidsTV) score -= 20;

      if (score < FALLBACK_THRESHOLD) continue;
      scored.push({ ...item, score, _popularity: item.popularity || 0 });
    }

    scored.sort((a, b) => b.score - a.score || b._popularity - a._popularity);

    const results = scored
      .slice(0, 20)
      .map(item => {
        delete item.score;
        return buildResult(item);
      })
      .filter(Boolean)
      .filter(item => !dismissedKeys.has(item.ratingKey))
      .map(item => {
        delete item._popularity;
        delete item._rank;
        return item;
      });

    return res.json({ sourceTitle: sourceCached.title, similar: results });

  } catch (err) {
    logger.error('search/similar error:', err.message);
    res.status(500).json({ error: 'Failed to fetch similar items' });
  }
});

// GET /api/search/person?personId=X&hideLibrary=false
// Returns movies/TV a person is credited on (cast or crew), enriched with local
// library/watchlist/request status — powers the "More with X" search browse.
router.get('/search/person', async (req, res) => {
  const { personId, hideLibrary } = req.query;
  if (!personId || !/^\d+$/.test(String(personId))) {
    return res.status(400).json({ error: 'Valid personId is required' });
  }
  if (!db.hasTmdbKey()) return res.json({ credits: [] });

  const hideLib = hideLibrary === 'true';
  const { id: userId } = req.session.plexUser;
  const discoverEnabled = db.isDiscoverEnabled();
  const requestedIds = db.getAllRequestedTmdbIds();
  const dismissedKeys = db.getDismissals(userId);

  try {
    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);
    const libraryByTmdb = new Map();
    for (const item of [...movies, ...tv]) {
      if (item.tmdbId) libraryByTmdb.set(String(item.tmdbId), item);
    }
    const watchedKeys = db.getWatchedKeysFromDb(String(userId));
    const watchlistKeys = new Set(db.getWatchlistFromDb(userId));

    // Same shape as /search/similar so the cards render identically client-side.
    function buildResult(candidate) {
      const libItem = libraryByTmdb.get(String(candidate.tmdbId));
      if (hideLib && libItem) return null;
      if (!discoverEnabled && !libItem) return null;
      return {
        tmdbId: candidate.tmdbId,
        mediaType: candidate.mediaType,
        title: candidate.title,
        year: candidate.year || null,
        releaseDate: candidate.releaseDate || null,
        overview: candidate.overview || '',
        posterUrl: candidate.posterUrl,
        voteAverage: candidate.voteAverage || 0,
        genres: candidate.genres || [],
        contentRating: candidate.contentRating || null,
        inLibrary: !!libItem,
        ratingKey: libItem?.ratingKey || null,
        deepLink: libItem ? plexService.getDeepLink(libItem.ratingKey) : null,
        plexAppLink: libItem ? plexService.getAppLink(libItem.ratingKey) : null,
        isInWatchlist: libItem ? watchlistKeys.has(libItem.ratingKey) : false,
        isWatched: libItem ? watchedKeys.has(libItem.ratingKey) : false,
        isRequested: !libItem && requestedIds.has(`${candidate.tmdbId}:${candidate.mediaType}`),
      };
    }

    const candidates = await tmdbService.getPersonCombinedCredits(Number(personId));
    const credits = candidates
      .map(buildResult)
      .filter(Boolean)
      .filter(item => !item.ratingKey || !dismissedKeys.has(item.ratingKey))
      .slice(0, 40);

    return res.json({ credits });
  } catch (err) {
    logger.error('search/person error:', err.message);
    res.status(500).json({ error: 'Failed to fetch person credits' });
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
  const dumbPullActive = db.getSetting('dumb_request_mode', 'pull') === 'pull' && hasRiven;
  const defaultService = dumbPullActive
    ? 'riven'
    : (hasBothSides ? (c.defaultRequestService || 'overseerr') : null);
  const directRequestAccess = db.getDirectRequestAccess();
  res.json({ overseerr: hasOverseerr, radarr: hasRadarr, sonarr: hasSonarr, riven: hasRiven, defaultService, directRequestAccess });
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
    if (['1', 'true'].includes(db.getSetting('riven_enabled', '0')) && db.getSetting('dumb_request_mode', 'pull') === 'pull') {
      logger.info(`[riven] DUMB pull mode active — skipping push for tmdbId=${tmdbId}`);
      return;
    }
    if (!c.rivenEnabled || !c.rivenUrl) {
      throw new Error('Riven requests not configured');
    }
    // Resolve API key — stored override or auto-read from DUMB settings.json
    const fs = require('fs');
    const RIVEN_SETTINGS_PATH = process.env.RIVEN_SETTINGS_PATH || '/opt/riven/settings.json';
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

    // When DUMB pull mode is active, route to riven so submitRequestToService early-returns cleanly.
    const dumbPullActive = db.getSetting('dumb_request_mode', 'pull') === 'pull' && ['1', 'true'].includes(db.getSetting('riven_enabled', '0'));
    const effectiveService = dumbPullActive ? 'riven' : service;

    if (!autoApprove) {
      // Store as pending — do NOT submit to service
      db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title || '', effectiveService, seasonsCount, 'pending', seasons || null, storedPosterUrl);
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
    if (effectiveService !== 'none') await submitRequestToService({ tmdbId, mediaType, title, service: effectiveService, seasons });

    db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title || '', effectiveService, seasonsCount, 'approved', seasons || null, storedPosterUrl);
    logger.info(`Request submitted: user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}" service=${effectiveService}`);


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

// eslint-disable-next-line no-unused-vars -- spare admin guard; queue routes currently check inline
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
  const { status = 'all', page = '1', limit: limitParam = '25', sort: sortParam = 'requested_at', sortDir: sortDirParam = 'DESC', search: searchParam = '', userId: userIdParam = '', from: fromParam = '', to: toParam = '' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(limitParam) || 25));
  const pageNum = Math.max(1, parseInt(page) || 1);
  const ALLOWED_SORT_COLS = ['title', 'username', 'media_type', 'requested_at', 'status'];
  const sortCol = ALLOWED_SORT_COLS.includes(sortParam) ? sortParam : 'requested_at';
  const sortDir = sortDirParam === 'ASC' ? 'ASC' : 'DESC';
  const search = typeof searchParam === 'string' ? searchParam.trim() : '';
  const userIdFilter = isAdmin && typeof userIdParam === 'string' && userIdParam.trim() ? userIdParam.trim() : null;
  const dateFrom = (() => { const n = parseInt(fromParam, 10); return Number.isFinite(n) ? n : null; })();
  const dateTo = (() => { const n = parseInt(toParam, 10); return Number.isFinite(n) ? n : null; })();

  // 'requested' and 'available' are computed displayStatuses derived from approved rows:
  //   requested = approved + NOT in library
  //   available = approved + IN library
  // Both require fetching all approved and filtering in memory.
  const libraryTmdbIds = db.getLibraryTmdbIds();
  const isComputedFilter = status === 'requested' || status === 'available';
  const dbStatus = isComputedFilter ? 'approved' : status;

  let rows, total;
  if (isComputedFilter) {
    const all = isAdmin
      ? db.getAllRequests(10000, 0, 'approved', sortCol, sortDir, search || null, userIdFilter, dateFrom, dateTo)
      : db.getUserRequests(userId, 10000, 0, 'approved', sortCol, sortDir, search || null, dateFrom, dateTo);
    const filtered = all.rows.filter(r =>
      status === 'available' ? libraryTmdbIds.has(String(r.tmdb_id)) : !libraryTmdbIds.has(String(r.tmdb_id))
    );
    total = filtered.length;
    rows = filtered.slice((pageNum - 1) * limit, pageNum * limit);
  } else {
    ({ rows, total } = isAdmin
      ? db.getAllRequests(limit, (pageNum - 1) * limit, dbStatus, sortCol, sortDir, search || null, userIdFilter, dateFrom, dateTo)
      : db.getUserRequests(userId, limit, (pageNum - 1) * limit, dbStatus, sortCol, sortDir, search || null, dateFrom, dateTo));
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

// GET /api/queue/users — distinct users who have made requests (admin-only, for filter dropdown)
router.get('/queue/users', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
  res.json({ users: db.getRequestUsers() });
});

// GET /api/queue/:id — fetch a single request by id
router.get('/queue/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const request = db.getRequestById(parseInt(req.params.id));
  if (!request) return res.status(404).json({ error: 'Not found' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  if (!isAdmin && String(request.user_id) !== String(req.session.plexUser.id)) return res.status(403).json({ error: 'Forbidden' });
  res.json(request);
});

// PUT /api/queue/:id — edit a pending request, or an approved request not yet in library
router.put('/queue/:id', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (!isAdmin && request.user_id !== req.session.plexUser.id) return res.status(403).json({ error: 'Forbidden' });
  if (request.status !== 'pending' && request.status !== 'approved') {
    return res.status(400).json({ error: 'Request is not editable' });
  }
  if (request.status === 'approved') {
    const libraryTmdbIds = db.getLibraryTmdbIds();
    if (libraryTmdbIds.has(String(request.tmdb_id))) {
      return res.status(400).json({ error: 'Content is already available in the library' });
    }
  }

  const { service, seasons } = req.body;
  const seasonsJson = Array.isArray(seasons) && seasons.length > 0 ? JSON.stringify(seasons.map(Number)) : null;
  const seasonsCount = Array.isArray(seasons) && seasons.length > 0 ? seasons.length : 1;
  db.updateRequest(request.id, {
    service: service || request.service,
    seasonsJson,
    seasonsCount,
  });

  // For approved requests, re-submit to the service with updated configuration
  if (request.status === 'approved') {
    const dumbPullActive = db.getSetting('dumb_request_mode', 'pull') === 'pull' && ['1', 'true'].includes(db.getSetting('riven_enabled', '0'));
    const effectiveService = (service && service !== 'none')
      ? service
      : (dumbPullActive ? 'riven'
        : (request.media_type === 'movie'
            ? (db.getConnectionSettings().radarrEnabled ? 'radarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')
            : (db.getConnectionSettings().sonarrEnabled ? 'sonarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')));
    const storedSeasons = request.seasons_json ? JSON.parse(request.seasons_json) : null;
    const effectiveSeasons = (Array.isArray(seasons) && seasons.length > 0) ? seasons : storedSeasons;
    try {
      await submitRequestToService({
        tmdbId: request.tmdb_id,
        mediaType: request.media_type,
        title: request.title,
        service: effectiveService,
        seasons: effectiveSeasons,
      });
      logger.info(`Request re-submitted after edit: id=${request.id} tmdbId=${request.tmdb_id}`);
    } catch (e) {
      logger.warn(`Re-submission after edit failed (edit still saved): id=${request.id} error=${e.message}`);
    }
  }

  res.json({ success: true, request: db.getRequestById(request.id) });
});

// POST /api/queue/:id/approve
router.post('/queue/:id/approve', requirePrivileged, async (req, res) => {
  try {
    const request = db.getRequestById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const storedSeasons = request.seasons_json ? JSON.parse(request.seasons_json) : null;
    // If service is 'none' (e.g. queued via shim), pick the best available service now.
    // When DUMB pull mode is active, prefer riven so submitRequestToService early-returns cleanly.
    const dumbPullActive = db.getSetting('dumb_request_mode', 'pull') === 'pull' && ['1', 'true'].includes(db.getSetting('riven_enabled', '0'));
    const service = (!request.service || request.service === 'none')
      ? (dumbPullActive ? 'riven'
        : (request.media_type === 'movie'
            ? (db.getConnectionSettings().radarrEnabled ? 'radarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')
            : (db.getConnectionSettings().sonarrEnabled ? 'sonarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')))
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
// POST /api/queue/bulk-delete — admin-only bulk removal
router.post('/queue/bulk-delete', requirePrivileged, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many ids (max 500)' });
  const deletedCount = db.deleteRequestsByIds(ids);
  res.json({ success: true, deletedCount });
});

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

// Enrich an issue row with a resolved posterUrl
function enrichIssuePoster(issue) {
  const libItem = db.getLibraryItemByKey(issue.rating_key);
  const mediaType = libItem?.type === 'show' ? 'tv' : issue.media_type;
  const cached = libItem?.tmdbId ? db.getTmdbCache(libItem.tmdbId, mediaType) : null;
  let posterUrl = null;
  if (cached?.posterUrl) {
    posterUrl = cached.posterUrl;
  } else if (libItem?.thumb) {
    posterUrl = `/api/poster?path=${encodeURIComponent(libItem.thumb)}`;
  }
  return { ...issue, posterUrl };
}

// GET /api/issues — paginated list (admin sees all, users see own)
router.get('/issues', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const userId = String(req.session.plexUser.id);
  const { status = 'all', page = '1', limit: lp = '25', search: searchParam = '', userId: userIdParam = '', from: fromParam = '', to: toParam = '' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(lp) || 25));
  const pageNum = Math.max(1, parseInt(page) || 1);
  const search = typeof searchParam === 'string' ? searchParam.trim() : '';
  const userIdFilter = isAdmin && typeof userIdParam === 'string' && userIdParam.trim() ? userIdParam.trim() : null;
  const dateFrom = (() => { const n = parseInt(fromParam, 10); return Number.isFinite(n) ? n : null; })();
  const dateTo = (() => { const n = parseInt(toParam, 10); return Number.isFinite(n) ? n : null; })();
  const { rows, total } = isAdmin
    ? db.getAllIssues(limit, (pageNum - 1) * limit, status, search || null, userIdFilter, dateFrom, dateTo)
    : db.getUserIssues(userId, limit, (pageNum - 1) * limit, status, search || null, dateFrom, dateTo);
  const enriched = rows.map(enrichIssuePoster);
  res.json({ issues: enriched, total, page: pageNum, totalPages: Math.ceil(total / limit) || 1 });
});

// GET /api/issues/users — distinct users who have reported issues (admin-only, for filter dropdown)
router.get('/issues/users', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
  res.json({ users: db.getIssueUsers() });
});

// GET /api/issues/:id — fetch a single issue by id
router.get('/issues/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const issue = db.getIssueById(parseInt(req.params.id));
  if (!issue) return res.status(404).json({ error: 'Not found' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  if (!isAdmin && String(issue.user_id) !== String(req.session.plexUser.id)) return res.status(403).json({ error: 'Forbidden' });
  res.json(enrichIssuePoster(issue));
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

// POST /api/issues/bulk-delete — admin-only bulk removal
router.post('/issues/bulk-delete', requirePrivileged, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many ids (max 500)' });
  const deletedCount = db.deleteIssuesByIds(ids);
  res.json({ success: true, deletedCount });
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

// GET /api/user/settings — load user's current preferences + notification prefs
router.get('/user/settings', (req, res) => {
  const userId = req.session.plexUser.id;
  const prefs = db.getUserPreferences(userId);
  const notif = db.getUserNotificationPrefs(userId);
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser);
  const isElevated = !isAdmin && db.getPrivilegedUserIds().includes(String(userId));
  const discordConfig = (() => { try { return JSON.parse(db.getSetting('discord_agent', 'null')); } catch { return null; } })();
  const pushoverConfig = pushoverAgent.getConfig();
  const getAgentEnabled = (key) => { try { const c = JSON.parse(db.getSetting(key, 'null')); return !!(c && c.enabled); } catch { return false; } };
  const enabled_providers = [
    discordConfig?.enabled ? 'discord' : null,
    pushoverConfig?.enabled ? 'pushover' : null,
    getAgentEnabled('telegram_agent') ? 'telegram' : null,
    getAgentEnabled('pushbullet_agent') ? 'pushbullet' : null,
    getAgentEnabled('email_agent') ? 'email' : null,
  ].filter(Boolean);
  res.json({
    region: prefs.region,
    language: prefs.language,
    ui_language: prefs.ui_language,
    landing_page: prefs.landing_page,
    show_mature: prefs.show_mature,
    review_privacy: prefs.review_privacy || 'public',
    is_admin: isAdmin,
    is_elevated: isElevated,
    discover_enabled: db.getSetting('discover_enabled', '1') === '1',
    pushover_agent_enabled: !!(pushoverConfig && pushoverConfig.enabled),
    discord_agent_enabled: !!(discordConfig && discordConfig.enabled),
    discord_invite_link: discordConfig?.inviteLink || null,
    enabled_providers,
    ...notif,
  });
});

// POST /api/user/settings — save user's own content preferences + notification prefs
router.post('/user/settings', (req, res) => {
  const userId = req.session.plexUser.id;
  const { region, language, ui_language, landing_page, show_mature, review_privacy,
          notify_approved, notify_denied, notify_available,
          discord_webhook, discord_enabled, discord_user_id, pushover_user_key, pushover_enabled,
          notify_pending, notify_auto_approved, notify_process_failed,
          notify_issue_new, notify_issue_update, notify_issue_comment, notify_monitor } = req.body;
  // Read current prefs so partial updates (e.g. only show_mature) don't reset other fields
  const oldPrefs = db.getUserPreferences(userId);
  const oldNotif = db.getUserNotificationPrefs(userId);
  const newRegion      = region      !== undefined ? (region      || null) : oldPrefs.region;
  const newLanguage    = language    !== undefined ? (language    || null) : oldPrefs.language;
  const newUiLanguage  = ui_language !== undefined ? (ui_language || null) : oldPrefs.ui_language;
  const newLandingPage = landing_page !== undefined ? (landing_page || null) : oldPrefs.landing_page;
  const newShowMature  = show_mature !== undefined
    ? (show_mature === true || show_mature === 'true' || show_mature === 1)
    : oldPrefs.show_mature;
  const newReviewPrivacy = review_privacy !== undefined ? review_privacy : oldPrefs.review_privacy;
  db.setUserPreferences(userId, {
    region: newRegion, language: newLanguage, ui_language: newUiLanguage, landing_page: newLandingPage, show_mature: newShowMature, review_privacy: newReviewPrivacy,
  });
  // Invalidate discover pool cache if any pref that affects pool selection changed
  const poolChanged = oldPrefs.show_mature !== newShowMature
    || oldPrefs.region   !== newRegion
    || oldPrefs.language !== newLanguage;
  if (poolChanged) {
    try { require('../services/discoverRecommender').invalidateUserCache(userId); } catch {}
  }
  // Toggling review privacy changes which reviews belong in the public feed.
  if (oldPrefs.review_privacy !== newReviewPrivacy) {
    reviewFeed.invalidateFeedCache();
  }
  // Helper: preserve existing value when field is absent from request body
  const _b = (val, fallback) => val === undefined ? fallback : (val !== false && val !== 'false');
  const _s = (val, fallback) => val === undefined ? fallback : (val || null);
  const _e = (val, fallback) => val === undefined ? fallback : (val === true || val === 'true');
  db.setUserNotificationPrefs(userId, {
    notify_approved:       _b(notify_approved,      oldNotif.notify_approved),
    notify_denied:         _b(notify_denied,         oldNotif.notify_denied),
    notify_available:      _b(notify_available,      oldNotif.notify_available),
    discord_webhook:       _s(discord_webhook,       oldNotif.discord_webhook),
    discord_enabled:       _e(discord_enabled,       oldNotif.discord_enabled),
    discord_user_id:       _s(discord_user_id,       oldNotif.discord_user_id),
    pushover_user_key:     _s(pushover_user_key,     oldNotif.pushover_user_key),
    pushover_enabled:      _e(pushover_enabled,      oldNotif.pushover_enabled),
    notify_pending:        _b(notify_pending,        oldNotif.notify_pending),
    notify_auto_approved:  _b(notify_auto_approved,  oldNotif.notify_auto_approved),
    notify_process_failed: _b(notify_process_failed, oldNotif.notify_process_failed),
    notify_issue_new:      _b(notify_issue_new,      oldNotif.notify_issue_new),
    notify_issue_update:   _b(notify_issue_update,   oldNotif.notify_issue_update),
    notify_issue_comment:  _b(notify_issue_comment,  oldNotif.notify_issue_comment),
    notify_monitor:        _b(notify_monitor,        oldNotif.notify_monitor),
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

router.post('/notifications/read-all', (req, res) => {
  const userId = req.session.plexUser.id;
  db.markNotificationsRead(userId, null);
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

// ── Monitors ──────────────────────────────────────────────────────────────────

// GET /api/monitors — list user's monitors
router.get('/monitors', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const monitors = db.getMonitors(userId);
  const result = monitors.map(m => ({
    ...m,
    criteria: db.getCriteria(m.id),
  }));
  res.json(result);
});

// POST /api/monitors — create monitor
router.post('/monitors', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const { name, enabled, matchMode, notifyPlex, notifyRequestable, criteria } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Monitor name is required' });

  const monitorId = db.createMonitor({
    userId,
    name: name.trim(),
    enabled: enabled !== false,
    matchMode: matchMode || 'ALL',
    notifyPlex: notifyPlex !== false,
    notifyRequestable: notifyRequestable !== false,
  });

  if (Array.isArray(criteria)) {
    for (const c of criteria) {
      if (c.type && c.entityName && monitorMatcher.VALID_CRITERION_TYPES.has(c.type)) {
        db.createCriteria({
          monitorId,
          type: c.type,
          entityId: c.entityId || null,
          entityName: c.entityName,
          metadata: c.metadata || null,
        });
      }
    }
  }

  const monitor = db.getMonitor(monitorId, userId);
  monitor.criteria = db.getCriteria(monitorId);
  res.json(monitor);
});

// GET /api/monitors/:id — get monitor detail
router.get('/monitors/:id', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const monitor = db.getMonitor(req.params.id, userId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  monitor.criteria = db.getCriteria(monitor.id);
  res.json(monitor);
});

// PUT /api/monitors/:id — update monitor
router.put('/monitors/:id', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const monitor = db.getMonitor(req.params.id, userId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });

  const { name, enabled, matchMode, notifyPlex, notifyRequestable } = req.body;
  db.updateMonitor(monitor.id, userId, { name, enabled, matchMode, notifyPlex, notifyRequestable });

  const updated = db.getMonitor(monitor.id, userId);
  updated.criteria = db.getCriteria(monitor.id);
  res.json(updated);
});

// DELETE /api/monitors/:id — delete monitor
router.delete('/monitors/:id', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const monitor = db.getMonitor(req.params.id, userId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  db.deleteMonitor(monitor.id, userId);
  res.json({ ok: true });
});

// POST /api/monitors/:id/toggle — enable/disable monitor
router.post('/monitors/:id/toggle', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const { enabled } = req.body;
  const monitor = db.getMonitor(req.params.id, userId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  db.toggleMonitor(monitor.id, userId, enabled);
  const updated = db.getMonitor(monitor.id, userId);
  res.json(updated);
});

// POST /api/monitors/:id/criteria — add criterion
router.post('/monitors/:id/criteria', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const monitor = db.getMonitor(req.params.id, userId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  const { type, entityId, entityName, metadata } = req.body;
  if (!type || !entityName) return res.status(400).json({ error: 'type and entityName are required' });
  if (!monitorMatcher.VALID_CRITERION_TYPES.has(type)) return res.status(400).json({ error: `Invalid criterion type: ${type}` });

  const criteriaId = db.createCriteria({
    monitorId: monitor.id,
    type,
    entityId: entityId || null,
    entityName,
    metadata: metadata || null,
  });
  const criterion = db.getCriteria(monitor.id).find(c => c.id === criteriaId);
  res.json(criterion);
});

// DELETE /api/monitors/:id/criteria/:criteriaId — remove criterion
router.delete('/monitors/:id/criteria/:criteriaId', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const monitor = db.getMonitor(req.params.id, userId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  db.deleteCriteria(req.params.criteriaId, monitor.id);
  res.json({ ok: true });
});

// POST /api/monitors/quick — quick-create monitor from content context
router.post('/monitors/quick', requireAuth, (req, res) => {
  const userId = req.session.plexUser.id;
  const { name, criteria } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Monitor name is required' });
  if (!Array.isArray(criteria) || criteria.length === 0) return res.status(400).json({ error: 'At least one criterion is required' });

  const monitorId = db.createMonitor({
    userId,
    name: name.trim(),
    enabled: true,
    matchMode: 'ALL',
    notifyPlex: true,
    notifyRequestable: true,
  });

  for (const c of criteria) {
    if (c.type && c.entityName && monitorMatcher.VALID_CRITERION_TYPES.has(c.type)) {
      db.createCriteria({
        monitorId,
        type: c.type,
        entityId: c.entityId || null,
        entityName: c.entityName,
        metadata: c.metadata || null,
      });
    }
  }

  const monitor = db.getMonitor(monitorId, userId);
  monitor.criteria = db.getCriteria(monitorId);
  res.json(monitor);
});

// GET /api/monitors/criteria/suggest — autocomplete for criterion values
router.get('/monitors/criteria/suggest', requireAuth, async (req, res) => {
  try {
    const { type, q, limit } = req.query;
    const query = (q || '').trim();
    const maxLimit = Math.min(100, Math.max(1, parseInt(limit) || 20));

    if (type === 'genre') {
      const allGenres = new Set();
      const tmdbMovieGenres = Object.keys(tmdbService.MOVIE_GENRE_MAP || {});
      const tmdbTvGenres = Object.keys(tmdbService.TV_GENRE_MAP || {});
      tmdbMovieGenres.forEach(g => allGenres.add(g));
      tmdbTvGenres.forEach(g => allGenres.add(g));
      let results = [...allGenres].sort();
      if (query) results = results.filter(g => g.toLowerCase().includes(query.toLowerCase()));
      return res.json({ values: results.slice(0, maxLimit) });
    }

    if (type === 'media_type') {
      const types = ['movie', 'tv'];
      let results = types;
      if (query) results = results.filter(t => t.toLowerCase().includes(query.toLowerCase()));
      return res.json({ values: results });
    }

    if (type === 'language') {
      const languages = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Korean', 'Chinese', 'Italian', 'Portuguese', 'Russian'];
      let results = languages.sort();
      if (query) results = results.filter(l => l.toLowerCase().includes(query.toLowerCase()));
      return res.json({ values: results.slice(0, maxLimit) });
    }

    if (type === 'country') {
      const [movies, tv] = await Promise.all([
        plexService.getLibraryItems(plexService.MOVIES_SECTION),
        plexService.getLibraryItems(plexService.TV_SECTION),
      ]);
      const pool = [...movies, ...tv];
      const set = new Set();
      for (const item of pool) {
        for (const c of (item.countries || [])) { if (c) set.add(c); }
      }
      let results = [...set].sort();
      if (query) results = results.filter(c => c.toLowerCase().includes(query.toLowerCase()));
      return res.json({ values: results.slice(0, maxLimit) });
    }

    // For cast, director, writer, studio, network, collection, keyword, producer
    // Reuse the facets endpoint logic
    const FACET_MAP = {
      cast: 'cast', director: 'directors', writer: 'writers',
      producer: 'producers', studio: 'studio', collection: 'collections',
    };
    const facetKey = FACET_MAP[type];
    if (facetKey) {
      const [movies, tv] = await Promise.all([
        plexService.getLibraryItems(plexService.MOVIES_SECTION),
        plexService.getLibraryItems(plexService.TV_SECTION),
      ]);
      const pool = [...movies, ...tv];
      const set = new Set();
      for (const item of pool) {
        const val = item[facetKey];
        if (Array.isArray(val)) {
          for (const v of val) { if (v) set.add(String(v)); }
        } else if (val) {
          set.add(String(val));
        }
      }
      let results = [...set].sort();
      if (query) results = results.filter(v => v.toLowerCase().includes(query.toLowerCase()));
      return res.json({ values: results.slice(0, maxLimit) });
    }

    // Network: use studio field from library
    if (type === 'network') {
      const tv = await plexService.getLibraryItems(plexService.TV_SECTION);
      const set = new Set();
      for (const item of tv) {
        if (item.studio) set.add(item.studio);
      }
      let results = [...set].sort();
      if (query) results = results.filter(v => v.toLowerCase().includes(query.toLowerCase()));
      return res.json({ values: results.slice(0, maxLimit) });
    }

    // Keyword: search TMDB cache
    if (type === 'keyword' && query) {
      const items = db.getAllTmdbCacheItems();
      const set = new Set();
      for (const item of items) {
        if (item.keywords && Array.isArray(item.keywords)) {
          for (const kw of item.keywords) {
            if (kw && kw.toLowerCase().includes(query.toLowerCase())) set.add(kw);
          }
        }
      }
      return res.json({ values: [...set].sort().slice(0, maxLimit) });
    }

    res.json({ values: [] });
  } catch (err) {
    res.json({ values: [] });
  }
});

// POST /api/monitors/evaluate — manual evaluation trigger (admin only)
router.post('/monitors/evaluate', requireAuth, async (req, res) => {
  const userId = req.session.plexUser.id;
  const isAdmin = db.isAdminUser(userId);
  if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

  try {
    const [movies, tv] = await Promise.all([
      plexService.getLibraryItems(plexService.MOVIES_SECTION),
      plexService.getLibraryItems(plexService.TV_SECTION),
    ]);
    const contents = [...movies, ...tv].map(monitorMatcher.buildContentFromLibrary);
    const matches = await monitorMatcher.evaluateBatch(contents, 'plex');
    await monitorNotifier.sendMatches(matches, 'plex');
    res.json({ ok: true, matches: matches.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/rebuild-pool — force rebuild discover candidate pools + tmdb_cache
router.post('/admin/rebuild-pool', requireAuth, async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser);
  if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
  try {
    console.log('[admin] Force pool rebuild started by user', req.session.plexUser.id);
    await discoverRecommender.refreshSharedCandidatePools();
    await discoverRecommender.warmAllUserDiscoverCaches();
    console.log('[admin] Force pool rebuild complete');
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] Pool rebuild failed:', err);
    res.status(500).json({ error: 'Rebuild failed: ' + err.message });
  }
});

// ── Watch History ─────────────────────────────────────────────────────────────

// GET /api/history — user's watch history from Tautulli
router.get('/history', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(userId);

  const {
    mediaType = 'all',
    startDate = '',
    endDate = '',
    watchedStatus = 'all',
    search = '',
    sortBy = 'date',
    sortDir = 'desc',
    page = '1',
    perPage = '25',
    userIds = '',
    reviewedOnly = '',
  } = req.query;

  // "Reviewed only" filters to rows the requester has personally reviewed (reviews
  // are always own-only, even for admins viewing the aggregate).
  const reviewedByUserId = (reviewedOnly === '1' || reviewedOnly === 'true') ? userId : null;

  // Admins see an aggregate of all users by default; an explicit `userIds`
  // whitelist (comma-separated) narrows it down. Standard users only ever see
  // their own history regardless of the params they send.
  const includeUserIds = isAdmin && userIds
    ? String(userIds).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  // Non-admins are locked to their own rows; admins query the aggregate.
  const ownUserId = isAdmin ? null : userId;

  const pageNum = Math.max(1, parseInt(page) || 1);
  const perPageNum = Math.min(100, Math.max(1, parseInt(perPage) || 25));

  // History is served from the local cache (populated by a background sync). On a
  // cold start with nothing cached yet, prime it once so the first load isn't empty.
  if (db.getWatchHistoryCount() === 0 && db.getSyncTime('watch_history') === 0) {
    try { await tautulliService.syncWatchHistory(); } catch { /* fall through to empty */ }
  }

  const result = db.queryWatchHistory({
    ownUserId,
    includeUserIds,
    mediaType,
    // Frontend sends date filters in ms; the cache stores watched_at in seconds.
    startDate: startDate ? Math.floor(parseInt(startDate) / 1000) : null,
    endDate: endDate ? Math.floor(parseInt(endDate) / 1000) : null,
    watchedStatus,
    search: search.trim(),
    sortBy,
    sortDir,
    page: pageNum,
    perPage: perPageNum,
    reviewedByUserId,
  });

  // Enrich each item (and, for grouped shows, each child episode) with TMDB ids,
  // the requester's own review, avatar, and a proxied poster.
  const enrich = (item) => {
    const libItem = db.getLibraryItemByKey(item.ratingKey);
    const parentLib = item.grandparentRatingKey ? db.getLibraryItemByKey(item.grandparentRatingKey) : null;
    const effectiveLib = libItem || parentLib;
    const tmdbId = effectiveLib?.tmdbId || null;
    // Reviews apply to any matched library item. Items with a TMDB id are keyed by
    // it; items without one (e.g. YouTube/abridged content) fall back to the Plex
    // rating_key so they can still be reviewed.
    const mediaTypeForReview = effectiveLib
      ? (effectiveLib.type === 'show' ? 'tv' : 'movie')
      : null;
    const reviewTmdbId = tmdbId ? Number(tmdbId) : null;
    const reviewRatingKey = effectiveLib?.ratingKey || null;

    // A row is "own" when it belongs to the requesting user. Reviews and review
    // controls only ever apply to your own watched content — admins never see or
    // touch other users' reviews.
    const isOwnWatch = item.userId == null || String(item.userId) === userId;

    let review = null;
    if (isOwnWatch && mediaTypeForReview) {
      if (reviewTmdbId) review = db.getReview(userId, mediaTypeForReview, reviewTmdbId);
      else if (reviewRatingKey) review = db.getReviewByRatingKey(userId, reviewRatingKey);
    }

    // Tautulli user_thumb is typically an absolute avatar URL; only Plex
    // /library/ paths need to be proxied (the poster proxy rejects everything else).
    let userAvatarUrl = null;
    if (item.userThumb) {
      if (/^https?:\/\//i.test(item.userThumb)) userAvatarUrl = item.userThumb;
      else if (item.userThumb.startsWith('/library/')) userAvatarUrl = `/api/poster?path=${encodeURIComponent(item.userThumb)}`;
    }

    return {
      ...item,
      // duration stays in seconds (actual time watched); no runtime fallback.
      duration: item.duration || 0,
      tmdbId: reviewTmdbId,
      reviewMediaType: mediaTypeForReview,
      reviewRatingKey,
      contentRating: effectiveLib?.contentRating || null,
      isOwnWatch,
      userAvatarUrl,
      review: review ? {
        id: review.id,
        rating: review.rating,
        reviewText: review.review_text,
        spoiler: !!review.spoiler,
        rewatch: !!review.rewatch,
      } : null,
      posterUrl: item.thumb ? `/api/poster?path=${encodeURIComponent(item.thumb)}` : null,
      children: Array.isArray(item.children) ? item.children.map(enrich) : undefined,
    };
  };

  const items = result.items.map(enrich);

  res.json({ ...result, items });
});

// GET /api/history/users — users present in cached history (admin only)
router.get('/history/users', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });

  try {
    res.json({ users: db.getWatchHistoryUsers() });
  } catch (err) {
    res.json({ users: [] });
  }
});

// ── Reviews ───────────────────────────────────────────────────────────────────

// GET /api/reviews — current user's reviews
router.get('/reviews', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const { page = '1', perPage = '50' } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const perPageNum = Math.min(100, Math.max(1, parseInt(perPage) || 50));
  const reviews = db.getUserReviews(userId, perPageNum, (pageNum - 1) * perPageNum);
  const total = db.getUserReviewsCount(userId);
  res.json({
    reviews: reviews.map(r => ({
      id: r.id,
      mediaType: r.media_type,
      tmdbId: r.tmdb_id,
      title: r.title,
      year: r.year,
      rating: r.rating,
      reviewText: r.review_text,
      spoiler: !!r.spoiler,
      rewatch: !!r.rewatch,
      watchedDate: r.watched_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total,
    page: pageNum,
    totalPages: Math.ceil(total / perPageNum) || 1,
  });
});

// GET /api/reviews/:mediaType/:tmdbId — check for existing review
router.get('/reviews/:mediaType/:tmdbId', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const { mediaType, tmdbId } = req.params;
  if (!['movie', 'tv'].includes(mediaType)) return res.status(400).json({ error: 'Invalid mediaType' });
  const review = db.getReview(String(req.session.plexUser.id), mediaType, Number(tmdbId));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  res.json({
    id: review.id,
    mediaType: review.media_type,
    tmdbId: review.tmdb_id,
    title: review.title,
    year: review.year,
    rating: review.rating,
    reviewText: review.review_text,
    spoiler: !!review.spoiler,
    rewatch: !!review.rewatch,
    watchedDate: review.watched_date,
    tmdbSyncedRating: review.tmdb_synced_rating ?? null,
    createdAt: review.created_at,
    updatedAt: review.updated_at,
  });
});

// POST /api/reviews — create or update review
router.post('/reviews', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const { mediaType, tmdbId, ratingKey, title, year, rating, reviewText, spoiler, rewatch, watchedDate } = req.body;

  if (!mediaType || (tmdbId == null && !ratingKey) || rating == null || !watchedDate) {
    return res.status(400).json({ error: 'mediaType, (tmdbId or ratingKey), rating, and watchedDate are required' });
  }
  if (!['movie', 'tv'].includes(mediaType)) return res.status(400).json({ error: 'Invalid mediaType' });
  const ratingNum = Number(rating);
  if (ratingNum < 0.5 || ratingNum > 5.0 || ratingNum % 0.5 !== 0) {
    return res.status(400).json({ error: 'Rating must be between 0.5 and 5.0 in 0.5 increments' });
  }

  // You may only review content you have actually watched. Resolve the library
  // item — by TMDB id, or by Plex rating_key for items with no TMDB match — then
  // confirm it appears in the user's own Tautulli history (movie rating_key / show
  // grandparent_rating_key). Enforced here so it can't be bypassed via the API.
  const lib = tmdbId != null
    ? db.getLibraryItemByTmdbId(Number(tmdbId))
    : db.getLibraryItemByKey(String(ratingKey));
  if (!lib) {
    return res.status(403).json({ error: 'You can only review content you have watched' });
  }
  // getLibraryItemByTmdbId returns a raw row (rating_key); getLibraryItemByKey
  // returns a mapped item (ratingKey).
  const libRatingKey = String(lib.rating_key ?? lib.ratingKey);
  const watchedKeys = mediaType === 'movie'
    ? await tautulliService.getWatchedMovieKeys(userId)
    : await tautulliService.getWatchedShowKeys(userId);
  if (!watchedKeys.has(libRatingKey)) {
    return res.status(403).json({ error: 'You can only review content you have watched' });
  }

  db.createReview({
    userId,
    mediaType,
    tmdbId: tmdbId != null ? Number(tmdbId) : null,
    ratingKey: tmdbId != null ? null : libRatingKey,
    title: title || '',
    year: year != null ? Number(year) : null,
    rating: ratingNum,
    reviewText: reviewText || '',
    spoiler: !!spoiler,
    rewatch: !!rewatch,
    watchedDate: Number(watchedDate),
  });

  recommender.invalidateUserCache(userId);
  reviewFeed.invalidateFeedCache();

  // Mirror the rating into the user's personal Plex rating (0.5–5 → 0–10 scale).
  // Best-effort; never blocks the response.
  plexService.setUserRating(userId, libRatingKey, ratingNum * 2).catch(() => {});

  const review = tmdbId != null
    ? db.getReview(userId, mediaType, Number(tmdbId))
    : db.getReviewByRatingKey(userId, libRatingKey);
  reviewCardCache.invalidate(review.id);
  res.json({
    id: review.id,
    mediaType: review.media_type,
    tmdbId: review.tmdb_id,
    ratingKey: review.rating_key,
    title: review.title,
    year: review.year,
    rating: review.rating,
    reviewText: review.review_text,
    spoiler: !!review.spoiler,
    rewatch: !!review.rewatch,
    watchedDate: review.watched_date,
    tmdbSyncedRating: review.tmdb_synced_rating ?? null,
  });
});

// PUT /api/reviews/:id — update review
router.put('/reviews/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

  const { title, year, rating, reviewText, spoiler, rewatch } = req.body;
  if (rating != null) {
    const ratingNum = Number(rating);
    if (ratingNum < 0.5 || ratingNum > 5.0 || ratingNum % 0.5 !== 0) {
      return res.status(400).json({ error: 'Rating must be between 0.5 and 5.0 in 0.5 increments' });
    }
  }

  db.updateReview(review.id, userId, { title, year, rating, reviewText, spoiler, rewatch });
  recommender.invalidateUserCache(userId);
  reviewFeed.invalidateFeedCache();
  reviewCardCache.invalidate(review.id);
  const updated = db.getReviewById(review.id);

  // Push the (possibly changed) rating to the user's personal Plex rating.
  if (rating != null) {
    const pushKey = updated.rating_key || db.getLibraryItemByTmdbId(updated.tmdb_id)?.rating_key;
    if (pushKey) plexService.setUserRating(userId, String(pushKey), Number(updated.rating) * 2).catch(() => {});
  }

  res.json({
    id: updated.id,
    mediaType: updated.media_type,
    tmdbId: updated.tmdb_id,
    ratingKey: updated.rating_key,
    title: updated.title,
    year: updated.year,
    rating: updated.rating,
    reviewText: updated.review_text,
    spoiler: !!updated.spoiler,
    rewatch: !!updated.rewatch,
    watchedDate: updated.watched_date,
    tmdbSyncedRating: updated.tmdb_synced_rating ?? null,
  });
});

// DELETE /api/reviews/:id
router.delete('/reviews/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

  // Clear the user's personal Plex rating (the review was the source of truth).
  const pushKey = review.rating_key || db.getLibraryItemByTmdbId(review.tmdb_id)?.rating_key;
  if (pushKey) plexService.setUserRating(userId, String(pushKey), -1).catch(() => {});

  db.deleteReview(review.id, userId);
  recommender.invalidateUserCache(userId);
  reviewFeed.invalidateFeedCache();
  reviewCardCache.invalidate(review.id);
  res.json({ success: true });
});

// ── Social Review Feed ────────────────────────────────────────────────────────

// GET /api/reviews/feed — public review feed
router.get('/reviews/feed', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const { page = '1', perPage = '20', followedOnly = 'false' } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const perPageNum = Math.min(100, Math.max(1, parseInt(perPage) || 20));
  const offset = (pageNum - 1) * perPageNum;
  const followedSet = new Set(db.getFollowedUserIds(currentUserId));

  // The global feed is a shared, user-independent dataset (counts are denormalized
  // columns) so it's served from the in-memory cache. The followed-only feed is
  // per-user, so it stays a live query.
  let reviews;
  let total;
  if (followedOnly === 'true') {
    const followedUserIds = Array.from(followedSet);
    reviews = db.getPublicReviews(perPageNum, offset, followedUserIds);
    total = db.getPublicReviewsCount(followedUserIds);
  } else {
    const cached = reviewFeed.getGlobalFeedPage(perPageNum, offset);
    if (cached) {
      reviews = cached.rows;
      total = cached.total;
    } else {
      // Deep pagination past the cached window — fall back to the DB.
      reviews = db.getPublicReviews(perPageNum, offset, null);
      total = db.getPublicReviewsCount(null);
    }
  }

  // Overlay the per-user flag that can't be cached: did *this* viewer react?
  const reactedSet = new Set(db.getUserReactedReviewIds(currentUserId, reviews.map(r => r.id)));

  res.json({
    reviews: reviews.map(r => ({
      id: r.id,
      userId: r.user_id,
      username: r.username || r.user_id,
      userAvatar: r.thumb || null,
      mediaType: r.media_type,
      tmdbId: r.tmdb_id,
      title: r.title,
      year: r.year,
      posterUrl: r.poster_url || null,
      contentRating: r.content_rating || '',
      rating: r.rating,
      reviewText: r.review_text,
      spoiler: !!r.spoiler,
      rewatch: !!r.rewatch,
      watchedDate: r.watched_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reactionCount: r.reaction_count || 0,
      commentCount: r.comment_count || 0,
      hasReacted: reactedSet.has(r.id),
      isOwn: r.user_id === currentUserId,
      isFollowing: followedSet.has(r.user_id),
    })),
    total,
    page: pageNum,
    totalPages: Math.ceil(total / perPageNum) || 1,
  });
});

// GET /api/reviews/:id — single review by ID (for feed detail / share link)
router.get('/reviews/:id', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  // Check privacy
  const prefs = db.getUserPreferences(review.user_id);
  if (prefs.review_privacy === 'private' && review.user_id !== currentUserId) {
    return res.status(404).json({ error: 'Review not found' });
  }
  const ku = db.prepare('SELECT username, thumb FROM known_users WHERE user_id = ?').get(review.user_id);
  const reactionCount = db.getReviewReactionCount(review.id);
  const commentCount = db.getReviewCommentCount(review.id);
  const hasReacted = db.hasUserReacted(review.id, currentUserId);
  const followedSet = new Set(db.getFollowedUserIds(currentUserId));
  // Resolve poster + content rating from the matching library item
  const lib = review.tmdb_id != null ? db.getLibraryItemByTmdbId(review.tmdb_id) : null;
  const thumbPath = lib?.thumb || lib?.art || null;
  const posterUrl = thumbPath
    ? (thumbPath.startsWith('http') ? thumbPath : `/api/poster?path=${encodeURIComponent(thumbPath)}`)
    : null;
  res.json({
    id: review.id,
    userId: review.user_id,
    username: ku?.username || review.user_id,
    userAvatar: ku?.thumb || null,
    mediaType: review.media_type,
    tmdbId: review.tmdb_id,
    title: review.title,
    year: review.year,
    posterUrl,
    contentRating: lib?.content_rating || '',
    rating: review.rating,
    reviewText: review.review_text,
    spoiler: !!review.spoiler,
    rewatch: !!review.rewatch,
    watchedDate: review.watched_date,
    createdAt: review.created_at,
    updatedAt: review.updated_at,
    reactionCount,
    commentCount,
    hasReacted,
    isOwn: review.user_id === currentUserId,
    isFollowing: followedSet.has(review.user_id),
  });
});

// POST /api/reviews/:id/react — toggle reaction
router.post('/reviews/:id/react', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  // Check privacy
  const prefs = db.getUserPreferences(review.user_id);
  if (prefs.review_privacy === 'private') {
    return res.status(403).json({ error: 'Cannot react to private reviews' });
  }
  const reacted = db.toggleReaction(review.id, currentUserId);
  const count = db.getReviewReactionCount(review.id);
  reviewFeed.invalidateFeedCache();
  res.json({ reacted, count });
});

// GET /api/reviews/:id/reactions — reaction info
router.get('/reviews/:id/reactions', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  // Don't leak reaction info for private reviews (parity with /comments and /react).
  const prefs = db.getUserPreferences(review.user_id);
  if (prefs.review_privacy === 'private' && review.user_id !== currentUserId) {
    return res.status(404).json({ error: 'Review not found' });
  }
  res.json({
    count: db.getReviewReactionCount(review.id),
    hasReacted: db.hasUserReacted(review.id, currentUserId),
  });
});

// ── Review Comments ───────────────────────────────────────────────────────────

// GET /api/reviews/:id/comments
router.get('/reviews/:id/comments', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const prefs = db.getUserPreferences(review.user_id);
  if (prefs.review_privacy === 'private' && review.user_id !== currentUserId) {
    return res.status(404).json({ error: 'Review not found' });
  }
  const comments = db.getReviewComments(review.id);
  const authorIds = [...new Set(comments.map(c => c.user_id))];
  const kuRows = authorIds.length
    ? db.prepare('SELECT user_id, username, thumb FROM known_users WHERE user_id IN (' + authorIds.map(() => '?').join(',') + ')').all(...authorIds)
    : [];
  const kuMap = {};
  for (const ku of kuRows) kuMap[ku.user_id] = ku;
  res.json({
    comments: comments.map(c => ({
      id: c.id,
      userId: c.user_id,
      username: kuMap[c.user_id]?.username || c.user_id,
      userAvatar: kuMap[c.user_id]?.thumb || null,
      body: c.body,
      parentId: c.parent_id,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      isOwn: c.user_id === currentUserId,
    })),
  });
});

// POST /api/reviews/:id/comments
router.post('/reviews/:id/comments', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const review = db.getReviewById(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const prefs = db.getUserPreferences(review.user_id);
  if (prefs.review_privacy === 'private') {
    return res.status(403).json({ error: 'Cannot comment on private reviews' });
  }
  const { body, parentId } = req.body;
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'Comment body is required' });
  }
  if (String(body).length > 1000) {
    return res.status(400).json({ error: 'Comment must be 1000 characters or less' });
  }
  // Validate parentId if provided
  let validParentId = null;
  if (parentId) {
    const parent = db.getReviewComment(Number(parentId));
    if (!parent || parent.review_id !== review.id) {
      return res.status(400).json({ error: 'Invalid parent comment' });
    }
    validParentId = Number(parentId);
  }
  const result = db.createReviewComment(review.id, currentUserId, body, validParentId);
  reviewFeed.invalidateFeedCache();
  const comment = db.getReviewComment(result.lastInsertRowid);
  const ku = db.prepare('SELECT username, thumb FROM known_users WHERE user_id = ?').get(currentUserId);
  res.status(201).json({
    id: comment.id,
    userId: comment.user_id,
    username: ku?.username || currentUserId,
    userAvatar: ku?.thumb || null,
    body: comment.body,
    parentId: comment.parent_id,
    createdAt: comment.created_at,
    isOwn: true,
  });
});

// PUT /api/reviews/comments/:commentId
router.put('/reviews/comments/:commentId', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const comment = db.getReviewComment(Number(req.params.commentId));
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.user_id !== currentUserId) return res.status(403).json({ error: 'Forbidden' });
  const { body } = req.body;
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'Comment body is required' });
  }
  if (String(body).length > 1000) {
    return res.status(400).json({ error: 'Comment must be 1000 characters or less' });
  }
  db.updateReviewComment(comment.id, currentUserId, body);
  const updated = db.getReviewComment(comment.id);
  res.json({
    id: updated.id,
    body: updated.body,
    updatedAt: updated.updated_at,
  });
});

// DELETE /api/reviews/comments/:commentId
router.delete('/reviews/comments/:commentId', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const currentUserId = String(req.session.plexUser.id);
  const comment = db.getReviewComment(Number(req.params.commentId));
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.user_id !== currentUserId) return res.status(403).json({ error: 'Forbidden' });
  db.deleteReviewComment(comment.id, currentUserId);
  reviewFeed.invalidateFeedCache();
  res.json({ success: true });
});

// ── Follow System ─────────────────────────────────────────────────────────────

// POST /api/users/init-follows — seed default follows on first visit
router.post('/users/init-follows', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  db.seedDefaultFollows(userId);
  res.json({ ok: true });
});

// POST /api/users/:userId/follow
router.post('/users/:userId/follow', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const followerId = String(req.session.plexUser.id);
  const followeeId = String(req.params.userId);
  if (followerId === followeeId) return res.status(400).json({ error: 'Cannot follow yourself' });
  const target = db.prepare('SELECT 1 FROM known_users WHERE user_id = ?').get(followeeId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.followUser(followerId, followeeId);
  res.json({ following: true });
});

// DELETE /api/users/:userId/follow
router.delete('/users/:userId/follow', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const followerId = String(req.session.plexUser.id);
  const followeeId = String(req.params.userId);
  if (followerId === followeeId) return res.status(400).json({ error: 'Cannot unfollow yourself' });
  db.unfollowUser(followerId, followeeId);
  res.json({ following: false });
});

// GET /api/users/:userId/following — check if current user follows target
router.get('/users/:userId/following', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const followerId = String(req.session.plexUser.id);
  const followeeId = String(req.params.userId);
  res.json({ following: db.isFollowing(followerId, followeeId) });
});

// GET /api/users/:userId/followers — list followers
router.get('/users/:userId/followers', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.params.userId);
  const followerIds = db.getFollowers(userId);
  const kuRows = db.prepare('SELECT user_id, username, thumb FROM known_users WHERE user_id IN (' + followerIds.map(() => '?').join(',') + ')').all(...followerIds);
  const kuMap = {};
  for (const ku of kuRows) kuMap[ku.user_id] = ku;
  res.json({
    followers: followerIds.map(fid => ({
      userId: fid,
      username: kuMap[fid]?.username || fid,
      thumb: kuMap[fid]?.thumb || null,
    })),
    count: followerIds.length,
  });
});

// GET /api/users/:userId/following-list — list who user follows
router.get('/users/:userId/following-list', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.params.userId);
  const followingIds = db.getFollowing(userId);
  const kuRows = db.prepare('SELECT user_id, username, thumb FROM known_users WHERE user_id IN (' + followingIds.map(() => '?').join(',') + ')').all(...followingIds);
  const kuMap = {};
  for (const ku of kuRows) kuMap[ku.user_id] = ku;
  res.json({
    following: followingIds.map(fid => ({
      userId: fid,
      username: kuMap[fid]?.username || fid,
      thumb: kuMap[fid]?.thumb || null,
    })),
    count: followingIds.length,
  });
});

// GET /api/users/follow-stats — batch follow stats for multiple users
router.get('/users/follow-stats', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const { userIds } = req.query;
  if (!userIds) return res.json({});
  const ids = Array.isArray(userIds) ? userIds : String(userIds).split(',');
  res.json(db.getFollowStats(ids));
});

// GET /api/users/:userId/profile — get a user's profile
router.get('/users/:userId/profile', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const targetId = String(req.params.userId);
  const profile = db.getUserProfile(targetId);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  const currentUserId = String(req.session.plexUser.id);
  const isOwn = targetId === currentUserId;
  const isFollowing = isOwn ? false : db.isFollowing(currentUserId, targetId);
  res.json({ ...profile, isOwn, isFollowing });
});

// PUT /api/users/profile — update current user's profile
router.put('/users/profile', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const { bio, favoriteGenres, favoriteMedia } = req.body || {};
  if (bio !== undefined && typeof bio !== 'string') return res.status(400).json({ error: 'bio must be a string' });
  if (favoriteGenres !== undefined && !Array.isArray(favoriteGenres)) return res.status(400).json({ error: 'favoriteGenres must be an array' });
  if (favoriteMedia !== undefined && !Array.isArray(favoriteMedia)) return res.status(400).json({ error: 'favoriteMedia must be an array' });
  if (favoriteGenres && favoriteGenres.length > 5) return res.status(400).json({ error: 'Maximum 5 favorite genres allowed' });
  if (favoriteMedia && favoriteMedia.length > 5) return res.status(400).json({ error: 'Maximum 5 favorite media items allowed' });
  db.updateUserProfile(userId, { bio, favoriteGenres, favoriteMedia });
  res.json(db.getUserProfile(userId));
});

// GET /api/users/:userId/reviews — get a user's public reviews (paginated)
router.get('/users/:userId/reviews', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const targetId = String(req.params.userId);
  const currentUserId = String(req.session.plexUser.id);
  const { page = '1', perPage = '20' } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const perPageNum = Math.min(100, Math.max(1, parseInt(perPage) || 20));
  const offset = (pageNum - 1) * perPageNum;
  const isOwn = targetId === currentUserId;
  if (!isOwn) {
    const prefs = db.getUserPreferences(targetId);
    if (prefs.review_privacy === 'private') {
      return res.json({ reviews: [], total: 0, page: pageNum, totalPages: 1 });
    }
  }
  const reviews = db.getUserPublicReviews(targetId, perPageNum, offset);
  const total = db.getUserPublicReviewsCount(targetId);
  const followedSet = new Set(db.getFollowedUserIds(currentUserId));
  const reactedSet = new Set(db.getUserReactedReviewIds(currentUserId, reviews.map(r => r.id)));
  res.json({
    reviews: reviews.map(r => ({
      id: r.id,
      userId: r.user_id,
      username: r.username || r.user_id,
      userAvatar: r.thumb || null,
      mediaType: r.media_type,
      tmdbId: r.tmdb_id,
      title: r.title,
      year: r.year,
      posterUrl: r.poster_url || null,
      contentRating: r.content_rating || '',
      rating: r.rating,
      reviewText: r.review_text,
      spoiler: !!r.spoiler,
      rewatch: !!r.rewatch,
      watchedDate: r.watched_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reactionCount: r.reaction_count || 0,
      commentCount: r.comment_count || 0,
      hasReacted: reactedSet.has(r.id),
      isOwn: r.user_id === currentUserId,
      isFollowing: followedSet.has(r.user_id),
    })),
    total,
    page: pageNum,
    totalPages: Math.ceil(total / perPageNum) || 1,
  });
});

// ── TMDB Per-User Integration ─────────────────────────────────────────────────

function getAppUrl(req) {
  return process.env.APP_URL || req.appUrl || `${req.protocol}://${req.get('host')}`;
}

function isInternalUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') ||
      h.startsWith('10.') || h.startsWith('172.16.') || h.endsWith('.local') ||
      h.includes('internal');
  } catch {
    return true;
  }
}

// GET /api/tmdb/connection — get current user's TMDB connection status (no secrets)
router.get('/tmdb/connection', (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const conn = db.getTmdbConnection(userId);
  if (!conn) {
    return res.json({ connected: false });
  }
  res.json({
    connected: true,
    accountId: conn.account_id,
    status: conn.status,
    connectedAt: new Date(conn.connected_at * 1000).toISOString(),
    lastVerifiedAt: conn.last_verified_at ? new Date(conn.last_verified_at * 1000).toISOString() : null,
  });
});

// POST /api/tmdb/connect/initiate — start OAuth flow, return auth URL
router.post('/tmdb/connect/initiate', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { requestToken, expiresAt } = await tmdbIntegration.createRequestToken();
    const callbackUrl = `${getAppUrl(req)}/api/tmdb/connect/callback`;
    const authUrl = `https://www.themoviedb.org/authenticate/${requestToken}?redirect_to=${encodeURIComponent(callbackUrl)}`;

    if (isInternalUrl(callbackUrl)) {
      console.warn(`[tmdb] Callback URL appears to be internal: ${callbackUrl}. TMDB won't be able to reach it.`);
    }

    req.session._tmdbRequestToken = requestToken;
    res.json({ authUrl, expiresAt });
  } catch (err) {
    if (err.message === 'TMDB API key not configured') {
      return res.status(503).json({ error: 'TMDB API key not configured by admin' });
    }
    console.error('[tmdb] Failed to create request token:', err);
    res.status(500).json({ error: 'Failed to initiate TMDB connection: ' + err.message });
  }
});

// GET /api/tmdb/connect/callback?request_token=xxx&approved=true — exchange request token for session
router.get('/tmdb/connect/callback', async (req, res) => {
  // TMDB redirects back with ?request_token=XXX&approved=true; fall back to the
  // token we stashed in the session at initiate time.
  const token = req.query.request_token || req.session._tmdbRequestToken;
  const approved = req.query.approved;
  if (approved === 'false' || approved === 'denied') {
    return res.send('<html><body><p>TMDB connection was cancelled. You can close this window.</p><script>window.close()</script></body></html>');
  }
  if (!token) {
    return res.status(400).send('<html><body><h1>Error</h1><p>No token provided.</p></body></html>');
  }

  try {
    const { sessionId, accountId } = await tmdbIntegration.requestTokenToSession(token);
    const encrypted = cryptoUtil.encrypt(sessionId);

    // If the user is authenticated in this session, store the connection
    if (req.session?.plexUser) {
      const userId = String(req.session.plexUser.id);
      db.createTmdbConnection(userId, encrypted, accountId);
      req.session.cookietmdbConnected = 1;
      delete req.session._tmdbRequestToken;
      res.send('<html><body><p>Connected to TMDB. You can close this window.</p><script>window.close()</script></body></html>');
    } else {
      // Store token in a short-lived cookie so the user can log in first
      res.cookie('tmdb_pending_token', token, { maxAge: 600000, httpOnly: true, sameSite: 'lax' });
      res.redirect(`${getAppUrl(req)}/`);
    }
  } catch (err) {
    console.error('[tmdb] Callback failed:', err);
    res.status(500).send('<html><body><h1>Connection Failed</h1><p>Could not connect to TMDB. Please try again.</p></body></html>');
  }
});

// POST /api/tmdb/disconnect — remove TMDB connection
router.post('/tmdb/disconnect', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const conn = db.getTmdbConnection(userId);
  if (!conn) return res.status(400).json({ error: 'No TMDB connection to remove' });

  try {
    const sessionId = cryptoUtil.decrypt(conn.session_id);
    await tmdbIntegration.deleteSession(sessionId).catch(() => {});
  } catch (err) {
    console.warn('[tmdb] Failed to delete remote session:', err.message);
  }

  db.deleteTmdbConnection(userId);
  res.json({ success: true });
});

// POST /api/tmdb/verify — verify session is still valid
router.post('/tmdb/verify', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const conn = db.getTmdbConnection(userId);
  if (!conn) return res.status(400).json({ error: 'No TMDB connection' });

  try {
    const sessionId = cryptoUtil.decrypt(conn.session_id);
    await tmdbIntegration.getAccountInfo(conn.account_id, sessionId);
    db.updateTmdbConnectionVerified(userId);
    res.json({ verified: true, status: 'connected' });
  } catch (err) {
    if (err instanceof tmdbIntegration.ExpiredSessionError) {
      db.updateTmdbConnectionStatus(userId, 'needs_reconnect');
      return res.status(401).json({ error: 'TMDB session expired. Please reconnect.', status: 'needs_reconnect' });
    }
    console.warn('[tmdb] Verify failed:', err.message);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// POST /api/tmdb/sync-rating — push review rating to TMDB
router.post('/tmdb/sync-rating', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const { reviewId } = req.body;

  const review = db.getReviewById(Number(reviewId));
  if (!review || review.user_id !== userId) {
    return res.status(404).json({ error: 'Review not found' });
  }

  const conn = db.getTmdbConnection(userId);
  if (!conn) return res.status(400).json({ error: 'No TMDB connection' });
  if (conn.status === 'needs_reconnect') {
    return res.status(401).json({ error: 'TMDB session expired. Please reconnect.', status: 'needs_reconnect' });
  }

  try {
    const sessionId = cryptoUtil.decrypt(conn.session_id);
    const mapped = mapReviewToTmdb(review);
    await tmdbIntegration.setRating(sessionId, mapped.mediaType, mapped.tmdbId, mapped.value);
    db.setReviewTmdbSyncedRating(review.id, userId, review.rating);
    db.updateTmdbConnectionVerified(userId);
    res.json({ success: true, tmdbRating: mapped.value });
  } catch (err) {
    if (err instanceof tmdbIntegration.ExpiredSessionError) {
      db.updateTmdbConnectionStatus(userId, 'needs_reconnect');
      return res.status(401).json({ error: 'TMDB session expired. Please reconnect.', status: 'needs_reconnect' });
    }
    if (err instanceof tmdbIntegration.RateLimitError) {
      return res.status(429).json({ error: 'TMDB rate limited. Rating saved locally.', retryAfter: err.retryAfter });
    }
    console.warn('[tmdb] Sync rating failed:', err.message);
    res.status(502).json({ error: 'Failed to push rating to TMDB. Rating saved locally.' });
  }
});

// DELETE /api/tmdb/sync-rating — remove TMDB rating
router.delete('/tmdb/sync-rating', async (req, res) => {
  if (!req.session?.plexUser) return res.status(401).json({ error: 'Not authenticated' });
  const userId = String(req.session.plexUser.id);
  const { reviewId } = req.body;

  const review = db.getReviewById(Number(reviewId));
  if (!review || review.user_id !== userId) {
    return res.status(404).json({ error: 'Review not found' });
  }

  const conn = db.getTmdbConnection(userId);
  if (!conn) return res.status(400).json({ error: 'No TMDB connection' });

  try {
    const sessionId = cryptoUtil.decrypt(conn.session_id);
    await tmdbIntegration.deleteRating(sessionId, review.media_type, review.tmdb_id);
    db.setReviewTmdbSyncedRating(review.id, userId, null);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof tmdbIntegration.ExpiredSessionError) {
      db.updateTmdbConnectionStatus(userId, 'needs_reconnect');
      return res.status(401).json({ error: 'TMDB session expired. Please reconnect.', status: 'needs_reconnect' });
    }
    console.warn('[tmdb] Delete rating failed:', err.message);
    res.status(502).json({ error: 'Failed to remove TMDB rating.' });
  }
});

module.exports = router;
module.exports.submitRequestToService = submitRequestToService;
