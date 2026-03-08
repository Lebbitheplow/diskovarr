const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discoverRecommender = require('../services/discoverRecommender');
const db = require('../db/database');

router.use(requireAuth);

// GET /api/recommendations
router.get('/recommendations', async (req, res) => {
  try {
    const { id: userId, token: userToken } = req.session.plexUser;
    const data = await recommender.getRecommendations(userId, userToken);
    res.json(data);
  } catch (err) {
    console.error('recommendations error:', err);
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
    } = req.query;

    const PAGE_SIZE = 40;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const minRatingNum = parseFloat(minRating) || 0;
    const genreList = genres ? genres.split(',').map(g => g.trim().toLowerCase()).filter(Boolean) : [];

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

// ── Explore (external content) recommendations ────────────────────────────────

// GET /api/explore/services — which request services are enabled
router.get('/explore/services', (req, res) => {
  const c = db.getConnectionSettings();
  res.json({
    overseerr: c.overseerrEnabled && !!c.overseerrUrl,
    radarr: c.radarrEnabled && !!c.radarrUrl,
    sonarr: c.sonarrEnabled && !!c.sonarrUrl,
  });
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
    const data = await discoverRecommender.getDiscoverRecommendations(userId, userToken);
    res.json(data);
  } catch (err) {
    console.error('explore/recommendations error:', err);
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

  const { tmdbId, mediaType, title, year, service } = req.body;
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

  try {
    if (service === 'overseerr') {
      if (!c.overseerrEnabled || !c.overseerrUrl || !c.overseerrApiKey) {
        return res.status(400).json({ error: 'Overseerr not configured' });
      }
      const r = await fetch(`${c.overseerrUrl.replace(/\/$/, '')}/api/v1/request`, {
        method: 'POST',
        headers: {
          'X-Api-Key': c.overseerrApiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ mediaType, mediaId: Number(tmdbId) }),
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
      const qualityProfileId = profiles[0]?.id;
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
      const qualityProfileId = profiles[0]?.id;
      const rootFolderPath = folders[0]?.path;
      const languageProfileId = langs[0]?.id || 1;
      if (!qualityProfileId || !rootFolderPath) {
        return res.status(500).json({ error: 'Could not determine Sonarr quality profile or root folder' });
      }
      const r = await fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/series`, {
        method: 'POST',
        headers: {
          'X-Api-Key': c.sonarrApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tvdbId: 0, // Sonarr v4 accepts tmdbId lookup, fallback gracefully
          title: title || '',
          qualityProfileId,
          languageProfileId,
          rootFolderPath,
          monitored: true,
          addOptions: { searchForMissingEpisodes: true },
          // Sonarr v4 supports tmdbId directly
          ...(Number(tmdbId) ? { tmdbId: Number(tmdbId) } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const body = await r.text();
        return res.status(r.status).json({ error: `Sonarr error: ${body}` });
      }
    }

    // Log the request so it shows as "Already Requested" in the UI
    db.addDiscoverRequest(userId, tmdbId, mediaType, title || '', service);
    discoverRecommender.invalidateUserCache(userId);

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
