require('dotenv').config()
const express = require('express')
const session = require('express-session')
const path = require('path')
const fs = require('fs')

const PORT = process.env.PORT || 3232
const dataDir = path.join(__dirname, 'data')
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
app.use(express.static(path.join(__dirname, 'public')))

app.use((req, res, next) => {
  req.appUrl = req.protocol + '://' + req.get('host')
  if (req.path.startsWith('/auth/') || req.path === '/callback') {
    console.log(`[${req.method} ${req.path}] Cookie: ${req.headers.cookie || 'NONE'}`)
  }
  next()
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use(session({
  name: 'diskovarr.react.sid',
  store: new SQLiteStore({ dir: dataDir, db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is not set'); })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}))

// Public API routes
app.use('/api/login', require('./routes/login'))

// API routes
app.use('/auth', require('./routes/auth'))
app.use('/api/v1', require('./routes/overseerrShim'))
app.use('/api', require('./routes/api'))
app.use('/admin', require('./routes/admin'))
app.use('/admin/riven', require('./routes/riven'))

// Dynamic theme/icon routes (need Express)
const db = require('./db/database')
const APP_VERSION = require('./package.json').version
function bgGradientCss() {
  const color = db.getThemeColor()
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  return `body{background-image:radial-gradient(ellipse 50% 50% at 50% 0%,rgba(${r},${g},${b},0.28) 0%,transparent 100%),radial-gradient(ellipse 60% 40% at 50% 100%,rgba(${r},${g},${b},0.12) 0%,transparent 100%);background-attachment:fixed;}`
}
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

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Diskovarr server running on port ${PORT}`)

  const discoverRecommender = require('./services/discoverRecommender')
  const recommender = require('./services/recommender')
  const plexService = require('./services/plex')
  const logger = require('./services/logger')

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
      } catch {}
    }
  } catch {}

  // On startup: sync library from DB/Plex, then pre-warm caches
  setTimeout(async () => {
    try {
      await plexService.warmCache()
      logger.info('Library synced successfully on startup')
    } catch (err) {
      logger.warn('Startup library sync failed:', err.message)
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
})
