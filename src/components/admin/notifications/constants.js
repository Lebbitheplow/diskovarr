export const PROVIDERS = [
  { id: 'broadcast', label: 'Broadcast', description: 'Send message to all users', icon: 'notif-broadcast-icon' },
  { id: 'discord', label: 'Discord', description: 'Webhook or Bot DMs', hasUserInfoModal: true, hasUserSettings: true, icon: 'notif-discord-icon' },
  { id: 'pushover', label: 'Pushover', description: 'Push notifications', hasUserInfoModal: true, hasUserSettings: true, icon: 'notif-pushover-icon' },
  { id: 'webhook', label: 'Webhook', description: 'Custom JSON webhook', hasUserInfoModal: true, icon: 'notif-webhook-icon' },
  { id: 'slack', label: 'Slack', description: 'Slack webhook', hasUserInfoModal: true, icon: 'notif-slack-icon' },
  { id: 'gotify', label: 'Gotify', description: 'Self-hosted Gotify', hasUserInfoModal: true, icon: 'notif-gotify-icon' },
  { id: 'ntfy', label: 'ntfy', description: 'ntfy cloud or self-hosted', hasUserInfoModal: true, icon: 'notif-ntfy-icon' },
  { id: 'telegram', label: 'Telegram', description: 'Telegram bot', hasUserInfoModal: true, hasUserSettings: true, icon: 'notif-telegram-icon' },
  { id: 'pushbullet', label: 'Pushbullet', description: 'Pushbullet push', hasUserInfoModal: true, hasUserSettings: true, icon: 'notif-pushbullet-icon' },
  { id: 'email', label: 'Email', description: 'SMTP email', hasUserInfoModal: true, hasUserSettings: true, icon: 'notif-email-icon' },
  { id: 'webpush', label: 'WebPush', description: 'Browser push', hasUserInfoModal: true, hasUserSettings: true, icon: 'notif-webpush-icon' },
]

// Providers a user can point at their own target from Settings → Notifications.
// Derived from PROVIDERS so the two lists can't drift.
export const USER_FACEABLE_PROVIDERS = PROVIDERS.filter(p => p.hasUserSettings).map(p => p.id)

// Provider "notification types" checkboxes. Each option is a group of
// canonical event ids (`events`); a provider's saved selection is a flat list
// of event ids, and a checkbox is ticked when all of its events are selected.
// `value` is only a stable key. Older configs stored a grouped option as one
// comma-joined string — normalizeTypeSelection expands those on load (the
// server also expands them when matching and when saving).
export const SHARED_NOTIFICATION_TYPES = [
  { value: 'request_pending', events: ['request_pending'], label: 'New request pending', meta: '(admin)' },
  { value: 'request_auto_approved', events: ['request_auto_approved'], label: 'Request auto-approved', meta: '(admin)' },
  { value: 'request_approved', events: ['request_approved'], label: 'Request approved', meta: '(requester)' },
  { value: 'request_denied', events: ['request_denied'], label: 'Request denied', meta: '(requester)' },
  { value: 'request_available', events: ['request_available'], label: 'Request available in library', meta: '(requester)' },
  { value: 'request_process_failed', events: ['request_process_failed'], label: 'Request processing error', meta: '(admin)' },
  { value: 'issue_new', events: ['issue_new'], label: 'New issue reported', meta: '(admin)' },
  { value: 'issue_updated', events: ['issue_updated'], label: 'Issue status updated', meta: '(requester)' },
  { value: 'issue_comments', events: ['issue_comment_added_admin', 'issue_comment_added_user'], label: 'Issue Comments' },
  { value: 'monitor_match', events: ['monitor_match'], label: 'Monitor matches', meta: '(user)' },
  { value: 'tuberr_alert', events: ['tuberr_alert'], label: 'YouTube downloader alerts', meta: '(admin)' },
  { value: 'deletion', events: ['deletion'], label: 'Media deletion notices', meta: '(admin)' },
  { value: 'movie_night_picks', events: ['movie_night_added', 'movie_night_invite'], label: 'Movie Night picks' },
  { value: 'movie_night_comment', events: ['movie_night_comment'], label: 'Movie Night comments' },
  { value: 'movie_night_tonight', events: ['movie_night_tonight'], label: 'Movie Night tonight' },
  { value: 'watch_party_invite', events: ['watch_party_invite'], label: 'Watch Together invites' },
]

