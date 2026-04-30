const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discoverRecommender = require('../services/discoverRecommender');
const logger = require('../services/logger');
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

let autoSyncEnabled = db.getSetting('auto_sync_enabled', '1') === '1';
let syncInProgress = false;
let lastSyncError = null;

function getAutoSyncEnabled() { return autoSyncEnabled; }

// Called by server.js before each scheduled sync
function shouldAutoSync() { return autoSyncEnabled && !syncInProgress; }

module.exports.shouldAutoSync = shouldAutoSync;

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(require('path').resolve(__dirname, '../../dist/index.html'));
});

router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not set in .env' });
  }

  const a = Buffer.from(password || '');
  const b = Buffer.from(adminPassword);
  const match = a.length === b.length &&
    require('crypto').timingSafeEqual(a, b);

  if (!match) {
    logger.warn(`Admin login failed: incorrect password from ip=${req.ip}`);
    return res.status(401).json({ error: 'Incorrect password' });
  }

  logger.info(`Admin login success: ip=${req.ip}`);
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  if (req.session) req.session.isAdmin = false;
  res.json({ ok: true });
});

// ── Users JSON endpoint (for in-place pagination) ────────────────────────────

router.get('/users', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = [10, 25, 50].includes(parseInt(req.query.perPage)) ? parseInt(req.query.perPage) : 10;
  const allUsers = db.getAdminStats().users;
  const total = allUsers.length;
  const users = allUsers.slice((page - 1) * perPage, page * perPage);
  res.json({ users, page, perPage, total, totalPages: Math.ceil(total / perPage) });
});

// ── Main admin page — serve the React SPA ────────────────────────────────────

router.get('/', requireAdmin, (req, res) => {
  res.sendFile(require('path').resolve(__dirname, '../../dist/index.html'));
});

// ── API: Status (polled by admin UI) ─────────────────────────────────────────

