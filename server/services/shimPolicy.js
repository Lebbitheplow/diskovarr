// Authorization policy for the Overseerr-compatible shim (routes/overseerrShim.js).
//
// Two kinds of key reach the shim:
//  - app key (api_apps.api_key): the shim's equivalent of Overseerr's API key and
//    admin of the whole Overseerr surface. DUMB/Riven pull mode, Homarr and
//    Agregarr-style tools need every request, not just their own, so an app key
//    may do anything the shim offers (user management stays within its own app
//    because service-user lookups are keyed by app). One exception: the DUMB
//    bridge key may only delete by plain request id those requests its app
//    filed (createdByApp), since Riven 0.x sends media ids, not request ids, to
//    DELETE /request/:id; media-id deletes (an encoded id there, or
//    DELETE /media/:id) are unaffected.
//  - service-user key (app_service_users.api_key): a per-user key under one app,
//    authorised like an Overseerr user holding its stored permission mask — its
//    own requests and issues, plus whatever MANAGE_* / *_VIEW bits grant.
//
// Bit values and checks mirror Overseerr (server/lib/permissions.ts and its route
// guards); ADMIN implies every other permission.

const Permission = Object.freeze({
  NONE: 0,
  ADMIN: 2,
  MANAGE_SETTINGS: 4,
  MANAGE_USERS: 8,
  MANAGE_REQUESTS: 16,
  REQUEST: 32,
  VOTE: 64,
  AUTO_APPROVE: 128,
  AUTO_APPROVE_MOVIE: 256,
  AUTO_APPROVE_TV: 512,
  REQUEST_4K: 1024,
  REQUEST_4K_MOVIE: 2048,
  REQUEST_4K_TV: 4096,
  REQUEST_ADVANCED: 8192,
  REQUEST_VIEW: 16384,
  AUTO_APPROVE_4K: 32768,
  AUTO_APPROVE_4K_MOVIE: 65536,
  AUTO_APPROVE_4K_TV: 131072,
  REQUEST_MOVIE: 262144,
  REQUEST_TV: 524288,
  MANAGE_ISSUES: 1048576,
  VIEW_ISSUES: 2097152,
  CREATE_ISSUES: 4194304,
});

// Masks are combined with 32-bit bitwise ops, so keep them in the positive int range
const MAX_MASK = 0x7fffffff;

// Mask for new service users when the creator names none: Overseerr's default
// (settings.main.defaultPermissions), which /settings/public and /settings/main
// advertise. db.createServiceUser defaults to the same value.
const DEFAULT_PERMISSIONS = Permission.REQUEST;

// Validate a permission mask from a request body: non-negative integer (numeric
// strings allowed, as JSON clients sometimes send them). Returns null if invalid.
function parseMask(value) {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_MASK ? n : null;
}

// Build the principal for an authenticated shim key.
function principal(app, serviceUser = null) {
  if (serviceUser) {
    return {
      kind: 'service',
      appId: app.id,
      userId: serviceUser.user_id,
      serviceUser,
      mask: parseMask(serviceUser.permissions) ?? 0,
    };
  }
  // App-created rows (requests/issues without X-API-User) use this virtual user
  return { kind: 'app', appId: app.id, userId: `__app_${app.id}__`, serviceUser: null, mask: 0 };
}

const isAppAdmin = p => p?.kind === 'app';

// Overseerr's hasPermission: ADMIN short-circuits; 'and' needs every bit, 'or' any.
function hasPermission(p, perms, type = 'and') {
  if (!p) return false;
  if (isAppAdmin(p) || (p.mask & Permission.ADMIN)) return true;
  const list = Array.isArray(perms) ? perms : [perms];
  return type === 'or'
    ? list.some(bit => (p.mask & bit) !== 0)
    : list.every(bit => (p.mask & bit) !== 0);
}

const owns = (p, row) => !!(p && row && row.user_id === p.userId);

// ── Requests ──────────────────────────────────────────────────────────────────

const canViewAllRequests = p => hasPermission(p, [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], 'or');
const canViewRequest = (p, row) => canViewAllRequests(p) || owns(p, row);
// Approve / decline / status changes / media status / retry
const canManageRequests = p => hasPermission(p, Permission.MANAGE_REQUESTS);
// Edit or delete: managers always; a requester only while their own request is pending
const canModifyRequest = (p, row) => canManageRequests(p) || (owns(p, row) && row.status === 'pending');

