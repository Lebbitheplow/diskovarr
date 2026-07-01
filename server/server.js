require('dotenv').config()
const express = require('express')
const session = require('express-session')
const path = require('path')
const fs = require('fs')

const PORT = process.env.PORT || 3232
// Overridable for tests and non-Docker installs that keep data elsewhere
const dataDir = process.env.DISKOVARR_DATA_DIR || path.join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const { DatabaseSync } = require('node:sqlite')

class SQLiteStore extends session.Store {
  constructor({ dir, db: dbFile }) {
    super()
    const sessDb = new DatabaseSync(path.join(dir, dbFile))
    sessDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT NOT NULL PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `)
    this._db = sessDb
  }
  get(sid, cb) {
    try {
      const now = Math.floor(Date.now() / 1000)
      const row = this._db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired >= ?').get(sid, now)
      cb(null, row ? JSON.parse(row.sess) : null)
    } catch (e) {
      cb(null, null)
    }
  }

  set(sid, session, cb) {
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge / 1000 : 86400
    const expired = Math.floor(Date.now() / 1000) + Math.floor(maxAge)
    this._db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
      .run(sid, JSON.stringify(session), expired)
    cb(null)
  }

  destroy(sid, cb) {
    this._db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid)
    cb(null)
  }

  touch(sid, session, cb) {
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge / 1000 : 86400
    const expired = Math.floor(Date.now() / 1000) + Math.floor(maxAge)
    this._db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid)
    cb(null)
  }

  _pruneExpired() {
    this._db.prepare('DELETE FROM sessions WHERE expired < ?').run(Math.floor(Date.now() / 1000))
  }
  clear(cb) { this._db.exec('DELETE FROM sessions'); cb() }
}

const app = express()
// Behind Cloudflare → NPM; trust the first proxy hop so req.protocol/req.ip
// reflect the original request (needed for secure:'auto' cookies & rate limits)
app.set('trust proxy', 1)
app.use(express.static(path.join(__dirname, 'public')))

app.use((req, res, next) => {
  req.appUrl = req.protocol + '://' + req.get('host')
  if (req.path.startsWith('/auth/') || req.path === '/callback') {
    console.log(`[${req.method} ${req.path}] Cookie: ${req.headers.cookie ? 'present' : 'NONE'}`)
  }
  next()
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Unauthenticated health check for Docker/monitoring — verifies the DB answers.
// Mounted before the session middleware so probes never touch the session store.
app.get('/health', (req, res) => {
  try {
    require('./db/database').prepare('SELECT 1').get()
    res.json({
      status: 'ok',
      version: require('./package.json').version,
      uptime: Math.floor(process.uptime()),
    })
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message })
  }
})

app.use(session({
  name: 'diskovarr.react.sid',
  store: new SQLiteStore({ dir: dataDir, db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is not set'); })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 'auto': Secure flag on HTTPS (via trust proxy), plain over LAN HTTP.
    // 'lax' (not 'strict') because the Plex OAuth callback is a cross-site
    // top-level navigation and must carry the session cookie.
    secure: 'auto',
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}))

// Public API routes
app.use('/api/login', require('./routes/login'))

// API routes
app.use('/auth', require('./routes/auth'))
app.use('/api/v1', require('./routes/overseerrShim'))
// Public review reads — must precede the authenticated /api router
app.use('/api/public', require('./routes/public'))
app.use('/api', require('./routes/api'))
app.use('/admin', require('./routes/admin'))
app.use('/admin/riven', require('./routes/riven'))
app.use('/admin/automation', require('./routes/adminAutomation'))

// Public Open Graph card images for shared reviews (no auth — crawlers have no session)
app.use('/og', require('./routes/og'))

// Dynamic theme/icon routes (need Express)
const db = require('./db/database')

// Track last visit for logged-in users (throttled to once per 5 minutes per user)
const _lastVisitTouch = new Map()
app.use((req, res, next) => {
  const userId = req.session?.plexUser?.id;
  if (userId) {
    const now = Date.now();
    const last = _lastVisitTouch.get(userId) || 0;
    if (now - last > 5 * 60 * 1000) {
      _lastVisitTouch.set(userId, now);
      try { db.touchKnownUser(userId); } catch {}
    }
  }
  next();
});

const APP_VERSION = require('./package.json').version
// eslint-disable-next-line no-unused-vars -- theme CSS helper retained for SSR shell use
function bgGradientCss() {
  const color = db.getThemeColor()
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  return `body{background-image:radial-gradient(ellipse 50% 50% at 50% 0%,rgba(${r},${g},${b},0.28) 0%,transparent 100%),radial-gradient(ellipse 60% 40% at 50% 100%,rgba(${r},${g},${b},0.12) 0%,transparent 100%);background-attachment:fixed;}`
}
// eslint-disable-next-line no-unused-vars -- theme helper retained for SSR shell use
function themeParam() {
  return encodeURIComponent(db.getThemeColor())
}

app.get('/theme.css', (req, res) => {
  const color = db.getThemeColor()
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  const rh = Math.min(255, Math.round(r + (255 - r) * 0.15))
  const gh = Math.min(255, Math.round(g + (255 - g) * 0.15))
  const bh = Math.min(255, Math.round(b + (255 - b) * 0.15))
  const hover = `#${rh.toString(16).padStart(2,'0')}${gh.toString(16).padStart(2,'0')}${bh.toString(16).padStart(2,'0')}`
  const css = `:root {
  --accent: ${color};
  --accent-rgb: ${r}, ${g}, ${b};
  --accent-dim: rgba(${r}, ${g}, ${b}, 0.15);
  --accent-dim2: rgba(${r}, ${g}, ${b}, 0.20);
  --accent-glow: rgba(${r}, ${g}, ${b}, 0.08);
  --accent-border: rgba(${r}, ${g}, ${b}, 0.4);
  --accent-shadow: rgba(${r}, ${g}, ${b}, 0.4);
  --accent-hover: ${hover};
}
\n`
  res.setHeader('Content-Type', 'text/css')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.send(css)
})

