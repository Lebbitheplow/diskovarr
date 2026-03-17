require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const logger = require('./services/logger');
const notificationService = require('./services/notificationService');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Initialize logger state from DB (DB module self-initializes, safe to require here)
// We do this after data dir exists but before routes load
{
  const db = require('./db/database');
  logger.setVerbose(db.getSetting('verbose_logging_enabled', '0') === '1');
}

const { DatabaseSync } = require('node:sqlite');

class SQLiteStore extends session.Store {
  constructor({ dir, db: dbFile }) {
    super();
    const sessDb = new DatabaseSync(path.join(dir, dbFile));
    sessDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT NOT NULL PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    this._db = sessDb;
    setInterval(() => this._pruneExpired(), 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    const now = Math.floor(Date.now() / 1000);
    const row = this._db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired >= ?').get(sid, now);
    cb(null, row ? JSON.parse(row.sess) : null);
  }

  set(sid, session, cb) {
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge / 1000 : 86400;
    const expired = Math.floor(Date.now() / 1000) + Math.floor(maxAge);
    this._db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
      .run(sid, JSON.stringify(session), expired);
    cb(null);
  }

  destroy(sid, cb) {
    this._db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb(null);
  }

  touch(sid, session, cb) {
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge / 1000 : 86400;
    const expired = Math.floor(Date.now() / 1000) + Math.floor(maxAge);
    this._db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid);
    cb(null);
  }

  _pruneExpired() {
    this._db.prepare('DELETE FROM sessions WHERE expired < ?').run(Math.floor(Date.now() / 1000));
  }
}

const app = express();

// Trust reverse proxy (Nginx Proxy Manager) so req.protocol and req.hostname
// reflect the real domain (diskovarr.lebbi.org) rather than the internal IP
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP request logger (only active when logging enabled)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.http(req, res, Date.now() - start));
  next();
});

// Session
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is not set'); })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));
app.use('/admin', require('./routes/admin'));

// Public: Discord bot avatar PNG (themed, no auth required)
app.get('/discord-avatar.png', (req, res) => {
  try {
    const { generateAvatar } = require('./services/discordAvatar');
    const db = require('./db/database');
    const accentHex = db.getThemeColor() || 'e5a00d';
    const { png } = generateAvatar(accentHex);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OG image — served as SVG for link previews (Discord, Slack, etc.)
app.get('/og-image.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0f0f0f"/>
  <rect width="1200" height="630" fill="url(#grad)" opacity="0.4"/>
  <defs>
    <radialGradient id="grad" cx="30%" cy="50%" r="70%">
      <stop offset="0%" stop-color="#e5a00d" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#0f0f0f" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <text x="600" y="260" font-family="serif" font-size="160" fill="#e5a00d" text-anchor="middle" opacity="0.9">◈</text>
  <text x="600" y="380" font-family="system-ui,sans-serif" font-size="80" font-weight="700" fill="#ffffff" text-anchor="middle" letter-spacing="-2">diskovarr</text>
  <text x="600" y="450" font-family="system-ui,sans-serif" font-size="32" fill="#a0a0a0" text-anchor="middle">Personalized Plex recommendations</text>
</svg>`);
});

app.use('/', require('./routes/pages'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3232;
app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`Diskovarr running on http://0.0.0.0:${PORT}\n`);
  logger.info(`Logging enabled. Diskovarr v${require('./package.json').version} started on port ${PORT}`);

  const plexService = require('./services/plex');
  const REFRESH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

  const adminRoute = require('./routes/admin');

  async function refreshLibrarySync() {
    if (!adminRoute.shouldAutoSync()) {
      logger.info('Auto-sync skipped (disabled by admin)');
      return;
    }
    try {
      plexService.invalidateCache();
      await plexService.warmCache();
      logger.info('Library synced successfully');
    } catch (err) {
      logger.warn('Library sync failed:', err.message);
    }
  }

  // On startup: load from DB if fresh, otherwise sync from Plex
  setTimeout(refreshLibrarySync, 2000);

  // Background re-sync every 2 hours
  setInterval(refreshLibrarySync, REFRESH_INTERVAL);

  // Start notification delivery service
  notificationService.start();
});
