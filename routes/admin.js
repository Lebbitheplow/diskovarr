const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discoverRecommender = require('../services/discoverRecommender');
const { version: APP_VERSION } = require('../package.json');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// ── Update check (GitHub releases, 6h cache) ─────────────────────────────────

let _updateCache = { checkedAt: 0, latestVersion: null };
const UPDATE_CHECK_TTL = 6 * 60 * 60 * 1000;

async function getLatestVersion() {
  if (Date.now() - _updateCache.checkedAt < UPDATE_CHECK_TTL) {
    return _updateCache.latestVersion;
  }
  try {
    const res = await fetch('https://api.github.com/repos/Lebbitheplow/diskovarr/releases/latest', {
      headers: { 'User-Agent': 'diskovarr-update-check' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    _updateCache = { checkedAt: Date.now(), latestVersion: tag || null };
  } catch {
    _updateCache.checkedAt = Date.now(); // suppress retries for TTL window
  }
  return _updateCache.latestVersion;
}

function isNewerVersion(latest, current) {
  if (!latest) return false;
  const [lM, lm, lp] = latest.split('.').map(Number);
  const [cM, cm, cp] = current.split('.').map(Number);
  return lM > cM || (lM === cM && lm > cm) || (lM === cM && lm === cm && lp > cp);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// ── Sync state (in-process — survives as long as server runs) ─────────────────

let autoSyncEnabled = true;
let syncInProgress = false;
let lastSyncError = null;

function getAutoSyncEnabled() { return autoSyncEnabled; }

// Called by server.js before each scheduled sync
function shouldAutoSync() { return autoSyncEnabled && !syncInProgress; }

module.exports.shouldAutoSync = shouldAutoSync;

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.render('admin/login', { error: 'ADMIN_PASSWORD not set in .env' });
  }

  // Timing-safe string comparison to prevent timing attacks
  const a = Buffer.from(password || '');
  const b = Buffer.from(adminPassword);
  const match = a.length === b.length &&
    require('crypto').timingSafeEqual(a, b);

  if (!match) {
    return res.render('admin/login', { error: 'Incorrect password' });
  }

  req.session.isAdmin = true;
  res.redirect('/admin');
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

// ── Main admin page ───────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  const stats = db.getAdminStats();
  const latestVersion = await getLatestVersion();
  res.render('admin/index', {
    stats,
    autoSyncEnabled,
    syncInProgress,
    lastSyncError,
    watchlistMode: db.getAdminWatchlistMode(),
    ownerUserId: db.getOwnerUserId(),
    knownUsers: db.getKnownUsers(),
    connections: db.getConnectionSettings(),
    themeParam: encodeURIComponent(db.getThemeColor()),
    appVersion: APP_VERSION,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, APP_VERSION),
  });
});

// ── API: Status (polled by admin UI) ─────────────────────────────────────────

router.get('/status', requireAdmin, (req, res) => {
  const stats = db.getAdminStats();
  res.json({
    stats, autoSyncEnabled, syncInProgress, lastSyncError,
    watchlistMode: db.getAdminWatchlistMode(),
    discoverEnabled: db.isDiscoverEnabled(),
  });
});

// ── Library sync controls ─────────────────────────────────────────────────────

router.post('/sync/library', requireAdmin, async (req, res) => {
  if (syncInProgress) {
    return res.json({ success: false, message: 'Sync already in progress' });
  }
  syncInProgress = true;
  lastSyncError = null;

  // Run in background — respond immediately
  res.json({ success: true, message: 'Library sync started' });

  try {
    plexService.invalidateCache();
    await plexService.warmCache();
    recommender.invalidateAllCaches();
    discoverRecommender.invalidateAllCaches();
    console.log('[Admin] Manual library sync completed');
  } catch (err) {
    lastSyncError = err.message;
    console.error('[Admin] Library sync error:', err.message);
  } finally {
    syncInProgress = false;
  }
});

router.post('/sync/auto/enable', requireAdmin, (req, res) => {
  autoSyncEnabled = true;
  res.json({ success: true, autoSyncEnabled });
});

