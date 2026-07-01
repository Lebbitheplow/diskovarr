// Shared "requested item is now available" logic. Used by the startup one-shot
// check (server.js), the manual admin library sync (routes/admin.js), the Plex
// SSE per-item handler (services/plex.js), and the Overseerr shim's explicit
// /media/:id/available endpoints (routes/overseerrShim.js).
const db = require('../db/database');
const logger = require('./logger');

// Create and enqueue a request_available notification for the requester.
// Idempotent: skips if notified_available_at is already set.
// Also removes any stale request_process_failed notifications for the same tmdbId.
function notifyRequestAvailable(request) {
  if (request.notified_available_at) {
    logger.debug(`[fulfillment] request #${request.id} already notified available, skipping`);
    return;
  }
  try {
    const prefs = db.getUserNotificationPrefs(request.user_id);
    if (prefs.notify_available) {
      const title = request.title || 'Unknown';
      const notifId = db.createOrBundleNotification({
        userId: request.user_id,
        type: 'request_available',
        title: `"${title}" is now available`,
        body: 'Your requested content has been added to the library.',
        data: { requestId: request.id, tmdbId: request.tmdb_id, mediaType: request.media_type, title },
      });
      db.enqueueNotification({
        notificationId: notifId, agent: 'discord', userId: request.user_id,
        payload: { type: 'request_available', title: `"${title}" is now available`, body: 'Your requested content has been added to the library.', posterUrl: request.poster_url },
      });
      db.enqueueNotification({
        notificationId: notifId, agent: 'pushover', userId: request.user_id,
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
function checkAndNotifyFulfilled(source) {
  const fulfilled = db.getUnnotifiedFulfilledRequests();
  if (fulfilled.length === 0) return 0;
  const ids = [];
  for (const req of fulfilled) {
    notifyRequestAvailable(req);
    ids.push(req.id);
  }
  db.markRequestsNotifiedAvailable(ids);
  logger.info(`[fulfillment] ${source}: ${ids.length} request(s) now available in library`);
  return ids.length;
}

module.exports = { notifyRequestAvailable, checkAndNotifyFulfilled };
