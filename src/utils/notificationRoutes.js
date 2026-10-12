/**
 * Where clicking a bell notification goes: one explicit entry per event
 * family. Links that leave the app (push, email, chat buttons) come from the
 * matching server table in server/services/notificationAgents/links.js — keep
 * the two in step when adding an event.
 *
 * Every request_* event, request_available included, opens the request queue.
 * Sending availability there rather than to the title is a deliberate product
 * decision carried over from 2.6.0, not an accident of branch order.
 */

function parseData(data) {
  if (!data) return {}
  if (typeof data === 'object') return data
  try { return JSON.parse(data) || {} } catch { return {} }
}

const enc = encodeURIComponent

/** App path for a notification event, or null when it has no destination. */
export function notificationPath(type, rawData) {
  const event = String(type || '')
  const data = parseData(rawData)
  if (event.startsWith('request_') || event === 'autorequest') return '/queue'
  if (event.startsWith('issue_')) return data.issueId ? `/issues?id=${enc(data.issueId)}` : '/issues'
  // notify_movie_night_* is how picks/comments were stored before 3.4.3.
  if (event.startsWith('movie_night_') || event.startsWith('notify_movie_night_')) {
    return data.groupId ? `/movie-night/${enc(data.groupId)}` : '/movie-night'
  }
  if (event === 'watch_party_invite') return data.partyId ? `/watch-party/${enc(data.partyId)}` : '/movie-night'
  if (event === 'monitor_match') {
    return data.tmdbId && data.mediaType
      ? `/search?q=${enc(data.title || '')}&selectedTmdbId=${enc(data.tmdbId)}&selectedType=${enc(data.mediaType)}`
      : '/search'
  }
  // Admin tabs are hash-addressed (src/pages/Admin.jsx reads location.hash)
  if (event === 'tuberr_alert') return '/admin#youtube'
  if (event === 'deletion') return '/admin#automation'
  return null
}

/**
 * What a click on this notification should do:
 * { kind: 'broadcast' } opens the message modal, { kind: 'navigate', path }
 * routes, null does nothing (unknown or malformed event).
 */
export function notificationDestination(notification) {
  if (!notification || typeof notification.type !== 'string') return null
  if (notification.type === 'broadcast') return { kind: 'broadcast' }
  const path = notificationPath(notification.type, notification.data)
  return path ? { kind: 'navigate', path } : null
}

/**
 * External request links (approved, declined, available) land on
 * /queue?id=<request>. The queue opens its Edit dialog only for a row
 * PUT /api/queue/:id would accept (a raw GET /api/queue/:id row); anything
 * else just shows the list.
 */
export function opensRequestEditor(request) {
  return !!request && !request.is_follow && (
    request.status === 'pending' || (request.status === 'approved' && !request.notified_available_at)
  )
}
