const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discoverRecommender = require('../services/discoverRecommender');
const logger = require('../services/logger');
const { version: APP_VERSION } = require('../package.json');

function bgGradientCss() {
  const color = db.getThemeColor();
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `body{background-image:radial-gradient(ellipse 50% 50% at 50% 0%,rgba(${r},${g},${b},0.28) 0%,transparent 100%),radial-gradient(ellipse 60% 40% at 50% 100%,rgba(${r},${g},${b},0.12) 0%,transparent 100%);background-attachment:fixed;}`;
}

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
    logger.warn(`Admin login failed: incorrect password from ip=${req.ip}`);
    return res.render('admin/login', { error: 'Incorrect password' });
  }

  logger.info(`Admin login success: ip=${req.ip}`);
  req.session.isAdmin = true;
  res.redirect('/admin');
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
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

// ── Main admin page ───────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  const userPage = Math.max(1, parseInt(req.query.userPage) || 1);
  const userPerPage = [10, 25, 50].includes(parseInt(req.query.userPerPage)) ? parseInt(req.query.userPerPage) : 10;
  const stats = db.getAdminStats();
  const totalUsers = stats.users.length;
  const pagedUsers = stats.users.slice((userPage - 1) * userPerPage, userPage * userPerPage);
  const latestVersion = await getLatestVersion();
  res.render('admin/index', {
    stats: { ...stats, users: pagedUsers },
    userPage,
    userPerPage,
    totalUsers,
    userTotalPages: Math.ceil(totalUsers / userPerPage),
    autoSyncEnabled,
    syncInProgress,
    lastSyncError,
    watchlistMode: db.getAdminWatchlistMode(),
    ownerUserId: db.getOwnerUserId(),
    knownUsers: db.getKnownUsers(),
    connections: db.getConnectionSettings(),
    themeParam: encodeURIComponent(db.getThemeColor()),
    bgGradientCss: bgGradientCss(),
    appVersion: APP_VERSION,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, APP_VERSION),
    individualSeasonsEnabled: db.isIndividualSeasonsEnabled(),
    directRequestAccess: db.getDirectRequestAccess(),
    globalLimits: db.getGlobalRequestLimits(),
    userLimitOverrides: db.getAllUserRequestLimitOverrides(),
    verboseLoggingEnabled: db.getSetting('verbose_logging_enabled', '0') === '1',
    hasApiKey: !!db.getSetting('diskovarr_api_key', ''),
    appPublicUrl: db.getSetting('app_public_url', ''),
    agregarrApp: (() => {
      const apps = db.listApiApps().filter(a => a.type === 'agregarr');
      return apps[0] || null;
    })(),
    dumbHasApiKey: !!(db.listApiApps().find(a => a.type === 'dumb')?.api_key),
  });
});

// ── API: Status (polled by admin UI) ─────────────────────────────────────────

