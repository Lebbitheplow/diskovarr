const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const config = require('../config');
const naming = require('../lib/naming');
const torrentLib = require('../lib/torrent');
const downloader = require('../lib/downloader');
const sonarr = require('../lib/sonarr');
const mappings = require('../lib/mappings');

const router = express.Router();

router.use((req, res, next) => {
  if (req.get('X-Api-Key') !== getSetting('api_key')) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  next();
});

router.get('/health', async (req, res) => {
  const ytdlp = require('../lib/ytdlp');
  const fs = require('fs');
  const path = require('path');
  const ytDlp = await downloader.ytdlpVersion();
  res.json({
    ok: true,
    version: require('../package.json').version,
    sonarr: !!(getSetting('sonarr_url') && getSetting('sonarr_api_key')),
    youtubeKey: !!getSetting('youtube_api_key'),
    cookies: fs.existsSync(path.join(config.dataDir, 'cookies.txt')),
    ytDlp: ytDlp || 'missing',
    ytDlpStatus: ytdlp.status(),
    downloadsDir: config.downloadsDir,
  });
});

router.get('/config', (req, res) => {
  res.json({
    sonarrUrl: getSetting('sonarr_url'),
    sonarrApiKey: getSetting('sonarr_api_key') ? '••••' : '',
    youtubeApiKey: getSetting('youtube_api_key') ? '••••' : '',
    downloadsDir: config.downloadsDir,
  });
});

router.put('/config', (req, res) => {
  const { sonarrUrl, sonarrApiKey, youtubeApiKey, cookies } = req.body || {};
  if (sonarrUrl !== undefined) setSetting('sonarr_url', String(sonarrUrl).replace(/\/$/, ''));
  if (sonarrApiKey !== undefined && sonarrApiKey !== '••••') setSetting('sonarr_api_key', sonarrApiKey);
  if (youtubeApiKey !== undefined && youtubeApiKey !== '••••') setSetting('youtube_api_key', youtubeApiKey);
  // YouTube account cookies (Netscape cookies.txt) — unlock age-restricted
  // videos. Empty string clears them. On set, un-break previously failed
  // matches so the scheduler re-offers and re-searches them.
  if (cookies !== undefined) {
    const fs = require('fs');
    const path = require('path');
    const cookiesFile = path.join(config.dataDir, 'cookies.txt');
    if (String(cookies).trim()) {
      fs.writeFileSync(cookiesFile, String(cookies).trim() + '\n', { mode: 0o600 });
      const { changes } = db.prepare('UPDATE episode_matches SET broken = 0 WHERE broken = 1').run();
      console.log(`[manage] cookies saved; reset ${changes} broken match(es) for retry`);
    } else {
      try { fs.unlinkSync(cookiesFile); } catch { /* already gone */ }
    }
  }
  res.json({ ok: true });
});

router.get('/mappings', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM episode_matches em WHERE em.mapping_id = m.id) AS total_episodes,
      (SELECT COUNT(*) FROM episode_matches em WHERE em.mapping_id = m.id AND em.video_id IS NOT NULL AND em.broken = 0) AS matched_episodes
    FROM series_mappings m ORDER BY m.created_at DESC
  `).all();
  res.json(rows);
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
      channelId && String(channelId).startsWith('UC') ? 'UU' + String(channelId).slice(2) : null,
      JSON.stringify(playlistIds || []), Math.floor(Date.now() / 1000));
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

// Placeholder until the matcher lands; keeps POST /mappings' contract stable
function tryAutoMatch(mappingId) {
  try {
    const matcher = require('../lib/matcher');
    matcher.autoMatch(mappingId).catch(e => console.error(`[matcher] mapping ${mappingId}: ${e.message}`));
  } catch { /* matcher not available yet */ }
}

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
  res.json({ ...mapping, playlist_ids: JSON.parse(mapping.playlist_ids || '[]'), matches, downloads });
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
    tryAutoMatch(mapping.id);
    res.json({ ok: true, episodeCount, ...mappings.refreshMatchStatus(mapping.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/mappings/:id/matches/:season/:episode', (req, res) => {
  const mapping = mappings.getMapping(req.params.id);
  if (!mapping) return res.status(404).json({ error: 'not found' });
  const { videoId } = req.body || {};
  const season = Number(req.params.season);
  const episode = Number(req.params.episode);
  const row = db.prepare('SELECT * FROM episode_matches WHERE mapping_id = ? AND season = ? AND episode = ?')
    .get(mapping.id, season, episode);
  if (!row) return res.status(404).json({ error: 'episode not found' });
  if (videoId) {
    db.prepare(`
      UPDATE episode_matches SET video_id = ?, confidence = 1, source = 'manual', broken = 0
      WHERE mapping_id = ? AND season = ? AND episode = ?
    `).run(String(videoId), mapping.id, season, episode);
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

router.get('/youtube/channels', async (req, res) => {
  const youtube = require('../lib/youtube');
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    // URLs/handles/ids resolve directly (1 unit); free text searches (100 units)
    if (/youtube\.com|youtu\.be|^UC[\w-]{22}$|^@/.test(q)) {
      const resolved = await youtube.resolveChannel(q);
      return res.json(resolved ? [{ ...resolved, description: '', thumbnail: '' }] : []);
    }
    res.json(await youtube.searchChannels(q));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/downloads', (req, res) => {
  res.json(db.prepare('SELECT * FROM downloads ORDER BY added_on DESC').all());
});

// Dev helper: mint a torrent for any videoId so the qbit flow can be exercised
// without the torznab side (curl -F torrents=@file /api/v2/torrents/add)
router.post('/debug/torrent', (req, res) => {
  const { videoId, releaseTitle, durationSec } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  const title = releaseTitle || naming.buildReleaseTitle('Tuberr Debug', 1, 1, videoId);
  const sizeBytes = naming.estimateSizeBytes(durationSec);
  const { buffer, infoHash } = torrentLib.buildTorrent({ releaseTitle: title, sizeBytes, videoId });
  db.prepare(`
    INSERT INTO grabs (info_hash, video_id, release_title, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(info_hash) DO UPDATE SET release_title = excluded.release_title, size_bytes = excluded.size_bytes
  `).run(infoHash, videoId, title, sizeBytes, Math.floor(Date.now() / 1000));
  res.set('X-Info-Hash', infoHash);
  res.set('Content-Disposition', `attachment; filename="${infoHash}.torrent"`);
  res.type('application/x-bittorrent').send(buffer);
});

module.exports = router;
