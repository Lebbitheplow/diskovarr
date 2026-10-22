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
  return { userId, isAdmin, token: plexUser.token, jellyfin: plexUser.jellyfin || null };
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
router.get('/:year', (req, res) => {
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

function jellyfinEnabled() {
  try { return require('../services/jellyfin').isEnabled(); } catch { return false; }
}

// Which server the Wrapped playlist goes to: `requested` ('plex' | 'jellyfin',
// the picker on the Wrapped page) when this session can use it, else the
// active source (the nav toggle), else whichever server the session can reach.
// null when nothing fits — or an explicit request names an unusable server.
function playlistTarget(auth, requested, activeSource) {
  const usable = {
    plex: !!auth.token,
    jellyfin: !!auth.jellyfin?.userId && jellyfinEnabled(),
  };
  if (requested === 'plex' || requested === 'jellyfin') return usable[requested] ? requested : null;
  const preferred = activeSource === 'jellyfin' ? 'jellyfin' : 'plex';
  if (usable[preferred]) return preferred;
  return ['plex', 'jellyfin'].find(s => usable[s]) || null;
}

// The top titles as rating keys on `source`. History keeps the key of the
// server each play happened on, so a title watched on the other server is
// matched to the same work there by TMDB id (then title + year, as the
// Wrapped drift resolver does). Titles the target server lacks are skipped.
function resolvePlaylistKeys(picks, source) {
  const byTitle = db.prepare('SELECT rating_key, year FROM library_items WHERE source = ? AND type = ? AND title = ? COLLATE NOCASE LIMIT 5');
  const keys = [];
  for (const p of picks) {
    const rk = p.libraryKey || p.ratingKey;
    const row = rk ? db.getLibraryItemByKey(rk) : null;
    const type = row?.type || p.mediaType;
    let key = null;
    if (row && (row.source || 'plex') === source) key = row.ratingKey;
    else if (row?.tmdbId) key = db.getLibraryItemByTmdbId(row.tmdbId, type === 'show' ? 'tv' : 'movie', source)?.rating_key || null;
    if (!key && p.title) {
      const rows = byTitle.all(source, type, p.title);
      const year = row?.year || p.year;
      key = (type === 'movie' && year ? rows.find(r => r.year === year) : rows[0])?.rating_key || null;
    }
    if (key && !keys.includes(String(key))) keys.push(String(key));
  }
  return keys;
}

// POST /api/wrapped/:year/playlist — build "Diskovarr Wrapped {year}" in the
// user's own Plex or Jellyfin account from their top content (replace
// semantics). Body `{ target }` picks the server; see playlistTarget.
router.post('/:year/playlist', async (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  const year = parseYear(req, res);
  if (year == null) return;
  if (!wrappedStats.isYearUnlocked(year) && !auth.isAdmin) {
    return res.status(403).json({ error: 'This Wrapped has not unlocked yet' });
  }
  const requested = req.body?.target;
  if (requested != null && requested !== 'plex' && requested !== 'jellyfin') {
    return res.status(400).json({ error: 'Unknown playlist target' });
  }
  const target = playlistTarget(auth, requested, req.session.activeSource);
  if (!target) {
    if (requested === 'jellyfin') return res.status(400).json({ error: 'No linked Jellyfin account on this session' });
    if (requested === 'plex' || !auth.jellyfin?.userId) return res.status(400).json({ error: 'No Plex token on session — sign in again' });
    return res.status(400).json({ error: 'Jellyfin is not enabled' });
  }
  const useJellyfin = target === 'jellyfin';

  const wrapped = wrappedStats.getWrapped(auth.userId, year);
  if (wrapped.notEnoughData) return res.status(400).json({ error: 'Not enough watch data for a playlist' });

  // Top 10 movies + top 5 shows by watch time, resolved onto the target server.
  const picks = [
    ...wrapped.payload.topMovies.bySeconds.slice(0, 10).map(p => ({ ...p, mediaType: 'movie' })),
    ...wrapped.payload.topShows.bySeconds.slice(0, 5).map(p => ({ ...p, mediaType: 'show' })),
  ];
  const keys = resolvePlaylistKeys(picks, target);
  if (!keys.length) {
    return res.status(400).json({ error: `None of your top titles are in the ${useJellyfin ? 'Jellyfin' : 'Plex'} library` });
  }

  const title = `Diskovarr Wrapped ${year}`;
  if (useJellyfin) {
    try {
      const playlists = require('../services/jellyfin/playlists');
      const { playlistId, count } = await playlists.createPlaylistWithItems(auth.jellyfin.userId, title, keys, { token: auth.jellyfin.token });
      const url = playlists.getPlaylistDeepLink(playlistId);
      logger.info(`wrapped Jellyfin playlist "${title}" created for ${auth.userId} (${count} items)`);
      return res.json({ ok: true, source: 'jellyfin', title, count, url, deepLink: url });
    } catch (err) {
      logger.error(`wrapped Jellyfin playlist failed for ${auth.userId}: ${err.message}`);
      return res.status(502).json({ error: 'Jellyfin refused the playlist — try again' });
    }
  }

  try {
    const { playlistId, count } = await plexService.createPlaylistWithItems(auth.token, title, keys);
    logger.info(`wrapped playlist "${title}" created for ${auth.userId} (${count} items)`);
    const deepLink = plexService.getPlaylistDeepLink(playlistId);
    res.json({ ok: true, source: 'plex', title, count, deepLink, url: deepLink });
  } catch (err) {
    logger.error(`wrapped playlist failed for ${auth.userId}: ${err.message}`);
    res.status(502).json({ error: 'Plex refused the playlist — try again' });
  }
});

// POST /api/wrapped/:year/recompute — admin: force a fresh compute
router.post('/:year/recompute', (req, res) => {
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

// POST /api/wrapped/backfill/jellyfin — admin: mirror every Jellyfin user's
// history now instead of waiting for the 15-minute job. Reports what Jellyfin
// can actually provide: with the Playback Reporting plugin, one row per play;
// without it, only each title's played state and latest play date.
router.post('/backfill/jellyfin', async (req, res) => {
  const auth = requireUser(req, res);
  if (!auth) return;
  if (!auth.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const jellyfin = require('../services/jellyfin');
  if (!jellyfin.isEnabled()) return res.status(400).json({ error: 'Jellyfin is not enabled' });
  try {
    const playbackReporting = await jellyfin.probePlaybackReporting(true);
    const users = await jellyfin.syncAllUsers();
    logger.info(`wrapped Jellyfin history refresh by ${auth.userId}: ${users} user(s), Playback Reporting ${playbackReporting ? 'available' : 'not installed'}`);
    res.json({ users, playbackReporting, history: playbackReporting ? 'per-play' : 'latest-play' });
  } catch (err) {
    logger.error(`wrapped Jellyfin history refresh failed: ${err.message}`);
    res.status(502).json({ error: 'History refresh failed — check the Jellyfin connection' });
  }
});

module.exports = router;
module.exports.playlistTarget = playlistTarget;
module.exports.resolvePlaylistKeys = resolvePlaylistKeys;
