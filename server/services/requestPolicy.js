// Request policy shared by every path that turns a title into an acquisition
// request (POST /api/request, queue edits, the watchlist auto-request worker):
//
//   • which download service a user may pick (direct_request_access),
//   • what a request costs against the user's quota (whole-show TV requests
//     cost every season the submission will actually fetch),
//   • per-user serialization of check → submit → insert so concurrent
//     requests can't both pass the same quota check,
//   • duplicate refusal, approval policy, submission and notifications,
//   • refusing titles the library holds only where the user can't see them.
//
// Connector submission itself stays in routes/api.js (submitRequestToService);
// it is resolved lazily so tests and callers can replace it on that module.
const db = require('../db/database');
const logger = require('./logger');
const tmdbService = require('./tmdb');
const notify = require('./requestNotifications');
const libraryAccess = require('./libraryAccess');

class RequestError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ── Restricted titles ────────────────────────────────────────────────────────
// A title is "restricted" for a user when the library holds it, but only in
// sections they can't access (Plex sharing / Jellyfin policy). Requesting it
// would fetch nothing they could watch and count as fulfilled at once, so it is
// refused; search flags it the same way (routes/api.js libraryIndexFor). Every
// section counts, not just the browse pool, so the flag and the refusal agree.
// Jellyfin rows only count while Jellyfin is enabled.
const RESTRICTED_MESSAGE = 'This title is in a library you don\'t have access to — ask the server owner';

const RESTRICTION_COLUMNS = 'rating_key, section_id, source, type, tmdb_id, tvdb_id';

function restrictionLookup(access, rows) {
  const jellyfinOn = require('./jellyfin/client').isEnabled();
  const allowed = new Set();
  const denied = new Set();
  for (const r of rows) {
    if (r.source === 'jellyfin' && !jellyfinOn) continue;
    const mediaType = r.type === 'show' ? 'tv' : 'movie';
    const into = libraryAccess.allows(access, r) ? allowed : denied;
    if (r.tmdb_id) into.add(`tmdb:${r.tmdb_id}:${mediaType}`);
    if (r.tvdb_id) into.add(`tvdb:${r.tvdb_id}:${mediaType}`);
  }
  return (tmdbId, tvdbId, mediaType) => {
    const keys = [];
    if (tmdbId) keys.push(`tmdb:${tmdbId}:${mediaType}`);
    if (tvdbId) keys.push(`tvdb:${tvdbId}:${mediaType}`);
    return keys.some(k => denied.has(k)) && !keys.some(k => allowed.has(k));
  };
}

/**
 * Lookup (tmdbId, tvdbId, mediaType 'movie'|'tv') → whether the title is
 * restricted for `access` (services/libraryAccess; null = unrestricted, never;
 * undefined = never looked up, sees no library). For marking many titles at
 * once (search results).
 */
function restrictedTitles(access) {
  if (access === null) return () => false;
  if (access === undefined) access = libraryAccess.NO_ACCESS;
  return restrictionLookup(access, db.prepare(
    `SELECT ${RESTRICTION_COLUMNS} FROM library_items WHERE tmdb_id IS NOT NULL OR tvdb_id IS NOT NULL`
  ).all());
}

/** One title: restrictedTitles' answer from just the rows that match it. */
function isRestrictedTitle({ access, tmdbId, tvdbId = null, mediaType }) {
  if (access === null || (!tmdbId && !tvdbId)) return false;
  access = access ?? libraryAccess.NO_ACCESS;
  const where = [];
  const params = [];
  if (tmdbId) { where.push('tmdb_id = ?'); params.push(String(tmdbId)); }
  if (tvdbId) { where.push('tvdb_id = ?'); params.push(String(tvdbId)); }
  const rows = db.prepare(`SELECT ${RESTRICTION_COLUMNS} FROM library_items WHERE ${where.join(' OR ')}`).all(...params);
  return restrictionLookup(access, rows)(tmdbId, tvdbId, mediaType);
}

// Throws the 409 POST /api/request and request edits answer for a restricted
// title. `access` undefined resolves the user's own (background callers).
function checkLibraryAccess({ userId, access, tmdbId, tvdbId = null, mediaType }) {
  const resolved = access === undefined ? libraryAccess.forUser(userId) : access;
  if (isRestrictedTitle({ access: resolved, tmdbId, tvdbId, mediaType })) {
    throw new RequestError(409, RESTRICTED_MESSAGE, { restricted: true });
  }
}

function submitRequestToService(data) {
  return require('../routes/api').submitRequestToService(data);
}