router.get('/status', requireAdmin, (req, res) => {
  const stats = db.getAdminStats();
  res.json({
    stats, autoSyncEnabled, syncInProgress, lastSyncError,
    watchlistMode: db.getAdminWatchlistMode(),
    discoverEnabled: db.isDiscoverEnabled(),
    individualSeasonsEnabled: db.isIndividualSeasonsEnabled(),
    autoRequestMovies: db.getSetting('auto_request_watchlist_movies', 'false') === 'true',
    autoRequestTv: db.getSetting('auto_request_watchlist_tv', 'false') === 'true',
    discordAgent: (() => { try { return JSON.parse(db.getSetting('discord_agent', 'null')); } catch { return null; } })(),
    pushoverAgent: (() => { try { return JSON.parse(db.getSetting('pushover_agent', 'null')); } catch { return null; } })(),
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

// ── Verbose logging toggle ────────────────────────────────────────────────────

router.post('/settings/logging', requireAdmin, (req, res) => {
  const enabled = req.body.enabled === true || req.body.enabled === 'true';
  db.setSetting('verbose_logging_enabled', enabled ? '1' : '0');
  logger.setVerbose(enabled);
  logger.info(`Verbose logging ${enabled ? 'enabled' : 'disabled'} by admin`);
  res.json({ success: true, enabled });
});

// ── Request limits ────────────────────────────────────────────────────────────

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
  'default_request_service',
  'individual_seasons_enabled',
  'direct_request_access',
  'app_public_url',
];

router.post('/connections/save', requireAdmin, (req, res) => {
  const body = req.body;
  const BOOL_KEYS = new Set(['discover_enabled','overseerr_enabled','radarr_enabled','sonarr_enabled','individual_seasons_enabled','direct_request_access']);
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
  res.json(settings);
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
    });
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

// ── Per-user settings PAGE ────────────────────────────────────────────────────

router.get('/user-settings/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  const settings = db.getUserSettings(userId);
  const user = db.getKnownUsers().find(u => u.user_id === userId);
  const saved = req.query.saved === '1';
  const discordConfig = (() => { try { return JSON.parse(db.getSetting('discord_agent', 'null')); } catch { return null; } })();
  res.render('admin/user-settings', {
    userId,
    username: user?.username || userId,
    thumb: user?.thumb || null,
    settings,
    saved,
    themeParam: encodeURIComponent(db.getThemeColor()),
    bgGradientCss: bgGradientCss(),
    appVersion: APP_VERSION,
    connections: db.getConnectionSettings(),
    individualSeasonsEnabled: db.isIndividualSeasonsEnabled(),
    discoverEnabled: db.isDiscoverEnabled(),
    notificationPrefs: db.getUserNotificationPrefs(userId),
    discordAgentEnabled: discordConfig?.enabled === true,
    discordMode: discordConfig?.mode || 'webhook',
    pushoverAgentEnabled: (() => { try { return JSON.parse(db.getSetting('pushover_agent', 'null'))?.enabled === true; } catch { return false; } })(),
    isPrivileged: db.getPrivilegedUserIds().includes(userId),
    ownerUserId: db.getOwnerUserId(),
  });
});

router.post('/user-settings/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  const {
    movieLimit, seasonLimit, movieWindowDays, tvWindowDays,
    overrideGlobal, auto_approve_movies, auto_approve_tv, is_admin,
    region, language, auto_request_movies, auto_request_tv, landing_page,
    notify_approved, notify_denied, notify_available,
    discord_webhook, discord_enabled, pushover_user_key, pushover_enabled,
    notify_pending, notify_auto_approved, notify_process_failed,
    notify_issue_new, notify_issue_update, notify_issue_comment,
  } = req.body;
  db.saveUserSettings(userId, {
    movieLimit: parseInt(movieLimit) || 0,
    seasonLimit: parseInt(seasonLimit) || 0,
    movieWindowDays: parseInt(movieWindowDays) || 7,
    tvWindowDays: parseInt(tvWindowDays) || 7,
    overrideGlobal: overrideGlobal === '1' || overrideGlobal === true,
    auto_approve_movies: auto_approve_movies === '' ? null : (auto_approve_movies === '1' || auto_approve_movies === true),
    auto_approve_tv: auto_approve_tv === '' ? null : (auto_approve_tv === '1' || auto_approve_tv === true),
    is_admin: is_admin === '1' || is_admin === true,
    region: region || null,
    language: language || null,
    auto_request_movies: auto_request_movies === '1' || auto_request_movies === true,
    auto_request_tv: auto_request_tv === '1' || auto_request_tv === true,
    landing_page: landing_page || null,
  });
  const { discord_user_id } = req.body;
  db.setUserNotificationPrefs(userId, {
    notify_approved:      notify_approved      !== undefined ? (notify_approved      === '1' || notify_approved      === true) : true,
    notify_denied:        notify_denied        !== undefined ? (notify_denied        === '1' || notify_denied        === true) : true,
    notify_available:     notify_available     !== undefined ? (notify_available     === '1' || notify_available     === true) : true,
    discord_webhook:      discord_webhook       || null,
    discord_enabled:      discord_enabled       === '1' || discord_enabled       === true,
    discord_user_id:      discord_user_id       || null,
    pushover_user_key:    pushover_user_key     || null,
    pushover_enabled:     pushover_enabled      === '1' || pushover_enabled      === true,
    notify_pending:       notify_pending        !== undefined ? (notify_pending        === '1' || notify_pending        === true) : true,
    notify_auto_approved: notify_auto_approved  !== undefined ? (notify_auto_approved  === '1' || notify_auto_approved  === true) : true,
    notify_process_failed: notify_process_failed !== undefined ? (notify_process_failed === '1' || notify_process_failed === true) : true,
    notify_issue_new:      notify_issue_new      !== undefined ? (notify_issue_new      === '1' || notify_issue_new      === true) : true,
    notify_issue_update:   notify_issue_update   !== undefined ? (notify_issue_update   === '1' || notify_issue_update   === true) : true,
    notify_issue_comment:  notify_issue_comment  !== undefined ? (notify_issue_comment  === '1' || notify_issue_comment  === true) : true,
  });
  res.redirect(`/admin/user-settings/${userId}?saved=1`);
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
  const discordAgent = require('../services/discordAgent');
  const pushoverAgent = require('../services/pushoverAgent');
  await Promise.allSettled([
    discordAgent.sendBroadcast(msg),
    pushoverAgent.sendBroadcast(msg),
  ]);
  logger.info(`Admin broadcast sent to ${users.length} users`);
  res.json({ success: true, userCount: users.length });
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

module.exports = router;
module.exports.shouldAutoSync = shouldAutoSync;
module.exports.requireAdmin = requireAdmin;
