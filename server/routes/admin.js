const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const requireAuth = require('../middleware/requireAuth');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');
const discoverRecommender = require('../services/discoverRecommender');
const logger = require('../services/logger');
const appVersion = require('../services/appVersion');
const { parseImageDataUri, AVATAR_MAX_BYTES } = require('../utils/imageUpload');
const requestPolicy = require('../services/requestPolicy');
const requestNotifications = require('../services/requestNotifications');
const { isDiscordWebhookUrl } = require('../services/notificationAgents/destinations');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  // The Diskovarr API key (Admin → General) grants admin access to external
  // integrations — DUMB uses it to provision the Riven bridge and connections.
  if (require('../middleware/requireAuth').hasApiKey(req)) return next();

  // Only a top-level navigation may be bounced to the login page. An XHR
  // follows that redirect transparently and lands on GET /admin/login, which
  // serves the SPA shell with a 200 — so the caller resolves successfully,
  // reads its fields off an HTML string, and renders zeros and empty tables
  // with no error to show. Those callers get a 401 they can act on instead.
  const isDocument = req.get('Sec-Fetch-Dest') === 'document' ||
    (!req.get('Sec-Fetch-Dest') && req.accepts(['json', 'html']) === 'html');

  if (isDocument) return res.redirect('/admin/login');
  res.status(401).json({ error: 'Admin session required' });
}

// ── Sync state (in-process — survives as long as server runs) ─────────────────

let autoSyncEnabled = db.getSetting('auto_sync_enabled', '1') === '1';
let syncInProgress = false;
let lastSyncError = null;

// eslint-disable-next-line no-unused-vars -- companion to shouldAutoSync, kept for symmetry
function getAutoSyncEnabled() { return autoSyncEnabled; }

// Called by server.js before each scheduled sync
function shouldAutoSync() { return autoSyncEnabled && !syncInProgress; }

module.exports.shouldAutoSync = shouldAutoSync;

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(require('path').resolve(__dirname, '../../dist/index.html'));
});

