const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('../db');
const config = require('../config');
const naming = require('../lib/naming');
const torrentLib = require('../lib/torrent');
const downloader = require('../lib/downloader');
const sonarr = require('../lib/sonarr');
const { getOptions, setOptions } = require('../lib/options');

// Management API used by Diskovarr's admin UI. Everything requires the
// X-Api-Key header; mapping routes live in manageMappings.js and the status/
// maintenance routes in manageStatus.js (both mounted below the auth gate).

const router = express.Router();

router.use((req, res, next) => {
  if (req.get('X-Api-Key') !== getSetting('api_key')) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  next();
});

router.get('/health', async (req, res) => {
  const ytdlp = require('../lib/ytdlp');
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
    ...getOptions(),
  });
});

// Clears `broken` on every failed match (so the scheduler re-offers and
// re-searches them) and, best-effort, removes their Sonarr blocklist entries
// so the identical release title is accepted again.
function unbreakAll(reason) {
  const rows = db.prepare(`
    SELECT em.season, em.episode, m.title FROM episode_matches em
    JOIN series_mappings m ON m.id = em.mapping_id WHERE em.broken = 1
  `).all();
  const { changes } = db.prepare('UPDATE episode_matches SET broken = 0 WHERE broken = 1').run();
  console.log(`[manage] ${reason}; reset ${changes} broken match(es) for retry`);
  if (rows.length && sonarr.isConfigured()) {
    sonarr.clearBlocklistFor(rows.map(r => naming.releasePrefix(r.title, r.season, r.episode)))
      .catch(e => console.error(`[manage] blocklist cleanup failed: ${e.message}`));
  }
  return changes;
}

router.put('/config', (req, res) => {
  const { sonarrUrl, sonarrApiKey, youtubeApiKey, cookies } = req.body || {};
  if (sonarrUrl !== undefined) setSetting('sonarr_url', String(sonarrUrl).replace(/\/$/, ''));
  if (sonarrApiKey !== undefined && sonarrApiKey !== '••••') setSetting('sonarr_api_key', sonarrApiKey);
  if (youtubeApiKey !== undefined && youtubeApiKey !== '••••') setSetting('youtube_api_key', youtubeApiKey);
  setOptions(req.body || {});
  // YouTube account cookies (Netscape cookies.txt) — unlock age-restricted
  // videos. Empty string clears them. On set, un-break previously failed
  // matches so the scheduler re-offers and re-searches them.
  if (cookies !== undefined) {
    const cookiesFile = path.join(config.dataDir, 'cookies.txt');
    if (String(cookies).trim()) {
      fs.writeFileSync(cookiesFile, String(cookies).trim() + '\n', { mode: 0o600 });
      unbreakAll('cookies saved');
      require('../lib/state').state.cookies.botCheckAt = null;
    } else {
      try { fs.unlinkSync(cookiesFile); } catch { /* already gone */ }
    }
  }
  res.json({ ok: true, ...getOptions() });
});

// Rotate the management API key. Authenticated with the CURRENT key (the
// route middleware already enforced that), so a compromised key can be
// replaced from Diskovarr's Connections page. Persists to the DB + the
// mirrored api_key.txt; the caller is responsible for updating anything that
// stores the old key (Diskovarr's tuberr_api_key + Sonarr's indexer).
router.post('/regenerate-key', (req, res) => {
  const newKey = crypto.randomBytes(24).toString('hex');
  setSetting('api_key', newKey);
  try {
    fs.writeFileSync(path.join(config.dataDir, 'api_key.txt'), newKey + '\n', { mode: 0o600 });
  } catch { /* non-fatal — key is still in the DB */ }
  res.json({ ok: true, apiKey: newKey });
});

router.use(require('./manageMappings'));
router.use(require('./manageStatus'));

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
