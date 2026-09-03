const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const config = require('../config');
const downloader = require('../lib/downloader');
const janitor = require('../lib/janitor');
const scheduler = require('../lib/scheduler');
const { state } = require('../lib/state');

// /manage/status + maintenance triggers. Mounted by manage.js behind its
// API-key gate. Diskovarr's health job polls status every 10 minutes and
// treats every timestamp as epoch milliseconds.

const router = express.Router();
const STAGING_CACHE_MS = 10 * 60 * 1000;

let stagingCache = { at: 0, value: { bytes: 0, dirs: 0 } };

// du of the staging dir: bytes + number of release directories. Cached for
// 10 minutes — it's a full stat walk of a directory Sonarr may be reading.
function stagingUsage() {
  const now = Date.now();
  if (now - stagingCache.at < STAGING_CACHE_MS) return stagingCache.value;
  let bytes = 0;
  let dirs = 0;
  try {
    for (const entry of fs.readdirSync(config.downloadsDir, { withFileTypes: true })) {
      const full = path.join(config.downloadsDir, entry.name);
      if (!entry.isDirectory()) { bytes += janitor.dirSize(full); continue; }
      // <downloadsDir>/<category>/<release> — count releases, not categories
      const children = fs.readdirSync(full, { withFileTypes: true });
      const subdirs = children.filter(c => c.isDirectory());
      if (subdirs.length) {
        dirs += subdirs.length;
        bytes += janitor.dirSize(full);
      } else {
        dirs += 1;
        bytes += janitor.dirSize(full);
      }
    }
  } catch { /* downloads dir unreadable — report what we have */ }
  stagingCache = { at: now, value: { bytes, dirs } };
  return stagingCache.value;
}

function ms(epochSeconds) {
  return epochSeconds > 0 ? epochSeconds * 1000 : null;
}

router.get('/status', async (req, res) => {
  const ytdlp = require('../lib/ytdlp');
  const ytDlp = await downloader.ytdlpVersion();
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(state, 'active') = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN state = 'paused' THEN 1 ELSE 0 END) AS paused,
      SUM(CASE WHEN state = 'unavailable' THEN 1 ELSE 0 END) AS unavailable,
      SUM(CASE WHEN match_status = 'matched' THEN 1 ELSE 0 END) AS matched,
      SUM(CASE WHEN match_status = 'partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN match_status = 'pending' OR match_status IS NULL THEN 1 ELSE 0 END) AS pending
    FROM series_mappings
  `).get();
  const needsReview = db.prepare(`
    SELECT COUNT(*) AS n FROM episode_matches em
    JOIN series_mappings m ON m.id = em.mapping_id
    WHERE COALESCE(m.state, 'active') = 'active' AND em.video_id IS NULL AND em.skipped = 0 AND em.broken = 0
  `).get().n;
  const queue = db.prepare("SELECT * FROM downloads WHERE state IN ('queued', 'downloading') ORDER BY added_on").all()
    .map(r => ({
      infoHash: r.info_hash, releaseTitle: r.release_title, state: r.state, progress: r.progress,
      dlspeed: r.dlspeed, eta: r.eta, addedOn: ms(r.added_on), error: r.error || null,
    }));
  const lastGrab = db.prepare('SELECT MAX(added_on) AS t FROM downloads').get().t;
  const lastGrabRecorded = db.prepare('SELECT MAX(last_grab_at) AS t FROM series_mappings').get().t;
  const lastCompleted = db.prepare("SELECT MAX(completed_on) AS t FROM downloads WHERE state = 'completed'").get().t;
  const completedRows = db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE state = 'completed'").get().n;

  res.json({
    ok: true,
    version: require('../package.json').version,
    ytDlp: ytDlp || null,
    ytDlpStatus: ytdlp.status(),
    downloadsDir: config.downloadsDir,
    cookies: {
      present: fs.existsSync(path.join(config.dataDir, 'cookies.txt')),
      botCheckAt: state.cookies.botCheckAt,
    },
    quota: { exceededAt: state.quota.exceededAt, lastError: state.quota.lastError },
    lastRefreshAt: state.lastRefreshAt,
    lastRefreshDurationMs: state.lastRefreshDurationMs,
    lastRefreshError: state.lastRefreshError,
    lastFastTickAt: state.lastFastTickAt,
    lastGrabAt: Math.max(state.lastGrabAt || 0, ms(lastGrab) || 0, ms(lastGrabRecorded) || 0) || null,
    lastCompletedAt: Math.max(state.lastCompletedAt || 0, ms(lastCompleted) || 0) || null,
    queue,
    recentFailures: state.recentFailures,
    needsReview,
    mappings: {
      total: counts.total || 0,
      active: counts.active || 0,
      paused: counts.paused || 0,
      unavailable: counts.unavailable || 0,
      matched: counts.matched || 0,
      partial: counts.partial || 0,
      pending: counts.pending || 0,
    },
    staging: { ...stagingUsage(), completedRows },
    janitor: {
      lastRunAt: state.janitor.lastRunAt,
      removed: state.janitor.removed,
      freedBytes: state.janitor.freedBytes,
      lastError: state.janitor.lastError,
    },
  });
});

// Kick a full refresh cycle in the background (202 if started, 200 if one is
// already running).
router.post('/refresh', (req, res) => {
  if (scheduler.isRunning()) return res.json({ ok: true, started: false, message: 'refresh already running' });
  scheduler.refreshAll().catch(e => console.error(`[scheduler] manual refresh failed: ${e.message}`));
  res.status(202).json({ ok: true, started: true });
});

router.post('/janitor/run', async (req, res) => {
  try {
    res.json({ ok: true, ...(await janitor.run()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