app.get('/manifest.json', (req, res) => {
  const color = db.getThemeColor()
  res.setHeader('Content-Type', 'application/manifest+json')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.json({
    name: 'Diskovarr',
    short_name: 'Diskovarr',
    description: 'Personalized Plex recommendations based on your watch history.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f0f0f',
    theme_color: color,
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  })
})

app.get('/icons/icon.svg', (req, res) => {
  const c = db.getThemeColor()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="18" fill="#0f0f0f"/>
  <g transform="translate(20,20) scale(2.5)" fill="none">
    <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="${c}"/>
    <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="${c}"/>
    <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="${c}"/>
    <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="${c}"/>
    <circle cx="15" cy="9" r="5" stroke="${c}" stroke-width="2"/>
    <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>`
  res.setHeader('Content-Type', 'image/svg+xml')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.send(svg)
})

app.get('/icons/icon-maskable.svg', (req, res) => {
  const c = db.getThemeColor()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#0f0f0f"/>
  <g transform="translate(22,22) scale(2.33)" fill="none">
    <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="${c}"/>
    <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="${c}"/>
    <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="${c}"/>
    <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="${c}"/>
    <circle cx="15" cy="9" r="5" stroke="${c}" stroke-width="2"/>
    <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>`
  res.setHeader('Content-Type', 'image/svg+xml')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.send(svg)
})