// Admins and the users an admin elevated to request managers.
function isPrivilegedSession(session) {
  if (!session?.plexUser) return false;
  if (session.isAdmin || session.isPlexAdminUser) return true;
  return db.getPrivilegedUserIds().includes(String(session.plexUser.id));
}

function serviceAvailability() {
  const c = db.getConnectionSettings();
  return {
    overseerr: !!(c.overseerrEnabled && c.overseerrUrl),
    radarr: !!(c.radarrEnabled && c.radarrUrl),
    sonarr: !!(c.sonarrEnabled && c.sonarrUrl),
    riven: !!(c.rivenEnabled && c.rivenUrl),
    configuredDefault: c.defaultRequestService || 'overseerr',
  };
}

// The concrete service the request dialog's main "Request" button sends for a
// media type — mirrors RequestModal's defaultSvc resolution exactly.
function resolveDefaultService(mediaType, { tvdbOnly = false } = {}) {
  const s = serviceAvailability();
  const directSvc = mediaType === 'movie' ? 'radarr' : 'sonarr';
  const hasDirect = s[directSvc];
  const sideCount = [s.overseerr, s.riven, s.radarr || s.sonarr].filter(Boolean).length;
  const configured = sideCount >= 2 ? s.configuredDefault : null;
  const available = tvdbOnly ? { [directSvc]: hasDirect } : { overseerr: s.overseerr, riven: s.riven, [directSvc]: hasDirect };
  const raw = configured === 'direct' ? directSvc : configured;
  if (raw && available[raw]) return raw;
  if (!tvdbOnly && s.overseerr) return 'overseerr';
  if (!tvdbOnly && s.riven) return 'riven';
  if (hasDirect) return directSvc;
  return 'none';
}

function directAccessAdminOnly() {
  return db.getDirectRequestAccess() === '1';
}

// Whether the YouTube downloader can take requests — the same condition that
// shows the request dialog's YouTube option (/api/explore/services `tuberr`).
function youtubeRequestsEnabled() {
  const c = db.getConnectionSettings();
  return !!(c.youtubeEnabled && c.sonarrEnabled && c.sonarrUrl && c.tuberrUrl && c.tuberrApiKey);
}

// Server-side twin of the request dialog's "Advanced → Send to Radarr/Sonarr
// instead" gate. When the admin restricted direct access, a non-privileged
// user may still reach Radarr/Sonarr when it *is* the default app (a TVDB-only
// show's only app is Sonarr), through the YouTube downloader (always Sonarr,
// only while the admin has it enabled), or by keeping a request's existing
// routing on edit — but never pick it as an alternate. tvdbOnly must be a
// server-checked fact (createRequest verifies it against TMDB).
function checkServiceAccess({ service, mediaType, tvdbOnly = false, downloader, privileged = false, currentService = null }) {
  if (service === 'radarr' && mediaType !== 'movie') throw new RequestError(400, 'Radarr only handles movies');
  if (service === 'sonarr' && mediaType !== 'tv') throw new RequestError(400, 'Sonarr only handles TV shows');
  if (privileged || !directAccessAdminOnly()) return;
  if (service !== 'radarr' && service !== 'sonarr') return;
  if (currentService && service === currentService) return;
  if (downloader === 'youtube' && youtubeRequestsEnabled()) return;
  if (service === resolveDefaultService(mediaType, { tvdbOnly })) return;
  throw new RequestError(403, `Only admins can send requests directly to ${service === 'radarr' ? 'Radarr' : 'Sonarr'}`);
}

function parseSeasonList(json) {
  try {
    const list = json ? JSON.parse(json) : null;
    return Array.isArray(list) && list.length ? list.map(Number) : null;
  } catch { return null; }
}

// Explicit season selection → sorted unique numbers, or null for "whole show".
function normalizeSeasons(seasons) {
  if (seasons == null) return null;
  if (!Array.isArray(seasons)) throw new RequestError(400, 'seasons must be an array');
  const nums = [...new Set(seasons.map(Number))];
  // YouTube series in Sonarr number their seasons by year (2026)
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 9999)) throw new RequestError(400, 'Invalid season number');
  return nums.length ? nums.sort((a, b) => a - b) : null;
}

// Every regular season TMDB lists for a show, or null when unknown.
async function tmdbSeasonNumbers(tmdbId) {
  if (!tmdbId) return null;
  const details = await Promise.resolve(tmdbService.getItemDetails(tmdbId, 'tv')).catch(() => null);
  const listed = (details?.seasonDetails || []).map(s => Number(s.number)).filter(n => n > 0);
  if (listed.length) return listed;
  const count = Number(details?.numberOfSeasons);
  return count > 0 ? Array.from({ length: count }, (_, i) => i + 1) : null;
}

