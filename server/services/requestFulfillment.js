// Shared "requested item is now available" logic. Used by the startup one-shot
// check (server.js), the manual admin library sync (routes/admin.js), the Plex
// SSE per-item handler (services/plex.js), and the Overseerr shim's explicit
// /media/:id/available endpoints (routes/overseerrShim.js).
const db = require('../db/database');
const logger = require('./logger');
const { enqueueForUser } = require('./notificationAgents');
const seasonAvailability = require('./seasonAvailability');

// Create and enqueue a request_available notification for the requester.
// Idempotent: skips if notified_available_at is already set.
// Also removes any stale request_process_failed notifications for the same tmdbId.
function notifyRequestAvailable(request) {
  if (request.notified_available_at) {
    logger.debug(`[fulfillment] request #${request.id} already notified available, skipping`);
    return;
  }
  try {
    // Lazy: autoRequest pulls in the Plex modules, and plex.js requires this file
    const { SYSTEM_USER_ID } = require('./autoRequest');
    const prefs = db.getUserNotificationPrefs(request.user_id);
    // List auto-requests belong to a system identity nobody reads alerts for
    if (request.user_id !== SYSTEM_USER_ID && prefs.notify_available) {
      const title = request.title || 'Unknown';
      const notifId = db.createOrBundleNotification({
        userId: request.user_id,
        type: 'request_available',
        title: `"${title}" is now available`,
        body: 'Your requested content has been added to the library.',
        data: { requestId: request.id, tmdbId: request.tmdb_id, mediaType: request.media_type, title },
      });
      enqueueForUser({
        notificationId: notifId, userId: request.user_id,
        payload: { type: 'request_available', title: `"${title}" is now available`, body: 'Your requested content has been added to the library.', posterUrl: request.poster_url },
      });
      logger.info(`[fulfillment] request_available notification enqueued for user ${request.user_id} — "${title}"`);
    }
    // Clean up any stale request_process_failed notifications for this tmdbId
    try {
      const failedNotifs = db.prepare(
        "SELECT id FROM notifications WHERE type = 'request_process_failed' AND (user_id = ? OR user_id IS NULL)"
      ).all(String(request.user_id));
      for (const n of failedNotifs) {
        const nData = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
        if (nData && nData.tmdbId === request.tmdb_id) {
          db.prepare('DELETE FROM notifications WHERE id = ?').run(n.id);
          logger.info(`[fulfillment] removed stale request_process_failed notification #${n.id} for "${request.title || 'Unknown'}"`);
        }
      }
    } catch (e) {
      logger.warn('[fulfillment] error cleaning stale failure notifications:', e.message);
    }
  } catch (e) {
    logger.warn(`[fulfillment] error notifying request available for #${request.id}:`, e.message);
  }
}

// Find un-notified requests whose tmdb id is now in the library, notify their
// requesters, and stamp notified_available_at. Every match is stamped even when
// the user has availability alerts off, so it isn't re-checked forever.
//
// Season-gated requests (specific seasons — e.g. "request missing seasons" of
// a show the library already has) are not fulfilled by the show merely being
// present: they're handed to an async per-season check instead. The stamp is
// therefore the fulfillment record, set only once the content is really there.
function checkAndNotifyFulfilled(source) {
  const fulfilled = db.getUnnotifiedFulfilledRequests();
  if (fulfilled.length === 0) return 0;
  const ids = [];
  let gated = 0;
  for (const req of fulfilled) {
    if (req.season_gated && req.media_type === 'tv') { gated++; continue; }
    notifyRequestAvailable(req);
    ids.push(req.id);
  }
  if (ids.length) {
    db.markRequestsNotifiedAvailable(ids);
    logger.info(`[fulfillment] ${source}: ${ids.length} request(s) now available in library`);
  }
  if (gated) scheduleSeasonCheck();
  return ids.length;
}

// ── Season-gated requests ─────────────────────────────────────────────────────