router.post('/sync/auto/disable', requireAdmin, (req, res) => {
  autoSyncEnabled = false;
  res.json({ success: true, autoSyncEnabled });
});

// ── Per-user watched sync ─────────────────────────────────────────────────────

router.post('/sync/watched/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  // Find the user's token from active sessions
  const { DatabaseSync } = require('node:sqlite');
  const sessDb = new DatabaseSync(require('path').join(__dirname, '..', 'data', 'sessions.db'));
  const rows = sessDb.prepare('SELECT sess FROM sessions').all();
  sessDb.close();

  let userToken = null;
  for (const row of rows) {
    try {
      const s = JSON.parse(row.sess);
      if (s.plexUser && s.plexUser.id === userId) {
        userToken = s.plexUser.token;
        break;
      }
    } catch {}
  }

  if (!userToken) {
    return res.json({ success: false, message: 'User not found in active sessions. They need to be signed in.' });
  }

  res.json({ success: true, message: 'Watched sync started for user ' + userId });

  try {
    await plexService.syncUserWatched(userId, userToken);
    recommender.invalidateUserCache(userId);
    console.log(`[Admin] Watched sync completed for user ${userId}`);
  } catch (err) {
    console.error(`[Admin] Watched sync error for ${userId}:`, err.message);
  }
});

// ── Theme color ───────────────────────────────────────────────────────────────

router.post('/theme/color', requireAdmin, (req, res) => {
  const { color } = req.body;
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return res.status(400).json({ error: 'Invalid color — must be a 6-digit hex value' });
  }
  db.setThemeColor(color);
  res.json({ success: true, color });
});

router.get('/theme/color', (req, res) => {
  res.json({ color: db.getThemeColor() });
});

// ── Watchlist mode ─────────────────────────────────────────────────────────────

router.get('/settings/watchlist-mode', requireAdmin, (req, res) => {
  res.json({ mode: db.getAdminWatchlistMode() });
});

router.post('/settings/watchlist-mode', requireAdmin, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'watchlist' && mode !== 'playlist') {
    return res.status(400).json({ error: 'Invalid mode — must be "watchlist" or "playlist"' });
  }
  db.setAdminWatchlistMode(mode);
  res.json({ success: true, mode });
});

router.post('/settings/owner-user', requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId || !/^\d+$/.test(String(userId))) {
    return res.status(400).json({ error: 'Invalid userId' });
  }
  db.setOwnerUserId(userId);
  res.json({ success: true, userId });
});

// ── Connections & external service config ────────────────────────────────────

const CONNECTION_KEYS = [
  'plex_url', 'plex_token',
  'tautulli_url', 'tautulli_api_key',
  'tmdb_api_key', 'discover_enabled',
  'overseerr_url', 'overseerr_api_key', 'overseerr_enabled',
  'radarr_url', 'radarr_api_key', 'radarr_enabled', 'radarr_quality_profile_id',
  'sonarr_url', 'sonarr_api_key', 'sonarr_enabled', 'sonarr_quality_profile_id',
];

router.post('/connections/save', requireAdmin, (req, res) => {
  const body = req.body;
  for (const key of CONNECTION_KEYS) {
    if (key in body) {
      // Checkboxes send '1' when checked, absent when unchecked
      db.setSetting(key, body[key] || '0');
    }
  }
  // Invalidate discover cache when settings change
  discoverRecommender.invalidateAllCaches();
  res.json({ success: true });
});

router.get('/connections/reveal', requireAdmin, (req, res) => {
  res.json({
    plexToken:       db.getSetting('plex_token', '')        || process.env.PLEX_TOKEN        || '',
    tautulliApiKey:  db.getSetting('tautulli_api_key', '')  || process.env.TAUTULLI_API_KEY  || '',
    tmdbApiKey:      db.getSetting('tmdb_api_key', '')      || '',
    overseerrApiKey: db.getSetting('overseerr_api_key', '') || '',
    radarrApiKey:    db.getSetting('radarr_api_key', '')    || '',
    sonarrApiKey:    db.getSetting('sonarr_api_key', '')    || '',
  });
});