// Every regular season Sonarr's lookup lists for a TVDB id (shows TMDB doesn't
// carry), or null when unknown.
async function sonarrSeasonNumbers(tvdbId) {
  const c = db.getConnectionSettings();
  if (!tvdbId || !c.sonarrEnabled || !c.sonarrUrl || !c.sonarrApiKey) return null;
  try {
    const r = await fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3/series/lookup?term=tvdb:${encodeURIComponent(tvdbId)}`, {
      headers: { 'X-Api-Key': c.sonarrApiKey }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const listed = ((Array.isArray(data) && data[0]?.seasons) || []).map(s => Number(s.seasonNumber)).filter(n => n > 0);
    return listed.length ? listed : null;
  } catch { return null; }
}

// What a request will fetch and therefore cost. An explicit list costs its
// length; a whole-show request costs every regular season TMDB lists — or, for
// a TVDB-only show, Sonarr lists (what Overseerr's 'all' / Sonarr's
// monitor-all submission acquires). cost is null when the season count can't
// be determined. coversAll: an explicit list that names every known season.
async function resolveSeasonPlan({ tmdbId, tvdbId = null, mediaType, seasons }) {
  if (mediaType !== 'tv') return { seasons: null, cost: 1, allSeasons: null, coversAll: false };
  const explicit = normalizeSeasons(seasons);
  const all = tmdbId ? await tmdbSeasonNumbers(tmdbId) : await sonarrSeasonNumbers(tvdbId);
  if (explicit) {
    const coversAll = !!all && all.every(n => explicit.includes(n));
    return { seasons: explicit, cost: explicit.length, allSeasons: all, coversAll };
  }
  return { seasons: null, cost: all ? all.length : null, allSeasons: all, coversAll: true };
}

// Whether a request must wait for its specific seasons (not just the show) to
// count as available. Always for a subset of the show's seasons; for a list
// naming every season only when the show is already in the library — then
// "the show is present" says nothing about the requested seasons.
function isSeasonGated(plan, { tmdbId, tvdbId = null }) {
  if (!plan.seasons) return false;
  if (!plan.coversAll) return true;
  return db.getLibraryShowsForRequest({ tmdb_id: tmdbId, tvdb_id: tvdbId }).length > 0;
}

// A whole-show selection on a show the library already has must name its
// seasons: the show's presence says nothing about them, and the season check
// needs an explicit list to verify (F13). Cost is unchanged.
function pinLibrarySeasons(plan, { tmdbId, tvdbId = null }) {
  if (plan.seasons || !plan.allSeasons) return plan;
  if (db.getLibraryShowsForRequest({ tmdb_id: tmdbId, tvdb_id: tvdbId }).length === 0) return plan;
  return { ...plan, seasons: plan.allSeasons, coversAll: true };
}

// What an existing row already charges inside a quota window.
function chargedInWindow(row, windowDays) {
  if (!row || row.status === 'denied' || row.is_follow) return 0;
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  if (!(row.requested_at > since)) return 0;
  return row.media_type === 'tv' ? (Number(row.seasons_count) || 1) : 1;
}

// Rolling-window quota. `replacing` is the row an edit re-prices: its current
// charge is swapped for the new cost instead of being added to it.
function checkQuota(userId, mediaType, cost, { replacing = null } = {}) {
  const limits = db.getEffectiveLimits(userId);
  if (!limits) return;
  const days = (n) => `${n} day${n !== 1 ? 's' : ''}`;
  if (mediaType === 'movie' && limits.movieLimit > 0) {
    const previousCost = chargedInWindow(replacing, limits.movieWindowDays);
    const recent = db.countRecentMovieRequests(userId, limits.movieWindowDays) - previousCost;
    if (recent + 1 > limits.movieLimit) {
      throw new RequestError(429, `Movie request limit reached: ${limits.movieLimit} per ${days(limits.movieWindowDays)}. Try again later.`);
    }
  }
  if (mediaType === 'tv' && limits.seasonLimit > 0) {
    const seasons = cost;
    if (seasons == null) {
      throw new RequestError(503, 'Could not determine how many seasons this show has. Pick the seasons to request, or try again later.');
    }
    const previousCost = chargedInWindow(replacing, limits.seasonWindowDays);
    const recent = db.countRecentSeasonRequests(userId, limits.seasonWindowDays) - previousCost;
    if (recent + seasons > limits.seasonLimit) {
      const remaining = Math.max(0, limits.seasonLimit - recent);
      throw new RequestError(429, `Season request limit reached: ${limits.seasonLimit} per ${days(limits.seasonWindowDays)}. You can request ${remaining} more season${remaining !== 1 ? 's' : ''}.`);
    }
  }
}

// The user's own unfulfilled request that already covers this one: any live
// movie request, or TV requests whose seasons include every requested season.
function findDuplicate({ userId, tmdbId, tvdbId, mediaType, plan, excludeId = null }) {
  const rows = db.getActiveRequestsForTitle({ tmdbId, tvdbId, mediaType, userId })
    .filter(r => r.id !== excludeId && !r.notified_available_at);
  if (rows.length === 0) return null;
  if (mediaType !== 'tv') return rows[0];
  const covered = new Set();
  for (const r of rows) {
    const list = parseSeasonList(r.seasons_json);
    if (!list) return r; // whole-show request covers everything
    list.forEach(n => covered.add(n));
  }
  const wanted = plan.seasons || plan.allSeasons;
  return wanted && wanted.every(n => covered.has(n)) ? rows[0] : null;
}

// A follower who then requests the title themselves: retire the follow rows
// the new request covers, so the title isn't listed (and announced available)
// twice. A TV follow for seasons the request leaves out is kept.
function dropCoveredFollows({ userId, tmdbId, tvdbId, mediaType, seasons }) {
  const follows = db.prepare(`
    SELECT id, seasons_json FROM discover_requests
    WHERE user_id = ? AND media_type = ? AND is_follow = 1 AND notified_available_at IS NULL
      AND ((tmdb_id = ? AND tmdb_id != 0) OR (tvdb_id IS NOT NULL AND tvdb_id = ?))
  `).all(String(userId), String(mediaType), Number(tmdbId) || 0, Number(tvdbId) || 0);
  const drop = db.prepare('DELETE FROM discover_requests WHERE id = ?');
  for (const f of follows) {
    const followed = parseSeasonList(f.seasons_json);
    if (mediaType !== 'tv' || !seasons || (followed && followed.every(n => seasons.includes(n)))) drop.run(f.id);
  }
}

// One in-flight request decision per user. The process is single-node, so an
// in-memory promise chain is enough to make check → submit → insert atomic.
const userLocks = new Map();
async function withUserLock(userId, fn) {
  const key = String(userId);
  const previous = userLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => mine);
  userLocks.set(key, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === tail) userLocks.delete(key);
  }
}

// Deny a request under its owner's request lock, so a deny can neither race an
// approval that is still submitting nor be overwritten by it afterwards: if the
// row changed while this waited for the lock, nothing is written and
// `conflict` is returned. Followers left without a live request are dropped
// and the requester is told (once — re-denying stays quiet).
async function denyRequest(found, note = null) {
  return withUserLock(found.user_id, async () => {
    const row = db.getRequestById(found.id);
    if (!row) return { request: null };
    if (row.status !== found.status) return { conflict: true, request: row };
    db.updateRequestStatus(row.id, 'denied', note || null);
    db.pruneOrphanFollowers(row);
    if (row.status !== 'denied') notify.notifyDenied(row, note || null);
    return { request: db.getRequestById(row.id) };
  });
}

// Create (and when auto-approved, submit) a request for one user. Throws a
// RequestError carrying the HTTP status for policy refusals and submission
// failures; nothing is stored when it throws. `access` is the requester's
// library access (req.libraryAccess); omitted, it is looked up from userId.
async function createRequest({
  userId, username, tmdbId, tvdbId = null, mediaType, title, service,
  seasons = null, downloader, youtube, privileged = false, origin = 'request', access,
}) {
  if (downloader === 'youtube' && !youtubeRequestsEnabled()) {
    throw new RequestError(400, 'YouTube requests are not enabled');
  }
  let tvdbOnly = !tmdbId && !!tvdbId;
  if (tvdbOnly && mediaType === 'tv') {
    // "Not on TMDB" is the client's word; check it. A show TMDB knows takes the
    // TMDB path, so the direct-access gate and TMDB season pricing apply.
    const found = await Promise.resolve(tmdbService.tmdbFetchPublic(`/find/${encodeURIComponent(tvdbId)}?external_source=tvdb_id`))
      .catch(() => undefined);
    const knownId = Number(found?.tv_results?.[0]?.id) || null;
    if (knownId) {
      tmdbId = knownId;
      tvdbOnly = false;
    } else if (found === undefined && !privileged && directAccessAdminOnly() && downloader !== 'youtube') {
      throw new RequestError(503, 'Could not check this show with TMDB. Try again later.');
    }
  }
  checkServiceAccess({ service, mediaType, tvdbOnly, downloader, privileged });
  checkLibraryAccess({ userId, access, tmdbId, tvdbId, mediaType });
  const plan = pinLibrarySeasons(await resolveSeasonPlan({ tmdbId, tvdbId, mediaType, seasons }), { tmdbId, tvdbId });

  return withUserLock(userId, async () => {
    const dup = findDuplicate({ userId, tmdbId, tvdbId, mediaType, plan });
    if (dup) {
      throw new RequestError(409, `You already have an active request for "${dup.title || title}"`, { requestId: dup.id });
    }
    checkQuota(userId, mediaType, plan.cost);

    const seasonsCount = plan.cost || 1;
    const autoApprove = db.getEffectiveAutoApprove(userId, mediaType);
    const posterUrl = db.getTmdbCache(tmdbId, mediaType)?.posterUrl || null;
    // Specific seasons are only fulfilled once those seasons are in the library
    const extras = { tvdbId, downloader, youtube, seasonGated: mediaType === 'tv' && isSeasonGated(plan, { tmdbId, tvdbId }) };
    const who = username || userId;

    if (!autoApprove) {
      const requestId = db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title || '', service, seasonsCount, 'pending', plan.seasons, posterUrl, extras);
      dropCoveredFollows({ userId, tmdbId, tvdbId, mediaType, seasons: plan.seasons });
      logger.info(`Request queued (pending approval): user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}" service=${service} origin=${origin}`);
      notify.notifyPending({ title, tmdbId, mediaType, username: who, posterUrl });
      return { requestId, status: 'pending', service };
    }

    if (service !== 'none') {
      try {
        await submitRequestToService({ tmdbId, mediaType, title, service, seasons: plan.seasons, tvdbId, downloader, youtube });
      } catch (err) {
        logger.warn(`Request submission failed: user=${userId} tmdbId=${tmdbId} service=${service} origin=${origin}: ${err.message}`);
        notify.notifyProcessFailed({ title, tmdbId, mediaType, error: err, posterUrl });
        throw new RequestError(500, 'Request failed: ' + err.message);
      }
    }
    const requestId = db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, title || '', service, seasonsCount, 'approved', plan.seasons, posterUrl, extras);
    dropCoveredFollows({ userId, tmdbId, tvdbId, mediaType, seasons: plan.seasons });
    logger.info(`Request submitted: user=${userId} tmdbId=${tmdbId} type=${mediaType} title="${title}" service=${service} origin=${origin}`);
    notify.notifyAutoApproved({ requestId, userId, title, tmdbId, mediaType, username: who, posterUrl });
    return { requestId, status: 'approved', service };
  });
}