// Library imports arrive as bursts of per-episode events; coalesce them into
// one pass shortly after, with a trailing re-run if more arrive mid-pass.
const SEASON_CHECK_DELAY_MS = 15 * 1000;
let seasonTimer = null;
let seasonRunning = false;
let seasonRerun = false;

function scheduleSeasonCheck() {
  if (seasonRunning) { seasonRerun = true; return; }
  if (seasonTimer) return;
  seasonTimer = setTimeout(async () => {
    seasonTimer = null;
    seasonRunning = true;
    try {
      await checkSeasonGatedRequests('season check');
    } catch (e) {
      logger.warn('[fulfillment] season check failed:', e.message);
    } finally {
      seasonRunning = false;
      if (seasonRerun) { seasonRerun = false; scheduleSeasonCheck(); }
    }
  }, SEASON_CHECK_DELAY_MS);
  if (seasonTimer.unref) seasonTimer.unref();
}

function requestedSeasonNumbers(row) {
  let list = null;
  try { list = row.seasons_json ? JSON.parse(row.seasons_json) : null; } catch { list = null; }
  const nums = Array.isArray(list) ? [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
  return nums.length ? nums : null;
}

// Per-season completeness for the show a request points at, using the same
// rule the request dialog uses to gray a season out as "In library": the
// library holds at least as many episodes as TMDB lists (any episode at all
// when TMDB has no count). Both media servers are consulted; the fuller wins.
async function loadShowSeasonState(row) {
  const items = db.getLibraryShowsForRequest(row);
  if (items.length === 0) return null;
  const counts = new Map();
  for (const item of items) {
    // Fresh read — this runs because new episodes just landed
    seasonAvailability.invalidateLibrarySeasons(item.ratingKey);
    const seasons = await seasonAvailability.fetchLibrarySeasons(item);
    for (const s of seasons || []) {
      counts.set(Number(s.number), Math.max(counts.get(Number(s.number)) || 0, Number(s.episodeCount) || 0));
    }
  }
  let tmdbSeasons = [];
  if (row.tmdb_id) {
    try { tmdbSeasons = await seasonAvailability.fetchTmdbSeasons(row.tmdb_id) || []; } catch { tmdbSeasons = []; }
  }
  const merged = seasonAvailability.mergeSeasonAvailability({
    tmdbSeasons,
    librarySeasons: [...counts].map(([number, episodeCount]) => ({ number, episodeCount })),
  });
  return new Map(merged.map(s => [s.number, s.complete]));
}

// Stamp and notify every season-gated request whose seasons are all complete.
// Returns how many were fulfilled. Exported for tests and manual triggers.
async function checkSeasonGatedRequests(source = 'season check') {
  const candidates = db.getUnnotifiedFulfilledRequests().filter(r => r.season_gated && r.media_type === 'tv');
  if (candidates.length === 0) return 0;
  const shows = new Map(); // show key -> Promise<Map<season, complete> | null>
  let done = 0;
  for (const row of candidates) {
    const wanted = requestedSeasonNumbers(row);
    const key = row.tmdb_id ? `tmdb:${row.tmdb_id}` : `tvdb:${row.tvdb_id}`;
    if (!shows.has(key)) shows.set(key, loadShowSeasonState(row).catch(e => {
      logger.warn(`[fulfillment] season lookup failed for "${row.title}": ${e.message}`);
      return null;
    }));
    const state = await shows.get(key);
    if (!state) continue;
    if (wanted && !wanted.every(n => state.get(n) === true)) continue;
    // Re-read: an overlapping pass or the shim may have stamped it meanwhile
    const fresh = db.getRequestById(row.id);
    if (!fresh || fresh.notified_available_at || fresh.status === 'denied') continue;
    notifyRequestAvailable(fresh);
    db.markRequestsNotifiedAvailable([fresh.id]);
    done++;
  }
  if (done) logger.info(`[fulfillment] ${source}: ${done} season request(s) now available in library`);
  return done;
}

module.exports = { notifyRequestAvailable, checkAndNotifyFulfilled, checkSeasonGatedRequests };
