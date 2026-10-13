/**
 * Overseerr-compatible API shim — mounted at /api/v1/
 *
 * Allows external apps (Agregarr, etc.) to connect to Diskovarr as if it were
 * an Overseerr instance. Auth is via X-Api-Key matched against api_apps or
 * app_service_users — completely separate from the main Diskovarr API key.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const logger = require('../services/logger');
const tmdb = require('../services/tmdb');
const policy = require('../services/shimPolicy');
const shimRequests = require('../services/shimRequests');
const requestNotifications = require('../services/requestNotifications');
const requestPolicy = require('../services/requestPolicy');

const { Permission } = policy;

// ── In-memory library cache ────────────────────────────────────────────────────
// Caches library TMDB IDs for 2 minutes so bulk Agregarr list runs don't hit
// SQLite for every individual request. Invalidated on library sync events.
let _libCache = { ids: null, expiresAt: 0 };
const LIB_CACHE_TTL = 2 * 60 * 1000;

function getLibraryIdSet() {
  if (Date.now() < _libCache.expiresAt && _libCache.ids) return _libCache.ids;
  const rows = db.prepare('SELECT tmdb_id, type FROM library_items WHERE tmdb_id IS NOT NULL').all();
  const ids = new Set(rows.map(r => `${r.tmdb_id}:${r.type === 'show' ? 'tv' : 'movie'}`));
  _libCache = { ids, expiresAt: Date.now() + LIB_CACHE_TTL };
  return ids;
}

// Invalidate when the library syncs
process.on('diskovarr:checkFulfilled', () => { _libCache.expiresAt = 0; });

// ── Public (unauthenticated) endpoints ────────────────────────────────────────
// Must be registered BEFORE the auth middleware so they work without an API key.

// GET /api/v1/settings/public — checked by some apps before authenticating
router.get('/settings/public', (req, res) => {
  res.json({
    applicationTitle: 'Diskovarr',
    applicationUrl: '',
    hideAvailable: false,
    localLogin: true,
    newPlexLogin: false,
    defaultPermissions: policy.DEFAULT_PERMISSIONS,
    version: '2.0.0',
  });
});

// ── Shim auth middleware ───────────────────────────────────────────────────────
// Sets req.shimApp (always), req.shimUser (if request is from a service user key)
// and req.shimPrincipal, which every route authorises against (services/shimPolicy).

router.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!apiKey) return res.status(401).json({ message: 'Unauthorized' });

  // Try service-user key first (more specific)
  const svcUser = db.getServiceUserByKey(apiKey);
  if (svcUser) {
    const app = db.getApiApp(svcUser.app_id);
    if (!app || !app.enabled) return res.status(401).json({ message: 'Unauthorized' });
    req.shimApp = app;
    req.shimUser = svcUser;
    req.shimPrincipal = policy.principal(app, svcUser);
    return next();
  }

  // Try app-level (admin) key
  const app = db.getApiAppByKey(apiKey);
  if (app) {
    req.shimApp = app;
    req.shimUser = null; // admin-level, no specific service user
    req.shimPrincipal = policy.principal(app);
    return next();
  }

  return res.status(401).json({ message: 'Unauthorized' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract just the TMDB image path from a full URL
// e.g. "https://image.tmdb.org/t/p/w342/abc.jpg" → "/abc.jpg"
function tmdbPath(url) {
  if (!url) return null;
  const m = url.match(/\/[^/]+\.[a-z]+$/i);
  return m ? m[0] : null;
}

// Build an Overseerr-format user object from an app_service_users row
function shimUserObj(svcUser, includeKey = false) {
  const obj = {
    id: svcUser.overseerr_user_id,
    email: svcUser.email || `${svcUser.username.toLowerCase()}@diskovarr.local`,
    username: svcUser.username,
    displayName: svcUser.username,
    userType: 1,
    permissions: svcUser.permissions,
    avatar: '',
    createdAt: new Date(svcUser.created_at * 1000).toISOString(),
    updatedAt: new Date(svcUser.created_at * 1000).toISOString(),
    requestCount: 0,
  };
  if (includeKey) obj.apiKey = svcUser.api_key;
  return obj;
}

// Build synthetic admin user object (for app-level key auth)
function shimAdminObj(app) {
  return {
    id: 1,
    email: 'admin@diskovarr.local',
    username: 'admin',
    displayName: 'admin',
    userType: 1,
    // Full Overseerr permissions bitmask so Agregarr knows it can do everything
    permissions: 2097151,
    avatar: '',
    createdAt: new Date(app.created_at * 1000).toISOString(),
    updatedAt: new Date(app.created_at * 1000).toISOString(),
    requestCount: 0,
  };
}

// Overseerr MediaRequestStatus: 1=PENDING 2=APPROVED 3=DECLINED 4=FAILED 5=COMPLETED
function toOverseerrStatus(diskoStatus) {
  if (diskoStatus === 'approved') return 2;
  if (diskoStatus === 'denied')   return 3;
  return 1; // pending
}

// eslint-disable-next-line no-unused-vars -- kept for Overseerr status-mapping reference
function fromOverseerrStatus(status) {
  if (status === 2) return 'approved';
  if (status === 3) return 'denied';
  return 'pending';
}

// Convert a discover_requests row to Overseerr request format
function toOverseerrRequest(row) {
  const svcUser = row.user_id.startsWith('__svc_')
    ? db.prepare('SELECT * FROM app_service_users WHERE user_id = ?').get(row.user_id)
    : null;
  const seasons = row.seasons_json ? JSON.parse(row.seasons_json) : [];
  return {
    id: row.id,
    type: row.media_type, // 'movie' or 'tv' — DUMB reads item.type in log/skip messages
    status: toOverseerrStatus(row.status),
    media: {
      // Shim media id (TMDB id + type in a range of its own; shimRequests.encodeMediaId)
      id: shimRequests.mediaIdFor(row.tmdb_id, row.media_type),
      mediaType: row.media_type,
      media_type: row.media_type, // snake_case alias — DUMB accesses data.media_type in its fallback path
      tmdbId: row.tmdb_id,
      // DUMB filters for status==2 (approved) && media.status==3 (processing).
      // Use 5 (Available) once this request is fulfilled, 3 (Processing) for approved
      // but not yet downloaded — including missing seasons of a show the library
      // already has — and 2 (Pending) for pending requests.
      status: shimRequests.requestAvailable(row, getLibraryIdSet()) ? 5
            : row.status === 'approved' ? 3 : 2,
      // Fields Homarr's media-requests-list widget uses for display
      title: row.title || null,
      originalTitle: row.title || null,
      // Homarr fetches poster/backdrop from /movie/{id} or /tv/{id}, but include here as fallback
      posterPath: tmdbPath(row.poster_url),
      // downloadStatus: empty array means "not downloading"; Homarr uses this for availability state
      downloadStatus: [],
    },
    seasons: seasons.map(n => ({ id: n, seasonNumber: n, status: 2 })),
    createdAt: new Date((row.requested_at || 0) * 1000).toISOString(),
    updatedAt: new Date((row.requested_at || 0) * 1000).toISOString(),
    requestedBy: svcUser ? shimUserObj(svcUser) : {
      id: 1, username: row.username || row.user_id, email: 'admin@diskovarr.local',
      displayName: row.username || row.user_id, userType: 1, permissions: 2097151,
      avatar: row.user_thumb || '',
    },
    modifiedBy: null,
    is4k: false,
    serverId: 0,
    profileId: 0,
    rootFolder: '',
  };
}

// Pick the best available service for a request
function pickService(mediaType) {
  // If DUMB pull mode is active, route to riven (submitRequestToService will early-return).
  const dumbPullActive = db.getSetting('dumb_request_mode', 'pull') === 'pull' && ['1', 'true'].includes(db.getSetting('riven_enabled', '0'));
  if (dumbPullActive) return 'riven';

  const c = db.getConnectionSettings();
  if (mediaType === 'movie') {
    if (c.radarrEnabled && c.radarrUrl) return 'radarr';
    if (c.overseerrEnabled && c.overseerrUrl) return 'overseerr';
    if (c.rivenEnabled && c.rivenUrl) return 'riven';
  } else {
    if (c.sonarrEnabled && c.sonarrUrl) return 'sonarr';
    if (c.overseerrEnabled && c.overseerrUrl) return 'overseerr';
    if (c.rivenEnabled && c.rivenUrl) return 'riven';
  }
  return 'none';
}

// Create and enqueue a request_available notification for the requester.
// Shared with the startup / admin-sync / Plex SSE fulfillment paths.
const { notifyRequestAvailable } = require('../services/requestFulfillment');

// ── GET /api/v1/auth/me ───────────────────────────────────────────────────────
router.get('/auth/me', (req, res) => {
  if (req.shimUser) return res.json(shimUserObj(req.shimUser));
  res.json(shimAdminObj(req.shimApp));
});

// ── POST /api/v1/auth/local ───────────────────────────────────────────────────
// Agregarr may call this to create a session — we just return the user object
router.post('/auth/local', (req, res) => {
  if (req.shimUser) return res.json(shimUserObj(req.shimUser));
  res.json(shimAdminObj(req.shimApp));
});

// ── POST /api/v1/auth/logout ──────────────────────────────────────────────────
router.post('/auth/logout', (req, res) => {
  res.json({});
});

// ── GET /api/v1/settings/main ─────────────────────────────────────────────────
// Agregarr checks this to confirm it's talking to Overseerr
router.get('/settings/main', (req, res) => {
  res.json({
    applicationTitle: 'Diskovarr',
    applicationUrl: '',
    hideAvailable: false,
    localLogin: true,
    newPlexLogin: false,
    defaultPermissions: policy.DEFAULT_PERMISSIONS,
    version: '2.0.0',
  });
});

// Every other /settings route (reads expose connection details; writes trigger
// syncs) needs MANAGE_SETTINGS, as in Overseerr. /settings/public and
// /settings/main are registered above and stay open to any valid key.
router.use('/settings', policy.requirePermission(Permission.MANAGE_SETTINGS));

// ── User management ───────────────────────────────────────────────────────────

// POST /api/v1/user — Agregarr creates service users here. Without a
// `permissions` value the user gets Overseerr's default (REQUEST); unlike
// Overseerr, an explicit one (even 0) is honoured — only app keys get here.
router.post('/user', (req, res) => {
  const { username, email, permissions = policy.DEFAULT_PERMISSIONS } = req.body || {};
  if (!username) return res.status(400).json({ message: 'username required' });

  // Only app-level (admin) key can create users
  if (req.shimUser) return res.status(403).json({ message: 'Forbidden' });
  const mask = policy.parseMask(permissions);
  if (mask === null) return res.status(400).json({ message: 'Invalid permissions' });

  try {
    const svcUser = db.createServiceUser(req.shimApp.id, { username, email, permissions: mask });
    logger.info(`[shim] Created service user: ${username} for app "${req.shimApp.name}"`);
    res.status(201).json(shimUserObj(svcUser, true));
  } catch (err) {
    logger.warn('[shim] createServiceUser error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// GET /api/v1/user — list users with request counts
// - Service-user key callers: return app service users (Agregarr user management)
// - Admin-key callers (Homarr media stats): return real Diskovarr users from known_users
router.get('/user', (req, res) => {
  if (req.shimUser) {
    // Called as a service user — return app service accounts for Agregarr
    const users = db.getServiceUsersByApp(req.shimApp.id);
    return res.json({
      pageInfo: { pages: 1, pageSize: 100, results: users.length, page: 1 },
      results: users.map(u => shimUserObj(u)),
    });
  }

  // Admin-key caller — return real Diskovarr users with request counts.
  // Bot/service user_ids start with '__' (__svc_*, __app_*); real users are
  // numeric Plex ids or jf_<guid> Jellyfin ids, so exclude rather than match.
  const rows = db.prepare(`
    SELECT ku.rowid AS rid, ku.user_id, ku.username, ku.thumb,
           COUNT(dr.id) AS requestCount
    FROM known_users ku
    LEFT JOIN discover_requests dr ON dr.user_id = ku.user_id
    WHERE ku.user_id NOT LIKE '\\_\\_%' ESCAPE '\\'
    GROUP BY ku.user_id
    ORDER BY requestCount DESC, ku.username ASC
  `).all();

  const results = rows.map((row, idx) => ({
    id: row.rid || idx + 1,
    email: `${row.username.toLowerCase().replace(/\s+/g, '.')}@diskovarr.local`,
    username: row.username,
    displayName: row.username,
    userType: 1,
    permissions: 32,
    avatar: row.thumb || '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    requestCount: row.requestCount || 0,
  }));

  res.json({
    pageInfo: { pages: 1, pageSize: results.length || 10, results: results.length, page: 1 },
    results,
  });
});

// GET /api/v1/user/:id
router.get('/user/:id', (req, res) => {
  const id = parseInt(req.params.id);
  // Service-user key: look up by overseerr_user_id in this app's service users
  if (req.shimUser) {
    const svcUser = db.getServiceUserById(req.shimApp.id, id);
    if (!svcUser) return res.status(404).json({ message: 'User not found' });
    return res.json(shimUserObj(svcUser));
  }
  // Admin-key: id is the rowid from known_users (as returned by GET /user)
  const knownUser = db.prepare('SELECT rowid AS rid, * FROM known_users WHERE rowid = ?').get(id);
  if (knownUser) {
    const reqCount = db.prepare('SELECT COUNT(*) as cnt FROM discover_requests WHERE user_id = ?').get(knownUser.user_id)?.cnt || 0;
    return res.json({
      id: knownUser.rid,
      email: `${knownUser.username.toLowerCase().replace(/\s+/g, '.')}@diskovarr.local`,
      username: knownUser.username,
      displayName: knownUser.username,
      userType: 1, permissions: 32,
      avatar: knownUser.thumb || '',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      requestCount: reqCount,
    });
  }
  // Fallback: check service users by overseerr_user_id
  const svcUser = db.getServiceUserById(req.shimApp.id, id);
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  res.json(shimUserObj(svcUser));
});

// Shared by PUT /user/:id and POST /user/:id/settings/permissions. App keys may
// set any mask on their own app's service users; service-user keys need
// MANAGE_USERS and can't grant bits they lack (see shimPolicy.permissionChangeError).
function updateServiceUserPermissions(req, res) {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  const { permissions } = req.body || {};
  if (permissions === undefined) {
    if (!policy.canManageUser(req.shimPrincipal, svcUser)) return policy.forbid(res);
    return res.json(shimUserObj(svcUser));
  }
  const mask = policy.parseMask(permissions);
  if (mask === null) return res.status(400).json({ message: 'Invalid permissions' });
  const denied = policy.permissionChangeError(req.shimPrincipal, svcUser, mask);
  if (denied) return policy.forbid(res, denied);
  db.prepare('UPDATE app_service_users SET permissions = ? WHERE id = ?').run(mask, svcUser.id);
  res.json(shimUserObj(db.prepare('SELECT * FROM app_service_users WHERE id = ?').get(svcUser.id)));
}

// Service user for a no-op settings write, or null after sending 404/403.
function settingsWriteTarget(req, res) {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) { res.status(404).json({ message: 'User not found' }); return null; }
  if (!policy.canManageUser(req.shimPrincipal, svcUser)) { policy.forbid(res); return null; }
  return svcUser;
}

// PUT /api/v1/user/:id — Agregarr updates permissions
router.put('/user/:id', updateServiceUserPermissions);

// DELETE /api/v1/user/:id — delete a service user
router.delete('/user/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (req.shimUser) return res.status(403).json({ message: 'Forbidden' });
  const svcUser = db.getServiceUserById(req.shimApp.id, id);
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  db.deleteServiceUser(svcUser.id);
  res.json({});
});

// GET /api/v1/user/:id/settings/main — user general settings (Overseerr sub-path)
router.get('/user/:id/settings/main', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  res.json({ discordId: '', locale: '', region: null, originalLanguage: null, pgpKey: null });
});

// POST /api/v1/user/:id/settings/main — update user general settings (no-op)
router.post('/user/:id/settings/main', (req, res) => {
  const svcUser = settingsWriteTarget(req, res);
  if (svcUser) res.json(shimUserObj(svcUser));
});

// POST /api/v1/user/:id/settings — no-op, just return success
router.post('/user/:id/settings', (req, res) => {
  const svcUser = settingsWriteTarget(req, res);
  if (svcUser) res.json(shimUserObj(svcUser));
});

// POST /api/v1/user/:id/settings/notifications — Agregarr updates notification prefs
router.post('/user/:id/settings/notifications', (req, res) => {
  if (settingsWriteTarget(req, res)) res.json({ notificationTypes: {}, pgpKey: null });
});

// POST /api/v1/user/:id/settings/permissions — Agregarr sets permissions before requests
router.post('/user/:id/settings/permissions', updateServiceUserPermissions);

// GET /api/v1/user/:id/settings
router.get('/user/:id/settings', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  res.json({ discordId: '', locale: '', region: null, originalLanguage: null, pgpKey: null });
});

// ── Request endpoints ─────────────────────────────────────────────────────────

// POST /api/v1/request — Agregarr submits a media request
router.post('/request', async (req, res) => {
  const { mediaId, mediaType, seasons } = req.body || {};
  if (!mediaId || !mediaType) {
    return res.status(400).json({ message: 'mediaId and mediaType required' });
  }
  if (!['movie', 'tv'].includes(mediaType)) {
    return res.status(400).json({ message: 'Invalid mediaType' });
  }

  // Determine which user_id this request is from.
  // Agregarr authenticates with the admin key but sends X-API-User header
  // containing the service user's overseerr_user_id for impersonation.
  let userId;
  let resolvedSvcUser = req.shimUser || null;

  if (req.shimUser) {
    // Authenticated as a service user directly
    userId = req.shimUser.user_id;
  } else {
    // Admin key — check X-API-User impersonation header (Agregarr's mechanism)
    const impersonateId = req.headers['x-api-user'];
    if (impersonateId) {
      const svc = db.getServiceUserById(req.shimApp.id, parseInt(impersonateId));
      if (svc) {
        resolvedSvcUser = svc;
        userId = svc.user_id;
      }
    }
    if (!userId) userId = `__app_${req.shimApp.id}__`;
  }

  // The acting user needs REQUEST (or the per-type bit), checked before any side
  // effect as in Overseerr. An app key without X-API-User acts as admin.
  const requester = resolvedSvcUser ? policy.principal(req.shimApp, resolvedSvcUser) : req.shimPrincipal;
  const denied = policy.requestPermissionError(requester, mediaType);
  if (denied) {
    logger.info(`[shim] Request refused: user=${userId} lacks permission for ${mediaType} requests (tmdbId=${mediaId})`);
    return policy.forbid(res, denied);
  }

  // Ensure the app-level virtual user exists in known_users
  if (!resolvedSvcUser) {
    db.prepare('INSERT OR IGNORE INTO known_users (user_id, username, thumb, seen_at) VALUES (?, ?, NULL, ?)')
      .run(userId, req.shimApp.name, Math.floor(Date.now() / 1000));
  }

  try {
    // Resolve title from TMDB cache; fetch live if missing or if TV show lacks
    // numberOfSeasons (old cache entries pre-date that field — without it, rate
    // limits fall back to seasonsCount=1 and are bypassed for large shows).
    let cached = db.getTmdbCache(mediaId, mediaType);
    if ((!cached || (mediaType === 'tv' && !cached.numberOfSeasons)) && db.hasTmdbKey()) {
      try {
        const details = await tmdb.getItemDetails(mediaId, mediaType === 'tv' ? 'tv' : 'movie');
        if (details) {
          db.setTmdbCache(mediaId, mediaType, details);
          cached = db.getTmdbCache(mediaId, mediaType);
        }
      } catch (e) {
        logger.debug(`[shim] TMDB fetch failed for ${mediaId}: ${e.message}`);
      }
    }
    const title = cached?.title || null;
    if (!title) {
      // TMDB returned 404 or key not configured — ID doesn't exist on TMDB (likely AniList/other source).
      // Skip silently so Agregarr's sync isn't interrupted.
      logger.debug(`[shim] skipping tmdbId=${mediaId} type=${mediaType} — could not resolve title (non-TMDB ID?)`);
      return res.status(201).json({
        id: 0, status: 1,
        media: { id: shimRequests.mediaIdFor(mediaId, mediaType), mediaType, tmdbId: Number(mediaId), status: 1 },
        seasons: Array.isArray(seasons) ? seasons.map(n => ({ id: Number(n), seasonNumber: Number(n), status: 1 })) : [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        requestedBy: resolvedSvcUser ? shimUserObj(resolvedSvcUser) : shimAdminObj(req.shimApp),
        modifiedBy: null, is4k: false, serverId: 0, profileId: 0, rootFolder: '',
      });
    }
    const posterUrl = cached?.posterUrl || null;
    // Build seasons array: use explicit list from request body if provided,
    // otherwise derive from TMDB's numberOfSeasons (so bubbles are always visible).
    let seasonsArray = Array.isArray(seasons) && seasons.length > 0 ? seasons.map(Number) : null;
    if (!seasonsArray && mediaType === 'tv' && cached?.numberOfSeasons > 0) {
      seasonsArray = Array.from({ length: cached.numberOfSeasons }, (_, i) => i + 1);
    }
    const seasonsCount = seasonsArray ? seasonsArray.length : 1;

    // For rate limiting TV shows: charge the TOTAL season count from TMDB, not
    // just the explicitly requested seasons. Agregarr always sends seasons:[1] as
    // a convention, but a 50-season show should exhaust the limit proportionally.
    // This count is also what gets stored in seasons_count so the running window
    // sum (countRecentSeasonRequests) stays accurate across requests.
    const limitSeasonsCount = (mediaType === 'tv' && cached?.numberOfSeasons > 0)
      ? cached.numberOfSeasons
      : seasonsCount;
    if (mediaType === 'tv' && !cached?.numberOfSeasons) {
      logger.warn(`[shim] tmdbId=${mediaId} "${title}": numberOfSeasons unknown — rate limit charges ${seasonsCount} (explicit) instead of full show count`);
    }

    // Rate limit check — must happen after TMDB fetch so limitSeasonsCount reflects
    // the real total season count. Silently return 201 so automated callers like
    // Agregarr don't freeze on 4xx.
    const limits = db.getEffectiveLimits(userId);
    if (limits) {
      if (mediaType === 'movie' && limits.movieLimit > 0) {
        const count = db.countRecentMovieRequests(userId, limits.movieWindowDays);
        if (count >= limits.movieLimit) {
          logger.debug(`[shim] rate limit: user=${userId} movie limit ${limits.movieLimit}/${limits.movieWindowDays}d reached (${count} used) — silently dropping`);
          return res.status(201).json({
            id: 0, status: 1,
            media: { id: shimRequests.mediaIdFor(mediaId, mediaType), mediaType, tmdbId: Number(mediaId), status: 1 },
            seasons: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            requestedBy: resolvedSvcUser ? shimUserObj(resolvedSvcUser) : shimAdminObj(req.shimApp),
            modifiedBy: null, is4k: false, serverId: 0, profileId: 0, rootFolder: '',
          });
        }
      }
      if (mediaType === 'tv' && limits.seasonLimit > 0) {
        const count = db.countRecentSeasonRequests(userId, limits.seasonWindowDays);
        logger.debug(`[shim] season limit check: user=${userId} limit=${limits.seasonLimit}/${limits.seasonWindowDays}d used=${count} charging=${limitSeasonsCount} (show has ${cached?.numberOfSeasons ?? '?'} total seasons) title="${title}"`);
        if (count + limitSeasonsCount > limits.seasonLimit) {
          logger.info(`[shim] rate limit blocked: user=${userId} limit=${limits.seasonLimit}/${limits.seasonWindowDays}d — ${count} used + ${limitSeasonsCount} needed = ${count + limitSeasonsCount} > limit — dropping "${title}"`);
          return res.status(201).json({
            id: 0, status: 1,
            media: { id: shimRequests.mediaIdFor(mediaId, mediaType), mediaType, tmdbId: Number(mediaId), status: 1 },
            seasons: seasonsArray ? seasonsArray.map(n => ({ id: n, seasonNumber: n, status: 1 })) : [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            requestedBy: resolvedSvcUser ? shimUserObj(resolvedSvcUser) : shimAdminObj(req.shimApp),
            modifiedBy: null, is4k: false, serverId: 0, profileId: 0, rootFolder: '',
          });
        }
      }
    }

    // Check if already in Plex library (cached set — avoids DB query per request)
    const libKey = `${mediaId}:${mediaType === 'tv' ? 'tv' : 'movie'}`;
    if (getLibraryIdSet().has(libKey)) {
      logger.debug(`[shim] ${title} already in library — skipping request`);
      // Return a synthetic "available" response matching Overseerr format
      return res.status(201).json({
        id: 0, status: 5, // AVAILABLE
        media: { id: shimRequests.mediaIdFor(mediaId, mediaType), mediaType, tmdbId: Number(mediaId), status: 5 },
        seasons: seasonsArray ? seasonsArray.map(n => ({ id: n, seasonNumber: n, status: 5 })) : [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        requestedBy: resolvedSvcUser ? shimUserObj(resolvedSvcUser) : shimAdminObj(req.shimApp),
        modifiedBy: null, is4k: false, serverId: 0, profileId: 0, rootFolder: '',
      });
    }

    // Check for an existing non-denied request for this title. "Notify me"
    // followers acquire nothing, so they never count as one.
    const existing = db.prepare(
      `SELECT * FROM discover_requests WHERE tmdb_id = ? AND media_type = ? AND status != 'denied' AND is_follow = 0 ORDER BY id DESC LIMIT 1`
    ).get(Number(mediaId), mediaType);
    if (existing) {
      logger.debug(`[shim] ${title} already requested (id=${existing.id}) — returning existing`);
      return res.status(409).json({ message: 'Request already exists', ...toOverseerrRequest(existing) });
    }

    // Shim requests are queued in Diskovarr only — never routed to Radarr/Sonarr.
    // Respect the global auto-approve setting.
    const status = db.getEffectiveAutoApprove(userId, mediaType) ? 'approved' : 'pending';
    // Store limitSeasonsCount (TMDB total) in seasons_count so the running window
    // sum stays accurate for future rate limit checks. seasons_json still holds the
    // explicit seasons list Agregarr sent (for display purposes).
    db.addDiscoverRequestWithStatus(userId, mediaId, mediaType, title, 'none', limitSeasonsCount, status, seasonsArray, posterUrl);
    logger.info(`[shim] Request ${status}: user=${userId} tmdbId=${mediaId} type=${mediaType} title="${title}"`);

    const row = db.prepare('SELECT * FROM discover_requests WHERE user_id = ? AND tmdb_id = ? ORDER BY id DESC LIMIT 1').get(userId, Number(mediaId));
    res.status(201).json(toOverseerrRequest({ ...row, username: resolvedSvcUser?.username || req.shimApp.name }));
  } catch (err) {
    logger.warn('[shim] request error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// GET /api/v1/request — Agregarr fetches existing requests for dedup cache.
// Riven polls take=10000 and never pages, so the cap must cover that.
const MAX_REQUEST_PAGE = 10000;
router.get('/request', (req, res) => {
  const { filter, take = '500', skip = '0' } = req.query;
  const limit = Math.min(MAX_REQUEST_PAGE, Math.max(1, parseInt(take) || 500));
  const offset = Math.max(0, parseInt(skip) || 0);
  const statusFilter = filter === 'pending' ? 'pending'
    : filter === 'approved' ? 'approved'
    : filter === 'declined' ? 'denied'
    : null;
  // YouTube-downloader requests (Sonarr+Tuberr only — DUMB polling this endpoint
  // in pull mode must not try to fetch them via debrid) and TVDB-only rows
  // (tmdb_id sentinel 0) are excluded in SQL, so pages and totals stay consistent.
  // Without MANAGE_REQUESTS/REQUEST_VIEW a service user sees only its own requests.
  const userId = policy.canViewAllRequests(req.shimPrincipal) ? null : req.shimPrincipal.userId;
  const { rows, total } = shimRequests.listRequests({ limit, offset, status: statusFilter, userId });
  res.json({
    pageInfo: { pages: Math.ceil(total / limit), pageSize: limit, results: total, page: Math.floor(offset / limit) + 1 },
    results: rows.map(toOverseerrRequest),
  });
});

// Load the request named by :id and authorise `allowed(principal, request)`.
// Returns the row, or null after sending 404/403.
function authorizedRequest(req, res, allowed) {
  const request = db.getRequestById(req.params.id);
  if (!request) { res.status(404).json({ message: 'Request not found' }); return null; }
  if (!allowed(req.shimPrincipal, request)) { policy.forbid(res); return null; }
  return request;
}

// Submit a pending request to its download service (unless queue-only) and
// mark it approved, with the same notifications as the Queue's approve. Shared
// by the dedicated and generic status endpoints. An already-approved row is
// left alone (never submitted twice); a denied one must be reset to pending.
// Runs under the owner's request lock and re-reads the row there, so it can't
// race the Queue's approve (or another client) into a second submission.
async function approveRequest(found) {
  const request = await requestPolicy.withUserLock(found.user_id, () => submitApproval(found.id));
  if (request) requestNotifications.notifyApproved(request);
}

async function submitApproval(id) {
  const request = db.getRequestById(id);
  if (!request) throw Object.assign(new Error('Request not found'), { shimStatus: 404 });
  if (request.status === 'approved') return null;
  if (request.status !== 'pending') throw Object.assign(new Error('Request is not pending'), { shimStatus: 400 });
  // YouTube requests always route to Sonarr and must keep their downloader payload.
  // Shim-created rows are stored with service 'none' (queued only); an explicit
  // approval picks the app now, as the Queue's approve does.
  const service = request.downloader === 'youtube' ? 'sonarr'
    : (request.service && request.service !== 'none' ? request.service : pickService(request.media_type));
  if (service !== 'none') {
    const { submitRequestToService } = require('./api');
    const seasons = request.seasons_json ? JSON.parse(request.seasons_json) : null;
    try {
      await submitRequestToService({
        tmdbId: request.tmdb_id,
        mediaType: request.media_type,
        title: request.title,
        service,
        seasons,
        tvdbId: request.tvdb_id || null,
        downloader: request.downloader || undefined,
        youtube: request.youtube_json ? JSON.parse(request.youtube_json) : null,
      });
    } catch (err) {
      requestNotifications.notifyProcessFailed({
        title: request.title, tmdbId: request.tmdb_id, mediaType: request.media_type, error: err, posterUrl: request.poster_url,
      });
      throw err;
    }
  }
  db.updateRequestStatus(request.id, 'approved');
  db.setRequestSubmitError(request.id, null);
  return request;
}

// Deny a request like the Queue's deny (same lock, follower cleanup and
// notification). 409 when an approval or other change landed meanwhile.
async function declineRequest(request, reason) {
  const note = typeof reason === 'string' && reason ? reason : null;
  const { request: row, conflict } = await requestPolicy.denyRequest(request, note);
  if (!row) throw Object.assign(new Error('Request not found'), { shimStatus: 404 });
  if (conflict) throw Object.assign(new Error(`Request is ${row.status}`), { shimStatus: 409 });
}

// POST /api/v1/request/:id/approve
router.post('/request/:id/approve', async (req, res) => {
  const request = authorizedRequest(req, res, policy.canManageRequests);
  if (!request) return;
  try {
    await approveRequest(request);
    res.json(toOverseerrRequest(db.getRequestById(request.id)));
  } catch (err) {
    res.status(err.shimStatus || 500).json({ message: err.message });
  }
});

// POST /api/v1/request/:id/decline
router.post('/request/:id/decline', async (req, res) => {
  const request = authorizedRequest(req, res, policy.canManageRequests);
  if (!request) return;
  try {
    await declineRequest(request, req.body?.reason);
  } catch (err) {
    return res.status(err.shimStatus || 500).json({ message: err.message });
  }
  res.json(toOverseerrRequest(db.getRequestById(request.id)));
});

// DELETE /api/v1/request/:id — managers, or the requester while it is pending.
// Riven 0.x sends a request's media.id here rather than its id, so:
//  - an encoded media id (shimRequests.decodeMediaId) deletes that title's
//    requests like DELETE /media/:id (MANAGE_REQUESTS; 204, or 404 if none);
//  - with the DUMB bridge key (Riven's), a plain id is honoured only for a
//    request that app filed itself. Riven rows stored before media ids were
//    encoded hold bare TMDB ids, which would name some unrelated request.
router.delete('/request/:id', (req, res) => {
  const media = shimRequests.decodeMediaId(req.params.id);
  if (media) {
    if (!policy.canManageRequests(req.shimPrincipal)) return policy.forbid(res);
    const removed = shimRequests.deleteMediaRequests(media.tmdbId, media.mediaType);
    if (!removed) return res.status(404).json({ message: 'Request not found' });
    logger.info(`[shim] "${req.shimApp.name}" deleted media ${req.params.id} (tmdbId=${media.tmdbId} ${media.mediaType}): ${removed} request row(s)`);
    return res.status(204).end();
  }
  if (req.shimApp.type === 'dumb') {
    const target = db.getRequestById(req.params.id);
    if (target && !policy.createdByApp(req.shimApp, target)) {
      logger.warn(`[shim] "${req.shimApp.name}": ignored DELETE /request/${req.params.id} — not a request this app filed (likely a TMDB id stored by Riven); nothing deleted`);
      return res.status(404).json({ message: 'Request not found' });
    }
  }
  const request = authorizedRequest(req, res, policy.canModifyRequest);
  if (!request) return;
  db.deleteRequest(request.id);
  db.pruneOrphanFollowers(request);
  res.json({ message: 'Request deleted' });
});

// PUT /api/v1/request/:id — update request (seasons/service); managers, or the
// requester while it is pending
router.put('/request/:id', (req, res) => {
  const request = authorizedRequest(req, res, policy.canModifyRequest);
  if (!request) return;
  const { seasons } = req.body || {};
  if (Array.isArray(seasons)) {
    const list = seasons.map(Number);
    if (!list.every(n => Number.isInteger(n) && n >= 0)) return res.status(400).json({ message: 'Invalid seasons' });
    // seasons_count is the rate-limit charge (the shim bills a show's full TMDB
    // season count); a requester editing their own request may not shrink it.
    const seasonsCount = policy.canManageRequests(req.shimPrincipal)
      ? list.length
      : Math.max(list.length, request.seasons_count || 1);
    db.updateRequest(request.id, {
      service: request.service,
      seasonsJson: JSON.stringify(list),
      seasonsCount,
    });
  }
  res.json(toOverseerrRequest(db.getRequestById(request.id)));
});

// GET /api/v1/movie/:id — DUMB uses this for IMDb ID; Homarr uses for title/poster/backdrop
router.get('/movie/:id', async (req, res) => {
  const tmdbId = parseInt(req.params.id);
  if (!tmdbId) return res.status(400).json({ message: 'Invalid id' });
  let cached = db.getTmdbCache(tmdbId, 'movie');
  if (!cached && db.hasTmdbKey()) {
    try { cached = await tmdb.getItemDetails(tmdbId, 'movie'); } catch {}
  }
  res.json({
    id: tmdbId,
    mediaType: 'movie',
    title: cached?.title || null,
    originalTitle: cached?.title || null,
    releaseDate: cached?.releaseDate || null,
    posterPath: tmdbPath(cached?.posterUrl),
    backdropPath: tmdbPath(cached?.backdropUrl),
    overview: cached?.overview || null,
    externalIds: { imdbId: cached?.imdbId || null, tmdbId },
  });
});

// GET /api/v1/tv/:id — DUMB uses this for IMDb ID; Homarr uses for name/poster/backdrop
router.get('/tv/:id', async (req, res) => {
  const tmdbId = parseInt(req.params.id);
  if (!tmdbId) return res.status(400).json({ message: 'Invalid id' });
  let cached = db.getTmdbCache(tmdbId, 'tv');
  if (!cached && db.hasTmdbKey()) {
    try { cached = await tmdb.getItemDetails(tmdbId, 'tv'); } catch {}
  }
  res.json({
    id: tmdbId,
    mediaType: 'tv',
    name: cached?.title || null,
    originalName: cached?.title || null,
    firstAirDate: cached?.releaseDate || null,
    posterPath: tmdbPath(cached?.posterUrl),
    backdropPath: tmdbPath(cached?.backdropUrl),
    overview: cached?.overview || null,
    numberOfSeasons: cached?.numberOfSeasons || null,
    externalIds: { imdbId: cached?.imdbId || null, tmdbId },
  });
});

// GET /api/v1/tv/:id/season/:seasonNumber — season details stub
router.get('/tv/:id/season/:seasonNumber', async (req, res) => {
  const tmdbId = parseInt(req.params.id);
  const seasonNumber = parseInt(req.params.seasonNumber);
  res.json({
    id: tmdbId,
    seasonNumber,
    episodeCount: 0,
    episodes: [],
    airDate: null,
    name: `Season ${seasonNumber}`,
    overview: null,
    posterPath: null,
  });
});

// GET /api/v1/request/count — DUMB polls this for queue depth; Homarr uses for stats.
// Aggregate counts over the same visible rows GET /request lists.
router.get('/request/count', (req, res) => {
  res.json(shimRequests.requestCounts(getLibraryIdSet()));
});

// GET /api/v1/request/:id — get single request by ID
router.get('/request/:id', (req, res) => {
  const request = authorizedRequest(req, res, policy.canViewRequest);
  if (request) res.json(toOverseerrRequest(request));
});

// POST /api/v1/request/:id/retry — retry a failed request (Diskovarr has no failed state, no-op)
router.post('/request/:id/retry', (req, res) => {
  const request = authorizedRequest(req, res, policy.canManageRequests);
  if (request) res.json(toOverseerrRequest(request));
});

// POST /api/v1/request/:id/:status — generic status update (pending/approve/decline)
// Jellyseerr and newer apps use this form instead of specific /approve and /decline routes.
router.post('/request/:id/:status', async (req, res) => {
  const { status } = req.params;
  if (!['approve', 'decline', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }
  const request = authorizedRequest(req, res, policy.canManageRequests);
  if (!request) return;
  if (status === 'approve') {
    try {
      await approveRequest(request);
    } catch (err) {
      return res.status(err.shimStatus || 500).json({ message: err.message });
    }
  } else if (status === 'decline') {
    try {
      await declineRequest(request, req.body?.reason);
    } catch (err) {
      return res.status(err.shimStatus || 500).json({ message: err.message });
    }
  } else {
    db.updateRequestStatus(request.id, 'pending');
  }
  res.json(toOverseerrRequest(db.getRequestById(request.id)));
});

// Media type hint for the bare-TMDB-id /media/:id routes (movie and TV ids
// overlap). Accepted from the query string or JSON body, camel or snake case.
function mediaTypeHint(req) {
  return req.query.mediaType || req.query.media_type || req.body?.mediaType || req.body?.media_type || null;
}

// Media named by a /media/:id segment, as { tmdbId, hint }, or null if invalid.
// An encoded shim media id (the media.id the shim emits) names one exact title:
// its type replaces any hint, so it is never ambiguous. Anything below the
// encoded range is a bare TMDB id (Agregarr's GET /media/{tmdbId}, older
// clients) resolved with the type hint or the requests on file.
function mediaRef(req) {
  const decoded = shimRequests.decodeMediaId(req.params.id);
  if (decoded) return { tmdbId: decoded.tmdbId, hint: decoded.mediaType };
  const tmdbId = parseInt(req.params.id);
  return tmdbId > 0 && tmdbId < shimRequests.MEDIA_ID_MIN ? { tmdbId, hint: mediaTypeHint(req) } : null;
}

// Mark one title available: notify every approved requester (not just the
// newest) and stamp their requests. `ambiguous` when the id has approved
// requests as both a movie and a show and no hint picks one.
function markMediaAvailable(tmdbId, hint) {
  const types = shimRequests.mediaTypesFor(tmdbId, { status: 'approved', visibleOnly: false });
  const { mediaType, ambiguous } = shimRequests.resolveMediaType(types, hint);
  if (ambiguous) return { ambiguous, mediaType: null, requests: [] };
  const requests = mediaType
    ? shimRequests.mediaRequests(tmdbId, mediaType, { status: 'approved', visibleOnly: false })
    : [];
  for (const request of requests) notifyRequestAvailable(request);
  const unstamped = requests.filter(r => !r.notified_available_at).map(r => r.id);
  if (unstamped.length) db.markRequestsNotifiedAvailable(unstamped);
  if (requests.length) process.emit('diskovarr:checkFulfilled');
  _libCache.expiresAt = 0;
  return { ambiguous: false, mediaType, requests };
}

const AMBIGUOUS_MEDIA = { message: 'Ambiguous media id: it matches both a movie and a TV show; pass mediaType' };

// PUT /api/v1/media/:id/available — a downloader marks a title available
// (Overseerr's form is POST /media/:id/available, below)
router.put('/media/:id/available', policy.requirePermission(Permission.MANAGE_REQUESTS), (req, res) => {
  const ref = mediaRef(req);
  if (!ref) return res.status(400).json({ message: 'Invalid media id' });
  const { tmdbId } = ref;
  const { ambiguous, requests } = markMediaAvailable(tmdbId, ref.hint);
  if (ambiguous) return res.status(409).json(AMBIGUOUS_MEDIA);
  if (!requests.length) return res.status(404).json({ message: 'No approved request found for this media' });
  logger.info(`[shim] "${req.shimApp.name}" marked tmdbId=${tmdbId} (${requests[0].media_type}) available — request(s) #${requests.map(r => r.id).join(', #')}`);
  res.json(toOverseerrRequest(requests[0]));
});

// GET /api/v1/user/:id/requests — requests made by a specific user
router.get('/user/:id/requests', (req, res) => {
  const { take = '20', skip = '0' } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(take) || 20));
  const offset = Math.max(0, parseInt(skip) || 0);
  const id = parseInt(req.params.id);

  let userId = null;
  if (req.shimUser) {
    const svcUser = db.getServiceUserById(req.shimApp.id, id);
    userId = svcUser?.user_id || null;
  } else {
    // Admin-key: look up by known_users rowid
    const ku = db.prepare('SELECT rowid AS rid, user_id FROM known_users WHERE rowid = ?').get(id);
    if (ku) userId = ku.user_id;
    else {
      const svcUser = db.getServiceUserById(req.shimApp.id, id);
      userId = svcUser?.user_id || null;
    }
  }

  if (!userId) return res.status(404).json({ message: 'User not found' });
  // Another user's requests need MANAGE_REQUESTS or REQUEST_VIEW
  if (userId !== req.shimPrincipal.userId && !policy.canViewAllRequests(req.shimPrincipal)) {
    return policy.forbid(res);
  }

  const { rows, total } = shimRequests.listRequests({ limit, offset, userId });

  res.json({
    pageInfo: { pages: Math.ceil(total / limit), pageSize: limit, results: total, page: Math.floor(offset / limit) + 1 },
    results: rows.map(toOverseerrRequest),
  });
});

// GET /api/v1/user/:id/quota — return user request quota info
router.get('/user/:id/quota', (req, res) => {
  const id = parseInt(req.params.id);
  let userId = null;
  if (req.shimUser) {
    const svcUser = db.getServiceUserById(req.shimApp.id, id);
    if (svcUser && !policy.canViewQuota(req.shimPrincipal, svcUser)) return policy.forbid(res);
    userId = svcUser?.user_id;
  } else {
    const ku = db.prepare('SELECT rowid AS rid, user_id FROM known_users WHERE rowid = ?').get(id);
    userId = ku?.user_id;
  }
  const limits = userId ? db.getEffectiveLimits(userId) : null;
  const movieUsed = userId ? db.countRecentMovieRequests(userId, limits?.movieWindowDays || 7) : 0;
  const tvUsed = userId ? db.countRecentSeasonRequests(userId, limits?.seasonWindowDays || 7) : 0;
  res.json({
    movie: {
      days: limits?.movieWindowDays || 7,
      limit: limits?.movieLimit || 0,
      used: movieUsed,
      remaining: limits?.movieLimit ? Math.max(0, limits.movieLimit - movieUsed) : null,
    },
    tv: {
      days: limits?.seasonWindowDays || 7,
      limit: limits?.seasonLimit || 0,
      used: tvUsed,
      remaining: limits?.seasonLimit ? Math.max(0, limits.seasonLimit - tvUsed) : null,
    },
  });
});

// GET /api/v1/user/:id/watchlist — return empty watchlist (not implemented)
router.get('/user/:id/watchlist', (req, res) => {
  res.json({ pageInfo: { pages: 0, pageSize: 0, results: 0, page: 1 }, results: [] });
});

// GET /api/v1/user/:id/watch_data — stub (Tautulli watch data not used by shim)
router.get('/user/:id/watch_data', (req, res) => {
  res.json({ playCount: 0, playDuration: 0, userPercent: 0 });
});

// ── Status endpoints ──────────────────────────────────────────────────────────

// GET /api/v1/status
router.get('/status', (req, res) => {
  res.json({
    version: '2.0.0',
    commitTag: 'diskovarr',
    updateAvailable: false,
    commitsBehind: 0,
    restartRequired: false,
    databaseMigration: false,
  });
});

// GET /api/v1/status/appdata
router.get('/status/appdata', (req, res) => {
  res.json({ appData: true });
});

// ── Media lookup ──────────────────────────────────────────────────────────────

// Media entries are derived from requests, one per (tmdb_id, media_type): several
// users requesting a title yield one entry. Status is computed per title by
// shimRequests.mediaStatus (5 only when the title is in the library and no
// approved request for missing seasons is still open).
const isoTime = secs => new Date((secs || 0) * 1000).toISOString();

// Overseerr GET /media filters, by media status ('approved' is a legacy shim
// value: any approved request). Unknown/absent filters list everything.
const MEDIA_FILTERS = {
  available: m => m.status === 5,
  allavailable: m => m.status === 5 || m.status === 4,
  partial: m => m.status === 4,
  processing: m => m.status === 3,
  pending: m => m.status === 2,
  approved: m => m.approved > 0,
};

// GET /api/v1/media — list media items from requests
// (Overseerr clients may pass a `sort` query param; not applied here.)
router.get('/media', (req, res) => {
  const { take = '20', skip = '0', filter } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(take) || 20));
  const offset = Math.max(0, parseInt(skip) || 0);
  const matches = Object.hasOwn(MEDIA_FILTERS, filter) ? MEDIA_FILTERS[filter] : () => true;
  const media = shimRequests.listRequestedMedia(getLibraryIdSet()).filter(matches);
  res.json({
    pageInfo: { pages: Math.ceil(media.length / limit), pageSize: limit, results: media.length, page: Math.floor(offset / limit) + 1 },
    results: media.slice(offset, offset + limit).map(m => ({
      id: shimRequests.mediaIdFor(m.tmdb_id, m.media_type),
      mediaType: m.media_type,
      tmdbId: m.tmdb_id,
      status: m.status,
      createdAt: isoTime(m.first_requested_at),
      updatedAt: isoTime(m.last_requested_at),
    })),
  });
});

// Status of one media identity from its visible requests
function mediaStatusOf(tmdbId, mediaType, requests) {
  return shimRequests.mediaStatus({
    inLibrary: getLibraryIdSet().has(shimRequests.libraryKey(tmdbId, mediaType)),
    approved: requests.filter(r => r.status === 'approved').length,
    pending: requests.filter(r => r.status === 'pending').length,
    openSeasons: requests.filter(r => r.status === 'approved' && r.season_gated && !r.notified_available_at).length,
  });
}

// GET /api/v1/media/:id — media detail by shim media id or TMDB id (see
// mediaRef). For a bare TMDB id pass ?mediaType=movie|tv to pick between a movie
// and a show sharing it; otherwise the most recently requested one is returned.
// Not in Overseerr; Agregarr reads .status via GET /media/{tmdbId}.
router.get('/media/:id', (req, res) => {
  const ref = mediaRef(req);
  if (!ref) return res.status(400).json({ message: 'Invalid id' });
  const { tmdbId } = ref;
  const { mediaType } = shimRequests.resolveMediaType(shimRequests.mediaTypesFor(tmdbId), ref.hint);
  if (!mediaType) return res.status(404).json({ message: 'Media not found' });
  const requests = shimRequests.mediaRequests(tmdbId, mediaType);
  res.json({
    id: shimRequests.mediaIdFor(tmdbId, mediaType),
    mediaType,
    tmdbId,
    status: mediaStatusOf(tmdbId, mediaType, requests),
    createdAt: isoTime(Math.min(...requests.map(r => r.requested_at || 0))),
    updatedAt: isoTime(Math.max(...requests.map(r => r.requested_at || 0))),
    requests: requests.filter(r => policy.canViewRequest(req.shimPrincipal, r)).map(toOverseerrRequest),
  });
});

// DELETE /api/v1/media/:id — delete all requests for one title (TMDB id + type)
router.delete('/media/:id', policy.requirePermission(Permission.MANAGE_REQUESTS), (req, res) => {
  const ref = mediaRef(req);
  if (!ref) return res.status(400).json({ message: 'Invalid id' });
  const { tmdbId } = ref;
  const { mediaType, ambiguous } = shimRequests.resolveMediaType(shimRequests.mediaTypesFor(tmdbId), ref.hint);
  if (ambiguous) return res.status(409).json(AMBIGUOUS_MEDIA);
  if (mediaType) shimRequests.deleteMediaRequests(tmdbId, mediaType);
  res.json({});
});

// POST /api/v1/media/:id/:status — generic media status update. Only
// 'available' acts (notifies requesters); other statuses are derived from the
// library and requests, so they are acknowledged with the current status.
router.post('/media/:id/:status', policy.requirePermission(Permission.MANAGE_REQUESTS), (req, res) => {
  const ref = mediaRef(req);
  if (!ref) return res.status(400).json({ message: 'Invalid id' });
  const { tmdbId, hint } = ref;
  const media = (mediaType, status) => {
    const type = mediaType || shimRequests.normalizeMediaType(hint) || 'movie';
    return { id: shimRequests.mediaIdFor(tmdbId, type), mediaType: type, tmdbId, status };
  };
  if (req.params.status === 'available') {
    const { ambiguous, mediaType } = markMediaAvailable(tmdbId, hint);
    if (ambiguous) return res.status(409).json(AMBIGUOUS_MEDIA);
    return res.json(media(mediaType, 5));
  }
  const { mediaType } = shimRequests.resolveMediaType(shimRequests.mediaTypesFor(tmdbId), hint);
  const status = mediaType ? mediaStatusOf(tmdbId, mediaType, shimRequests.mediaRequests(tmdbId, mediaType)) : 1;
  res.json(media(mediaType, status));
});

// ── Settings endpoints ────────────────────────────────────────────────────────

// GET /api/v1/settings/discover
router.get('/settings/discover', (req, res) => {
  res.json([]);
});

// POST /api/v1/settings/discover/reset
router.post('/settings/discover/reset', (req, res) => {
  res.json([]);
});

// GET /api/v1/settings/plex
router.get('/settings/plex', (req, res) => {
  const c = db.getConnectionSettings();
  res.json({
    name: c.plexServerName || 'Plex',
    machineId: c.plexServerId || '',
    ip: '',
    port: 32400,
    useSsl: false,
    libraries: [],
    webAppUrl: '',
  });
});

// GET /api/v1/settings/plex/library
router.get('/settings/plex/library', (req, res) => {
  res.json({ results: [] });
});

// GET /api/v1/settings/jellyfin — stub for clients that probe it (mirrors
// /settings/plex). Host/port/ssl derive from the configured jellyfin_url;
// libraries are the jf_ entries of the synced-sections list.
router.get('/settings/jellyfin', (req, res) => {
  const c = db.getConnectionSettings();
  let hostname = '';
  let port = 8096;
  let useSsl = false;
  let urlBase = '';
  if (c.jellyfinUrl) {
    try {
      const u = new URL(c.jellyfinUrl);
      hostname = u.hostname;
      useSsl = u.protocol === 'https:';
      port = u.port ? Number(u.port) : (useSsl ? 443 : 80);
      urlBase = u.pathname.replace(/\/+$/, '');
    } catch { hostname = c.jellyfinUrl; }
  }
  const libraries = db.getSyncEnabledSections()
    .filter(s => String(s.id).startsWith('jf_'))
    .map(s => ({
      id: String(s.id).slice(3),
      name: s.title || String(s.id),
      enabled: !!s.enabled,
      type: s.type === 'show' ? 'show' : 'movie',
    }));
  res.json({
    name: 'Jellyfin',
    hostname,
    port,
    useSsl,
    urlBase,
    externalHostname: c.jellyfinUrl || '',
    jellyfinForgotPasswordUrl: '',
    libraries,
    serverId: '',
    apiKey: c.jellyfinApiKey ? '***' : '',
  });
});

// GET /api/v1/settings/jellyfin/library
router.get('/settings/jellyfin/library', (req, res) => {
  const libraries = db.getSyncEnabledSections()
    .filter(s => String(s.id).startsWith('jf_'))
    .map(s => ({ id: String(s.id).slice(3), name: s.title || String(s.id), enabled: !!s.enabled }));
  res.json(libraries);
});

// GET /api/v1/settings/radarr
router.get('/settings/radarr', (req, res) => {
  const c = db.getConnectionSettings();
  if (!c.radarrEnabled || !c.radarrUrl) return res.json([]);
  res.json([{
    id: 1, name: 'Radarr', hostname: c.radarrUrl,
    port: 7878, useSsl: false, apiKey: '***', baseUrl: '',
    activeProfileId: 0, activeProfileName: '',
    activeDirectory: '', is4kServer: false, isDefault: true, enabled: true,
  }]);
});

// GET /api/v1/settings/sonarr
router.get('/settings/sonarr', (req, res) => {
  const c = db.getConnectionSettings();
  if (!c.sonarrEnabled || !c.sonarrUrl) return res.json([]);
  res.json([{
    id: 1, name: 'Sonarr', hostname: c.sonarrUrl,
    port: 8989, useSsl: false, apiKey: '***', baseUrl: '',
    activeProfileId: 0, activeProfileName: '',
    activeDirectory: '', is4kServer: false, isDefault: true, enabled: true,
  }]);
});

// GET /api/v1/settings/notifications
router.get('/settings/notifications', (req, res) => {
  res.json({ results: [] });
});

// GET /api/v1/settings/about
router.get('/settings/about', (req, res) => {
  res.json({ version: '2.0.0', totalRequests: 0, totalMediaItems: 0 });
});

// GET /api/v1/settings/jobs
router.get('/settings/jobs', (req, res) => {
  res.json([
    { id: 'plex-recently-added-scan', name: 'Plex Recently Added Scan', type: 'process', interval: 300, nextExecutionTime: new Date(Date.now() + 300000).toISOString(), running: false },
    { id: 'plex-full-scan', name: 'Plex Full Library Scan', type: 'process', interval: 3600, nextExecutionTime: new Date(Date.now() + 3600000).toISOString(), running: false },
    { id: 'availability-sync', name: 'Availability Sync', type: 'process', interval: 300, nextExecutionTime: new Date(Date.now() + 300000).toISOString(), running: false },
  ]);
});

// POST /api/v1/settings/jobs/:jobId/run — trigger a sync job
router.post('/settings/jobs/:jobId/run', (req, res) => {
  const { jobId } = req.params;
  if (jobId === 'plex-full-scan' || jobId === 'plex-recently-added-scan' || jobId === 'availability-sync') {
    // Emit a cache-invalidation signal so the next request triggers a fresh library load
    _libCache.expiresAt = 0;
    logger.info(`[shim] Job triggered via API: ${jobId}`);
  }
  res.json({ message: 'Job triggered' });
});

// ── Search ────────────────────────────────────────────────────────────────────

// GET /api/v1/search?query=term&page=1 — multi-search proxied to TMDB
router.get('/search', async (req, res) => {
  const { query = '', page = '1' } = req.query;
  if (!query.trim()) return res.json({ page: 1, totalPages: 0, totalResults: 0, results: [] });
  if (!db.hasTmdbKey()) return res.json({ page: 1, totalPages: 0, totalResults: 0, results: [] });
  try {
    const json = await tmdb.tmdbFetchPublic(
      `/search/multi?query=${encodeURIComponent(query.trim())}&page=${parseInt(page) || 1}&include_adult=false`
    );
    const libIds = getLibraryIdSet();
    const requests = db.prepare('SELECT tmdb_id, media_type, status FROM discover_requests WHERE status != ? AND is_follow = 0').all('denied');
    const reqMap = new Map(requests.map(r => [`${r.tmdb_id}:${r.media_type}`, r.status]));
    const results = (json.results || []).map(item => {
      if (!['movie', 'tv'].includes(item.media_type)) return null;
      const key = `${item.id}:${item.media_type}`;
      const inLib = libIds.has(key);
      const reqStatus = reqMap.get(key);
      return {
        id: item.id,
        mediaType: item.media_type,
        title: item.title || item.name || null,
        originalTitle: item.original_title || item.original_name || null,
        releaseDate: item.release_date || item.first_air_date || null,
        posterPath: item.poster_path || null,
        backdropPath: item.backdrop_path || null,
        overview: item.overview || null,
        voteAverage: item.vote_average || 0,
        popularity: item.popularity || 0,
        mediaInfo: inLib ? { status: 5 }
          : reqStatus === 'approved' ? { status: 3 }
          : reqStatus === 'pending' ? { status: 2 }
          : null,
      };
    }).filter(Boolean);
    res.json({ page: json.page || 1, totalPages: json.total_pages || 1, totalResults: json.total_results || 0, results });
  } catch (err) {
    logger.warn('[shim] search error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Service endpoints ─────────────────────────────────────────────────────────

// GET /api/v1/service/radarr — list configured Radarr servers
router.get('/service/radarr', (req, res) => {
  const c = db.getConnectionSettings();
  if (!c.radarrEnabled || !c.radarrUrl) return res.json([]);
  res.json([{ id: 1, name: 'Radarr', hostname: c.radarrUrl, port: 7878, useSsl: false, isDefault: true, enabled: true, activeProfileId: 0, activeDirectory: '' }]);
});

// GET /api/v1/service/radarr/:id — single Radarr server
router.get('/service/radarr/:id', (req, res) => {
  const c = db.getConnectionSettings();
  if (!c.radarrEnabled || !c.radarrUrl) return res.status(404).json({ message: 'Not found' });
  res.json({ id: 1, name: 'Radarr', hostname: c.radarrUrl, port: 7878, useSsl: false, isDefault: true, enabled: true, activeProfileId: 0, activeDirectory: '' });
});

// GET /api/v1/service/sonarr — list configured Sonarr servers
router.get('/service/sonarr', (req, res) => {
  const c = db.getConnectionSettings();
  if (!c.sonarrEnabled || !c.sonarrUrl) return res.json([]);
  res.json([{ id: 1, name: 'Sonarr', hostname: c.sonarrUrl, port: 8989, useSsl: false, isDefault: true, enabled: true, activeProfileId: 0, activeDirectory: '' }]);
});

// GET /api/v1/service/sonarr/:id — single Sonarr server
router.get('/service/sonarr/:id', (req, res) => {
  const c = db.getConnectionSettings();
  if (!c.sonarrEnabled || !c.sonarrUrl) return res.status(404).json({ message: 'Not found' });
  res.json({ id: 1, name: 'Sonarr', hostname: c.sonarrUrl, port: 8989, useSsl: false, isDefault: true, enabled: true, activeProfileId: 0, activeDirectory: '' });
});

// ── Additional settings stubs ─────────────────────────────────────────────────

// GET /api/v1/settings/plex/devices/servers — available Plex servers stub
router.get('/settings/plex/devices/servers', (req, res) => {
  res.json({ results: [] });
});

// POST /api/v1/settings/plex/sync — trigger library sync (invalidate cache)
router.post('/settings/plex/sync', (req, res) => {
  _libCache.expiresAt = 0;
  process.emit('diskovarr:checkFulfilled');
  res.json({ running: true });
});

// GET /api/v1/settings/plex/sync — sync status stub
router.get('/settings/plex/sync', (req, res) => {
  res.json({ running: false });
});

// GET /api/v1/settings/tautulli — Tautulli config stub
router.get('/settings/tautulli', (req, res) => {
  res.json({ hostname: '', port: 8181, useSsl: false, urlBase: '', apiKey: '', externalIp: false, username: '', password: '', enabled: false });
});

// POST /api/v1/settings/tautulli — no-op
router.post('/settings/tautulli', (req, res) => {
  res.json({ hostname: '', port: 8181, useSsl: false, urlBase: '', apiKey: '', externalIp: false, username: '', password: '', enabled: false });
});

// POST /api/v1/settings/jobs/:jobId/cancel — stub
router.post('/settings/jobs/:jobId/cancel', (req, res) => {
  res.json({ message: 'Job cancelled' });
});

// GET /api/v1/genres/movie — movie genres from TMDB genre map
router.get('/genres/movie', (req, res) => {
  const { MOVIE_GENRE_MAP } = tmdb;
  if (!MOVIE_GENRE_MAP) return res.json([]);
  res.json(Object.entries(MOVIE_GENRE_MAP).map(([name, ids]) => ({ id: ids[0], name })));
});

// GET /api/v1/genres/tv — TV genres from TMDB genre map
router.get('/genres/tv', (req, res) => {
  const { TV_GENRE_MAP } = tmdb;
  if (!TV_GENRE_MAP) return res.json([]);
  res.json(Object.entries(TV_GENRE_MAP).map(([name, ids]) => ({ id: ids[0], name })));
});

// GET /api/v1/regions — stub (region list not stored locally)
router.get('/regions', (req, res) => {
  res.json([]);
});

// GET /api/v1/languages — stub
router.get('/languages', (req, res) => {
  res.json([]);
});

// GET /api/v1/backdrops — stub (trending backdrops)
router.get('/backdrops', (req, res) => {
  res.json([]);
});

// ── Issue endpoints ───────────────────────────────────────────────────────────

// Map Diskovarr issue scope to Overseerr problemType (1=video 2=audio 3=subtitle 4=other)
function scopeToProblemType(scope) {
  if (scope === 'video') return 1;
  if (scope === 'audio') return 2;
  if (scope === 'subtitle') return 3;
  return 4;
}

// Map Diskovarr issue status to Overseerr status (1=open 2=resolved)
function issueStatusToOverseerr(status) {
  return status === 'open' ? 1 : 2;
}

// Overseerr media ids are integers. A shim issue on a title outside the library
// is filed under its encoded media id (POST /issue), reported as it is. An issue
// on a library title with a TMDB id reports that title's shim media id, as
// requests do, unless the item's type contradicts the issue's (a legacy shim row
// holding a bare TMDB id that happens to equal some rating key). Otherwise the
// rating key gives a stable id folded below the encoded range
// (shimRequests.foldMediaId): Plex rating keys as they are, Jellyfin GUIDs as an
// FNV-1a hash.
function mediaIdOf(ratingKey, mediaType) {
  if (!ratingKey) return 0;
  const s = String(ratingKey);
  if (shimRequests.decodeMediaId(s)) return Number(s);
  const item = db.prepare('SELECT tmdb_id, type FROM library_items WHERE rating_key = ?').get(s);
  const issueType = shimRequests.normalizeMediaType(mediaType);
  const sameType = !issueType || issueType === shimRequests.normalizeMediaType(item?.type);
  const encoded = item?.tmdb_id && sameType ? shimRequests.encodeMediaId(item.tmdb_id, item.type) : null;
  if (encoded) return encoded;
  if (/^\d+$/.test(s)) return shimRequests.foldMediaId(Number(s));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return shimRequests.foldMediaId(h & 0x7fffffff);
}

function toOverseerrIssue(row, comments = null) {
  return {
    id: row.id,
    issueType: scopeToProblemType(row.scope),
    problemType: scopeToProblemType(row.scope),
    status: issueStatusToOverseerr(row.status),
    message: row.description || '',
    media: {
      id: mediaIdOf(row.rating_key, row.media_type),
      mediaType: row.media_type || 'movie',
      title: row.title || null,
      posterPath: row.poster_path || null,
    },
    requestedBy: {
      id: 1,
      username: row.username || row.user_id,
      displayName: row.username || row.user_id,
      email: `${(row.username || row.user_id).toLowerCase().replace(/\s+/g, '.')}@diskovarr.local`,
      avatar: '',
    },
    modifiedBy: null,
    comments: comments ? comments.map(c => ({
      id: c.id,
      message: c.comment,
      user: { id: 1, username: c.display_name, displayName: c.display_name, email: '', avatar: '' },
      createdAt: new Date((c.created_at || 0) * 1000).toISOString(),
      updatedAt: new Date((c.created_at || 0) * 1000).toISOString(),
    })) : [],
    createdAt: new Date((row.created_at || 0) * 1000).toISOString(),
    updatedAt: new Date((row.updated_at || row.created_at || 0) * 1000).toISOString(),
  };
}

// Issues may come from real Diskovarr users. Service-user keys follow Overseerr's
// issue permissions: VIEW_ISSUES / MANAGE_ISSUES to see everyone's, CREATE_ISSUES
// to raise (and then see/comment on/close) their own, MANAGE_ISSUES for the rest.

// Load the issue named by :id and authorise `allowed(principal, issue)`.
// Returns the row, or null after sending 404/403.
function authorizedIssue(req, res, allowed) {
  const issue = db.getIssueById(parseInt(req.params.id));
  if (!issue) { res.status(404).json({ message: 'Issue not found' }); return null; }
  if (!allowed(req.shimPrincipal, issue)) { policy.forbid(res); return null; }
  return issue;
}

// GET /api/v1/issue/count — issue counts by status
router.get('/issue/count', policy.requirePermission([Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES], 'or'), (req, res) => {
  const open     = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE status = 'open'").get()?.c || 0;
  const resolved = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE status = 'resolved'").get()?.c || 0;
  const closed   = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE status = 'closed'").get()?.c || 0;
  res.json({ open, resolved, closed, total: open + resolved + closed });
});

// GET /api/v1/issue — paginated issue list
router.get('/issue', (req, res) => {
  const { take = '20', skip = '0', filter } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(take) || 20));
  const offset = Math.max(0, parseInt(skip) || 0);
  const statusFilter = filter === 'open' ? 'open' : filter === 'resolved' ? 'resolved' : filter === 'closed' ? 'closed' : null;
  if (!policy.canListIssues(req.shimPrincipal)) return policy.forbid(res);
  const ownOnly = policy.canViewAllIssues(req.shimPrincipal) ? null : req.shimPrincipal.userId;
  const { rows, total } = db.getAllIssues(limit, offset, statusFilter, null, ownOnly);
  res.json({
    pageInfo: { pages: Math.ceil(total / limit) || 1, pageSize: limit, results: total, page: Math.floor(offset / limit) + 1 },
    results: rows.map(r => toOverseerrIssue(r)),
  });
});

// POST /api/v1/issue — create issue
router.post('/issue', (req, res) => {
  const body = req.body || {};
  const { issueType = 4, message = '' } = body;
  if (!body.mediaId) return res.status(400).json({ message: 'mediaId required' });
  if (!policy.canCreateIssue(req.shimPrincipal)) return policy.forbid(res);
  const userId = req.shimPrincipal.userId;
  // Overseerr's mediaId is the media.id the shim emits: decoded, it names one
  // exact title. Anything else is taken as a TMDB id with the body's mediaType,
  // as before. The issue is filed under the library item's rating key when the
  // library has the title, else under its encoded media id: rating keys stay
  // below 1e9, so a bare TMDB id can't be mistaken for an unrelated item's key.
  const media = shimRequests.decodeMediaId(body.mediaId);
  const mediaId = media ? media.tmdbId : body.mediaId;
  const mediaType = media ? media.mediaType : (body.mediaType || 'movie');
  const encoded = shimRequests.encodeMediaId(mediaId, mediaType);
  const libItem = encoded
    ? db.getLibraryItemByTmdbId(Number(mediaId), shimRequests.normalizeMediaType(mediaType))
    : null;
  let title = libItem?.title || null;
  try {
    const cached = db.getTmdbCache(mediaId, mediaType);
    title = cached?.title || title || String(mediaId);
  } catch {}
  const scopeMap = { 1: 'video', 2: 'audio', 3: 'subtitle', 4: 'series' };
  const issueId = db.createIssue({
    userId, ratingKey: libItem?.rating_key || String(encoded || mediaId), title: title || String(mediaId),
    mediaType, posterPath: null, scope: scopeMap[issueType] || 'series',
    scopeSeason: null, scopeEpisode: null, description: message,
  });
  const row = db.getIssueById(issueId);
  res.status(201).json(toOverseerrIssue(row));
});

// GET /api/v1/issue/:id — single issue with comments (BEFORE /:status route)
router.get('/issue/:id', (req, res) => {
  const issue = authorizedIssue(req, res, policy.canViewIssue);
  if (!issue) return;
  const comments = db.getIssueComments(issue.id);
  res.json(toOverseerrIssue(issue, comments));
});

// POST /api/v1/issue/:id/comment — add comment (BEFORE /:status route)
router.post('/issue/:id/comment', (req, res) => {
  const issue = authorizedIssue(req, res, policy.canActOnIssue);
  if (!issue) return;
  const { message = '' } = req.body || {};
  const userId = req.shimPrincipal.userId;
  const commentId = db.addIssueComment(issue.id, userId, message, false);
  const comment = db.prepare('SELECT ic.*, COALESCE(ku.username, ic.user_id) AS display_name FROM issue_comments ic LEFT JOIN known_users ku ON ku.user_id = ic.user_id WHERE ic.id = ?').get(commentId);
  res.status(201).json({
    id: comment.id,
    message: comment.comment,
    user: { id: 1, username: comment.display_name, displayName: comment.display_name, email: '', avatar: '' },
    createdAt: new Date((comment.created_at || 0) * 1000).toISOString(),
    updatedAt: new Date((comment.created_at || 0) * 1000).toISOString(),
  });
});

// POST /api/v1/issue/:id/:status — update issue status (open/resolved; Diskovarr also has closed)
router.post('/issue/:id/:status', (req, res) => {
  const { status } = req.params;
  if (!['open', 'resolved', 'closed'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
  const issue = authorizedIssue(req, res, policy.canActOnIssue);
  if (!issue) return;
  db.updateIssueStatus(issue.id, status);
  res.json(toOverseerrIssue(db.getIssueById(issue.id)));
});

// DELETE /api/v1/issue/:id
router.delete('/issue/:id', (req, res) => {
  const issue = authorizedIssue(req, res, policy.canActOnIssue);
  if (!issue) return;
  db.deleteIssue(issue.id);
  res.json({});
});

// GET /api/v1/issueComment/:id — get a single comment
router.get('/issueComment/:id', (req, res) => {
  const comment = db.prepare('SELECT ic.*, COALESCE(ku.username, ic.user_id) AS display_name FROM issue_comments ic LEFT JOIN known_users ku ON ku.user_id = ic.user_id WHERE ic.id = ?').get(parseInt(req.params.id));
  if (!comment) return res.status(404).json({ message: 'Comment not found' });
  if (!policy.canViewIssue(req.shimPrincipal, db.getIssueById(comment.issue_id))) return policy.forbid(res);
  res.json({ id: comment.id, message: comment.comment, user: { id: 1, username: comment.display_name, displayName: comment.display_name, email: '', avatar: '' }, createdAt: new Date((comment.created_at || 0) * 1000).toISOString(), updatedAt: new Date((comment.created_at || 0) * 1000).toISOString() });
});

// PUT /api/v1/issueComment/:id — update comment text
router.put('/issueComment/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(id);
  if (!comment) return res.status(404).json({ message: 'Comment not found' });
  if (!policy.canEditComment(req.shimPrincipal, comment)) return policy.forbid(res);
  const { message = '' } = req.body || {};
  db.prepare('UPDATE issue_comments SET comment = ? WHERE id = ?').run(message, id);
  const updated = db.prepare('SELECT ic.*, COALESCE(ku.username, ic.user_id) AS display_name FROM issue_comments ic LEFT JOIN known_users ku ON ku.user_id = ic.user_id WHERE ic.id = ?').get(id);
  res.json({ id: updated.id, message: updated.comment, user: { id: 1, username: updated.display_name, displayName: updated.display_name, email: '', avatar: '' }, createdAt: new Date((updated.created_at || 0) * 1000).toISOString(), updatedAt: new Date((updated.created_at || 0) * 1000).toISOString() });
});

// DELETE /api/v1/issueComment/:id — delete comment
router.delete('/issueComment/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(id);
  if (!comment) return res.status(404).json({ message: 'Comment not found' });
  if (!policy.canDeleteComment(req.shimPrincipal, comment)) return policy.forbid(res);
  db.deleteIssueComment(id, req.shimPrincipal.userId, true);
  res.json({});
});

// ── Notification settings stubs ───────────────────────────────────────────────

router.get('/settings/notifications/discord', (req, res) => {
  res.json({ enabled: false, types: { webhook: '' }, options: {} });
});
router.post('/settings/notifications/discord', (req, res) => { res.json({ enabled: false }); });

router.get('/settings/notifications/slack', (req, res) => { res.json({ enabled: false }); });
router.post('/settings/notifications/slack', (req, res) => { res.json({ enabled: false }); });

router.get('/settings/notifications/email', (req, res) => { res.json({ enabled: false }); });
router.post('/settings/notifications/email', (req, res) => { res.json({ enabled: false }); });

router.get('/settings/notifications/pushover', (req, res) => { res.json({ enabled: false }); });
router.post('/settings/notifications/pushover', (req, res) => { res.json({ enabled: false }); });

router.get('/settings/notifications/telegram', (req, res) => { res.json({ enabled: false }); });
router.post('/settings/notifications/telegram', (req, res) => { res.json({ enabled: false }); });

router.get('/settings/notifications/pushbullet', (req, res) => { res.json({ enabled: false }); });
router.post('/settings/notifications/pushbullet', (req, res) => { res.json({ enabled: false }); });

router.get('/settings/notifications/webpush', (req, res) => { res.json({ enabled: false }); });
router.post('/settings/notifications/webpush', (req, res) => { res.json({ enabled: false }); });

// ── Catch-all for unimplemented Overseerr endpoints ───────────────────────────
router.use((req, res) => {
  logger.debug(`[shim] Unhandled ${req.method} ${req.path}`);
  res.status(404).json({ message: 'Not implemented in Diskovarr shim' });
});

module.exports = router;
// Reused by the list sync job so auto-requests route like shim requests do
module.exports.pickService = pickService;