// "Notify me when available": subscribe to someone else's live request. The
// follower row acquires nothing (is_follow) — it exists so the availability
// notification reaches this user too.
function followRequest({ userId, tmdbId, mediaType, title }) {
  // The user's own live, unfulfilled request or follow already gets the notice
  const own = db.prepare(`
    SELECT id FROM discover_requests WHERE user_id = ? AND tmdb_id = ? AND media_type = ?
      AND status IN ('pending', 'approved') AND notified_available_at IS NULL LIMIT 1
  `).get(String(userId), Number(tmdbId), String(mediaType));
  if (own) return { alreadyFollowing: true, requestId: own.id };
  const live = db.getActiveRequestsForTitle({ tmdbId, mediaType });
  const target = live.find(r => !r.notified_available_at) || null;
  if (!target) {
    // requestable: the client offers the request flow instead (its card was stale)
    throw new RequestError(409, live.length
      ? 'This title is already available.'
      : 'Nothing to follow: nobody has an active request for this title.', { requestable: true });
  }
  const requestId = db.addDiscoverRequestWithStatus(
    userId, Number(tmdbId), mediaType, title || target.title || '', 'none', target.seasons_count || 1, 'approved',
    parseSeasonList(target.seasons_json), target.poster_url,
    { tvdbId: target.tvdb_id, isFollow: true, seasonGated: !!target.season_gated }
  );
  return { alreadyFollowing: false, requestId, followsRequestId: target.id };
}

module.exports = {
  RequestError,
  RESTRICTED_MESSAGE,
  restrictedTitles,
  isRestrictedTitle,
  checkLibraryAccess,
  isPrivilegedSession,
  resolveDefaultService,
  checkServiceAccess,
  youtubeRequestsEnabled,
  parseSeasonList,
  normalizeSeasons,
  resolveSeasonPlan,
  isSeasonGated,
  pinLibrarySeasons,
  checkQuota,
  findDuplicate,
  withUserLock,
  denyRequest,
  createRequest,
  followRequest,
};
