const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, getSetting, setSetting } = require('../db');
const config = require('../config');
const torrent = require('../lib/torrent');
const multipart = require('../lib/multipart');
const downloader = require('../lib/downloader');
const paths = require('../lib/paths');
const auth = require('../lib/qbitAuth');
const runtime = require('../lib/state');

// qBittorrent WebUI API v2 — the subset Sonarr v4's QBittorrentProxyV2 calls.
// States: queued→queuedDL, downloading→downloading, error→error, and
// completed→pausedUP (progress 1) which Sonarr treats as done-and-safe-to-import.
// Everything except auth/login requires a session (see lib/qbitAuth.js).

const router = express.Router();

// Sanity cap on queued + downloading items: a new torrent beyond it is refused
// with 'Fails.' (re-adds of a known infohash are always accepted). Generous
// enough for a whole-channel backfill; TUBERR_MAX_PENDING overrides it.
function maxPending() {
  return Number(process.env.TUBERR_MAX_PENDING) || 2000;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const QBIT_STATE = {
  queued: 'queuedDL',
  downloading: 'downloading',
  completed: 'pausedUP',
  // Failed downloads are deleted rather than left in 'error' (Sonarr reports
  // both qbit 'error' and 'missingFiles' as warnings and never fails the
  // item, so the episode would sit in its queue at 0%). Only rows written by
  // older versions can still be in this state.
  error: 'missingFiles',
};

function getCategories() {
  try {
    return JSON.parse(getSetting('qbit_categories', '{}'));
  } catch {
    return {};
  }
}

// Categories map to <downloadsDir>/<category> unless created with a savePath,
// which (relative paths resolve against the downloads dir) must stay inside
// the downloads dir. Returns false for an unsafe name or save path.
function saveCategory(name, savePath) {
  if (!paths.isSafeCategory(name)) return false;
  let resolved = path.join(config.downloadsDir, name);
  if (savePath) {
    resolved = path.resolve(config.downloadsDir, String(savePath));
    if (!paths.isInsideDownloads(resolved, { allowRoot: true })) return false;
  }
  const cats = getCategories();
  cats[name] = { name, savePath: resolved };
  setSetting('qbit_categories', JSON.stringify(cats));
  return true;
}

// torrents/add and setCategory implicitly create a missing category but never
// reset an existing one's save path.
function ensureCategory(name) {
  if (!paths.isSafeCategory(name)) return false;
  return getCategories()[name] ? true : saveCategory(name);
}

function categorySavePath(name) {
  if (!name) return config.downloadsDir;
  const fallback = path.join(config.downloadsDir, name);
  const cat = getCategories()[name];
  const savePath = (cat && cat.savePath) || fallback;
  // Categories stored before save paths were validated may point anywhere.
  // (The fallback can still be a symlink out; addTorrentBuffer re-checks.)
  if (savePath === fallback || paths.isInsideDownloads(savePath, { allowRoot: true })) return savePath;
  console.warn(`[qbit] category '${name}' save path ${savePath} is outside the downloads dir; using ${fallback}`);
  return fallback;
}

const textOk = (res) => res.type('text/plain').send('Ok.');

// Bad credentials get 200 'Fails.', exactly like qBittorrent — Sonarr reads
// the body, not the status, to decide whether the login worked.
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.checkCredentials(username, password)) {
    console.warn(`[qbit] rejected login for user '${String(username ?? '').slice(0, 64)}' from ${req.ip}`);
    runtime.noteQbitLogin(false, { username, from: req.ip });
    return res.type('text/plain').send('Fails.');
  }
  runtime.noteQbitLogin(true);
  res.set('Set-Cookie', `SID=${auth.createSession()}; HttpOnly; SameSite=Strict; Path=/`);
  textOk(res);
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(auth.sidFromRequest(req));
  textOk(res);
});

// Everything below needs a live session. 403 'Forbidden' is what qBittorrent
// sends without one, and is what makes Sonarr re-authenticate.
router.use((req, res, next) => {
  if (!auth.touchSession(auth.sidFromRequest(req))) {
    return res.status(403).type('text/plain').send('Forbidden');
  }
  next();
});

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
    // Seed limits "reached" the moment a download completes: Sonarr's
    // HasReachedSeedLimit is then true for pausedUP items, so it MOVES the file
    // into the library and, with removeCompletedDownloads on, asks us to
    // delete the torrent + data instead of copying and leaving it forever.
    max_ratio_enabled: true,
    max_ratio: 0,
    max_ratio_act: 0,
    max_seeding_time_enabled: true,
    max_seeding_time: 0,
    max_inactive_seeding_time_enabled: true,
    max_inactive_seeding_time: 0,
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
    ratio_limit: 0,
    seeding_time: 0,
    seeding_time_limit: 0,
    inactive_seeding_time_limit: 0,
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