router.post('/login', loginLimiter, async (req, res) => {
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
  // Elevation gets a fresh session ID; any signed-in user identity carries over
  try {
    await requireAuth.regenerateSession(req);
  } catch (err) {
    logger.error(`Admin login session error: ${err.message}`);
    return res.status(500).json({ error: 'Could not start an admin session' });
  }
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
  const perPageParsed = parseInt(req.query.perPage);
  const perPage = [10, 25, 50].includes(perPageParsed) ? perPageParsed : perPageParsed > 50 ? Math.min(perPageParsed, 9999) : 10;
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

// Per-media-server status for the admin Connections blocks: library row counts
// by source plus the realtime-feed flags (Plex SSE / Jellyfin websocket).
function sourceStatus() {
  const counts = {};
  try {
    for (const r of db.prepare('SELECT source, COUNT(*) AS c FROM library_items GROUP BY source').all()) {
      counts[r.source || 'plex'] = r.c;
    }
  } catch { /* table missing on a fresh boot */ }
  const jellyfin = require('../services/jellyfin');
  const jfSocket = require('../services/jellyfin/socket');
  let jfLastSync = 0;
  try {
    jfLastSync = db.prepare("SELECT MAX(last_sync) AS t FROM sync_log WHERE key LIKE 'library_jf\\_%' ESCAPE '\\'").get()?.t || 0;
  } catch { /* no sync_log yet */ }
  return {
    plex: {
      configured: !!(plexService.getPlexUrl() && plexService.getPlexToken()),
      libraryItems: counts.plex || 0,
      sseConnected: plexService.isSseConnected(),
    },
    jellyfin: {
      enabled: jellyfin.isEnabled(),
      libraryItems: counts.jellyfin || 0,
      wsConnected: jfSocket.isConnected(),
      lastSyncAt: jfLastSync > 0 ? new Date(jfLastSync * 1000).toISOString() : null,
    },
  };
}

router.get('/status', requireAdmin, (req, res) => {
  const stats = db.getAdminStats();
  const compatApp = db.listApiApps().find(a => a.type === 'compat');
  const syncSections = db.getSyncEnabledSections();
  res.json({
    stats, autoSyncEnabled, syncInProgress, lastSyncError,
    tuberr: require('../services/tuberrHealth').getStatus(),
    syncSections,
    sources: sourceStatus(),
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

// ── Update check ──────────────────────────────────────────────────────────────

router.get('/update-status', requireAdmin, async (req, res) => {
  res.json(await appVersion.getUpdateStatus());
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

  // Each configured server syncs independently: one being down (or absent)
  // never stops the other. Failures are reported per server in lastSyncError.
  const failures = [];
  try {
    if (plexService.isConfigured()) {
      try {
        plexService.invalidateCache();
        const enabledIds = db.getEnabledSectionIds().filter(id => !String(id).startsWith('jf_'));
        await plexService.warmCache(enabledIds);
      } catch (err) {
        failures.push(`Plex: ${err.message}`);
      }
    }
    const jellyfin = require('../services/jellyfin');
    if (jellyfin.isEnabled()) {
      try { await jellyfin.resyncAll(); }
      catch (err) { failures.push(`Jellyfin: ${err.message}`); }
    }
    recommender.invalidateAllCaches();
    discoverRecommender.invalidateAllCaches();

    // After sync: check for newly fulfilled requests and notify their requesters
    try {
      require('../services/requestFulfillment').checkAndNotifyFulfilled('admin sync');
    } catch (fulfillErr) {
      console.warn('[Admin] Fulfillment check after sync failed:', fulfillErr.message);
    }

    if (failures.length) {
      lastSyncError = failures.join('; ');
      console.error('[Admin] Library sync error:', lastSyncError);
    } else {
      console.log('[Admin] Manual library sync completed');
    }
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

// ── Library section management ────────────────────────────────────────────────

// Lists each configured server's libraries independently. A server that fails
// is reported in `errors` (keyed by source) while the other's libraries still
// list; only when every configured server fails is it a 500.
router.get('/sync/libraries', requireAdmin, async (req, res) => {
  try {
    const jellyfin = require('../services/jellyfin');
    const errors = {};
    const [plexSections, jfFolders] = await Promise.all([
      plexService.isConfigured()
        ? plexService.getPlexSections().catch(err => { errors.plex = err.message; return []; })
        : [],
      jellyfin.isEnabled()
        ? jellyfin.getFolders().catch(err => { errors.jellyfin = err.message; return []; })
        : [],
    ]);
    const configured = (plexService.isConfigured() ? 1 : 0) + (jellyfin.isEnabled() ? 1 : 0);
    if (configured > 0 && Object.keys(errors).length === configured) {
      return res.status(500).json({ error: 'Failed to fetch library sections', message: Object.values(errors).join('; '), errors });
    }
    for (const [source, message] of Object.entries(errors)) console.warn(`[Admin] ${source} library list failed:`, message);
    const enabledSections = db.getSyncEnabledSections();
    const enabledIds = new Set(enabledSections.filter(s => s.enabled).map(s => String(s.id)));
    const explicitIds = new Set(enabledSections.map(s => String(s.id)));

    const sectionRow = (section, source) => {
      // Jellyfin folders the admin has never toggled default to enabled — the
      // Jellyfin sync has always synced every folder.
      const enabled = explicitIds.has(String(section.id))
        ? enabledIds.has(String(section.id))
        : source === 'jellyfin';
      const itemCount = enabled ? db.getLibraryItemCount(section.id) : 0;
      const lastSync = db.getSyncTime(`library_${section.id}`);
      return {
        id: section.id,
        title: section.title,
        type: section.type,
        enabled,
        itemCount,
        lastSync: lastSync > 0 ? new Date(lastSync * 1000).toISOString() : null,
        source,
      };
    };

    const result = [
      ...plexSections.map(s => sectionRow(s, 'plex')),
      ...jfFolders.map(f => sectionRow({ id: jellyfin.SECTION_PREFIX + f.id, title: f.title, type: f.type }, 'jellyfin')),
    ];

    res.json({ sections: result, errors });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch library sections', message: err.message });
  }
});

router.post('/sync/libraries', requireAdmin, async (req, res) => {
  try {
    const { sections } = req.body;
    if (!Array.isArray(sections)) {
      return res.status(400).json({ error: 'Invalid request body. Expected { sections: [{ id, enabled }] }' });
    }

    const stored = db.getSyncEnabledSections();
    const explicit = new Map(stored.map(s => [String(s.id), !!s.enabled]));
    // Jellyfin sections the admin never toggled are enabled by default (they've
    // always been synced), so disabling one for the first time must still
    // delete its data.
    const wasEnabled = (sid) => explicit.has(sid) ? explicit.get(sid) : sid.startsWith('jf_');

    // Process changes: delete data for sections being disabled, track newly-enabled ones
    let removedAny = false;
    const newlyEnabledIds = [];
    for (const section of sections) {
      const sid = String(section.id);
      if (!section.enabled && wasEnabled(sid)) {
        // Section was enabled but is now being disabled — delete its data
        db.deleteLibraryItems(sid);
        removedAny = true;
      } else if (section.enabled && !wasEnabled(sid)) {
        newlyEnabledIds.push(sid);
      }
    }

    // Merge: preserve stored entries the caller didn't post (e.g. Jellyfin
    // sections when Jellyfin is temporarily unreachable) instead of silently
    // dropping them from the enabled set.
    const posted = new Set(sections.map(s => String(s.id)));
    const merged = sections.map(s => ({ id: String(s.id), enabled: !!s.enabled }));
    for (const s of stored) {
      if (!posted.has(String(s.id))) merged.push({ id: String(s.id), enabled: !!s.enabled });
    }
    db.setSyncEnabledSections(merged);

    // Removing a library invalidates recommendation caches so its items drop out immediately
    if (removedAny) {
      recommender.invalidateAllCaches();
      discoverRecommender.invalidateAllCaches();
    }

    res.json({ success: true });

    // Sync newly-enabled libraries in the background so their items populate right away
    if (newlyEnabledIds.length > 0 && !syncInProgress) {
      syncInProgress = true;
      lastSyncError = null;
      (async () => {
        // Per server, like the manual sync: a Plex failure doesn't skip Jellyfin
        const failures = [];
        try {
          const plexIds = newlyEnabledIds.filter(id => !id.startsWith('jf_'));
          if (plexIds.length > 0) {
            try { await plexService.warmCache(plexIds); }
            catch (err) { failures.push(`Plex: ${err.message}`); }
          }
          if (newlyEnabledIds.some(id => id.startsWith('jf_'))) {
            try { await require('../services/jellyfin').resyncAll(); }
            catch (err) { failures.push(`Jellyfin: ${err.message}`); }
          }
          recommender.invalidateAllCaches();
          discoverRecommender.invalidateAllCaches();
          if (failures.length) {
            lastSyncError = failures.join('; ');
            console.error('[Admin] Auto-sync of newly-enabled libraries failed:', lastSyncError);
          } else {
            console.log(`[Admin] Auto-synced newly-enabled libraries: ${newlyEnabledIds.join(', ')}`);
          }
        } finally {
          syncInProgress = false;
        }
      })();
    }
    return;
  } catch (err) {
    res.status(500).json({ error: 'Failed to save library settings', message: err.message });
  }
});

// ── Per-user watched sync ─────────────────────────────────────────────────────

// Plex token from an unexpired session in the configured session store, or
// null. Read-only and best-effort: a missing/locked sessions.db just means no token.
function sessionPlexToken(userId) {
  const file = db.dataPath('sessions.db');
  if (!require('fs').existsSync(file)) return null;
  let sessDb;
  try {
    const { DatabaseSync } = require('node:sqlite');
    sessDb = new DatabaseSync(file, { readOnly: true });
    const rows = sessDb.prepare('SELECT sess FROM sessions WHERE expired >= ?').all(Math.floor(Date.now() / 1000));
    for (const row of rows) {
      try {
        const s = JSON.parse(row.sess);
        if (s.plexUser && String(s.plexUser.id) === String(userId) && s.plexUser.token) return s.plexUser.token;
      } catch { /* malformed session JSON — skip */ }
    }
  } catch (err) {
    logger.debug(`[Admin] session token lookup failed: ${err.message}`);
  } finally {
    try { sessDb?.close(); } catch {}
  }
  return null;
}

router.post('/sync/watched/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const jellyfin = require('../services/jellyfin');

  // Jellyfin users have no Plex token — mirror their data via the admin API key.
  if (String(userId).startsWith('jf_')) {
    if (!jellyfin.isEnabled()) {
      return res.json({ success: false, message: 'Jellyfin is not enabled.' });
    }
    res.json({ success: true, message: 'Watched sync started for user ' + userId });
    try {
      const guid = String(userId).slice(3);
      const jfUser = (await jellyfin.getUsers()).find(u => String(u.id) === guid);
      if (!jfUser) throw new Error('user no longer exists on the Jellyfin server');
      await jellyfin.syncUserData(jfUser);
      recommender.invalidateUserCache(db.resolveCanonicalUserId(userId));
      console.log(`[Admin] Jellyfin watched sync completed for user ${userId}`);
    } catch (err) {
      console.error(`[Admin] Jellyfin watched sync error for ${userId}:`, err.message);
    }
    return;
  }

  // known_users holds the token from the user's latest sign-in (and is seeded
  // from live sessions at boot); a live session is the fallback.
  const userToken = db.getKnownUserById(String(userId))?.plex_token || sessionPlexToken(userId);

  if (!userToken) {
    return res.json({ success: false, message: 'No token available for this user. They need to sign in to Diskovarr first.' });
  }

  res.json({ success: true, message: 'Watched sync started for user ' + userId });

  try {
    await plexService.syncUserWatched(userId, userToken);
    // Linked Jellyfin account contributes to the same merged profile — refresh it too.
    try {
      const linked = db.getLinkedJellyfinRow(userId);
      if (linked && jellyfin.isEnabled()) {
        const guid = String(linked.user_id).replace(/^jf_/, '');
        const jfUser = (await jellyfin.getUsers()).find(u => String(u.id) === guid);
        if (jfUser) await jellyfin.syncUserData(jfUser);
      }
    } catch (jfErr) {
      console.warn(`[Admin] Linked Jellyfin sync failed for ${userId}:`, jfErr.message);
    }
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
  // Sync the Discord bot avatar to the new accent colour
  try {
    const discordCfg = JSON.parse(db.getSetting('discord_agent', '{}') || '{}');
    if (discordCfg.botEnabled && discordCfg.botToken && !discordCfg.botAvatarUrl) {
      const discordAgent = require('../services/discordAgent');
      discordAgent.updateBotAvatar(discordCfg.botToken, color).catch(() => {});
    }
  } catch {}
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
  // The owner is exempt from library access limits — re-evaluate everyone
  require('../services/libraryAccess').changed(null);
  res.json({ success: true, userId });
});

// ── Library access (Plex sharing / Jellyfin policy — services/libraryAccess) ──

// Section titles for the status table, live from the media servers; ids alone
// when a server is slow or unreachable (the table shouldn't wait on it).
async function librarySectionTitles() {
  const titles = {};
  const jellyfin = require('../services/jellyfin');
  const lookups = [
    plexService.getPlexSections().then(list => { for (const s of list) titles[s.id] = s.title; }),
    jellyfin.isEnabled()
      ? jellyfin.getFolders().then(list => { for (const f of list) titles[jellyfin.SECTION_PREFIX + f.id] = f.title; })
      : null,
  ].filter(Boolean).map(p => p.catch(() => { /* server unreachable */ }));
  let timer;
  await Promise.race([Promise.all(lookups), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  return { ...titles };
}

async function libraryAccessStatus() {
  const status = require('../services/libraryAccess').status();
  const titles = await librarySectionTitles();
  const named = (ids) => ids.map(id => ({ id, title: titles[id] || null }));
  return {
    ...status,
    users: status.users.map(u => ({
      ...u,
      snapshots: u.snapshots.map(({ sectionIds, filteredSectionIds, ...snap }) => ({
        ...snap, sections: named(sectionIds), filteredSections: named(filteredSectionIds),
      })),
    })),
  };
}

router.get('/library-access', requireAdmin, async (req, res) => {
  try {
    res.json(await libraryAccessStatus());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load library access', message: err.message });
  }
});

// Refresh every user now. Answers when done or after 25 s (the run carries on
// and the status shows refreshing: true).
router.post('/library-access/refresh', requireAdmin, async (req, res) => {
  const run = require('../services/libraryAccess').refreshAll().catch(err => {
    logger.warn(`Library access refresh failed: ${err.message}`);
  });
  let timer;
  await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, 25_000); })]);
  clearTimeout(timer);
  try {
    res.json(await libraryAccessStatus());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load library access', message: err.message });
  }
});

// Kill switch: off = every user sees every synced library, as before
router.post('/library-access/settings', requireAdmin, (req, res) => {
  const { enforced } = req.body || {};
  if (typeof enforced !== 'boolean') return res.status(400).json({ error: 'enforced must be true or false' });
  require('../services/libraryAccess').setEnforced(enforced);
  logger.info(`Library access enforcement ${enforced ? 'enabled' : 'disabled'} by admin`);
  res.json({ success: true, enforced });
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
  'youtube_enabled', 'youtube_api_key', 'youtube_root_folder', 'tuberr_url', 'tuberr_api_key',
  'jellyfin_url', 'jellyfin_api_key', 'jellyfin_enabled',
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
    riven_enabled:               !!rivenUrl && ['1', 'true'].includes(db.getSetting('riven_enabled', '0')),
    dumb_request_mode:           db.getSetting('dumb_request_mode', 'pull'),
    youtube_enabled:             db.getSetting('youtube_enabled', '0') === '1',
    youtube_root_folder:         db.getSetting('youtube_root_folder', ''),
    tuberr_url:                  db.getSetting('tuberr_url', ''),
    jellyfin_url:                db.getSetting('jellyfin_url', '') || process.env.JELLYFIN_URL || '',
    jellyfin_enabled:            require('../services/jellyfin').isEnabled(),
    default_request_service:     db.getSetting('default_request_service', 'overseerr'),
    // Normalized like the enforcement in services/requestPolicy, so a legacy
    // stored 'admin' shows as admin-only rather than everyone
    direct_request_access:       db.getDirectRequestAccess(),
  });
});

router.post('/connections/save', requireAdmin, (req, res) => {
  const body = req.body;
  const BOOL_KEYS = new Set(['discover_enabled','overseerr_enabled','radarr_enabled','sonarr_enabled','riven_enabled','youtube_enabled','individual_seasons_enabled','direct_request_access','jellyfin_enabled']);
  // Booleans may arrive as true/false, '1'/'0', or 'true'/'false' depending on caller — normalize to '1'/'0'
  // so downstream readers using strict `=== '1'` checks don't silently treat 'true' as disabled.
  const toBool01 = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? '1' : '0';
  for (const key of CONNECTION_KEYS) {
    if (key in body) {
      // direct_request_access is stored canonical '0'/'1' (legacy values normalized like its reader)
      if (key === 'direct_request_access') { db.setSetting(key, db.normalizeDirectRequestAccess(body[key])); continue; }
      db.setSetting(key, BOOL_KEYS.has(key) ? toBool01(body[key]) : (body[key] ?? ''));
    }
  }
  // Invalidate discover cache when settings change
  discoverRecommender.invalidateAllCaches();
  // Start/stop the bundled Tuberr instance to match the YouTube toggle
  try { require('../services/tuberrProcess').sync(); } catch (e) { console.warn('[tuberr] process sync failed:', e.message); }
  // Re-check Tuberr health + Sonarr wiring shortly after any YouTube-related
  // change (the bundled child needs a moment to boot before Sonarr can test the
  // indexer). The health job auto-repairs missing/stale indexer + client entries.
  if (['youtube_enabled', 'tuberr_url', 'tuberr_api_key', 'sonarr_url', 'sonarr_api_key'].some(k => k in body)) {
    setTimeout(() => {
      require('../services/tuberrHealth').check({ force: true })
        .catch(e => console.warn('[tuberr] post-save health check failed:', e.message));
    }, 20_000).unref();
  }
  // First Jellyfin enable: pull the library + user data right away instead of
  // waiting for the scheduled jobs.
  if ('jellyfin_url' in body || 'jellyfin_api_key' in body || 'jellyfin_enabled' in body) {
    const jellyfin = require('../services/jellyfin');
    // Start/stop/reconnect the realtime LibraryChanged socket to match the settings
    try { require('../services/jellyfin/socket').sync(); } catch (e) { console.warn('[jellyfin ws] sync failed:', e.message); }
    if (jellyfin.isEnabled()) {
      jellyfin.syncLibraryAndUsers()
        .catch(e => console.warn('[jellyfin] post-save sync failed:', e.message));
    }
  }
  // Keep Tuberr's config in sync (it needs Sonarr creds + the YouTube key for matching)
  if (db.getSetting('tuberr_url', '') && db.getSetting('tuberr_api_key', '')) {
    const tuberrService = require('../services/tuberr');
    tuberrService.pushConfig({
      sonarrUrl: db.getSetting('sonarr_url', ''),
      sonarrApiKey: db.getSetting('sonarr_api_key', ''),
      youtubeApiKey: db.getSetting('youtube_api_key', ''),
    }).catch(e => console.warn('[tuberr] config push failed:', e.message));
  }
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
    youtubeApiKey:   db.getSetting('youtube_api_key', '')   || '',
    tuberrApiKey:    db.getSetting('tuberr_api_key', '')    || '',
    jellyfinApiKey:  db.getSetting('jellyfin_api_key', '')  || process.env.JELLYFIN_API_KEY || '',
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

// Sonarr root folders — feeds the optional "YouTube root folder" picker
router.get('/connections/root-folders/sonarr', requireAdmin, async (req, res) => {
  const url = db.getSetting('sonarr_url', '');
  const apiKey = db.getSetting('sonarr_api_key', '');
  if (!url || !apiKey) return res.json({ ok: false, message: 'Sonarr not configured' });
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v3/rootfolder`, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Sonarr returned ${r.status}` });
    const folders = await r.json();
    res.json({ ok: true, folders: folders.map(f => ({ path: f.path, accessible: f.accessible })) });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// One-click Sonarr wiring for Tuberr (tag + indexer + download client)
router.post('/connections/tuberr/setup-sonarr', requireAdmin, async (req, res) => {
  try {
    const tuberrService = require('../services/tuberr');
    res.json(await tuberrService.setupSonarr());
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// Rotate Tuberr's API key (e.g. after a leak) and propagate it to Sonarr
router.post('/connections/tuberr/regenerate-key', requireAdmin, async (req, res) => {
  try {
    const tuberrService = require('../services/tuberr');
    res.json(await tuberrService.regenerateKey());
  } catch (err) {
    res.status(502).json({ ok: false, message: err.message });
  }
});

router.post('/connections/test/tuberr', requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body;
  const effectiveUrl = url || db.getSetting('tuberr_url', '');
  const effectiveKey = apiKey || db.getSetting('tuberr_api_key', '');
  if (!effectiveUrl || !effectiveKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const r = await fetch(`${effectiveUrl.replace(/\/$/, '')}/manage/health`, {
      headers: { 'X-Api-Key': effectiveKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: false, message: `Tuberr returned ${r.status}` });
    const data = await r.json();
    const warnings = [];
    if (!data.sonarr) warnings.push('Sonarr not configured in Tuberr');
    if (!data.youtubeKey) warnings.push('YouTube API key missing');
    if (data.ytDlp === 'missing') warnings.push('yt-dlp not found');
    res.json({
      ok: true,
      message: `Connected to Tuberr v${data.version}` + (warnings.length ? ` — ${warnings.join(', ')}` : ` (yt-dlp ${data.ytDlp})`),
    });
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

router.post('/connections/test/jellyfin', requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body;
  const effectiveKey = apiKey || db.getSetting('jellyfin_api_key', '') || process.env.JELLYFIN_API_KEY || '';
  if (!url || !effectiveKey) return res.json({ ok: false, message: 'URL and API key required' });
  try {
    const jellyfin = require('../services/jellyfin');
    const info = await jellyfin.testConnection(url, effectiveKey);
    res.json({ ok: true, message: `Connected to ${info.serverName} (Jellyfin ${info.version})` });
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
  const libraryTmdbKeys = db.getLibraryTmdbKeys();
  const libraryTvdbKeys = db.getLibraryTvdbKeys();
  const enriched = rows.map(r => {
    const cached = db.getTmdbCache(r.tmdb_id, r.media_type);
    const isAvailable = db.requestIsAvailable(r, libraryTmdbKeys, libraryTvdbKeys);
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

router.put('/requests/:id', requireAdmin, async (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const { service, seasons } = req.body;
  // YouTube requests only work through Sonarr + Tuberr — block reassignment
  if (request.downloader === 'youtube' && service && service !== 'sonarr') {
    return res.status(400).json({ error: 'YouTube requests can only be handled by Sonarr' });
  }
  let plan;
  try {
    // Whole-show selections are priced at the show's real season count, and
    // name their seasons when the show is already in the library
    const ids = { tmdbId: request.tmdb_id, tvdbId: request.tvdb_id };
    plan = requestPolicy.pinLibrarySeasons(
      await requestPolicy.resolveSeasonPlan({ ...ids, mediaType: request.media_type, seasons }), ids);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  db.updateRequest(request.id, {
    service: request.downloader === 'youtube' ? 'sonarr' : (service || request.service),
    seasonsJson: plan.seasons ? JSON.stringify(plan.seasons) : null,
    seasonsCount: request.media_type === 'tv' ? (plan.cost || 1) : 1,
    seasonGated: request.media_type === 'tv' && requestPolicy.isSeasonGated(plan, { tmdbId: request.tmdb_id, tvdbId: request.tvdb_id }),
  });
  res.json({ success: true, request: db.getRequestById(request.id) });
});

router.post('/requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { submitRequestToService } = require('./api');
    const found = db.getRequestById(req.params.id);
    if (!found) return res.status(404).json({ error: 'Request not found' });
    // Under the owner's request lock, re-read: a double click or a second
    // approver must not submit it to the download app twice
    const request = await requestPolicy.withUserLock(found.user_id, async () => {
      const row = db.getRequestById(found.id);
      if (!row || row.status !== 'pending') return null;

      const storedSeasons = row.seasons_json ? JSON.parse(row.seasons_json) : null;
      // If service is 'none', pick the best available service now.
      // YouTube requests always route to Sonarr — no other service can handle them.
      const dumbPullActive = db.getSetting('dumb_request_mode', 'pull') === 'pull' && ['1', 'true'].includes(db.getSetting('riven_enabled', '0'));
      const service = row.downloader === 'youtube' ? 'sonarr'
        : (!row.service || row.service === 'none')
        ? (dumbPullActive ? 'riven'
          : (row.media_type === 'movie'
              ? (db.getConnectionSettings().radarrEnabled ? 'radarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')
              : (db.getConnectionSettings().sonarrEnabled ? 'sonarr' : db.getConnectionSettings().overseerrEnabled ? 'overseerr' : 'riven')))
        : row.service;
      if (service !== 'none') {
        await submitRequestToService({
          tmdbId: row.tmdb_id,
          mediaType: row.media_type,
          title: row.title,
          service,
          seasons: storedSeasons,
          tvdbId: row.tvdb_id || null,
          downloader: row.downloader || undefined,
          youtube: row.youtube_json ? JSON.parse(row.youtube_json) : null,
        });
      }

      db.updateRequestStatus(row.id, 'approved', null);
      db.setRequestSubmitError(row.id, null);
      return row;
    });
    if (!request) return res.status(400).json({ error: 'Request is not pending' });
    logger.info(`Request approved by admin: id=${request.id} tmdbId=${request.tmdb_id} title="${request.title}"`);
    requestNotifications.notifyApproved(request);
    res.json({ success: true, request: db.getRequestById(request.id) });
  } catch (err) {
    console.error('admin approve error:', err);
    // Notify admins of the failure (bell + providers, same as the main API)
    const request = db.getRequestById(req.params.id);
    requestNotifications.notifyProcessFailed({
      title: request?.title || 'Unknown', tmdbId: request?.tmdb_id, mediaType: request?.media_type,
      error: err, posterUrl: request?.poster_url,
    });
    res.status(500).json({ error: err.message });
  }
});

// Same notification path as POST /api/queue/:id/deny
router.post('/requests/:id/deny', requireAdmin, async (req, res) => {
  const { note } = req.body;
  const found = db.getRequestById(req.params.id);
  if (!found) return res.status(404).json({ error: 'Request not found' });
  const { request, conflict } = await requestPolicy.denyRequest(found, note);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (conflict) return res.status(409).json({ error: `The request was ${request.status} meanwhile — reload the queue` });
  logger.info(`Request denied by admin: id=${request.id} title="${request.title}"`);
  res.json({ success: true, request });
});

router.delete('/requests/:id', requireAdmin, (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  db.deleteRequest(request.id);
  db.pruneOrphanFollowers(request);
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
  const body = req.body || {};
  const { notificationPrefs } = body;
  // Fields the caller left out stay undefined so saveUserSettings keeps them
  const pick = (key, parse) => (body[key] === undefined ? undefined : parse(body[key]));
  const flag = v => v === true || v === '1';
  const optionalFlag = v => (v === null || v === 'null' ? null : flag(v));
  const days = v => Math.max(1, parseInt(v) || 7);
  const orNull = v => v || null;
  // Older modal builds posted `override_global`
  const overrideRaw = body.overrideGlobal ?? body.override_global;
  // Same rule as the user's own settings save (S05), checked before any write
  const webhook = notificationPrefs && typeof notificationPrefs.discord_webhook === 'string' ? notificationPrefs.discord_webhook.trim() : '';
  if (webhook && !isDiscordWebhookUrl(webhook)) {
    return res.status(400).json({ error: 'Discord webhook must be an https://discord.com/api/webhooks/… URL' });
  }
  try {
    db.saveUserSettings(req.params.userId, {
      movieLimit: pick('movieLimit', v => parseInt(v) || 0),
      seasonLimit: pick('seasonLimit', v => parseInt(v) || 0),
      movieWindowDays: pick('movieWindowDays', days),
      tvWindowDays: pick('tvWindowDays', days),
      overrideGlobal: overrideRaw === undefined ? undefined : flag(overrideRaw),
      auto_approve_movies: pick('auto_approve_movies', optionalFlag),
      auto_approve_tv: pick('auto_approve_tv', optionalFlag),
      is_admin: pick('is_admin', flag),
      region: pick('region', orNull),
      language: pick('language', orNull),
      auto_request_movies: pick('auto_request_movies', flag),
      auto_request_tv: pick('auto_request_tv', flag),
      landing_page: pick('landing_page', orNull),
    });
    if (notificationPrefs && typeof notificationPrefs === 'object') {
      // Start from the stored row so channels this modal doesn't expose
      // (email address, ntfy, web push, monitor alerts) survive an admin edit.
      db.setUserNotificationPrefs(req.params.userId, {
        ...db.getUserNotificationPrefs(req.params.userId),
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
        discord_webhook:      webhook || null,
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
  const { imageDataUri, clear } = req.body || {};
  if (clear) {
    db.setSetting('discord_avatar_data_uri', null);
    return res.json({ success: true, cleared: true });
  }
  // Checks the decoded bytes (signature + 2 MB cap), not just the URI prefix.
  // The body itself gets through via a route-scoped parser in server.js, since
  // the global JSON limit is far smaller than a 2 MB image in base64.
  const image = parseImageDataUri(imageDataUri, { maxBytes: AVATAR_MAX_BYTES });
  if (!image.ok) return res.status(image.status).json({ error: image.error });
  db.setSetting('discord_avatar_data_uri', image.dataUri);
  res.json({ success: true });
});

// ── Notification agent settings ───────────────────────────────────────────────

// Type selections are stored as flat lists of canonical event ids (grouped
// checkboxes used to arrive as one comma-joined element that never matched).
const { normalizeNotificationTypes } = require('../services/notificationAgents/types');
const normalizeTypes = (list) => normalizeNotificationTypes(list || []);

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
    webhookNotificationTypes: normalizeTypes(webhookNotificationTypes || notificationTypes),
    botNotificationTypes: normalizeTypes(botNotificationTypes || notificationTypes),
    // Keep legacy field for old code reading it
    notificationTypes: normalizeTypes(notificationTypes || webhookNotificationTypes),
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
  const config = { enabled: !!enabled, appToken, userKey, sound, embedPoster: !!embedPoster, notificationTypes: normalizeTypes(notificationTypes) };
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
    notificationTypes: normalizeTypes(notificationTypes),
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
    notificationTypes: normalizeTypes(notificationTypes),
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
    notificationTypes: normalizeTypes(notificationTypes),
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
    notificationTypes: normalizeTypes(notificationTypes),
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
    notificationTypes: normalizeTypes(notificationTypes),
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
    notificationTypes: normalizeTypes(notificationTypes),
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
    notificationTypes: normalizeTypes(notificationTypes),
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

// Legacy alias of POST /api/user/webpush/subscribe (the app no longer calls
// it). Same provider-enabled gate and endpoint validation, shared via
// webpushAgent.registerSubscription.
router.post('/webpush/subscribe', requireAuth, (req, res) => {
  const userId = req.session.plexUser?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const webpushAgent = require('../services/webpushAgent');
  const result = webpushAgent.registerSubscription(userId, req.body?.subscription);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  res.json({ success: true });
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
  // Use the manager to broadcast to all agents; each reports real per-destination counts
  const { manager } = require('../services/notificationAgents');
  const delivery = await manager.sendBroadcast(msg);
  const external = Object.entries(delivery).filter(([, t]) => t.attempted > 0);
  const failed = external.reduce((n, [, t]) => n + t.failed, 0);
  const parts = external.map(([key, t]) => `${key} ${t.sent}/${t.attempted}`);
  const message_ = `Sent to ${users.length} user${users.length === 1 ? '' : 's'} in-app`
    + (parts.length ? `; external: ${parts.join(', ')}` : '; no external destinations')
    + (failed ? ` (${failed} failed)` : '');
  logger.info(`Admin broadcast: ${message_}`);
  res.json({ success: true, userCount: users.length, delivery, message: message_ });
});

// GET /admin/notifications/failures — queued external deliveries that failed
// permanently (or exhausted their retries), newest first.
router.get('/notifications/failures', requireAdmin, (req, res) => {
  const rows = db.getFailedQueuedNotifications(Number(req.query.limit) || 50).map(r => {
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}') || {}; } catch { /* keep empty */ }
    return {
      id: r.id, agent: r.agent, userId: r.user_id, notificationId: r.notification_id,
      type: payload.type || null, title: payload.title || null,
      attempts: r.attempts, error: r.last_error, createdAt: r.created_at, failedAt: r.updated_at,
    };
  });
  res.json({ failures: rows });
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

// ── Tuberr (YouTube downloader) supervision ───────────────────────────────────
// Served by Diskovarr itself (not proxied): child-process log ring + state, and
// an on-demand health/wiring check. Registered before the catch-all proxy.
router.get('/tuberr/logs', requireAdmin, (req, res) => {
  const tuberrProcess = require('../services/tuberrProcess');
  res.json({ lines: tuberrProcess.getLogs(req.query.limit), process: tuberrProcess.getProcessInfo() });
});

router.post('/tuberr/health-check', requireAdmin, async (req, res) => {
  try {
    res.json(await require('../services/tuberrHealth').check({ force: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tuberr (YouTube downloader) management proxy ──────────────────────────────
// The review UI talks to Tuberr's /manage API exclusively through this proxy so
// the Tuberr API key never reaches the browser.
router.all('/tuberr/*splat', requireAdmin, async (req, res) => {
  const tuberrService = require('../services/tuberr');
  const subPath = req.path.replace(/^\/tuberr/, '');
  try {
    const data = await tuberrService.manageFetch(subPath + (req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?')[1] : ''), {
      method: req.method,
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: JSON.stringify(req.body || {}) } : {}),
      timeoutMs: 30000,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
module.exports.shouldAutoSync = shouldAutoSync;
module.exports.requireAdmin = requireAdmin;