/** Flat, de-duplicated event ids from a stored selection (splits legacy "a,b" entries). */
export function normalizeTypeSelection(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    for (const part of item.split(',')) {
      const t = part.trim()
      if (t && !out.includes(t)) out.push(t)
    }
  }
  return out
}

/** Initial checkbox state: the saved selection, or the defaults when nothing is saved. */
export function initialTypeSelection(saved, defaults) {
  const selection = normalizeTypeSelection(saved)
  return selection.length > 0 ? selection : [...defaults]
}

export function isTypeOptionChecked(selection, option) {
  return option.events.every((e) => selection.includes(e))
}

/** Ticking adds every event of the option; unticking removes every one. */
export function toggleTypeOption(selection, option) {
  if (isTypeOptionChecked(selection, option)) return selection.filter((e) => !option.events.includes(e))
  return [...selection, ...option.events.filter((e) => !selection.includes(e))]
}

const eventsOf = (values) => SHARED_NOTIFICATION_TYPES
  .filter((t) => values.includes(t.value))
  .flatMap((t) => t.events)

export const DEFAULT_AGENT_TYPES = eventsOf([
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'request_available', 'request_process_failed',
  'issue_new', 'issue_updated', 'issue_comments',
  'tuberr_alert', 'deletion',
  'movie_night_picks', 'movie_night_comment', 'movie_night_tonight',
  'watch_party_invite',
])

export const WEBHOOK_NOTIFICATION_TYPES = SHARED_NOTIFICATION_TYPES.map(t => ({ ...t }))
export const BOT_NOTIFICATION_TYPES = SHARED_NOTIFICATION_TYPES.map(t => ({ ...t }))
// Pushover delivers every event (global key and per-user keys), so it offers
// the full list like the other providers.
export const PUSHOVER_NOTIFICATION_TYPES = SHARED_NOTIFICATION_TYPES.map(t => ({ ...t }))

export const DEFAULT_WEBHOOK_TYPES = eventsOf([
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'issue_new', 'issue_updated', 'issue_comments',
  'tuberr_alert', 'deletion',
])
export const DEFAULT_BOT_TYPES = eventsOf([
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'issue_new', 'issue_updated', 'issue_comments',
  'tuberr_alert', 'deletion',
])
export const DEFAULT_PUSHOVER_TYPES = eventsOf([
  'request_pending', 'request_approved', 'request_denied', 'request_available',
  'issue_new', 'issue_updated', 'issue_comments',
  'tuberr_alert', 'deletion',
])

export const DEFAULT_WEBHOOK_PAYLOAD = btoa(JSON.stringify({
  notification_type: '{{notification_type}}',
  event: '{{event}}',
  subject: '{{subject}}',
  message: '{{message}}',
  image: '{{image}}',
  timestamp: '{{timestamp}}',
}))

export function decodeWebhookPayload(encoded) {
  try { return JSON.stringify(JSON.parse(atob(encoded)), null, 2) } catch { return '' }
}
export function encodeWebhookPayload(jsonText) {
  try { return btoa(JSON.stringify(JSON.parse(jsonText))) } catch { return DEFAULT_WEBHOOK_PAYLOAD }
}

