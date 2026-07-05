const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, getSetting, setSetting } = require('../db');
const config = require('../config');
const torrent = require('../lib/torrent');
const multipart = require('../lib/multipart');
const downloader = require('../lib/downloader');

// qBittorrent WebUI API v2 — the subset Sonarr v4's QBittorrentProxyV2 calls.
// States: queued→queuedDL, downloading→downloading, error→error, and
// completed→pausedUP (progress 1) which Sonarr treats as done-and-safe-to-import.

const router = express.Router();

const QBIT_STATE = {
  queued: 'queuedDL',
  downloading: 'downloading',
  completed: 'pausedUP',
  error: 'error',
};

function getCategories() {
  try {
    return JSON.parse(getSetting('qbit_categories', '{}'));
  } catch {
    return {};
  }
}

function saveCategory(name, savePath) {
  if (!name) return;
  const cats = getCategories();
  cats[name] = { name, savePath: savePath || path.join(config.downloadsDir, name) };
  setSetting('qbit_categories', JSON.stringify(cats));
}

function categorySavePath(name) {
  if (!name) return config.downloadsDir;
  const cat = getCategories()[name];
  return (cat && cat.savePath) || path.join(config.downloadsDir, name);
}

router.post('/auth/login', (req, res) => {
  res.set('Set-Cookie', 'SID=tuberr; HttpOnly; Path=/');
  res.type('text/plain').send('Ok.');
});

router.post('/auth/logout', (req, res) => res.type('text/plain').send('Ok.'));

router.get('/app/webapiVersion', (req, res) => res.type('text/plain').send('2.8.3'));
router.get('/app/version', (req, res) => res.type('text/plain').send('v4.6.5'));

router.get('/app/preferences', (req, res) => {
  res.json({
    save_path: config.downloadsDir,
    temp_path_enabled: false,
    queueing_enabled: false,
    max_active_downloads: 10,
    max_active_torrents: 10,
    dht: true,
    max_ratio_enabled: false,
    max_ratio: -1,
    max_ratio_act: 0,
    max_seeding_time_enabled: false,
    max_seeding_time: -1,
    max_inactive_seeding_time_enabled: false,
    max_inactive_seeding_time: -1,
  });
});

function toInfoEntry(row) {
  return {
    hash: row.info_hash,
    name: row.release_title,
    size: row.size_bytes,
    total_size: row.size_bytes,
    progress: row.progress,
    eta: row.state === 'downloading' && row.eta > 0 ? row.eta : 8640000,
    state: QBIT_STATE[row.state] || 'unknown',
    category: row.category || '',
    save_path: row.save_path,
    content_path: row.content_path,
    ratio: 0,
    ratio_limit: -2,
    seeding_time: 0,
    seeding_time_limit: -2,
    inactive_seeding_time_limit: -2,
    added_on: row.added_on,
    completion_on: row.completed_on || 0,
    dlspeed: row.dlspeed,
    upspeed: 0,
    priority: 0,
    amount_left: Math.max(0, Math.round(row.size_bytes * (1 - row.progress))),
  };
}

router.get('/torrents/info', (req, res) => {
  const { category, hashes } = req.query;
  let rows = db.prepare('SELECT * FROM downloads').all();
  if (category !== undefined && category !== '') {
    rows = rows.filter(r => (r.category || '') === category);
  }
  if (hashes) {
    const wanted = new Set(String(hashes).toLowerCase().split('|'));
    rows = rows.filter(r => wanted.has(r.info_hash));
  }
  res.json(rows.map(toInfoEntry));
});

router.get('/torrents/properties', (req, res) => {
  const row = db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(String(req.query.hash || '').toLowerCase());
  if (!row) return res.status(404).type('text/plain').send('Not Found');
  res.json({ save_path: row.save_path, seeding_time: 0 });
});

router.get('/torrents/files', (req, res) => {
  const row = db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(String(req.query.hash || '').toLowerCase());
  if (!row) return res.status(404).type('text/plain').send('Not Found');
  res.json([{
    index: 0,
    name: `${row.release_title}/${row.release_title}.mp4`,
    size: row.size_bytes,
    progress: row.progress,
    priority: 1,
    is_seed: false,
  }]);
});

