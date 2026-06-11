const db = require('../db/database');

function requireAuth(req, res, next) {
  if (req.session && req.session.plexUser) {
    return next();
  }
  // API key auth (for external integrations)
  const authHeader = req.headers['authorization'] || '';
  const apiKey = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null)
              || req.headers['x-api-key'];
  if (apiKey) {
    const storedKey = db.getSetting('diskovarr_api_key', '');
    if (storedKey && apiKey === storedKey) {
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
  }
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

module.exports = requireAuth;
