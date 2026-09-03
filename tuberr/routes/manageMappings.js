const express = require('express');
const { db } = require('../db');
const naming = require('../lib/naming');
const sonarr = require('../lib/sonarr');
const mappings = require('../lib/mappings');

// /manage/mappings — series ↔ channel mappings, per-episode matches, states.
// Mounted by manage.js behind its API-key gate.

const router = express.Router();
const MAPPING_STATES = new Set(['active', 'paused', 'unavailable']);

function tryAutoMatch(mappingId, opts) {
  try {
    const matcher = require('../lib/matcher');
    matcher.autoMatch(mappingId, opts).catch(e => console.error(`[matcher] mapping ${mappingId}: ${e.message}`));
  } catch { /* matcher not available yet */ }
}

function uploadsPlaylistFor(channelId) {
  return channelId && String(channelId).startsWith('UC') ? 'UU' + String(channelId).slice(2) : null;
}

function clearBlocklistForEpisode(mapping, season, episode) {
  if (!sonarr.isConfigured()) return;
  sonarr.clearBlocklistFor([naming.releasePrefix(mapping.title, season, episode)])
    .catch(e => console.error(`[manage] blocklist cleanup failed: ${e.message}`));
}

router.get('/mappings', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM episode_matches em WHERE em.mapping_id = m.id AND em.skipped = 0) AS total_episodes,
      (SELECT COUNT(*) FROM episode_matches em WHERE em.mapping_id = m.id AND em.skipped = 0 AND em.video_id IS NOT NULL AND em.broken = 0) AS matched_episodes,
      (SELECT COUNT(*) FROM episode_matches em WHERE em.mapping_id = m.id AND em.skipped = 1) AS skipped_episodes,
      (SELECT COUNT(*) FROM episode_matches em WHERE em.mapping_id = m.id AND em.broken = 1) AS broken_episodes
    FROM series_mappings m ORDER BY m.created_at DESC
  `).all();
  res.json(rows.map(r => ({ ...r, state: r.state || 'active' })));
});

router.post('/mappings', async (req, res) => {
  const { tvdbId, title, channelId, channelTitle, playlistIds, sonarrSeriesId } = req.body || {};
  if (!tvdbId || !title) return res.status(400).json({ error: 'tvdbId and title required' });
  try {
    db.prepare(`
      INSERT INTO series_mappings (tvdb_id, sonarr_series_id, title, channel_id, channel_title, uploads_playlist_id, playlist_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tvdb_id) DO UPDATE SET
        title = excluded.title,
        sonarr_series_id = COALESCE(excluded.sonarr_series_id, series_mappings.sonarr_series_id),
        channel_id = COALESCE(excluded.channel_id, series_mappings.channel_id),
        channel_title = COALESCE(excluded.channel_title, series_mappings.channel_title),
        uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, series_mappings.uploads_playlist_id),
        playlist_ids = excluded.playlist_ids
    `).run(Number(tvdbId), sonarrSeriesId || null, title, channelId || null, channelTitle || null,
      uploadsPlaylistFor(channelId), JSON.stringify(playlistIds || []), Math.floor(Date.now() / 1000));
    const mapping = db.prepare('SELECT * FROM series_mappings WHERE tvdb_id = ?').get(Number(tvdbId));
    let episodeCount = 0;
    let syncError = null;
    try {
      episodeCount = await mappings.syncEpisodesFromSonarr(mapping);
    } catch (e) {
      syncError = e.message; // series may not be in Sonarr yet; refresh can retry
    }
    // Auto-match kicks off when a channel is set and metadata support is available
    tryAutoMatch(mapping.id);
    mappings.refreshMatchStatus(mapping.id);
    res.json({ ...mappings.getMapping(mapping.id), episodeCount, syncError });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/mappings/:id', (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  const matches = db.prepare(`
    SELECT em.*, v.title AS video_title, v.published_at, v.duration_sec
    FROM episode_matches em
    LEFT JOIN videos v ON v.video_id = em.video_id AND v.mapping_id = em.mapping_id
    WHERE em.mapping_id = ? ORDER BY em.season, em.episode
  `).all(mapping.id);
  const downloads = db.prepare('SELECT * FROM downloads WHERE info_hash IN (SELECT info_hash FROM grabs WHERE mapping_id = ?)')
    .all(mapping.id);
  res.json({ ...mapping, state: mapping.state || 'active', playlist_ids: JSON.parse(mapping.playlist_ids || '[]'), matches, downloads });
});

// State changes ('active' resets the zero-progress counter) and channel /
// playlist edits (which rebuild the video pool and re-match in the background).
router.put('/mappings/:id', (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  const { state, stateReason, playlistIds, channelId, channelTitle } = req.body || {};
  if (state !== undefined && !MAPPING_STATES.has(state)) {
    return res.status(400).json({ error: `state must be one of ${[...MAPPING_STATES].join(', ')}` });
  }
  if (playlistIds !== undefined && !Array.isArray(playlistIds)) {
    return res.status(400).json({ error: 'playlistIds must be an array' });
  }
  if (state !== undefined) mappings.setMappingState(mapping.id, state, stateReason);
  else if (stateReason !== undefined) db.prepare('UPDATE series_mappings SET state_reason = ? WHERE id = ?').run(stateReason || null, mapping.id);

  let sourceChanged = false;
  if (channelId !== undefined && (channelId || null) !== mapping.channel_id) {
    db.prepare('UPDATE series_mappings SET channel_id = ?, channel_title = ?, uploads_playlist_id = ?, detect_attempts = 0 WHERE id = ?')
      .run(channelId || null, channelTitle || null, uploadsPlaylistFor(channelId), mapping.id);
    sourceChanged = true;
  } else if (channelTitle !== undefined) {
    db.prepare('UPDATE series_mappings SET channel_title = ? WHERE id = ?').run(channelTitle || null, mapping.id);
  }
  if (playlistIds !== undefined) {
    const ids = playlistIds.map(String).filter(Boolean);
    if (JSON.stringify(ids) !== (mapping.playlist_ids || '[]')) {
      db.prepare('UPDATE series_mappings SET playlist_ids = ? WHERE id = ?').run(JSON.stringify(ids), mapping.id);
      sourceChanged = true;
    }
  }
  if (sourceChanged) {
    db.prepare('UPDATE series_mappings SET zero_progress_runs = 0, last_full_refresh_at = 0 WHERE id = ?').run(mapping.id);
    tryAutoMatch(mapping.id, { refresh: 'full' });
  }
  const updated = mappings.getMapping(mapping.id);
  res.json({ ...updated, state: updated.state || 'active', playlist_ids: JSON.parse(updated.playlist_ids || '[]'), refreshing: sourceChanged });
});

router.delete('/mappings/:id', (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM episode_matches WHERE mapping_id = ?').run(mapping.id);
  db.prepare('DELETE FROM videos WHERE mapping_id = ?').run(mapping.id);
  db.prepare('DELETE FROM series_mappings WHERE id = ?').run(mapping.id);
  res.json({ ok: true });
});

router.post('/mappings/:id/refresh', async (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  try {
    const episodeCount = await mappings.syncEpisodesFromSonarr(mapping);
    tryAutoMatch(mapping.id, { refresh: 'full' });
    res.json({ ok: true, episodeCount, ...mappings.refreshMatchStatus(mapping.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Body: { videoId } sets a manual match, {} clears it; { skipped, reason?,
// unmonitor? } marks the episode as never-to-download (optionally unmonitoring
// it in Sonarr so it leaves Wanted) or un-skips it.
router.put('/mappings/:id/matches/:season/:episode', async (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  const { videoId, skipped, reason, unmonitor } = req.body || {};
  const season = Number(req.params.season);
  const episode = Number(req.params.episode);
  const row = db.prepare('SELECT * FROM episode_matches WHERE mapping_id = ? AND season = ? AND episode = ?')
    .get(mapping.id, season, episode);
  if (!row) return res.status(404).json({ error: 'episode not found' });

  if (skipped !== undefined) {
    let sonarrError = null;
    if (skipped) {
      db.prepare('UPDATE episode_matches SET skipped = 1, skip_reason = ? WHERE mapping_id = ? AND season = ? AND episode = ?')
        .run(reason ? String(reason).slice(0, 200) : null, mapping.id, season, episode);
      if (unmonitor && row.sonarr_episode_id) {
        try {
          await sonarr.monitorEpisodes([row.sonarr_episode_id], false);
        } catch (e) {
          sonarrError = e.message;
          console.error(`[manage] unmonitor episode ${row.sonarr_episode_id} failed: ${e.message}`);
        }
      }
    } else {
      db.prepare('UPDATE episode_matches SET skipped = 0, skip_reason = NULL WHERE mapping_id = ? AND season = ? AND episode = ?')
        .run(mapping.id, season, episode);
    }
    const status = mappings.refreshMatchStatus(mapping.id);
    return res.json({ ok: true, skipped: !!skipped, sonarrEpisodeId: row.sonarr_episode_id, sonarrError, ...status });
  }

  if (videoId) {
    db.prepare(`
      UPDATE episode_matches SET video_id = ?, confidence = 1, source = 'manual', broken = 0
      WHERE mapping_id = ? AND season = ? AND episode = ?
    `).run(String(videoId), mapping.id, season, episode);
    // A manual match supersedes any earlier failure of this episode
    if (row.broken) clearBlocklistForEpisode(mapping, season, episode);
    // Grab it right away if Sonarr wants it — no extra click needed
    if (row.sonarr_episode_id) {
      sonarr.episodeSearch([row.sonarr_episode_id])
        .catch(e => console.error(`[manage] auto-search after manual match failed: ${e.message}`));
    }
  } else {
    db.prepare(`
      UPDATE episode_matches SET video_id = NULL, confidence = 0, source = 'manual', broken = 0
      WHERE mapping_id = ? AND season = ? AND episode = ?
    `).run(mapping.id, season, episode);
  }
  mappings.refreshMatchStatus(mapping.id);
  res.json({ ok: true, sonarrEpisodeId: row.sonarr_episode_id });
});

// Manual trigger for channel auto-detection (also runs on the scheduler)
router.post('/mappings/:id/detect-channel', async (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  try {
    const channelDetect = require('../lib/channelDetect');
    res.json(await channelDetect.detectChannel(mapping.id));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/mappings/:id/search-episode', async (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  const { season, episode } = req.body || {};
  const row = db.prepare('SELECT sonarr_episode_id FROM episode_matches WHERE mapping_id = ? AND season = ? AND episode = ?')
    .get(mapping.id, Number(season), Number(episode));
  if (!row || !row.sonarr_episode_id) return res.status(404).json({ error: 'episode not linked to Sonarr' });
  try {
    await sonarr.episodeSearch([row.sonarr_episode_id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
