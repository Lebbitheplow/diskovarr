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
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// Track last visit for logged-in users (throttled to once per 5 minutes per user)
const _lastVisitTouch = new Map();
app.use((req, res, next) => {
  const userId = req.session?.plexUser?.id;
  if (userId) {
    const now = Date.now();
    const last = _lastVisitTouch.get(userId) || 0;
    if (now - last > 5 * 60 * 1000) {
      _lastVisitTouch.set(userId, now);
      try { require('./db/database').touchKnownUser(userId); } catch {}
    }
  }
  next();
});

// Routes
app.use('/auth', require('./routes/auth'));

// Overseerr-compatible shim — must be before /api (has its own auth)
app.use('/api/v1', require('./routes/overseerrShim'));
app.use('/api', require('./routes/api'));
app.use('/admin', require('./routes/admin'));

// Riven torrent browser (admin-protected)
const { requireAdmin: _requireAdmin } = require('./routes/admin');
app.use('/admin/riven', _requireAdmin, require('./routes/riven'));

// Public: Discord bot avatar (themed auto-generated, or custom upload)
app.get('/discord-avatar.png', (req, res) => {
  try {
    const db = require('./db/database');
    const customDataUri = db.getSetting('discord_avatar_data_uri', null);
    if (customDataUri) {
      const match = customDataUri.match(/^data:(image\/(?:png|jpeg|gif));base64,(.+)$/);
      if (match) {
        const buf = Buffer.from(match[2], 'base64');
        res.setHeader('Content-Type', match[1]);
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.send(buf);
      }
    }
    const { generateAvatar } = require('./services/discordAvatar');
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
  const recommender = require('./services/recommender');
  const db = require('./db/database');
  const discordAgent = require('./services/discordAgent');
  const pushoverAgent = require('./services/pushoverAgent');
  const REFRESH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

  const adminRoute = require('./routes/admin');

  async function checkFulfilledRequests() {
    try {
      const [movies, tv] = await Promise.all([
        plexService.getLibraryItems(plexService.MOVIES_SECTION),
        plexService.getLibraryItems(plexService.TV_SECTION),
      ]);
      const libraryTmdbIds = new Set();
      for (const item of [...movies, ...tv]) {
        if (item.tmdbId) {
          libraryTmdbIds.add(`${item.tmdbId}:${item.type === 'show' ? 'tv' : 'movie'}`);
        }
      }
      const fulfilled = db.getUnnotifiedFulfilledRequests(libraryTmdbIds);
      if (!fulfilled.length) return;

      // Back-fill TMDB cache for any fulfilled items that have no stored poster URL
      const tmdbService = require('./services/tmdb');
      const missingPosters = fulfilled.filter(r => !r.poster_url && !db.getTmdbCache(r.tmdb_id, r.media_type));
      if (missingPosters.length > 0) {
        await Promise.all(missingPosters.map(r =>
          tmdbService.getItemDetails(r.tmdb_id, r.media_type).catch(() => null)
        ));
      }

      for (const req of fulfilled) {
        const prefs = db.getUserNotificationPrefs(req.user_id);
        if (!prefs.notify_available) continue;
        const notifTitle = `Now available: "${req.title}"`;
        const body = `"${req.title}" is now available in the library.`;
        const notifId = db.createOrBundleNotification({
          userId: req.user_id, type: 'request_available',
          title: notifTitle, body,
          data: { tmdbId: req.tmdb_id, mediaType: req.media_type },
        });
        const posterUrl = req.poster_url || db.getTmdbCache(req.tmdb_id, req.media_type)?.posterUrl || null;
        db.enqueueNotification({ notificationId: notifId, agent: 'discord', userId: req.user_id,
          payload: { type: 'request_available', title: notifTitle, body, posterUrl, userId: req.user_id } });
        db.enqueueNotification({ notificationId: notifId, agent: 'pushover', userId: req.user_id,
          payload: { type: 'request_available', title: notifTitle, body } });
      }
      db.markRequestsNotifiedAvailable(fulfilled.map(r => r.id));
      logger.info(`Request fulfillment: notified ${fulfilled.length} user(s) of available content`);
    } catch (err) {
      logger.warn('checkFulfilledRequests error:', err.message);
    }
  }

  // Allow the Plex webhook route to trigger fulfillment checks
  process.on('diskovarr:checkFulfilled', () =>
    checkFulfilledRequests().catch(err => logger.warn('checkFulfilledRequests (event) error:', err.message))
  );

  async function refreshLibrarySync() {
    if (!adminRoute.shouldAutoSync()) {
      logger.info('Auto-sync skipped (disabled by admin)');
      return;
    }
    try {
      plexService.invalidateCache();
      await plexService.warmCache();
      logger.info('Library synced successfully');
      await checkFulfilledRequests();
      // Pre-warm recommendation caches 30s after library sync (avoids load spike)
      setTimeout(() => recommender.warmAllUserCaches().catch(err =>
        logger.warn('Rec pre-warm failed:', err.message)
      ), 30_000);
    } catch (err) {
      logger.warn('Library sync failed:', err.message);
    }
  }

  // On startup: load from DB if fresh, otherwise sync from Plex
  setTimeout(refreshLibrarySync, 2000);

  // Background re-sync every 2 hours
  setInterval(refreshLibrarySync, REFRESH_INTERVAL);

  // Keep rec caches warm — re-warm every 25 min so caches never expire before users open the app
  // (rec cache TTL is 30 min; this fires just before expiry)
  setInterval(() => recommender.warmAllUserCaches().catch(err =>
    logger.warn('Periodic rec pre-warm failed:', err.message)
  ), 25 * 60 * 1000);

  const discoverRecommender = require('./services/discoverRecommender');

  // Refresh shared TMDB candidate pools every 6 hours (genre/trending/anime pages,
  // filtered by each unique region+language+mature combo found in user prefs)
  setInterval(() => discoverRecommender.refreshSharedCandidatePools()
    .catch(err => logger.warn('Discover pool refresh failed:', err.message)),
    6 * 60 * 60 * 1000
  );

  // Keep per-user discover caches warm every 28 min (re-score shared candidates
  // against each user's watch history so /explore loads instantly)
  setInterval(() => discoverRecommender.warmAllUserDiscoverCaches()
    .catch(err => logger.warn('Discover cache pre-warm failed:', err.message)),
    28 * 60 * 1000
  );

  // On startup: build shared candidate pools ~90s after start (after library sync settles)
  setTimeout(() => discoverRecommender.refreshSharedCandidatePools()
    .catch(err => logger.warn('Initial discover pool build failed:', err.message)),
    90_000
  );

  // Start notification delivery service
  notificationService.start();

  // Plex WebSocket — real-time library change notifications (no Plex Pass required).
  // Plex pushes timeline events over this socket whenever items are added/updated.
  // Uses Node.js built-in WebSocket (v22+) — no external dependency.
  (function connectPlexWebSocket(delay = 0) {
    setTimeout(() => {
      const wsPlexUrl   = plexService.getPlexUrl();
      const wsPlexToken = plexService.getPlexToken();
      if (!wsPlexUrl || !wsPlexToken) {
        logger.warn('Plex WebSocket: no URL or token configured, skipping');
        return;
      }

      const wsUrl = wsPlexUrl.replace(/^http/, 'ws') + '/:/websockets/notifications?X-Plex-Token=' + wsPlexToken;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        logger.info('Plex WebSocket connected');
      };

      // Collect new item ratingKeys from WebSocket events. Keyed by ratingKey so
      // duplicates within the same burst are deduplicated automatically.
      const _pendingItems = new Map(); // ratingKey -> sectionId
      let _wsDebounce = null;
      ws.onmessage = ({ data }) => {
        try {
          const container = JSON.parse(data)?.NotificationContainer;
          if (container?.type !== 'timeline') return;
          for (const e of (container.TimelineEntry || [])) {
            if (e.state === 5 && e.identifier === 'com.plexapp.plugins.library') {
              _pendingItems.set(String(e.itemID), String(e.sectionID));
            }
          }
          if (_pendingItems.size === 0) return;
          // Debounce: collect events for 3s, then fetch each new item individually
          // from Plex (same method Tautulli uses — no full library scan).
          if (_wsDebounce) clearTimeout(_wsDebounce);
          _wsDebounce = setTimeout(async () => {
            _wsDebounce = null;
            const batch = new Map(_pendingItems);
            _pendingItems.clear();
            await Promise.all([...batch.entries()].map(([ratingKey, sectionId]) =>
              plexService.fetchAndUpsertItem(ratingKey, sectionId).catch(() => null)
            ));
            checkFulfilledRequests().catch(err => logger.warn('checkFulfilledRequests (ws) error:', err.message));
          }, 3000);
        } catch {}
      };

      ws.onclose = () => {
        const nextDelay = Math.min((delay || 5000) * 2, 5 * 60 * 1000);
        logger.info(`Plex WebSocket closed, reconnecting in ${nextDelay / 1000}s`);
        connectPlexWebSocket(nextDelay);
      };

      ws.onerror = (err) => {
        logger.warn('Plex WebSocket error:', err.message);
        // onclose fires after onerror and handles reconnect
      };
    }, delay);
  })(3000); // 3s initial delay so startup sync completes first
});