router.post('/connections/test/tmdb', requireAdmin, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ ok: false, message: 'No API key provided' });
  // Temporarily test the provided key without saving
  const origKey = db.getSetting('tmdb_api_key', null);
  db.setSetting('tmdb_api_key', apiKey);
  const tmdb = require('../services/tmdb');
  const result = await tmdb.testApiKey();
  if (!result.ok) db.setSetting('tmdb_api_key', origKey || '');
  res.json(result);
});

router.post('/connections/test/overseerr', requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url || !apiKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v1/settings/public`, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Overseerr returned ${r.status}` });
    const data = await r.json();
    res.json({ ok: true, message: `Connected to Overseerr (${data.applicationTitle || 'OK'})` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/connections/test/radarr', requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url || !apiKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v3/system/status`, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Radarr returned ${r.status}` });
    const data = await r.json();
    res.json({ ok: true, message: `Connected to Radarr v${data.version || '?'}` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/connections/test/sonarr', requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url || !apiKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v3/system/status`, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Sonarr returned ${r.status}` });
    const data = await r.json();
    res.json({ ok: true, message: `Connected to Sonarr v${data.version || '?'}` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.get('/connections/quality-profiles/:service', requireAdmin, async (req, res) => {
  const { service } = req.params;
  if (!['radarr', 'sonarr'].includes(service)) return res.status(400).json({ ok: false, message: 'Invalid service' });
  const url = db.getSetting(`${service}_url`, '');
  const apiKey = db.getSetting(`${service}_api_key`, '');
  if (!url || !apiKey) return res.json({ ok: false, message: 'Service not configured — save URL and API key first' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v3/qualityprofile`, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `${service} returned ${r.status}` });
    const profiles = await r.json();
    res.json({ ok: true, profiles: profiles.map(p => ({ id: p.id, name: p.name })) });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/connections/test/tautulli', requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url || !apiKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const query = new URLSearchParams({ apikey: apiKey, cmd: 'get_server_info' });
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v2?${query}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Tautulli returned ${r.status}` });
    const data = await r.json();
    if (data.response?.result !== 'success') {
      return res.json({ ok: false, message: data.response?.message || 'Tautulli API error' });
    }
    res.json({ ok: true, message: 'Connected to Tautulli' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/connections/test/plex', requireAdmin, async (req, res) => {
  const { url, token } = req.body;
  if (!url || !token) return res.json({ ok: false, message: 'URL and token required' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/?X-Plex-Token=${token}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Plex returned ${r.status}` });
    const data = await r.json();
    const name = data?.MediaContainer?.friendlyName || 'Plex';
    res.json({ ok: true, message: `Connected to ${name}` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── Cache operations ──────────────────────────────────────────────────────────

router.post('/cache/clear/recommendations', requireAdmin, (req, res) => {
  recommender.invalidateAllCaches();
  res.json({ success: true, message: 'Recommendation caches cleared for all users' });
});

router.post('/cache/clear/watched/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  db.clearUserWatched(userId);
  recommender.invalidateUserCache(userId);
  res.json({ success: true, message: `Watched cache cleared for user ${userId}` });
});

router.post('/cache/clear/watched', requireAdmin, (req, res) => {
  db.clearAllUserWatched();
  recommender.invalidateAllCaches();
  res.json({ success: true, message: 'All watched caches cleared' });
});

router.post('/cache/clear/dismissals/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  db.clearUserDismissals(userId);
  recommender.invalidateUserCache(userId);
  res.json({ success: true, message: `Dismissals cleared for user ${userId}` });
});

router.post('/cache/clear/dismissals', requireAdmin, (req, res) => {
  db.clearUserDismissals(null);
  recommender.invalidateAllCaches();
  res.json({ success: true, message: 'All dismissals cleared' });
});

module.exports = router;
module.exports.shouldAutoSync = shouldAutoSync;
