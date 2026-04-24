const express = require('express');
const router = express.Router();
const tmdbService = require('../services/tmdb');

// GET /api/login/posters — returns poster URLs for the login screen background
router.get('/posters', async (req, res) => {
  try {
    const [movies, tvShows] = await Promise.all([
      tmdbService.getTrending('movie', 1),
      tmdbService.getTrending('tv', 1),
    ]);

    const movieDetails = await tmdbService.batchGetDetails(
      movies.slice(0, 50).map(m => ({ tmdbId: m.tmdbId, mediaType: 'movie' }))
    );
    const tvDetails = await tmdbService.batchGetDetails(
      tvShows.slice(0, 50).map(t => ({ tmdbId: t.tmdbId, mediaType: 'tv' }))
    );

    const posters = [
      ...movieDetails.filter(d => d?.posterUrl).slice(0, 50).map(d => ({
        url: d.posterUrl,
        title: d.title,
        year: d.year,
      })),
      ...tvDetails.filter(d => d?.posterUrl).slice(0, 50).map(d => ({
        url: d.posterUrl,
        title: d.title,
        year: d.year,
      })),
    ];

    res.json({ posters });
  } catch (err) {
    console.warn('[login/posters] Failed to fetch posters:', err.message);
    res.json({ posters: [] });
  }
});

module.exports = router;