function categoryRoute(req, res) {
  const { category, savePath } = req.body || {};
  if (!saveCategory(category, savePath)) {
    return res.status(400).type('text/plain').send('Invalid category name or save path');
  }
  textOk(res);
}
router.post('/torrents/createCategory', categoryRoute);
router.post('/torrents/editCategory', categoryRoute);

// Only the category label changes; files already downloaded stay where they are.
router.post('/torrents/setCategory', (req, res) => {
  const { hashes, category } = req.body || {};
  if (category && !ensureCategory(category)) {
    return res.status(400).type('text/plain').send('Invalid category name');
  }
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
  if (!VIDEO_ID_RE.test(parsed.videoId)) throw new Error(`invalid video id ${JSON.stringify(parsed.videoId.slice(0, 80))}`);
  // The release name becomes <savePath>/<name>/<name>.mp4 — one plain segment only
  if (!paths.isSafeSegment(parsed.name)) throw new Error(`unsafe release name ${JSON.stringify(parsed.name.slice(0, 200))}`);
  const savePath = categorySavePath(category);
  const contentPath = paths.assertInsideDownloads(path.join(savePath, parsed.name), 'release path');
  const known = db.prepare('SELECT 1 FROM downloads WHERE info_hash = ?').get(parsed.infoHash);
  if (!known) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE state IN ('queued', 'downloading')").get();
    if (n >= maxPending()) throw new Error(`download queue is full (${n} pending, limit ${maxPending()})`);
  }
  const now = Math.floor(Date.now() / 1000);
  const { changes } = db.prepare(`
    INSERT INTO downloads (info_hash, video_id, release_title, category, save_path, content_path, state, progress, size_bytes, added_on)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    ON CONFLICT(info_hash) DO NOTHING
  `).run(parsed.infoHash, parsed.videoId, parsed.name, category || '', savePath, contentPath, parsed.size, now);
  if (changes > 0) {
    runtime.state.lastGrabAt = Date.now();
    db.prepare('UPDATE series_mappings SET last_grab_at = ? WHERE id = (SELECT mapping_id FROM grabs WHERE info_hash = ?)')
      .run(now, parsed.infoHash);
  }
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
      category = req.body?.category || '';
      // urls= form: fetch our own torznab download links synchronously is
      // unnecessary — the infohash is the last path segment before .torrent
      for (const url of String(req.body?.urls || '').split('\n').filter(Boolean)) {
        const m = /([0-9a-f]{40})\.torrent/i.exec(url);
        if (!m) throw new Error(`unsupported url: ${url}`);
        const grab = db.prepare('SELECT * FROM grabs WHERE info_hash = ?').get(m[1].toLowerCase());
        if (!grab) throw new Error(`unknown grab: ${m[1]}`);
        const naming = require('../lib/naming');
        torrents.push(torrent.buildTorrent({
          releaseTitle: grab.release_title,
          sizeBytes: grab.size_bytes || naming.estimateSizeBytes(0),
          videoId: grab.video_id,
          attempt: grab.attempt || 0,
        }).buffer);
      }
    }
    if (torrents.length === 0) return res.status(415).type('text/plain').send('Fails.');
    // Any client-supplied savepath is ignored: downloads always go to the
    // category's (validated) save path under the downloads dir.
    if (category && !ensureCategory(category)) throw new Error(`invalid category ${JSON.stringify(String(category).slice(0, 80))}`);
    for (const buf of torrents) addTorrentBuffer(buf, category);
    textOk(res);
  } catch (e) {
    console.error(`[qbit] torrents/add failed: ${e.message}`);
    res.status(415).type('text/plain').send('Fails.');
  }
});

router.post('/torrents/delete', async (req, res) => {
  const { hashes, deleteFiles } = req.body || {};
  try {
    for (const h of String(hashes || '').toLowerCase().split('|').filter(Boolean)) {
      // Stop an in-flight yt-dlp first (and wait for it), so it can't write
      // files or update the row after both are gone.
      await downloader.cancel(h);
      const row = db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(h);
      if (row && String(deleteFiles) === 'true' && paths.isInsideDownloads(row.content_path)) {
        fs.rmSync(row.content_path, { recursive: true, force: true });
      }
      db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(h);
    }
    textOk(res);
  } catch (e) {
    console.error(`[qbit] torrents/delete failed: ${e.message}`);
    res.status(500).type('text/plain').send('Fails.');
  }
});

// Lifecycle commands are acknowledged no-ops. A YouTube download can't be
// paused/resumed mid-stream, seeding/share limits/priority don't apply, and
// there is no piece data to recheck. Sonarr only sends these as follow-ups to
// an add (initial state, force start, top priority, seed limits), so refusing
// them would fail the grab; cancelling a download is torrents/delete.
for (const ep of ['setForceStart', 'pause', 'resume', 'stop', 'start', 'topPrio', 'setShareLimits', 'recheck']) {
  router.post(`/torrents/${ep}`, (req, res) => textOk(res));
}

module.exports = router;
