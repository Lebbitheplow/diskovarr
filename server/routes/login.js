const express = require('express');
const router = express.Router();
const tmdbService = require('../services/tmdb');

// GET /api/login/posters — returns poster URLs for the login screen background
router.get('/posters', async (req, res) => {
  try {
    // Fetch 5 pages of trending content for both movies and TV shows to get enough items
    const [moviesPages, tvPages] = await Promise.all([
      Promise.all([
        tmdbService.getTrending('movie', 1),
        tmdbService.getTrending('movie', 2),
        tmdbService.getTrending('movie', 3),
        tmdbService.getTrending('movie', 4),
        tmdbService.getTrending('movie', 5),
      ]),
      Promise.all([
        tmdbService.getTrending('tv', 1),
        tmdbService.getTrending('tv', 2),
        tmdbService.getTrending('tv', 3),
        tmdbService.getTrending('tv', 4),
        tmdbService.getTrending('tv', 5),
      ]),
    ]);

    // Flatten the arrays from multiple pages
    const movies = moviesPages.flat();
    const tvShows = tvPages.flat();

    const movieDetails = await tmdbService.batchGetDetails(
      movies.slice(0, 100).map(m => ({ tmdbId: m.tmdbId, mediaType: 'movie' }))
    );
    const tvDetails = await tmdbService.batchGetDetails(
      tvShows.slice(0, 100).map(t => ({ tmdbId: t.tmdbId, mediaType: 'tv' }))
    );

    const posters = [
      ...movieDetails.filter(d => d?.posterUrl).slice(0, 100).map(d => ({
        url: d.posterUrl,
        title: d.title,
        year: d.year,
      })),
      ...tvDetails.filter(d => d?.posterUrl).slice(0, 100).map(d => ({
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
