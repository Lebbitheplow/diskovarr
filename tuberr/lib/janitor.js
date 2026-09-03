const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const config = require('../config');
const sonarr = require('./sonarr');
const { state } = require('./state');

// Staging cleanup. Sonarr copies (hardlinks off) each finished download into
// the library and — now that the qbit shim reports seed limits as reached —
// asks us to delete it. This job is the belt-and-braces path for anything
// that slipped through (older rows, Sonarr restarts mid-import): a completed
// download is only removed once Sonarr's history proves it was imported.
//
// Safety gates before anything is deleted:
//   1. row state = completed and completed_on older than 6 h
//   2. Sonarr history for that infohash has a downloadFolderImported record
//   3. data.importedPath still exists on disk, or the episode still has a
//      file in Sonarr, or (record without importedPath) the row is > 7 days old
//   4. content_path resolves strictly inside config.downloadsDir
// Rows whose content_path no longer exists are just dropped (no fs writes).
// Any Sonarr error aborts the run — nothing is deleted on guesswork.

const RUN_INTERVAL_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;
const MIN_AGE_SEC = 6 * 3600;
const UNCONFIRMED_AGE_SEC = 7 * 24 * 3600;

let running = false;

function insideDownloadsDir(p) {
  if (!p) return false;
  const root = path.resolve(config.downloadsDir);
  const target = path.resolve(p);
  return target !== root && target.startsWith(root + path.sep);
}

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  } catch { /* vanished mid-walk */ }
  return total;
}

async function importConfirmed(row, now) {
  const records = await sonarr.historyForDownload(row.info_hash);
  const imported = records.find(r => r && r.eventType === 'downloadFolderImported');
  if (!imported) return false;
  const importedPath = imported.data && imported.data.importedPath;
  if (importedPath && fs.existsSync(importedPath)) return true;
  // Renamed/upgraded since import? Sonarr still knows whether the episode has a file.
  if (imported.episodeId) {
    try {
      const ep = await sonarr.getEpisode(imported.episodeId);
      if (ep && ep.hasFile) return true;
    } catch { /* fall through to the age rule */ }
  }
  if (!importedPath && now - (Number(row.completed_on) || 0) > UNCONFIRMED_AGE_SEC) return true;
  return false;
}

async function run() {
  if (running) return state.janitor;
  running = true;
  const stats = { lastRunAt: Date.now(), removed: 0, freedBytes: 0, lastError: null };
  const now = Math.floor(Date.now() / 1000);
  let kept = 0;
  try {
    const rows = db.prepare("SELECT * FROM downloads WHERE state = 'completed' AND completed_on > 0 AND completed_on < ?")
      .all(now - MIN_AGE_SEC);
    const del = db.prepare('DELETE FROM downloads WHERE info_hash = ?');
    for (const row of rows) {
      if (!row.content_path || !fs.existsSync(row.content_path)) {
        del.run(row.info_hash);
        stats.removed++;
        continue;
      }
      if (!sonarr.isConfigured()) { stats.lastError = 'Sonarr not configured'; break; }
      let confirmed;
      try {
        confirmed = await importConfirmed(row, now);
      } catch (e) {
        stats.lastError = e.message;
        console.error(`[janitor] aborting: Sonarr history lookup failed for ${row.release_title}: ${e.message}`);
        break;
      }
      if (!confirmed) { kept++; continue; }
      if (!insideDownloadsDir(row.content_path)) {
        kept++;
        console.warn(`[janitor] refusing to delete ${row.content_path}: outside ${config.downloadsDir}`);
        continue;
      }
      const bytes = dirSize(row.content_path);
      fs.rmSync(row.content_path, { recursive: true, force: true });
      del.run(row.info_hash);
      stats.removed++;
      stats.freedBytes += bytes;
      console.log(`[janitor] removed imported ${row.release_title} (${(bytes / 1024 ** 2).toFixed(0)} MB)`);
    }
    if (stats.removed || kept) {
      console.log(`[janitor] removed ${stats.removed} completed download(s), freed ${(stats.freedBytes / 1024 ** 3).toFixed(2)} GB, kept ${kept} unconfirmed`);
    }
  } catch (e) {
    stats.lastError = e.message;
    console.error(`[janitor] run failed: ${e.message}`);
  } finally {
    Object.assign(state.janitor, stats);
    running = false;
  }
  return { ...state.janitor, kept };
}

function start() {
  setTimeout(() => run().catch(() => {}), BOOT_DELAY_MS).unref();
  setInterval(() => run().catch(() => {}), RUN_INTERVAL_MS).unref();
}

module.exports = { run, start, insideDownloadsDir, dirSize };
