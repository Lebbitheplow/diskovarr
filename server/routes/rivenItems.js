'use strict';

// /api/riven — privileged-user actions on Riven (DUMB) library items.
// Mounted in server.js behind requireAuth + requirePrivileged, so both admins
// and elevated request managers can reset a stuck download without opening
// Riven's own UI.

const express = require('express');
const router = express.Router();
const riven = require('../services/rivenClient');
const logger = require('../services/logger');

const MAX_SEASONS = 100;
const MAX_EPISODES = 500;

function parseTmdbId(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseMediaType(value) {
  if (value === 'movie') return 'movie';
  if (value === 'tv' || value === 'show') return 'tv';
  return null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Body → { seasons: [n], episodes: [{ season, episode }] } or an error string.
function parseSelection(body) {
  const rawSeasons = Array.isArray(body?.seasons) ? body.seasons : [];
  const rawEpisodes = Array.isArray(body?.episodes) ? body.episodes : [];
  if (rawSeasons.length > MAX_SEASONS) return { error: `Too many seasons (max ${MAX_SEASONS})` };
  if (rawEpisodes.length > MAX_EPISODES) return { error: `Too many episodes (max ${MAX_EPISODES})` };
  const seasons = [];
  for (const s of rawSeasons) {
    const n = positiveInt(s);
    if (!n) return { error: 'Season numbers must be positive integers' };
    seasons.push(n);
  }
  const episodes = [];
  for (const e of rawEpisodes) {
    const season = positiveInt(e?.season);
    const episode = positiveInt(e?.episode);
    if (!season || !episode) return { error: 'Episodes must be { season, episode } positive integers' };
    episodes.push({ season, episode });
  }
  return { seasons, episodes };
}

function sendRivenError(res, err, context) {
  const status = err.status === 404 ? 404 : err.status === 400 ? 400 : 502;
  if (status === 502) logger.warn(`[riven] ${context}: ${err.message}`);
  res.status(status).json({ error: err.message });
}

// GET /api/riven/item?tmdbId=&mediaType= — Riven's view of a title (compact tree)
router.get('/item', async (req, res) => {
  const tmdbId = parseTmdbId(req.query.tmdbId);
  const mediaType = parseMediaType(req.query.mediaType);
  if (!tmdbId || !mediaType) return res.status(400).json({ error: 'tmdbId and mediaType are required' });
  if (!riven.isRivenEnabled()) return res.status(400).json({ error: 'DUMB / Riven is not enabled' });
  try {
    const item = await riven.getItemByTmdb(tmdbId, mediaType);
    if (!item) return res.status(404).json({ error: 'This title is not in Riven' });
    res.json({ item: riven.summarizeItem(item) });
  } catch (err) {
    sendRivenError(res, err, `lookup tmdb=${tmdbId}`);
  }
});

// POST /api/riven/reset — blacklist the current torrent and re-queue.
// Body: { tmdbId, mediaType, seasons?: [n], episodes?: [{ season, episode }] }
// No seasons/episodes → the whole movie or show.
router.post('/reset', async (req, res) => {
  const tmdbId = parseTmdbId(req.body?.tmdbId);
  const mediaType = parseMediaType(req.body?.mediaType);
  if (!tmdbId || !mediaType) return res.status(400).json({ error: 'tmdbId and mediaType are required' });
  if (!riven.isRivenEnabled()) return res.status(400).json({ error: 'DUMB / Riven is not enabled' });
  const selection = parseSelection(req.body);
  if (selection.error) return res.status(400).json({ error: selection.error });
  if (mediaType === 'movie' && (selection.seasons.length || selection.episodes.length)) {
    return res.status(400).json({ error: 'Movies have no seasons or episodes to select' });
  }
  try {
    const result = await riven.resetByTmdb({ tmdbId, mediaType, ...selection });
    const who = req.session?.plexUser?.username || 'unknown';
    logger.info(`[riven] ${who} reset ${result.item.id} (${result.targets.map(t => t.label).join(', ')})`);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendRivenError(res, err, `reset tmdb=${tmdbId}`);
  }
});

module.exports = router;