export const PUSHOVER_SOUNDS = [
  { value: '', label: 'Device Default' }, { value: 'pushover', label: 'Pushover (default)' },
  { value: 'bike', label: 'Bike' }, { value: 'bugle', label: 'Bugle' },
  { value: 'cashregister', label: 'Cash Register' }, { value: 'classical', label: 'Classical' },
  { value: 'cosmic', label: 'Cosmic' }, { value: 'falling', label: 'Falling' },
  { value: 'gamelan', label: 'Gamelan' }, { value: 'incoming', label: 'Incoming' },
  { value: 'intermission', label: 'Intermission' }, { value: 'magic', label: 'Magic' },
  { value: 'mechanical', label: 'Mechanical' }, { value: 'pianobar', label: 'Piano Bar' },
  { value: 'siren', label: 'Siren' }, { value: 'spacealarm', label: 'Space Alarm' },
  { value: 'tugboat', label: 'Tug Boat' }, { value: 'alien', label: 'Alien Alarm (long)' },
  { value: 'climb', label: 'Climb (long)' }, { value: 'persistent', label: 'Persistent (long)' },
  { value: 'echo', label: 'Pushover Echo (long)' }, { value: 'updown', label: 'Up Down (long)' },
  { value: 'vibrate', label: 'Vibrate Only' }, { value: 'none', label: 'Silent' },
]

export const GOTIFY_PRIORITIES = [
  { value: 0, label: 'Minimum' }, { value: 1, label: 'Low' },
  { value: 2, label: 'Moderate (default)' }, { value: 3, label: 'High' },
  { value: 4, label: 'Emergency' }, { value: 5, label: 'Maximum' },
]

export const NTFY_PRIORITIES = [
  { value: 1, label: 'Minimum' }, { value: 2, label: 'Low' },
  { value: 3, label: 'Default' }, { value: 4, label: 'High' }, { value: 5, label: 'Urgent' },
]

export const SMTP_PORTS = [
  { value: 25, label: '25 (Legacy)' }, { value: 465, label: '465 (Implicit TLS)' },
  { value: 587, label: '587 (STARTTLS) — recommended' }, { value: 2525, label: '2525 (Alternate)' },
]

export const USER_NOTIF_TYPES = [
  { key: 'notify_approved', label: 'Request approved', desc: 'Get notified when your media requests are approved' },
  { key: 'notify_denied', label: 'Request declined', desc: 'Get notified when your media requests are declined' },
  { key: 'notify_available', label: 'Request available', desc: 'Get notified when requested media is available in the library' },
  { key: 'notify_issue_update', label: 'Issue status updated', desc: 'Get notified when an issue you reported changes status' },
  { key: 'notify_issue_comment', label: 'Issue comment', desc: 'Get notified when a comment is added to an issue' },
  { key: 'notify_monitor', label: 'Monitor match', desc: 'Get notified when content matches your monitors' },
  { key: 'notify_movie_night_added', label: 'Movie Night pick', desc: 'Get notified when someone adds a title to one of your movie nights' },
  { key: 'notify_movie_night_comment', label: 'Movie Night comment', desc: 'Get notified when someone comments on a movie night pick' },
]

export const ELEVATED_NOTIF_TYPES = [
  { key: 'notify_pending', label: 'New request pending', desc: 'Get notified when a request awaits approval' },
  { key: 'notify_auto_approved', label: 'Request auto-approved', desc: 'Get notified when a request is automatically submitted' },
]

export const ADMIN_ONLY_NOTIF_TYPES = [
  { key: 'notify_process_failed', label: 'Processing failed', desc: 'Get notified when a request fails to submit' },
  { key: 'notify_issue_new', label: 'New issue reported', desc: 'Get notified when a user reports a new issue' },
]

/**
 * Notification-type toggles a user may see. The server delivers every
 * admin-facing event (pending, auto-approved, processing failed, new issue) to
 * the same privileged set — admins and the elevated owner — so all of those
 * toggles are shown to anyone privileged and hidden from everyone else.
 */
export function visibleNotifTypes({ isAdmin = false, isElevated = false } = {}) {
  const privileged = isAdmin || isElevated
  return [
    ...USER_NOTIF_TYPES,
    ...(privileged ? ELEVATED_NOTIF_TYPES : []),
    ...(privileged ? ADMIN_ONLY_NOTIF_TYPES : []),
  ]
}
