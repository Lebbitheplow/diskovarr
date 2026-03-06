const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
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
    const url = `${plexService.PLEX_URL}${posterPath}?X-Plex-Token=${plexService.PLEX_TOKEN}`;
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
router.get('/watchlist', async (req, res) => {
  try {
    const { token: userToken } = req.session.plexUser;
    const watchlist = await plexService.getWatchlist(userToken);
    res.json(watchlist);
  } catch (err) {
    console.error('watchlist get error:', err);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

// POST /api/watchlist/add
router.post('/watchlist/add', async (req, res) => {
  const { ratingKey } = req.body;
  if (!ratingKey) return res.status(400).json({ error: 'ratingKey required' });

  // Security: ratingKey must be numeric
  if (!/^\d+$/.test(String(ratingKey))) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }

  try {
    const { token: userToken } = req.session.plexUser;
    await plexService.addToWatchlist(userToken, ratingKey);
    res.json({ success: true });
  } catch (err) {
    console.error('watchlist add error:', err);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// POST /api/watchlist/remove
router.post('/watchlist/remove', async (req, res) => {
  const { playlistId, playlistItemId } = req.body;
  if (!playlistId || !playlistItemId) {
    return res.status(400).json({ error: 'playlistId and playlistItemId required' });
  }

  // Security: must be numeric IDs
  if (!/^\d+$/.test(String(playlistId)) || !/^\d+$/.test(String(playlistItemId))) {
    return res.status(400).json({ error: 'Invalid playlist IDs' });
  }

  try {
    const { token: userToken } = req.session.plexUser;
    await plexService.removeFromWatchlist(userToken, playlistId, playlistItemId);
    res.json({ success: true });
  } catch (err) {
    console.error('watchlist remove error:', err);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
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

    // Attach watchlist status
    const watchlist = await plexService.getWatchlist(userToken);
    const watchlistKeys = new Set(watchlist.items.map(i => i.ratingKey));
    const watchlistMap = new Map(watchlist.items.map(i => [i.ratingKey, i]));

    const itemsWithWatchlist = items.map(item => ({
      ...item,
      isInWatchlist: watchlistKeys.has(item.ratingKey),
      watchlistPlaylistId: watchlist.playlistId,
      watchlistItemId: watchlistMap.get(item.ratingKey)?.playlistItemId || null,
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

module.exports = router;
