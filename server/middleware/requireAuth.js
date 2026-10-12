const db = require('../db/database');
const { timingSafeEqual } = require('crypto');

// Identity of the Diskovarr API key principal. Never a known_users row and
// never persisted — see requireAuth below.
const API_KEY_USER_ID = 'api-key';

// True when the request carries the Diskovarr API key (Admin → General) via
// `X-Api-Key` or `Authorization: Bearer`. Shared by requireAuth and requireAdmin
// so external tools such as DUMB can drive the admin API without a session.
function hasApiKey(req) {
  const authHeader = req.headers['authorization'] || '';
  const apiKey = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null)
              || req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') return false;
  const storedKey = db.getSetting('diskovarr_api_key', '');
  if (!storedKey) return false;
  const a = Buffer.from(apiKey);
  const b = Buffer.from(storedKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Endpoints behind requireAuth that the API key may call. The key authenticates
// an integration, not a person, so it gets the admin/request-manager operations
// but not endpoints that read or write a user's own data (watchlist, settings,
// reviews, Wrapped, Watch Together...) — those would act on, and create rows
// for, the synthetic identity. /admin/* is gated by requireAdmin instead.
const API_KEY_ROUTES = [
  { path: /^\/api\/(queue|riven)(\/|$)/i },
  { path: /^\/api\/(issues|history)(\/|$)/i, methods: ['GET', 'HEAD'] },
  { path: /^\/api\/issues\/(bulk-delete|[^/]+\/(search|resolve|close))\/?$/i, methods: ['POST'] },
  { path: /^\/api\/issues\/[^/]+(\/comments\/[^/]+)?\/?$/i, methods: ['DELETE'] },
  { path: /^\/api\/admin\/rebuild-pool\/?$/i, methods: ['POST'] },
];

function apiKeyMayUse(req) {
  const fullPath = (req.baseUrl || '') + (req.path || '');
  return API_KEY_ROUTES.some(r => r.path.test(fullPath) && (!r.methods || r.methods.includes(req.method)));
}

// Set a request-only session property. Non-enumerable so express-session's
// JSON-based change detection never sees it — a plain assignment would mark
// the session modified and persist it (with Set-Cookie).
function defineHidden(session, key, value) {
  Object.defineProperty(session, key, { value, enumerable: false, configurable: true });
}

// The admin role is read from the database on every authenticated request
// instead of trusting the snapshot taken at login, so revoking it in Admin →
// Users takes effect on that user's next request. Routes keep reading
// req.session.isPlexAdminUser; this keeps it current (persisting a change).
function syncSessionRole(req) {
  const isPlexAdmin = db.isAdminUser(req.session.plexUser.id);
  if (req.session.isPlexAdminUser !== isPlexAdmin) req.session.isPlexAdminUser = isPlexAdmin;
  return isPlexAdmin;
}

// Shared policy for admin-or-request-manager operations. session.isAdmin is the
// password admin (or the API key, per request); everyone else is checked
// against the current database (is_admin users plus the server owner).
function isPrivilegedRequest(req) {
  const s = req.session;
  if (!s) return false;
  if (s.isAdmin) return true;
  return !!s.plexUser && db.getPrivilegedUserIds().includes(String(s.plexUser.id));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.plexUser) {
    if (!req.apiKeyAuth) syncSessionRole(req);
    return next();
  }
  // API key auth (for external integrations)
  if (hasApiKey(req)) {
    if (!apiKeyMayUse(req)) {
      return res.status(403).json({ error: 'This endpoint is not available to the Diskovarr API key (it covers /admin, the request queue, Riven, issue management and history)' });
    }
    // A synthetic admin principal for this request only, with the same fields
    // privileged routes read from a signed-in admin (isAdmin on the session,
    // id on the user). Both hidden so no 30-day admin session is persisted.
    req.apiKeyAuth = true;
    defineHidden(req.session, 'plexUser', {
      id: API_KEY_USER_ID, userId: API_KEY_USER_ID, username: API_KEY_USER_ID, isAdmin: true, thumb: null,
    });
    if (!req.session.isAdmin) defineHidden(req.session, 'isAdmin', true);
    return next();
  }
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

// Issue a fresh session ID on login (session-fixation defence) while keeping
// what the session already holds — a password-admin flag, the active source —
// minus `drop`, the keys the login consumes. The old ID is destroyed.
function regenerateSession(req, drop = []) {
  const carried = {};
  for (const [key, value] of Object.entries(req.session)) {
    if (key !== 'cookie' && !drop.includes(key)) carried[key] = value;
  }
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, carried);
      resolve();
    });
  });
}

module.exports = requireAuth;
module.exports.hasApiKey = hasApiKey;
module.exports.API_KEY_USER_ID = API_KEY_USER_ID;
module.exports.syncSessionRole = syncSessionRole;
module.exports.isPrivilegedRequest = isPrivilegedRequest;
module.exports.regenerateSession = regenerateSession;
