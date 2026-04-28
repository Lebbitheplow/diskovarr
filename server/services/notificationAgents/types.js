// ── Notification event types ──────────────────────────────────────────────────
// Maps Diskovarr event names to bitmask values (Seerr-compatible)
// Bitmask allows efficient "has this type?" checks with bitwise AND

const NotificationType = {
  NONE:                  0,
  MEDIA_PENDING:         2,
  MEDIA_APPROVED:        4,
  MEDIA_AVAILABLE:       8,
  MEDIA_FAILED:          16,
  TEST_NOTIFICATION:     32,
  MEDIA_DECLINED:        64,
  MEDIA_AUTO_APPROVED:   128,
  ISSUE_CREATED:         256,
  ISSUE_COMMENT:         512,
  ISSUE_RESOLVED:        1024,
  ISSUE_REOPENED:        2048,
  MEDIA_AUTO_REQUESTED:  4096,
};

// All notification types combined (for "select all")
const ALL_NOTIFICATION_TYPES = Object.values(NotificationType)
  .filter((v) => !isNaN(Number(v)) && v !== 0)
  .reduce((sum, v) => sum + v, 0);

// Map Diskovarr event string → bitmask value
const TYPE_MAP = {
  request_pending:             NotificationType.MEDIA_PENDING,
  request_approved:            NotificationType.MEDIA_APPROVED,
  request_available:           NotificationType.MEDIA_AVAILABLE,
  request_process_failed:      NotificationType.MEDIA_FAILED,
  request_denied:              NotificationType.MEDIA_DECLINED,
  request_auto_approved:       NotificationType.MEDIA_AUTO_APPROVED,
  issue_new:                   NotificationType.ISSUE_CREATED,
  issue_updated:               NotificationType.ISSUE_RESOLVED,
  issue_comment_added_admin:   NotificationType.ISSUE_COMMENT,
  issue_comment_added_user:    NotificationType.ISSUE_COMMENT,
  test:                        NotificationType.TEST_NOTIFICATION,
};

// Human-readable labels for each type
const TYPE_LABELS = {
  request_pending:             'New request pending approval',
  request_auto_approved:       'Request auto-approved',
  request_approved:            'Request approved',
  request_denied:              'Request declined',
  request_available:           'Request available in library',
  request_process_failed:      'Request processing error',
  issue_new:                   'New issue reported',
  issue_updated:               'Issue resolved',
  issue_comment_added_admin:   'Issue comment (admin)',
  issue_comment_added_user:    'Issue comment (user)',
};

// Who receives each type: 'admin', 'user', or 'both'
const TYPE_TARGET = {
  request_pending:             'admin',
  request_auto_approved:       'admin',
  request_approved:            'user',
  request_denied:              'user',
  request_available:           'user',
  request_process_failed:      'admin',
  issue_new:                   'admin',
  issue_updated:               'both',
  issue_comment_added_admin:   'admin',
  issue_comment_added_user:    'both',
};

// Color map for Discord embeds
const TYPE_COLORS = {
  request_pending:             0xe5a00d,
  request_auto_approved:       0xe5a00d,
  request_approved:            0x00c864,
  request_denied:              0xff5252,
  request_available:           0x00b4d8,
  request_process_failed:      0xff5252,
  issue_new:                   0xff8c00,
  issue_updated:               0x00b4d8,
  issue_comment_added_admin:   0xff8c00,
  issue_comment_added_user:    0x00b4d8,
};

// ── Helper functions ──────────────────────────────────────────────────────────

// Check if a bitmask (agent types or user types) includes a specific type
function hasNotificationType(mask, diskovarrType) {
  if (mask === 0 || mask === undefined || mask === null) return true;
  const bit = TYPE_MAP[diskovarrType] || 0;
  if (bit === 0) return false;
  // Handle string-based types (legacy Diskovarr)
  if (typeof mask === 'string') {
    return mask.includes(diskovarrType);
  }
  // Handle array-based types (legacy Diskovarr)
  if (Array.isArray(mask)) {
    return mask.includes(diskovarrType);
  }
  // Bitmask check
  return !!(mask & bit);
}

// Convert array of Diskovarr type strings to bitmask
function typesToBitmask(typeStrings) {
  let mask = 0;
  for (const t of typeStrings) {
    mask |= (TYPE_MAP[t] || 0);
  }
  return mask;
}

// Convert bitmask to array of Diskovarr type strings
function bitmaskToTypes(mask) {
  const types = [];
  for (const [name, bit] of Object.entries(TYPE_MAP)) {
    if (mask & bit) types.push(name);
  }
  return types;
}

// Get the bitmask for a Diskovarr event type
function getBitForType(diskovarrType) {
  return TYPE_MAP[diskovarrType] || 0;
}

// ── Agent keys ────────────────────────────────────────────────────────────────

const AgentKey = {
  DISCORD:     'discord',
  EMAIL:       'email',
  GOTIFY:      'gotify',
  NTFY:        'ntfy',
  PUSHBULLET:  'pushbullet',
  PUSHOVER:    'pushover',
  SLACK:       'slack',
  TELEGRAM:    'telegram',
  WEBHOOK:     'webhook',
  WEBPUSH:     'webpush',
};

module.exports = {
  NotificationType,
  ALL_NOTIFICATION_TYPES,
  TYPE_MAP,
  TYPE_LABELS,
  TYPE_TARGET,
  TYPE_COLORS,
  hasNotificationType,
  typesToBitmask,
  bitmaskToTypes,
  getBitForType,
  AgentKey,
};
