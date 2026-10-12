// Request lifecycle notifications shared by every path that creates, approves,
// denies or fails a request (user API, admin panel, auto-request workers), so
// the same action produces the same bell entry and provider delivery no matter
// which route caused it. Each helper writes the in-app notification and
// enqueues it for the configured providers; failures are logged, never thrown.
const db = require('../db/database');
const logger = require('./logger');
const { enqueueForUser } = require('./notificationAgents');

function mediaNoun(mediaType) {
  return mediaType === 'movie' ? 'a movie' : 'a TV show';
}

function send({ userId, type, title, body, data, posterUrl }) {
  const notificationId = db.createOrBundleNotification({ userId, type, title, body, data });
  // userId rides in the payload too, as the issue notifications do, so
  // per-user providers can resolve the recipient from the payload alone
  enqueueForUser({ notificationId, userId, payload: { type, title, body, posterUrl: posterUrl || null, userId } });
}

// Fan an admin-audience event out to every privileged user whose pref allows it.
function toAdmins(prefKey, event, { exceptUserId = null } = {}) {
  try {
    for (const adminId of db.getPrivilegedUserIds()) {
      if (exceptUserId != null && String(adminId) === String(exceptUserId)) continue;
      if (!db.getUserNotificationPrefs(adminId)[prefKey]) continue;
      send({ userId: adminId, ...event });
    }
  } catch (e) {
    logger.warn(`notification error (${event.type}):`, e.message);
  }
}

function toRequester(request, prefKey, event) {
  try {
    if (!db.getUserNotificationPrefs(request.user_id)[prefKey]) return;
    send({ userId: request.user_id, ...event });
  } catch (e) {
    logger.warn(`notification error (${event.type}):`, e.message);
  }
}

// A request is waiting for approval.
function notifyPending({ title, tmdbId, mediaType, username, posterUrl }) {
  toAdmins('notify_pending', {
    type: 'request_pending',
    title: `New request: "${title}"`,
    body: `${username} requested ${mediaNoun(mediaType)}.`,
    data: { tmdbId, mediaType, title },
    posterUrl,
  });
}

// A request skipped the approval queue. Admin-audience (types.js); the
// requester isn't told about their own request.
function notifyAutoApproved({ requestId, userId, title, tmdbId, mediaType, username, posterUrl }) {
  toAdmins('notify_auto_approved', {
    type: 'request_auto_approved',
    title: `"${title}" auto-approved`,
    body: `${username} requested ${mediaNoun(mediaType)}; it was approved automatically.`,
    data: { requestId, tmdbId, mediaType, title },
    posterUrl,
  }, { exceptUserId: userId });
}

// Submitting to the download service failed.
function notifyProcessFailed({ title, tmdbId, mediaType, error, posterUrl }) {
  toAdmins('notify_process_failed', {
    type: 'request_process_failed',
    title: `Request failed: "${title || 'Unknown'}"`,
    body: String(error?.message || error || 'Unknown error'),
    data: { tmdbId, mediaType, title },
    posterUrl,
  });
}

function notifyApproved(request) {
  toRequester(request, 'notify_approved', {
    type: 'request_approved',
    title: `"${request.title}" approved`,
    body: 'Your request has been approved and submitted.',
    data: { requestId: request.id, tmdbId: request.tmdb_id, mediaType: request.media_type, title: request.title },
    posterUrl: request.poster_url,
  });
}

function notifyDenied(request, note) {
  const body = note ? `Reason: ${note}` : 'Your request has been declined.';
  toRequester(request, 'notify_denied', {
    type: 'request_denied',
    title: `"${request.title}" declined`,
    body,
    data: { requestId: request.id, tmdbId: request.tmdb_id, mediaType: request.media_type, title: request.title },
    posterUrl: request.poster_url,
  });
}

module.exports = { notifyPending, notifyAutoApproved, notifyProcessFailed, notifyApproved, notifyDenied };