// Creating a request, checked on the acting user (the X-API-User target when an
// app key impersonates one) as Overseerr's MediaRequest.request() does: REQUEST
// or the per-type bit. AUTO_APPROVE* and MANAGE_REQUESTS don't grant it. The shim
// always files non-4K requests, so the 4K bits neither grant nor are required.
// Returns null when allowed, else Overseerr's 403 message.
function requestPermissionError(p, mediaType) {
  const movie = mediaType === 'movie';
  const bits = [Permission.REQUEST, movie ? Permission.REQUEST_MOVIE : Permission.REQUEST_TV];
  if (hasPermission(p, bits, 'or')) return null;
  return `You do not have permission to make ${movie ? 'movie' : 'series'} requests.`;
}

// Whether `row` was filed through `app` itself: its virtual __app_<id>__ user or
// one of its service users (__svc_<id>_<n>__, see db.createServiceUser)
function createdByApp(app, row) {
  if (!app || !row) return false;
  const userId = String(row.user_id || '');
  return userId === `__app_${app.id}__` || userId.startsWith(`__svc_${app.id}_`);
}

// ── Users ─────────────────────────────────────────────────────────────────────

// Settings writes on a service user: themselves or MANAGE_USERS
const canManageUser = (p, target) => isAppAdmin(p) || (!!target && target.user_id === p.userId)
  || hasPermission(p, Permission.MANAGE_USERS);

// Viewing another user's quota needs both, as in Overseerr
const canViewQuota = (p, target) => isAppAdmin(p) || (!!target && target.user_id === p.userId)
  || hasPermission(p, [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS], 'and');

// Returns null when `p` may set `target`'s mask to `mask`, else a 403 message.
// Nobody below the app key may grant ADMIN, touch an ADMIN user, or grant/alter
// bits they do not hold themselves — so a key can never raise its own ceiling.
function permissionChangeError(p, target, mask) {
  if (isAppAdmin(p)) return null;
  if (!hasPermission(p, Permission.MANAGE_USERS)) return 'You do not have permission to modify users';
  if (mask & Permission.ADMIN) return 'You do not have permission to grant this level of access';
  const current = parseMask(target.permissions) ?? 0;
  if (current & Permission.ADMIN) return 'You do not have permission to modify this user';
  if (p.mask & Permission.ADMIN) return null;
  if ((mask & ~p.mask) || (current & ~p.mask)) return 'You cannot grant or change permissions you do not hold';
  return null;
}

// ── Issues ────────────────────────────────────────────────────────────────────

const canViewAllIssues = p => hasPermission(p, [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES], 'or');
// Listing at all needs some issue permission; CREATE_ISSUES alone sees only its own
const canListIssues = p => hasPermission(p, [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES, Permission.CREATE_ISSUES], 'or');
const canCreateIssue = p => hasPermission(p, [Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], 'or');
const canViewIssue = (p, issue) => canViewAllIssues(p) || owns(p, issue);
// Comment on / change status of / delete an issue: MANAGE_ISSUES or its creator
const canActOnIssue = (p, issue) => hasPermission(p, Permission.MANAGE_ISSUES) || owns(p, issue);
const canEditComment = (p, comment) => isAppAdmin(p) || owns(p, comment);
const canDeleteComment = (p, comment) => hasPermission(p, Permission.MANAGE_ISSUES) || owns(p, comment);

// ── Express helpers ───────────────────────────────────────────────────────────

function forbid(res, message = 'Forbidden') {
  return res.status(403).json({ message });
}

// Route guard: req.shimPrincipal must hold `perms` (see hasPermission for `type`)
function requirePermission(perms, type = 'and') {
  return (req, res, next) => (hasPermission(req.shimPrincipal, perms, type) ? next() : forbid(res));
}

module.exports = {
  Permission,
  MAX_MASK,
  DEFAULT_PERMISSIONS,
  parseMask,
  principal,
  isAppAdmin,
  hasPermission,
  owns,
  canViewAllRequests,
  canViewRequest,
  canManageRequests,
  canModifyRequest,
  requestPermissionError,
  createdByApp,
  canManageUser,
  canViewQuota,
  permissionChangeError,
  canViewAllIssues,
  canListIssues,
  canCreateIssue,
  canViewIssue,
  canActOnIssue,
  canEditComment,
  canDeleteComment,
  forbid,
  requirePermission,
};
