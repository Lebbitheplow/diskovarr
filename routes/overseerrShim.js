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

// ── Shim auth middleware ───────────────────────────────────────────────────────
// Sets req.shimApp (always) and req.shimUser (if request is from a service user key)

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
    return next();
  }

  // Try app-level (admin) key
  const app = db.getApiAppByKey(apiKey);
  if (app) {
    req.shimApp = app;
    req.shimUser = null; // admin-level, no specific service user
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

// Overseerr status: 1=PENDING 2=APPROVED 3=DECLINED 4=PARTIALLY_APPROVED 5=FAILED
function toOverseerrStatus(diskoStatus) {
  if (diskoStatus === 'approved') return 2;
  if (diskoStatus === 'denied')   return 3;
  return 1; // pending
}

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
      id: row.tmdb_id,
      mediaType: row.media_type,
      media_type: row.media_type, // snake_case alias — DUMB accesses data.media_type in its fallback path
      tmdbId: row.tmdb_id,
      // DUMB filters for status==2 (approved) && media.status==3 (processing).
      // Use 5 (Available) when already in Plex library, 3 (Processing) for approved
      // but not yet downloaded, 2 (Pending) for pending requests.
      status: getLibraryIdSet().has(`${row.tmdb_id}:${row.media_type === 'tv' ? 'tv' : 'movie'}`) ? 5
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

// ── GET /api/v1/settings/main ─────────────────────────────────────────────────
// Agregarr checks this to confirm it's talking to Overseerr
router.get('/settings/main', (req, res) => {
  res.json({
    applicationTitle: 'Diskovarr',
    applicationUrl: '',
    hideAvailable: false,
    localLogin: true,
    newPlexLogin: false,
    defaultPermissions: 32,
    version: '2.0.0',
  });
});

// ── User management ───────────────────────────────────────────────────────────

// POST /api/v1/user — Agregarr creates service users here
router.post('/user', (req, res) => {
  const { username, email, permissions = 0 } = req.body || {};
  if (!username) return res.status(400).json({ message: 'username required' });

  // Only app-level (admin) key can create users
  if (req.shimUser) return res.status(403).json({ message: 'Forbidden' });

  try {
    const svcUser = db.createServiceUser(req.shimApp.id, { username, email, permissions });
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
  // Bot/service user_ids start with '__'; real Plex user_ids are numeric.
  const rows = db.prepare(`
    SELECT ku.rowid AS rid, ku.user_id, ku.username, ku.thumb,
           COUNT(dr.id) AS requestCount
    FROM known_users ku
    LEFT JOIN discover_requests dr ON dr.user_id = ku.user_id
    WHERE ku.user_id GLOB '[0-9]*'
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

// PUT /api/v1/user/:id — Agregarr updates permissions
router.put('/user/:id', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  const { permissions } = req.body || {};
  if (permissions !== undefined) {
    db.prepare('UPDATE app_service_users SET permissions = ? WHERE id = ?')
      .run(Number(permissions), svcUser.id);
  }
  res.json(shimUserObj(db.prepare('SELECT * FROM app_service_users WHERE id = ?').get(svcUser.id)));
});

// POST /api/v1/user/:id/settings — no-op, just return success
router.post('/user/:id/settings', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  res.json(shimUserObj(svcUser));
});

// POST /api/v1/user/:id/settings/notifications — Agregarr updates notification prefs
router.post('/user/:id/settings/notifications', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  res.json({ notificationTypes: {}, pgpKey: null });
});

// POST /api/v1/user/:id/settings/permissions — Agregarr sets permissions before requests
router.post('/user/:id/settings/permissions', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  const { permissions } = req.body || {};
  if (permissions !== undefined) {
    db.prepare('UPDATE app_service_users SET permissions = ? WHERE id = ?')
      .run(Number(permissions), svcUser.id);
  }
  res.json(shimUserObj(db.prepare('SELECT * FROM app_service_users WHERE id = ?').get(svcUser.id)));
});

// GET /api/v1/user/:id/settings
router.get('/user/:id/settings', (req, res) => {
  const svcUser = db.getServiceUserById(req.shimApp.id, parseInt(req.params.id));
  if (!svcUser) return res.status(404).json({ message: 'User not found' });
  res.json({ discordId: '', locale: '', region: null, originalLanguage: null, pgpKey: null });
});

// ── Request endpoints ─────────────────────────────────────────────────────────

// POST /api/v1/request — Agregarr submits a media request
router.post('/request', async (req, res) => {
  const { mediaId, mediaType, seasons, is4k } = req.body || {};
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
        media: { id: Number(mediaId), mediaType, tmdbId: Number(mediaId), status: 1 },
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
            media: { id: Number(mediaId), mediaType, tmdbId: Number(mediaId), status: 1 },
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
            media: { id: Number(mediaId), mediaType, tmdbId: Number(mediaId), status: 1 },
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
        media: { id: Number(mediaId), mediaType, tmdbId: Number(mediaId), status: 5 },
        seasons: seasonsArray ? seasonsArray.map(n => ({ id: n, seasonNumber: n, status: 5 })) : [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        requestedBy: resolvedSvcUser ? shimUserObj(resolvedSvcUser) : shimAdminObj(req.shimApp),
        modifiedBy: null, is4k: false, serverId: 0, profileId: 0, rootFolder: '',
      });
    }

    // Check for an existing non-denied request for this title
    const existing = db.prepare(
      `SELECT * FROM discover_requests WHERE tmdb_id = ? AND media_type = ? AND status != 'denied' ORDER BY id DESC LIMIT 1`
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

// GET /api/v1/request — Agregarr fetches existing requests for dedup cache
router.get('/request', (req, res) => {
  const { filter, take = '100', skip = '0' } = req.query;
  const limit = Math.min(500, Math.max(1, parseInt(take) || 100));
  const offset = Math.max(0, parseInt(skip) || 0);
  const statusFilter = filter === 'pending' ? 'pending'
    : filter === 'approved' ? 'approved'
    : filter === 'declined' ? 'denied'
    : null;
  const { rows, total } = db.getAllRequests(limit, offset, statusFilter);
  res.json({
    pageInfo: { pages: Math.ceil(total / limit), pageSize: limit, results: total, page: Math.floor(offset / limit) + 1 },
    results: rows.map(toOverseerrRequest),
  });
});

// POST /api/v1/request/:id/approve
router.post('/request/:id/approve', async (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Request not found' });
  try {
    const service = request.service || pickService(request.media_type);
    if (service !== 'none') {
      const { submitRequestToService } = require('./api');
      const seasons = request.seasons_json ? JSON.parse(request.seasons_json) : null;
      await submitRequestToService({ tmdbId: request.tmdb_id, mediaType: request.media_type, title: request.title, service, seasons });
    }
    db.updateRequestStatus(request.id, 'approved');
    res.json(toOverseerrRequest(db.getRequestById(request.id)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/v1/request/:id/decline
router.post('/request/:id/decline', (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Request not found' });
  db.updateRequestStatus(request.id, 'denied', req.body?.reason || null);
  res.json(toOverseerrRequest(db.getRequestById(request.id)));
});

// DELETE /api/v1/request/:id
router.delete('/request/:id', (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Request not found' });
  db.deleteRequest(request.id);
  res.json({ message: 'Request deleted' });
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

// GET /api/v1/request/count — DUMB polls this for queue depth; Homarr uses for stats
router.get('/request/count', (req, res) => {
  const pending  = db.getAllRequests(500, 0, 'pending').total;
  const approved = db.getAllRequests(500, 0, 'approved').total;
  const declined = db.getAllRequests(500, 0, 'denied').total;
  const counts = db.prepare(`
    SELECT media_type, status, COUNT(*) AS cnt
    FROM discover_requests
    GROUP BY media_type, status
  `).all();
  let movie = 0, tv = 0;
  for (const row of counts) {
    if (row.status !== 'denied') {
      if (row.media_type === 'movie') movie += row.cnt;
      else if (row.media_type === 'tv') tv += row.cnt;
    }
  }
  res.json({ pending, approved, declined, available: 0, processing: 0, failed: 0, total: pending + approved + declined, movie, tv });
});

// GET /api/v1/request/:id — get single request by ID
router.get('/request/:id', (req, res) => {
  const request = db.getRequestById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Request not found' });
  res.json(toOverseerrRequest(request));
});

// PUT /api/v1/media/:id/available — DUMB calls this after downloading content
router.put('/media/:id/available', (req, res) => {
  const tmdbId = parseInt(req.params.id);
  if (!tmdbId) return res.status(400).json({ message: 'Invalid media id' });
  const request = db.prepare(
    `SELECT * FROM discover_requests WHERE tmdb_id = ? AND status = 'approved' ORDER BY requested_at DESC LIMIT 1`
  ).get(tmdbId);
  if (!request) return res.status(404).json({ message: 'No approved request found for this media' });
  db.markRequestsNotifiedAvailable([request.id]);
  process.emit('diskovarr:checkFulfilled');
  logger.info(`[shim] DUMB marked tmdbId=${tmdbId} available — request #${request.id}`);
  res.json(toOverseerrRequest(request));
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

  const rows = db.prepare(
    'SELECT * FROM discover_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT ? OFFSET ?'
  ).all(userId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM discover_requests WHERE user_id = ?').get(userId)?.c || 0;

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

// GET /api/v1/media — list media items from requests
router.get('/media', (req, res) => {
  const { take = '20', skip = '0', filter, sort = 'added' } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(take) || 20));
  const offset = Math.max(0, parseInt(skip) || 0);
  const statusFilter = filter === 'pending' ? 'pending'
    : filter === 'approved' ? 'approved'
    : filter === 'available' ? 'approved'
    : null;
  const { rows, total } = db.getAllRequests(limit, offset, statusFilter);
  const libIds = getLibraryIdSet();
  const results = rows.map(row => {
    const inLib = libIds.has(`${row.tmdb_id}:${row.media_type === 'tv' ? 'tv' : 'movie'}`);
    return {
      id: row.tmdb_id,
      mediaType: row.media_type,
      tmdbId: row.tmdb_id,
      status: inLib ? 5 : row.status === 'approved' ? 3 : 2,
      createdAt: new Date((row.requested_at || 0) * 1000).toISOString(),
      updatedAt: new Date((row.requested_at || 0) * 1000).toISOString(),
    };
  });
  res.json({
    pageInfo: { pages: Math.ceil(total / limit), pageSize: limit, results: total, page: Math.floor(offset / limit) + 1 },
    results,
  });
});

// GET /api/v1/media/:id — media detail by TMDB id
router.get('/media/:id', async (req, res) => {
  const tmdbId = parseInt(req.params.id);
  if (!tmdbId) return res.status(400).json({ message: 'Invalid id' });
  // Check for an existing request
  const request = db.prepare(
    'SELECT * FROM discover_requests WHERE tmdb_id = ? ORDER BY id DESC LIMIT 1'
  ).get(tmdbId);
  if (!request) return res.status(404).json({ message: 'Media not found' });
  const inLib = getLibraryIdSet().has(`${tmdbId}:${request.media_type === 'tv' ? 'tv' : 'movie'}`);
  res.json({
    id: tmdbId,
    mediaType: request.media_type,
    tmdbId,
    status: inLib ? 5 : request.status === 'approved' ? 3 : 2,
    createdAt: new Date((request.requested_at || 0) * 1000).toISOString(),
    updatedAt: new Date((request.requested_at || 0) * 1000).toISOString(),
    requests: [toOverseerrRequest(request)],
  });
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