router.get('/status', requireAdmin, (req, res) => {
  const stats = db.getAdminStats();
  const compatApp = db.listApiApps().find(a => a.type === 'compat');
  res.json({
    stats, autoSyncEnabled, syncInProgress, lastSyncError,
    watchlistMode: db.getAdminWatchlistMode(),
    discoverEnabled: db.isDiscoverEnabled(),
    individualSeasonsEnabled: db.isIndividualSeasonsEnabled(),
    autoRequestMovies: db.getSetting('auto_request_watchlist_movies', 'false') === 'true',
    autoRequestTv: db.getSetting('auto_request_watchlist_tv', 'false') === 'true',
    discordAgent: (() => { try { return JSON.parse(db.getSetting('discord_agent', 'null')); } catch { return null; } })(),
    pushoverAgent: (() => { try { return JSON.parse(db.getSetting('pushover_agent', 'null')); } catch { return null; } })(),
    verboseLogging: db.getSetting('verbose_logging_enabled', '0') === '1',
    ownerUserId: db.getOwnerUserId() || '',
    appPublicUrl: db.getSetting('app_public_url', ''),
    hasApiKey: !!db.getSetting('diskovarr_api_key', ''),
    compatEnabled: !!(compatApp && compatApp.enabled),
    compatApiKey: compatApp?.api_key || null,
    themeColor: db.getThemeColor(),
    defaultLandingPage: db.getLandingPage(),
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
  db.setSetting('auto_sync_enabled', '1');
  res.json({ success: true, autoSyncEnabled });
});

router.post('/sync/auto/disable', requireAdmin, (req, res) => {
  autoSyncEnabled = false;
  db.setSetting('auto_sync_enabled', '0');
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

// ── Verbose logging toggle ────────────────────────────────────────────────────

router.post('/settings/logging', requireAdmin, (req, res) => {
  const enabled = req.body.enabled === true || req.body.enabled === 'true';
  db.setSetting('verbose_logging_enabled', enabled ? '1' : '0');
  logger.setVerbose(enabled);
  logger.info(`Verbose logging ${enabled ? 'enabled' : 'disabled'} by admin`);
  res.json({ success: true, enabled });
});

// ── Request limits ────────────────────────────────────────────────────────────

router.get('/request-limits/global', requireAdmin, (req, res) => {
  res.json(db.getGlobalRequestLimits());
});

router.post('/request-limits/global', requireAdmin, (req, res) => {
  const { enabled, movieLimit, movieWindowDays, seasonLimit, seasonWindowDays } = req.body;
  db.setGlobalRequestLimits({
    enabled: enabled === '1' || enabled === true,
    movieLimit: parseInt(movieLimit) || 0,
    movieWindowDays: Math.max(1, parseInt(movieWindowDays) || 7),
    seasonLimit: parseInt(seasonLimit) || 0,
    seasonWindowDays: Math.max(1, parseInt(seasonWindowDays) || 7),
  });
  res.json({ success: true });
});

router.post('/request-limits/user', requireAdmin, (req, res) => {
  const { userId, overrideEnabled, movieLimit, movieWindowDays, seasonLimit, seasonWindowDays } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  db.setUserRequestLimitOverride(userId, {
    overrideEnabled: overrideEnabled === '1' || overrideEnabled === true,
    movieLimit: parseInt(movieLimit) || 0,
    movieWindowDays: Math.max(1, parseInt(movieWindowDays) || 7),
    seasonLimit: parseInt(seasonLimit) || 0,
    seasonWindowDays: Math.max(1, parseInt(seasonWindowDays) || 7),
  });
  res.json({ success: true });
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
  'radarr_url', 'radarr_api_key', 'radarr_enabled', 'radarr_quality_profile_id', 'radarr_quality_profile_name',
  'sonarr_url', 'sonarr_api_key', 'sonarr_enabled', 'sonarr_quality_profile_id', 'sonarr_quality_profile_name',
  'riven_url', 'riven_api_key', 'riven_rdkey', 'riven_enabled', 'dumb_request_mode',
  'default_request_service',
  'individual_seasons_enabled',
  'direct_request_access',
  'app_public_url',
  'landing_page',
];

router.get('/connections/settings', requireAdmin, (req, res) => {
  const overseerrUrl = db.getSetting('overseerr_url', '');
  const overseerrKey = db.getSetting('overseerr_api_key', '');
  const radarrUrl    = db.getSetting('radarr_url', '');
  const radarrKey    = db.getSetting('radarr_api_key', '');
  const sonarrUrl    = db.getSetting('sonarr_url', '');
  const sonarrKey    = db.getSetting('sonarr_api_key', '');
  const rivenUrl     = db.getSetting('riven_url', '');
  res.json({
    plex_url:                    db.getSetting('plex_url', ''),
    tautulli_url:                db.getSetting('tautulli_url', ''),
    discover_enabled:            db.getSetting('discover_enabled', '1') === '1',
    overseerr_url:               overseerrUrl,
    overseerr_enabled:           !!(overseerrUrl && overseerrKey) && db.getSetting('overseerr_enabled', '0') === '1',
    radarr_url:                  radarrUrl,
    radarr_enabled:              !!(radarrUrl && radarrKey) && db.getSetting('radarr_enabled', '0') === '1',
    radarr_quality_profile_id:   db.getSetting('radarr_quality_profile_id', ''),
    radarr_quality_profile_name: db.getSetting('radarr_quality_profile_name', ''),
    sonarr_url:                  sonarrUrl,
    sonarr_enabled:              !!(sonarrUrl && sonarrKey) && db.getSetting('sonarr_enabled', '0') === '1',
    sonarr_quality_profile_id:   db.getSetting('sonarr_quality_profile_id', ''),
    sonarr_quality_profile_name: db.getSetting('sonarr_quality_profile_name', ''),
    riven_url:                   rivenUrl,
    riven_enabled:               !!rivenUrl && db.getSetting('riven_enabled', '0') === '1',
    dumb_request_mode:           db.getSetting('dumb_request_mode', 'pull'),
    default_request_service:     db.getSetting('default_request_service', 'overseerr'),
    direct_request_access:       db.getSetting('direct_request_access', '0'),
  });
});

router.post('/connections/save', requireAdmin, (req, res) => {
  const body = req.body;
  const BOOL_KEYS = new Set(['discover_enabled','overseerr_enabled','radarr_enabled','sonarr_enabled','riven_enabled','individual_seasons_enabled','direct_request_access']);
  for (const key of CONNECTION_KEYS) {
    if (key in body) {
      // Checkboxes send '1' when checked, absent when unchecked — only default to '0' for boolean keys
      db.setSetting(key, BOOL_KEYS.has(key) ? (body[key] || '0') : (body[key] ?? ''));
    }
  }
  // Invalidate discover cache when settings change
  discoverRecommender.invalidateAllCaches();
  res.json({ success: true });
});

router.post('/settings/generate-api-key', requireAdmin, (req, res) => {
  const { randomBytes } = require('crypto');
  const key = randomBytes(32).toString('hex');
  db.setSetting('diskovarr_api_key', key);
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
    diskovarrApiKey: db.getSetting('diskovarr_api_key', '') || '',
    agregarrApiKey:  (() => { const a = db.listApiApps().find(x => x.type === 'agregarr'); return a ? a.api_key : ''; })(),
    dumbApiKey:      (() => { const a = db.listApiApps().find(x => x.type === 'dumb');      return a ? a.api_key : ''; })(),
    compatApiKey:    (() => { const a = db.listApiApps().find(x => x.type === 'compat');    return a ? a.api_key : ''; })(),
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
  const effectiveKey = apiKey || db.getSetting('radarr_api_key', '');
  if (!url || !effectiveKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v3/system/status`, {
      headers: { 'X-Api-Key': effectiveKey, 'Accept': 'application/json' },
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
  const effectiveKey = apiKey || db.getSetting('sonarr_api_key', '');
  if (!url || !effectiveKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v3/system/status`, {
      headers: { 'X-Api-Key': effectiveKey, 'Accept': 'application/json' },
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
  const url = req.query.url || db.getSetting(`${service}_url`, '');
  const apiKey = req.query.apiKey || db.getSetting(`${service}_api_key`, '');
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

// ── Plex OAuth ────────────────────────────────────────────────────────────────
// Generates a Plex PIN and returns the auth popup URL. No auth required so it
// works before Plex is configured (first-time setup flow).
router.get('/plex/auth-url', requireAdmin, async (req, res) => {
  try {
    const clientId = db.getSetting('plex_oauth_client_id', null) || (() => {
      const id = require('crypto').randomUUID();
      db.setSetting('plex_oauth_client_id', id);
      return id;
    })();
    const r = await fetch('https://plex.tv/api/v2/pins', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Plex-Product': 'Diskovarr',
        'X-Plex-Client-Identifier': clientId,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'strong=true',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(502).json({ error: `Plex returned ${r.status}` });
    const { id, code } = await r.json();
    const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(code)}&context%5Bdevice%5D%5Bproduct%5D=Diskovarr`;
    res.json({ authUrl, pinId: id, clientId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Polls plex.tv for whether the PIN was approved. On success saves the token.
router.get('/plex/check-pin/:pinId', requireAdmin, async (req, res) => {
  try {
    const clientId = db.getSetting('plex_oauth_client_id', null);
    if (!clientId) return res.status(400).json({ error: 'No OAuth session in progress' });
    const r = await fetch(`https://plex.tv/api/v2/pins/${encodeURIComponent(req.params.pinId)}`, {
      headers: {
        'Accept': 'application/json',
        'X-Plex-Client-Identifier': clientId,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(502).json({ error: `Plex returned ${r.status}` });
    const { authToken } = await r.json();
    if (authToken) {
      db.setSetting('plex_token', authToken);
      plexService.invalidateCache();
    }
    res.json({ authorized: !!authToken, token: authToken || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ── Request queue endpoints ───────────────────────────────────────────────────

router.get('/requests', requireAdmin, (req, res) => {
  const { status = 'all', page = '1', limit: limitParam = '20' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(limitParam) || 20));
  const pageNum = Math.max(1, parseInt(page) || 1);
  const offset = (pageNum - 1) * limit;
  const { rows, total } = db.getAllRequests(limit, offset, status);

  // Enrich with TMDB data and availability status
  const libraryTmdbIds = db.getLibraryTmdbIds();
  const enriched = rows.map(r => {
    const cached = db.getTmdbCache(r.tmdb_id, r.media_type);
    const isAvailable = libraryTmdbIds.has(String(r.tmdb_id));
    let displayStatus = r.status;
    if (r.status === 'approved') displayStatus = isAvailable ? 'available' : 'requested';
    return {
      ...r,
      posterUrl: r.poster_url || cached?.posterUrl || null,
      year: cached?.releaseDate ? parseInt(cached.releaseDate.slice(0, 4)) || null : null,
      contentRating: cached?.contentRating || null,
      displayStatus,
    };
  });

  res.json({
    requests: enriched,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limit),
  });
});

router.put('/requests/:id', requireAdmin, (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const { service, seasons } = req.body;
  const seasonsJson = Array.isArray(seasons) && seasons.length > 0 ? JSON.stringify(seasons.map(Number)) : null;
  const seasonsCount = Array.isArray(seasons) && seasons.length > 0 ? seasons.length : 1;
  db.updateRequest(request.id, {
    service: service || request.service,
    seasonsJson,
    seasonsCount,
  });
  res.json({ success: true, request: db.getRequestById(request.id) });
});

router.post('/requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { submitRequestToService } = require('./api');
    const request = db.getRequestById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const storedSeasons = request.seasons_json ? JSON.parse(request.seasons_json) : null;
    await submitRequestToService({
      tmdbId: request.tmdb_id,
      mediaType: request.media_type,
      title: request.title,
      service: request.service,
      seasons: storedSeasons,
    });

    db.updateRequestStatus(request.id, 'approved', null);
    logger.info(`Request approved by admin: id=${request.id} tmdbId=${request.tmdb_id} title="${request.title}"`);
    res.json({ success: true, request: db.getRequestById(request.id) });
  } catch (err) {
    console.error('admin approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/requests/:id/deny', requireAdmin, (req, res) => {
  const { note } = req.body;
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  db.updateRequestStatus(request.id, 'denied', note || null);
  logger.info(`Request denied by admin: id=${request.id} title="${request.title}"`);
  res.json({ success: true, request: db.getRequestById(request.id) });
});

router.delete('/requests/:id', requireAdmin, (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  db.deleteRequest(request.id);
  res.json({ success: true });
});

// ── Per-user request cleanup ──────────────────────────────────────────────────

router.delete('/users/:userId/requests', requireAdmin, (req, res) => {
  db.deleteRequestsByUser(req.params.userId);
  logger.info(`All requests deleted for user=${req.params.userId} by admin`);
  res.json({ success: true });
});

// ── User settings endpoints ───────────────────────────────────────────────────

router.get('/users/:userId/settings', requireAdmin, (req, res) => {
  const settings = db.getUserSettings(req.params.userId);
  const notificationPrefs = db.getUserNotificationPrefs(req.params.userId);
  res.json({ ...settings, notificationPrefs });
});

router.post('/users/:userId/settings', requireAdmin, (req, res) => {
  const {
    movieLimit,
    seasonLimit,
    movieWindowDays,
    tvWindowDays,
    overrideGlobal,
    auto_approve_movies,
    auto_approve_tv,
    is_admin,
    region,
    language,
    auto_request_movies,
    auto_request_tv,
    landing_page,
    notificationPrefs,
  } = req.body;
  try {
    db.saveUserSettings(req.params.userId, {
      movieLimit: parseInt(movieLimit) || 0,
      seasonLimit: parseInt(seasonLimit) || 0,
      movieWindowDays: Math.max(1, parseInt(movieWindowDays) || 7),
      tvWindowDays: Math.max(1, parseInt(tvWindowDays) || 7),
      overrideGlobal: overrideGlobal === true || overrideGlobal === '1',
      auto_approve_movies: auto_approve_movies === null || auto_approve_movies === 'null' ? null
        : (auto_approve_movies === true || auto_approve_movies === '1'),
      auto_approve_tv: auto_approve_tv === null || auto_approve_tv === 'null' ? null
        : (auto_approve_tv === true || auto_approve_tv === '1'),
      is_admin: is_admin === true || is_admin === '1',
      region: region || null,
      language: language || null,
      auto_request_movies: auto_request_movies === true || auto_request_movies === '1',
      auto_request_tv: auto_request_tv === true || auto_request_tv === '1',
      landing_page: landing_page || null,
    });
    if (notificationPrefs && typeof notificationPrefs === 'object') {
      db.setUserNotificationPrefs(req.params.userId, {
        notify_approved:      notificationPrefs.notify_approved      !== false,
        notify_denied:        notificationPrefs.notify_denied        !== false,
        notify_available:     notificationPrefs.notify_available     !== false,
        notify_pending:       notificationPrefs.notify_pending       !== false,
        notify_auto_approved: notificationPrefs.notify_auto_approved !== false,
        notify_process_failed: notificationPrefs.notify_process_failed !== false,
        notify_issue_new:     notificationPrefs.notify_issue_new     !== false,
        notify_issue_update:  notificationPrefs.notify_issue_update  !== false,
        notify_issue_comment: notificationPrefs.notify_issue_comment !== false,
        discord_user_id:      notificationPrefs.discord_user_id      || null,
        discord_enabled:      !!notificationPrefs.discord_enabled,
        discord_webhook:      notificationPrefs.discord_webhook      || null,
        pushover_user_key:    notificationPrefs.pushover_user_key    || null,
        pushover_enabled:     !!notificationPrefs.pushover_enabled,
        pushover_application_token: notificationPrefs.pushover_application_token || null,
        pushover_sound:       notificationPrefs.pushover_sound       || null,
        telegram_chat_id:     notificationPrefs.telegram_chat_id     || null,
        telegram_message_thread_id: notificationPrefs.telegram_message_thread_id || null,
        telegram_send_silently: !!notificationPrefs.telegram_send_silently,
        telegram_enabled:     !!notificationPrefs.telegram_enabled,
        pushbullet_access_token: notificationPrefs.pushbullet_access_token || null,
        pushbullet_enabled:   !!notificationPrefs.pushbullet_enabled,
        email_enabled:        !!notificationPrefs.email_enabled,
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk user settings ────────────────────────────────────────────────────────

router.post('/users/bulk-settings', requireAdmin, async (req, res) => {
  try {
    const { userIds, overrideGlobal, movieLimit, movieWindowDays, seasonLimit, tvWindowDays,
            auto_approve_movies, auto_approve_tv, is_admin } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds must be a non-empty array' });
    }
    for (const userId of userIds) {
      const current = db.getUserSettings(userId);
      const merged = {
        movieLimit:       overrideGlobal === 'enable'  ? (movieLimit        !== undefined ? Number(movieLimit) || 0        : current.movieLimit)       : current.movieLimit,
        movieWindowDays:  overrideGlobal === 'enable'  ? (movieWindowDays   !== undefined ? Number(movieWindowDays) || 7   : current.movieWindowDays)  : current.movieWindowDays,
        seasonLimit:      overrideGlobal === 'enable'  ? (seasonLimit       !== undefined ? Number(seasonLimit) || 0       : current.seasonLimit)      : current.seasonLimit,
        tvWindowDays:     overrideGlobal === 'enable'  ? (tvWindowDays      !== undefined ? Number(tvWindowDays) || 7      : current.tvWindowDays)     : current.tvWindowDays,
        overrideGlobal:   overrideGlobal === 'enable'  ? true  : overrideGlobal === 'disable' ? false : current.overrideGlobal,
        auto_approve_movies: auto_approve_movies === 'enable'  ? true
                           : auto_approve_movies === 'disable' ? false
                           : auto_approve_movies === 'clear'   ? null
                           : current.auto_approve_movies,
        auto_approve_tv:     auto_approve_tv    === 'enable'  ? true
                           : auto_approve_tv    === 'disable' ? false
                           : auto_approve_tv    === 'clear'   ? null
                           : current.auto_approve_tv,
        is_admin:         is_admin === 'grant'  ? true  : is_admin === 'revoke' ? false : current.is_admin,
        region:           current.region,
        language:         current.language,
        auto_request_movies: current.auto_request_movies,
        auto_request_tv:     current.auto_request_tv,
      };
      db.saveUserSettings(userId, merged);
    }
    res.json({ success: true, updated: userIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Global auto-approve ───────────────────────────────────────────────────────

router.post('/settings/auto-approve', requireAdmin, (req, res) => {
  const { movies, tv } = req.body;
  if (movies !== undefined) db.setSetting('auto_approve_movies', movies ? '1' : '0');
  if (tv !== undefined) db.setSetting('auto_approve_tv', tv ? '1' : '0');
  res.json({ success: true });
});

router.get('/settings/auto-approve', requireAdmin, (req, res) => {
  res.json({
    movies: db.getSetting('auto_approve_movies', '1') === '1',
    tv: db.getSetting('auto_approve_tv', '1') === '1',
  });
});

// ── Auto-request watchlist ────────────────────────────────────────────────────

router.post('/settings/auto-request', requireAdmin, (req, res) => {
  const { type, enabled } = req.body;
  if (!['movies', 'tv'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const key = type === 'movies' ? 'auto_request_watchlist_movies' : 'auto_request_watchlist_tv';
  db.setSetting(key, enabled ? 'true' : 'false');
  res.json({ success: true });
});

// ── Discord avatar upload ─────────────────────────────────────────────────────

router.post('/settings/discord-avatar', requireAdmin, (req, res) => {
  const { imageDataUri, clear } = req.body;
  if (clear) {
    db.setSetting('discord_avatar_data_uri', null);
    return res.json({ success: true, cleared: true });
  }
  if (!imageDataUri || typeof imageDataUri !== 'string') {
    return res.status(400).json({ error: 'imageDataUri required' });
  }
  // Validate it's an image data URI (png, jpeg, or gif)
  const match = imageDataUri.match(/^data:(image\/(?:png|jpeg|gif));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Must be a PNG, JPG, or GIF image' });
  const bytes = Buffer.byteLength(match[2], 'base64');
  if (bytes > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image exceeds 2 MB limit' });
  db.setSetting('discord_avatar_data_uri', imageDataUri);
  res.json({ success: true });
});

// ── Notification agent settings ───────────────────────────────────────────────

router.post('/settings/discord', requireAdmin, async (req, res) => {
  const { enabled, mode, webhookUrl, botToken, botUsername, botAvatarUrl, publicUrl,
          notificationRoleId, enableMentions, embedPoster, webhookEmbedPoster, botEmbedPoster,
          notificationTypes, webhookEnabled, botEnabled, webhookNotificationTypes,
          botNotificationTypes, inviteLink } = req.body;

  // Support both new schema (webhookEnabled/botEnabled) and old schema (mode)
  const usingNewSchema = webhookEnabled !== undefined || botEnabled !== undefined;

  const config = {
    enabled: !!enabled,
    webhookEnabled: usingNewSchema ? !!webhookEnabled : (mode !== 'bot' && !!enabled),
    botEnabled: usingNewSchema ? !!botEnabled : (mode === 'bot' && !!enabled),
    // Keep mode for backward compat with other code reading config
    mode: usingNewSchema ? (botEnabled ? 'bot' : 'webhook') : (mode === 'bot' ? 'bot' : 'webhook'),
    webhookUrl: webhookUrl || null,
    botToken: botToken || null,
    botUsername: botUsername || null,
    botAvatarUrl: botAvatarUrl || null,
    publicUrl: publicUrl || null,
    notificationRoleId: notificationRoleId || null,
    enableMentions: !!enableMentions,
    embedPoster: !!embedPoster, // keep for backward compat with old configs
    webhookEmbedPoster: webhookEmbedPoster !== undefined ? !!webhookEmbedPoster : !!embedPoster,
    botEmbedPoster: botEmbedPoster !== undefined ? !!botEmbedPoster : !!embedPoster,
    // New per-mode notification types; fall back to shared notificationTypes for old clients
    webhookNotificationTypes: webhookNotificationTypes || notificationTypes || [],
    botNotificationTypes: botNotificationTypes || notificationTypes || [],
    // Keep legacy field for old code reading it
    notificationTypes: notificationTypes || webhookNotificationTypes || [],
    inviteLink: inviteLink || null,
  };
  db.setSetting('discord_agent', JSON.stringify(config));
  // If bot is enabled, update the bot's avatar asynchronously
  if (config.botEnabled && config.botToken && !config.botAvatarUrl) {
    const discordAgent = require('../services/discordAgent');
    const accentHex = db.getThemeColor() || 'e5a00d';
    discordAgent.updateBotAvatar(config.botToken, accentHex).catch(() => {});
  }
  res.json({ success: true });
});

router.post('/settings/discord/test', requireAdmin, async (req, res) => {
  try {
    const { mode, webhookUrl, botToken, discordUserId, botUsername } = req.body;
    const discordAgent = require('../services/discordAgent');
    await discordAgent.sendTest({ mode, webhookUrl, botToken, discordUserId, botUsername });
    res.json({ ok: true, message: mode === 'bot' ? 'Test DM sent via bot' : 'Test message sent to Discord' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/settings/pushover', requireAdmin, (req, res) => {
  const { enabled, appToken, userKey, sound, embedPoster, notificationTypes } = req.body;
  const config = { enabled: !!enabled, appToken, userKey, sound, embedPoster: !!embedPoster, notificationTypes: notificationTypes || [] };
  db.setSetting('pushover_agent', JSON.stringify(config));
  res.json({ success: true });
});


router.post('/settings/pushover/test', requireAdmin, async (req, res) => {
  try {
    const { appToken, userKey } = req.body;
    if (!appToken || !userKey) return res.json({ ok: false, message: 'App token and user key required' });
    const pushoverAgent = require('../services/pushoverAgent');
    await pushoverAgent.sendTest(appToken, userKey);
    res.json({ ok: true, message: 'Test message sent via Pushover' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── New notification agent routes ─────────────────────────────────────────────

// Helper: get agent config or return empty defaults
function getAgentConfig(agentKey) {
  try {
    return JSON.parse(db.getSetting(agentKey, 'null'));
  } catch {
    return {};
  }
}

// ── Webhook ──
router.get('/settings/webhook', requireAdmin, (req, res) => {
  res.json(getAgentConfig('webhook_agent'));
});

router.post('/settings/webhook', requireAdmin, (req, res) => {
  const { enabled, webhookUrl, jsonPayload, authHeader, customHeaders, supportVariables, embedPoster, notificationTypes } = req.body;
  const config = {
    enabled: !!enabled,
    webhookUrl: webhookUrl || '',
    jsonPayload: jsonPayload || '',
    authHeader: authHeader || '',
    customHeaders: customHeaders || [],
    supportVariables: !!supportVariables,
    embedPoster: !!embedPoster,
    notificationTypes: notificationTypes || [],
  };
  db.setSetting('webhook_agent', JSON.stringify(config));
  res.json({ success: true });
});

router.post('/settings/webhook/test', requireAdmin, async (req, res) => {
  try {
    const webhookAgent = require('../services/webhookAgent');
    await webhookAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via webhook' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── Slack ──
router.get('/settings/slack', requireAdmin, (req, res) => {
  res.json(getAgentConfig('slack_agent'));
});

router.post('/settings/slack', requireAdmin, (req, res) => {
  const { enabled, webhookUrl, embedPoster, notificationTypes } = req.body;
  db.setSetting('slack_agent', JSON.stringify({
    enabled: !!enabled,
    webhookUrl: webhookUrl || '',
    embedPoster: !!embedPoster,
    notificationTypes: notificationTypes || [],
  }));
  res.json({ success: true });
});

router.post('/settings/slack/test', requireAdmin, async (req, res) => {
  try {
    const slackAgent = require('../services/slackAgent');
    await slackAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via Slack' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── Gotify ──
router.get('/settings/gotify', requireAdmin, (req, res) => {
  res.json(getAgentConfig('gotify_agent'));
});

router.post('/settings/gotify', requireAdmin, (req, res) => {
  const { enabled, url, token, priority, notificationTypes } = req.body;
  db.setSetting('gotify_agent', JSON.stringify({
    enabled: !!enabled,
    url: url || '',
    token: token || '',
    priority: priority ?? 0,
    notificationTypes: notificationTypes || [],
  }));
  res.json({ success: true });
});

router.post('/settings/gotify/test', requireAdmin, async (req, res) => {
  try {
    const gotifyAgent = require('../services/gotifyAgent');
    await gotifyAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via Gotify' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── ntfy ──
router.get('/settings/ntfy', requireAdmin, (req, res) => {
  res.json(getAgentConfig('ntfy_agent'));
});

router.post('/settings/ntfy', requireAdmin, (req, res) => {
  const { enabled, url, topic, authMethod, token, username, password, priority, embedPoster, notificationTypes } = req.body;
  db.setSetting('ntfy_agent', JSON.stringify({
    enabled: !!enabled,
    url: url || '',
    topic: topic || '',
    authMethod: authMethod || 'none',
    token: token || '',
    username: username || '',
    password: password || '',
    priority: priority ?? 3,
    embedPoster: !!embedPoster,
    notificationTypes: notificationTypes || [],
  }));
  res.json({ success: true });
});

router.post('/settings/ntfy/test', requireAdmin, async (req, res) => {
  try {
    const ntfyAgent = require('../services/ntfyAgent');
    await ntfyAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via ntfy' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── Telegram ──
router.get('/settings/telegram', requireAdmin, (req, res) => {
  res.json(getAgentConfig('telegram_agent'));
});

router.post('/settings/telegram', requireAdmin, (req, res) => {
  const { enabled, botAPI, chatId, messageThreadId, sendSilently, embedPoster, notificationTypes } = req.body;
  db.setSetting('telegram_agent', JSON.stringify({
    enabled: !!enabled,
    botAPI: botAPI || '',
    chatId: chatId || '',
    messageThreadId: messageThreadId || '',
    sendSilently: !!sendSilently,
    embedPoster: !!embedPoster,
    notificationTypes: notificationTypes || [],
  }));
  res.json({ success: true });
});

router.post('/settings/telegram/test', requireAdmin, async (req, res) => {
  try {
    const telegramAgent = require('../services/telegramAgent');
    await telegramAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via Telegram' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── Pushbullet ──
router.get('/settings/pushbullet', requireAdmin, (req, res) => {
  res.json(getAgentConfig('pushbullet_agent'));
});

router.post('/settings/pushbullet', requireAdmin, (req, res) => {
  const { enabled, accessToken, channelTag, notificationTypes } = req.body;
  db.setSetting('pushbullet_agent', JSON.stringify({
    enabled: !!enabled,
    accessToken: accessToken || '',
    channelTag: channelTag || '',
    notificationTypes: notificationTypes || [],
  }));
  res.json({ success: true });
});

router.post('/settings/pushbullet/test', requireAdmin, async (req, res) => {
  try {
    const pushbulletAgent = require('../services/pushbulletAgent');
    await pushbulletAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via Pushbullet' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── Email ──
router.get('/settings/email', requireAdmin, (req, res) => {
  res.json(getAgentConfig('email_agent'));
});

router.post('/settings/email', requireAdmin, (req, res) => {
  const { enabled, emailFrom, smtpHost, smtpPort, secure, ignoreTls, requireTls,
          authUser, authPass, allowSelfSigned, senderName, embedPoster, notificationTypes } = req.body;
  db.setSetting('email_agent', JSON.stringify({
    enabled: !!enabled,
    emailFrom: emailFrom || '',
    smtpHost: smtpHost || '',
    smtpPort: smtpPort || 587,
    secure: !!secure,
    ignoreTls: !!ignoreTls,
    requireTls: !!requireTls,
    authUser: authUser || '',
    authPass: authPass || '',
    allowSelfSigned: !!allowSelfSigned,
    senderName: senderName || 'Diskovarr',
    embedPoster: !!embedPoster,
    notificationTypes: notificationTypes || [],
  }));
  res.json({ success: true });
});

router.post('/settings/email/test', requireAdmin, async (req, res) => {
  try {
    const emailAgent = require('../services/emailAgent');
    await emailAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test email sent' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ── WebPush ──
router.get('/settings/webpush', requireAdmin, (req, res) => {
  const config = getAgentConfig('webpush_agent') || {};
  config.vapidPublic = db.getSetting('webpush_vapid_public', '') || '';
  res.json(config);
});

router.post('/settings/webpush', requireAdmin, (req, res) => {
  const { enabled, embedPoster } = req.body;
  db.setSetting('webpush_agent', JSON.stringify({
    enabled: !!enabled,
    embedPoster: !!embedPoster,
  }));
  res.json({ success: true });
});

router.post('/settings/webpush/test', requireAdmin, async (req, res) => {
  try {
    const webpushAgent = require('../services/webpushAgent');
    await webpushAgent.sendTest(req.body);
    res.json({ ok: true, message: 'Test notification sent via WebPush' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// Register browser push subscription
router.post('/webpush/subscribe', requireAuth, (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const webpushAgent = require('../services/webpushAgent');
    const ok = webpushAgent.saveSubscription(req.user?.user_id || 'anonymous', subscription);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get VAPID public key for browser registration
router.get('/webpush/vapid-key', (_req, res) => {
  const webpushAgent = require('../services/webpushAgent');
  const vapid = webpushAgent.initVapid();
  res.json({ publicKey: vapid.public });
});

// Update broadcast to use the manager for all agents
router.post('/notifications/broadcast', requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  const msg = message.trim();
  const users = db.getKnownUsers();
  for (const user of users) {
    db.createOrBundleNotification({ userId: user.user_id, type: 'broadcast', title: 'Message from Server Admin', body: msg });
  }
  // Use the manager to broadcast to all agents
  const { manager } = require('../services/notificationAgents');
  await manager.sendBroadcast(msg);
  logger.info(`Admin broadcast sent to ${users.length} users`);
  res.json({ success: true, userCount: users.length });
});

// ── Agregarr / API Apps management ───────────────────────────────────────────

// GET /admin/agregarr/config — get the Agregarr app config (creates app if none exists)
router.get('/agregarr/config', requireAdmin, (req, res) => {
  let apps = db.listApiApps().filter(a => a.type === 'agregarr');
  let app = apps[0] || null;
  if (!app) {
    // Auto-create the Agregarr app entry on first visit
    app = db.createApiApp('Agregarr', 'agregarr');
    // Disable it by default — admin must explicitly enable
    db.updateApiApp(app.id, { enabled: false });
    app = db.getApiApp(app.id);
  }
  const serviceUsers = db.getServiceUsersByApp(app.id);
  res.json({ app, serviceUsers });
});

// POST /admin/agregarr/enable — toggle enabled state
router.post('/agregarr/enable', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  let app = db.listApiApps().find(a => a.type === 'agregarr');
  if (!app) app = db.createApiApp('Agregarr', 'agregarr');
  db.updateApiApp(app.id, { enabled: !!enabled });
  res.json({ ok: true, enabled: !!enabled });
});

// POST /admin/agregarr/regenerate-key — regenerate the app API key
router.post('/agregarr/regenerate-key', requireAdmin, (req, res) => {
  let app = db.listApiApps().find(a => a.type === 'agregarr');
  if (!app) return res.status(404).json({ error: 'Agregarr app not found' });
  const newKey = db.regenerateApiAppKey(app.id);
  res.json({ ok: true, apiKey: newKey });
});

// DELETE /admin/agregarr/service-users/:id — remove a service user
router.delete('/agregarr/service-users/:id', requireAdmin, (req, res) => {
  db.deleteServiceUser(req.params.id);
  res.json({ ok: true });
});

// ── Shared Overseerr Compat key management ────────────────────────────────────

// GET /admin/agregarr/config now returns compat app users (backward-compat URL kept)
// Overrides the earlier route definition with the same path
router.get('/compat/config', requireAdmin, (req, res) => {
  let app = db.listApiApps().find(a => a.type === 'compat');
  if (!app) app = db.createApiApp('Overseerr Compat', 'compat');
  const serviceUsers = db.getServiceUsersByApp(app.id);
  res.json({ app, serviceUsers });
});

// POST /admin/compat/enable — toggle compat integration on/off
router.post('/compat/enable', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  let app = db.listApiApps().find(a => a.type === 'compat');
  if (!app) app = db.createApiApp('Overseerr Compat', 'compat');
  db.updateApiApp(app.id, { enabled: !!enabled });
  res.json({ ok: true, enabled: !!enabled });
});

// POST /admin/compat/regenerate-key — regenerate the shared compat key
// Also disables any legacy per-app keys (type='dumb', type='agregarr') so only
// the new compat key is valid going forward.
router.post('/compat/regenerate-key', requireAdmin, (req, res) => {
  let app = db.listApiApps().find(a => a.type === 'compat');
  if (!app) app = db.createApiApp('Overseerr Compat', 'compat');
  const newKey = db.regenerateApiAppKey(app.id);
  // Invalidate legacy per-app keys
  for (const legacy of db.listApiApps().filter(a => a.type === 'dumb' || a.type === 'agregarr')) {
    db.updateApiApp(legacy.id, { enabled: false });
  }
  res.json({ ok: true, apiKey: newKey });
});

module.exports = router;
module.exports.shouldAutoSync = shouldAutoSync;
module.exports.requireAdmin = requireAdmin;