// Discord bot avatar — themed PNG, changes with accent colour
app.get('/discord-avatar.png', (req, res) => {
  try {
    const customDataUri = db.getSetting('discord_avatar_data_uri', null)
    if (customDataUri) {
      const match = customDataUri.match(/^data:(image\/(?:png|jpeg|gif));base64,(.+)$/)
      if (match) {
        res.setHeader('Content-Type', match[1])
        res.setHeader('Cache-Control', 'public, max-age=300')
        return res.send(Buffer.from(match[2], 'base64'))
      }
    }
    const { generateAvatar } = require('./services/discordAvatar')
    const accentHex = db.getThemeColor() || 'e5a00d'
    const { png } = generateAvatar(accentHex)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(png)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Serve React static files
app.use(express.static(path.join(__dirname, '../dist')))

// Plex auth callback — store PIN in session server-side (same pattern as original app's GET /auth/callback)
// This runs before the SPA catch-all so the session cookie is set in the same response that serves the app
app.get('/callback', (req, res) => {
  const { pinId, pinCode } = req.query
  console.log(`[/callback] pinId=${pinId} pinCode=${pinCode ? pinCode.slice(0,6)+'...' : 'missing'} sessionID=${req.sessionID}`)
  if (pinId && pinCode) {
    req.session.plexPinId = String(pinId)
    req.session.plexPinCode = String(pinCode)
    console.log(`[/callback] stored pinId=${pinId} in session ${req.sessionID}`)
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

// Inject per-review Open Graph / Twitter meta tags into the SPA shell so shared
// review links preview richly on social platforms (crawlers don't run JS, so the
// SPA's client-side tags are invisible to them). Privacy/spoiler-safe via reviewShare.
// Matches /review/:id and /u/:username/review/:id; canonical id is the last segment.
const { getShareData, buildOgTags, getConfiguredPublicUrl } = require('./services/reviewShare')
let _indexHtml = null
function getIndexHtml() {
  if (_indexHtml == null) _indexHtml = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8')
  return _indexHtml
}
const REVIEW_PATH = /^\/(?:u\/[^/]+\/)?review\/(\d+)\/?$/
app.get(REVIEW_PATH, (req, res, next) => {
  try {
    const id = req.params[0]
    const data = getShareData(id)
    // Prefer the configured public URL so previews resolve even when the request
    // arrived over a LAN host; fall back to the request's own origin.
    const base = getConfiguredPublicUrl() || req.appUrl
    const tags = buildOgTags(data, base, id)
    const html = getIndexHtml().replace('</head>', `  ${tags}\n</head>`)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    return res.send(html)
  } catch {
    return next()
  }
})

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Diskovarr server running on port ${PORT}`)

  const discoverRecommender = require('./services/discoverRecommender')
  const recommender = require('./services/recommender')
  const plexService = require('./services/plex')
  const tautulliService = require('./services/tautulli')
  const reviewFeed = require('./services/reviewFeed')
  const reviewCardCache = require('./services/reviewCardCache')
  const logger = require('./services/logger')

  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 8) {
    logger.warn('ADMIN_PASSWORD is shorter than 8 characters — short passwords are brute-forceable even with login rate limiting.')
  }

  // Drain the external notification queue (Discord/Pushover) on a 30s loop.
  // Without this, enqueued notifications are never dispatched.
  require('./services/notificationService').start()

  // Sweep stale generated share cards on boot, then daily
  setTimeout(() => reviewCardCache.sweepJob(), 60_000)
  setInterval(() => reviewCardCache.sweepJob(), 24 * 60 * 60 * 1000)

  // Nightly DB backup via VACUUM INTO (consistent snapshot, doesn't block
  // readers). First run 5 min after boot, then every 24h; keeps the last 7.
  const BACKUP_KEEP = 7
  const runDbBackup = () => {
    try {
      const backupsDir = path.join(dataDir, 'backups')
      fs.mkdirSync(backupsDir, { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10)
      const dest = path.join(backupsDir, `diskovarr-${stamp}.db`)
      if (fs.existsSync(dest)) fs.rmSync(dest) // same-day rerun replaces
      db.backupTo(dest)
      const old = fs.readdirSync(backupsDir)
        .filter(f => /^diskovarr-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
      while (old.length > BACKUP_KEEP) fs.rmSync(path.join(backupsDir, old.shift()))
      logger.info(`DB backup written: ${dest}`)
    } catch (err) {
      logger.warn('DB backup failed:', err.message)
    }
  }
  setTimeout(runDbBackup, 5 * 60 * 1000)
  setInterval(runDbBackup, 24 * 60 * 60 * 1000)

  // Seed user tokens from active sessions (covers first run after migration)
  const { DatabaseSync } = require('node:sqlite')
  try {
    const sessDb = new DatabaseSync(path.join(dataDir, 'sessions.db'))
    const now = Math.floor(Date.now() / 1000)
    const sessions = sessDb.prepare('SELECT sess FROM sessions WHERE expired >= ?').all(now)
    for (const { sess } of sessions) {
      try {
        const s = JSON.parse(sess)
        if (s?.plexUser?.id && s?.plexUser?.token) {
          const db = require('./db/database')
          db.seedKnownUser(s.plexUser.id, s.plexUser.username, s.plexUser.thumb, s.plexUser.token)
        }
      } catch { /* malformed session JSON — skip */ }
    }
  } catch (err) {
    logger.warn('Session-token seeding failed:', err.message)
  }

  // On startup: sync library from DB/Plex, then pre-warm caches
  setTimeout(async () => {
    try {
      await plexService.warmCache()
      logger.info('Library synced successfully on startup')
    } catch (err) {
      logger.warn('Startup library sync failed:', err.message)
    }

    // One-shot fulfillment check on startup — catches requests fulfilled while server was down
    try {
      require('./services/requestFulfillment').checkAndNotifyFulfilled('startup')
    } catch (fulfillErr) {
      logger.warn('Startup fulfillment check failed:', fulfillErr.message);
    }

    // Sync Plex.tv watchlists for all known users 10s after library sync
    setTimeout(() => plexService.syncAllUserWatchlists()
      .catch(err => logger.warn('Startup watchlist sync failed:', err.message)),
      10_000
    )

    // Pre-warm recommendation caches 30s after library sync
    setTimeout(() => recommender.warmAllUserCaches().catch(err =>
      logger.warn('Rec pre-warm failed:', err.message)
    ), 30_000)

    // Build shared TMDB candidate pools ~90s after start so first user gets fast results
    setTimeout(() => discoverRecommender.refreshSharedCandidatePools()
      .catch(err => logger.warn('Initial discover pool build failed:', err.message)),
      90_000
    )

    // Cache Tautulli watch history 20s after start so the page serves from the DB
    setTimeout(() => tautulliService.syncWatchHistory()
      .then(n => logger.info(`Watch history synced: ${n} records`))
      .catch(err => logger.warn('Startup watch-history sync failed:', err.message)),
      20_000
    )

    // Warm the public review feed cache 15s after start so the first feed load is instant
    setTimeout(() => reviewFeed.warmFeedCacheJob(), 15_000)

    // Force a full library re-sync ~45s after boot. warmCache above serves the cached
    // library fast but won't re-fetch while it's still fresh, so deletions / rating-key
    // changes wouldn't be pruned until the 6h interval. This reconciles them each boot.
    // The recommendation caches were warmed (~30s) from the pre-prune library, so rebuild
    // them afterwards or Home keeps surfacing pruned (deleted) items.
    setTimeout(() => plexService.resyncAllSections()
      .then(() => {
        logger.info('Startup library re-sync complete')
        recommender.invalidateAllCaches()
        discoverRecommender.invalidateAllCaches()
        return recommender.warmAllUserCaches()
      })
      .catch(err => logger.warn('Startup library re-sync failed:', err.message)),
      45_000
    )
  }, 2000)

  // Refresh shared TMDB candidates every 6 hours
  setInterval(() => discoverRecommender.refreshSharedCandidatePools()
    .catch(err => logger.warn('Discover pool refresh failed:', err.message)),
    6 * 60 * 60 * 1000
  )

  // Keep per-user discover caches warm every 28 min
  setInterval(() => discoverRecommender.warmAllUserDiscoverCaches()
    .catch(err => logger.warn('Discover cache pre-warm failed:', err.message)),
    28 * 60 * 1000
  )

  // Keep rec caches warm every 25 min
  setInterval(() => recommender.warmAllUserCaches().catch(err =>
    logger.warn('Periodic rec pre-warm failed:', err.message)
  ), 25 * 60 * 1000)

  // Sync Plex.tv watchlists every 30 min
  setInterval(() => plexService.syncAllUserWatchlists()
    .catch(err => logger.warn('Periodic watchlist sync failed:', err.message)),
    30 * 60 * 1000
  )

  // Full library re-sync every 6h — reconciles deletions and rating-key changes by
  // pruning cached items Plex no longer has (the per-item WebSocket only adds/updates).
  // Invalidate the recommendation caches afterwards so pruned items stop being served.
  setInterval(() => plexService.resyncAllSections()
    .then(() => {
      recommender.invalidateAllCaches()
      discoverRecommender.invalidateAllCaches()
      // Evaluate monitors against library after sync
      try {
        const monitorMatcher = require('./services/monitorMatcher');
        const monitorNotifier = require('./services/monitorNotifier');
        const { MOVIES_SECTION, TV_SECTION } = require('./services/plex');
        Promise.all([
          plexService.getLibraryItems(MOVIES_SECTION),
          plexService.getLibraryItems(TV_SECTION),
        ])
          .then(([movies, tv]) => {
            const contents = [...movies, ...tv].map(monitorMatcher.buildContentFromLibrary);
            return monitorMatcher.evaluateBatch(contents, 'plex');
          })
          .then(matches => {
            if (matches.length > 0) monitorNotifier.sendMatches(matches, 'plex');
          })
          .catch(err => logger.warn('Post-sync monitor evaluation failed:', err.message));
      } catch (err) {
        logger.warn('Post-sync monitor evaluation failed:', err.message);
      }
    })
    .catch(err => logger.warn('Periodic library re-sync failed:', err.message)),
    6 * 60 * 60 * 1000
  )

  // Refresh cached watch history every 15 min (picks up new plays + in-progress updates)
  setInterval(() => tautulliService.syncWatchHistory()
    .catch(err => logger.warn('Periodic watch-history sync failed:', err.message)),
    15 * 60 * 1000
  )

  // Automation: auto-request from monitored lists. The runner checks every
  // 15 min; each list honors its own sync_interval_hours. First pass ~2 min
  // after boot (library cache is warm by then, so in-library dedup works).
  const autoRequest = require('./services/autoRequest')
  setTimeout(() => autoRequest.runDueLists()
    .catch(err => logger.warn('Auto request sync failed:', err.message)), 2 * 60 * 1000)
  setInterval(() => autoRequest.runDueLists()
    .catch(err => logger.warn('Auto request sync failed:', err.message)),
    15 * 60 * 1000
  )

  // Automation: deletion profiles. Daily, plus a startup evaluation ~5 min after
  // boot (needs library + watch history synced). No-ops with no enabled profiles;
  // only profiles in 'auto' mode ever delete anything.
  const deletionService = require('./services/deletion')
  setTimeout(() => deletionService.runProfiles()
    .catch(err => logger.warn('Deletion profile run failed:', err.message)), 5 * 60 * 1000)
  setInterval(() => deletionService.runProfiles()
    .catch(err => logger.warn('Deletion profile run failed:', err.message)),
    24 * 60 * 60 * 1000
  )

  // Keep the public review feed cache warm (matches its 5-min TTL)
  setInterval(() => reviewFeed.warmFeedCacheJob(), reviewFeed.FEED_CACHE_TTL)

  // Drain the producer/label detail backfill in small throttled batches. Starts ~60s after
  // boot (lets the library warm first) and repeats every 3 min until the backlog is empty.
  setTimeout(() => plexService.backfillItemDetails()
    .catch(err => logger.warn('Detail backfill failed:', err.message)), 60_000)
  setInterval(() => plexService.backfillItemDetails()
    .catch(err => logger.warn('Detail backfill failed:', err.message)),
    3 * 60 * 1000
  )

  // Connect to Plex WebSocket for real-time new-content detection.
  // Mimics how Tautulli receives library.new flags directly from PMS.
  plexService.startWebSocket((ratingKey, sectionId) => {
    plexService.fetchAndUpsertItem(ratingKey, sectionId)
      .then((item) => {
        recommender.invalidateAllCaches();
        discoverRecommender.invalidateAllCaches();
        process.emit('diskovarr:checkFulfilled');
        if (item) {
          try {
            const monitorMatcher = require('./services/monitorMatcher');
            const monitorNotifier = require('./services/monitorNotifier');
            const content = monitorMatcher.buildContentFromLibrary(item);
            monitorMatcher.evaluateContent(content, 'plex').then(matches => {
              if (matches.length > 0) monitorNotifier.sendMatches(matches, 'plex');
            }).catch(err => logger.warn('[plex ws] monitor evaluation failed:', err.message));
          } catch (err) {
            logger.warn('[plex ws] monitor evaluation failed:', err.message);
          }
        }
      })
      .catch(err => logger.warn('[plex ws] fetchAndUpsertItem error:', err.message));
  });
})

// Graceful shutdown: stop accepting connections, halt the notification queue
// loop, and close SQLite so the WAL checkpoints cleanly. Force-exits after 10s
// in case a request or job hangs.
let _shuttingDown = false
function shutdown(signal) {
  if (_shuttingDown) return
  _shuttingDown = true
  console.log(`${signal} received — shutting down gracefully`)
  server.close(() => {
    try { require('./services/notificationService').stop() } catch { /* not started */ }
    try { db.close() } catch { /* already closed */ }
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
