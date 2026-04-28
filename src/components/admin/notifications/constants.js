export const PROVIDERS = [
  { id: 'broadcast', label: 'Broadcast', description: 'Send message to all users' },
  { id: 'discord', label: 'Discord', description: 'Webhook or Bot DMs', hasUserInfoModal: true, hasUserSettings: true },
  { id: 'pushover', label: 'Pushover', description: 'Push notifications', hasUserInfoModal: true, hasUserSettings: true },
  { id: 'webhook', label: 'Webhook', description: 'Custom JSON webhook', hasUserInfoModal: true },
  { id: 'slack', label: 'Slack', description: 'Slack webhook', hasUserInfoModal: true },
  { id: 'gotify', label: 'Gotify', description: 'Self-hosted Gotify', hasUserInfoModal: true },
  { id: 'ntfy', label: 'ntfy', description: 'ntfy cloud or self-hosted', hasUserInfoModal: true },
  { id: 'telegram', label: 'Telegram', description: 'Telegram bot', hasUserInfoModal: true, hasUserSettings: true },
  { id: 'pushbullet', label: 'Pushbullet', description: 'Pushbullet push', hasUserInfoModal: true, hasUserSettings: true },
  { id: 'email', label: 'Email', description: 'SMTP email', hasUserInfoModal: true, hasUserSettings: true },
  { id: 'webpush', label: 'WebPush', description: 'Browser push', hasUserInfoModal: true },
]

export const USER_FACEABLE_PROVIDERS = ['discord', 'pushover', 'telegram', 'pushbullet', 'email']

export const SHARED_NOTIFICATION_TYPES = [
  { value: 'request_pending', label: 'New request pending', meta: '(admin)' },
  { value: 'request_auto_approved', label: 'Request auto-approved', meta: '(admin)' },
  { value: 'request_approved', label: 'Request approved', meta: '(requester)' },
  { value: 'request_denied', label: 'Request denied', meta: '(requester)' },
  { value: 'request_available', label: 'Request available in library', meta: '(requester)' },
  { value: 'request_process_failed', label: 'Request processing error', meta: '(admin)' },
  { value: 'issue_new', label: 'New issue reported', meta: '(admin)' },
  { value: 'issue_updated', label: 'Issue status updated', meta: '(requester)' },
  { value: 'issue_comment_added_admin,issue_comment_added_user', label: 'Issue Comments' },
]

export const DEFAULT_AGENT_TYPES = [
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'request_available', 'request_process_failed',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]

export const WEBHOOK_NOTIFICATION_TYPES = SHARED_NOTIFICATION_TYPES.map(t => ({ ...t }))
export const BOT_NOTIFICATION_TYPES = SHARED_NOTIFICATION_TYPES.map(t => ({ ...t }))

export const PUSHOVER_NOTIFICATION_TYPES = [
  { value: 'request_pending', label: 'New request pending' },
  { value: 'request_approved', label: 'Request approved' },
  { value: 'request_denied', label: 'Request denied' },
  { value: 'request_available', label: 'Request available in library' },
  { value: 'request_process_failed', label: 'Request processing error' },
  { value: 'issue_new', label: 'New issue reported' },
  { value: 'issue_updated', label: 'Issue status updated' },
  { value: 'issue_comment_added_admin,issue_comment_added_user', label: 'Issue Comments' },
]

export const DEFAULT_WEBHOOK_TYPES = [
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]
export const DEFAULT_BOT_TYPES = [
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]
export const DEFAULT_PUSHOVER_TYPES = [
  'request_pending', 'request_approved', 'request_denied', 'request_available',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]

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
]

export const ELEVATED_NOTIF_TYPES = [
  { key: 'notify_pending', label: 'New request pending', desc: 'Get notified when a request awaits approval' },
  { key: 'notify_auto_approved', label: 'Request auto-approved', desc: 'Get notified when a request is automatically submitted' },
]

export const ADMIN_ONLY_NOTIF_TYPES = [
  { key: 'notify_process_failed', label: 'Processing failed', desc: 'Get notified when a request fails to submit' },
  { key: 'notify_issue_new', label: 'New issue reported', desc: 'Get notified when a user reports a new issue' },
]