router.get('/torrents/categories', (req, res) => res.json(getCategories()));

router.post('/torrents/createCategory', (req, res) => {
  saveCategory(req.body.category, req.body.savePath);
  res.type('text/plain').send('Ok.');
});

router.post('/torrents/editCategory', (req, res) => {
  saveCategory(req.body.category, req.body.savePath);
  res.type('text/plain').send('Ok.');
});

router.post('/torrents/setCategory', (req, res) => {
  const { hashes, category } = req.body;
  if (category) saveCategory(category);
  if (hashes) {
    const stmt = db.prepare('UPDATE downloads SET category = ? WHERE info_hash = ?');
    for (const h of String(hashes).toLowerCase().split('|')) stmt.run(category || '', h);
  }
  res.type('text/plain').send('Ok.');
});

function addTorrentBuffer(buf, category) {
  const parsed = torrent.parseTorrent(buf);
  if (!parsed.videoId) {
    // Look up the grab record in case the torrent came from an older Tuberr
    const grab = db.prepare('SELECT video_id FROM grabs WHERE info_hash = ?').get(parsed.infoHash);
    if (!grab) throw new Error('torrent does not reference a Tuberr video');
    parsed.videoId = grab.video_id;
  }
  const savePath = categorySavePath(category);
  const contentPath = path.join(savePath, parsed.name);
  db.prepare(`
    INSERT INTO downloads (info_hash, video_id, release_title, category, save_path, content_path, state, progress, size_bytes, added_on)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    ON CONFLICT(info_hash) DO NOTHING
  `).run(parsed.infoHash, parsed.videoId, parsed.name, category || '', savePath, contentPath, parsed.size, Math.floor(Date.now() / 1000));
  downloader.enqueue(parsed.infoHash);
}

router.post('/torrents/add', (req, res) => {
  try {
    let category = '';
    const torrents = [];
    if (/multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      const { fields, files } = multipart.parse(req.body, req.headers['content-type']);
      category = fields.category || '';
      for (const f of files) {
        if (f.name === 'torrents' || f.filename.endsWith('.torrent')) torrents.push(f.data);
      }
    } else {
      category = req.body.category || '';
      // urls= form: fetch our own torznab download links synchronously is
      // unnecessary — the infohash is the last path segment before .torrent
      for (const url of String(req.body.urls || '').split('\n').filter(Boolean)) {
        const m = /([0-9a-f]{40})\.torrent/i.exec(url);
        if (!m) throw new Error(`unsupported url: ${url}`);
        const grab = db.prepare('SELECT * FROM grabs WHERE info_hash = ?').get(m[1].toLowerCase());
        if (!grab) throw new Error(`unknown grab: ${m[1]}`);
        const naming = require('../lib/naming');
        torrents.push(torrent.buildTorrent({
          releaseTitle: grab.release_title,
          sizeBytes: grab.size_bytes || naming.estimateSizeBytes(0),
          videoId: grab.video_id,
        }).buffer);
      }
    }
    if (torrents.length === 0) return res.status(415).type('text/plain').send('Fails.');
    if (category) saveCategory(category);
    for (const buf of torrents) addTorrentBuffer(buf, category);
    res.type('text/plain').send('Ok.');
  } catch (e) {
    console.error(`[qbit] torrents/add failed: ${e.message}`);
    res.status(415).type('text/plain').send('Fails.');
  }
});

router.post('/torrents/delete', (req, res) => {
  const { hashes, deleteFiles } = req.body;
  for (const h of String(hashes || '').toLowerCase().split('|').filter(Boolean)) {
    const row = db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(h);
    if (row && String(deleteFiles) === 'true' && row.content_path && row.content_path.startsWith(config.downloadsDir)) {
      fs.rmSync(row.content_path, { recursive: true, force: true });
    }
    db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(h);
  }
  res.type('text/plain').send('Ok.');
});

// Sonarr pokes these lifecycle endpoints; downloads are not pausable, so ack and move on
for (const ep of ['setForceStart', 'pause', 'resume', 'stop', 'start', 'topPrio', 'setShareLimits', 'recheck']) {
  router.post(`/torrents/${ep}`, (req, res) => res.type('text/plain').send('Ok.'));
}

module.exports = router;
