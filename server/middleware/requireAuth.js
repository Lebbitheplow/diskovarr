const db = require('../db/database');
const { timingSafeEqual } = require('crypto');

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

function requireAuth(req, res, next) {
  if (req.session && req.session.plexUser) {
    return next();
  }
  // API key auth (for external integrations)
  if (hasApiKey(req)) {
    // Inject a synthetic admin user for this request only. Non-enumerable so
    // express-session's JSON-based change detection never sees it — a plain
    // assignment would mark the session modified and persist a 30-day admin
    // session (with Set-Cookie) for every API-key request.
    Object.defineProperty(req.session, 'plexUser', {
      value: { username: 'api-key', isAdmin: true, userId: 'api-key', thumb: null },
      enumerable: false,
      configurable: true,
    });
    return next();
  }
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

module.exports = requireAuth;
module.exports.hasApiKey = hasApiKey;
