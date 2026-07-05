/**
 * Diskovarr Wrapped API. Each year's Wrapped unlocks December 1 of that year
 * and stays viewable afterward (archive); admins may preview the locked
 * in-progress year. Stats come from wrappedStats (precomputed, lazily
 * refreshed); the leaderboard rides along in every year response.
 */
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const wrappedStats = require('../services/wrappedStats');
const plexService = require('../services/plex');
const tautulliService = require('../services/tautulli');
const logger = require('../services/logger');

function requireUser(req, res) {
  const plexUser = req.session?.plexUser;
  if (!plexUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  // API-key auth injects a synthetic user carrying isAdmin on the user object
  // (see middleware/requireAuth.js) rather than on the session.
  const userId = String(plexUser.id ?? plexUser.userId);
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser || plexUser.isAdmin)
    || db.getPrivilegedUserIds().includes(userId);
  return { userId, isAdmin, token: plexUser.token };
}

function parseYear(req, res) {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: 'Bad year' });
    return null;
  }
  return year;
}

// GET /api/wrapped/years — which Wrapped years the requester can open
router.get('/years', (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  res.json(wrappedStats.getAvailableYears(auth.isAdmin));
});

// GET /api/wrapped/:year — own payload + global (leaderboard) + share slug
router.get('/:year(\\d+)', (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  const year = parseYear(req, res);
  if (year == null) return;
  if (!wrappedStats.isYearUnlocked(year) && !auth.isAdmin) {
    return res.status(403).json({ error: 'This Wrapped has not unlocked yet' });
  }
  try {
    res.json(wrappedStats.getWrapped(auth.userId, year));
  } catch (err) {
    logger.error(`wrapped ${year} failed for ${auth.userId}: ${err.message}`);
    res.status(500).json({ error: 'Failed to compute Wrapped' });
  }
});

// POST /api/wrapped/:year/playlist — build "Diskovarr Wrapped {year}" in the
// user's own Plex account from their top content (replace semantics).
router.post('/:year(\\d+)/playlist', async (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  const year = parseYear(req, res);
  if (year == null) return;
  if (!wrappedStats.isYearUnlocked(year) && !auth.isAdmin) {
    return res.status(403).json({ error: 'This Wrapped has not unlocked yet' });
  }
  if (!auth.token) return res.status(400).json({ error: 'No Plex token on session — sign in again' });

  const wrapped = wrappedStats.getWrapped(auth.userId, year);
  if (wrapped.notEnoughData) return res.status(400).json({ error: 'Not enough watch data for a playlist' });

  // Top 10 movies + top 5 shows by watch time. libraryKey is the item's
  // CURRENT rating key (drift-resolved at compute time); skip anything that
  // no longer exists in the library at all.
  const picks = [
    ...wrapped.payload.topMovies.bySeconds.slice(0, 10),
    ...wrapped.payload.topShows.bySeconds.slice(0, 5),
  ];
  const keys = picks.map((p) => p.libraryKey || p.ratingKey).filter((rk) => rk && db.getLibraryItemByKey(rk));
  if (!keys.length) return res.status(400).json({ error: 'None of your top titles are in the library anymore' });

  try {
    const title = `Diskovarr Wrapped ${year}`;
    const { playlistId, count } = await plexService.createPlaylistWithItems(auth.token, title, keys);
    logger.info(`wrapped playlist "${title}" created for ${auth.userId} (${count} items)`);
    res.json({ title, count, deepLink: plexService.getPlaylistDeepLink(playlistId) });
  } catch (err) {
    logger.error(`wrapped playlist failed for ${auth.userId}: ${err.message}`);
    res.status(502).json({ error: 'Plex refused the playlist — try again' });
  }
});

// POST /api/wrapped/:year/recompute — admin: force a fresh compute
router.post('/:year(\\d+)/recompute', (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  if (!auth.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const year = parseYear(req, res);
  if (year == null) return;
  const result = wrappedStats.computeWrappedYear(year);
  logger.info(`wrapped ${year} recomputed by ${auth.userId} (${result.users} users)`);
  res.json(result);
});

// POST /api/wrapped/backfill — admin: deep Tautulli history backfill for fresh installs
router.post('/backfill', async (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  if (!auth.isAdmin) return res.status(403).json({ error: 'Admin only' });
  try {
    const rows = await tautulliService.syncFullWatchHistory();
    logger.info(`wrapped backfill by ${auth.userId}: ${rows} history rows upserted`);
    res.json({ rows });
  } catch (err) {
    logger.error(`wrapped backfill failed: ${err.message}`);
    res.status(502).json({ error: 'Backfill failed — check Tautulli connection' });
  }
});

module.exports = router;
