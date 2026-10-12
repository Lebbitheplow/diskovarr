// Watchlist auto-request: titles a user adds to their Plex Watchlist that the
// library doesn't have become requests, under the same policy as a manual
// request (quota, auto-approve, duplicate checks, the admin's default app).
//
// Enabled per media type by Admin → Users → Auto-Request Watchlist (every user)
// or by the per-user "Auto-request … from watchlist" flags (that user only).
// Only *additions* count: the first pass after the feature turns on for a user
// records their current watchlist as a baseline and requests nothing, so
// enabling it (or deploying this worker onto settings saved while it did
// nothing) never bulk-requests an existing watchlist. Titles removed from the
// watchlist are forgotten, so re-adding one later counts as a new addition.
//
// Jellyfin Favorites can only hold items already in the library, so there is
// never anything to request from them; the Plex Watchlist is the source.
const db = require('../db/database');
const logger = require('./logger');
const policy = require('./requestPolicy');

const MEDIA_TYPES = ['movie', 'tv'];
const GLOBAL_KEYS = { movie: 'auto_request_watchlist_movies', tv: 'auto_request_watchlist_tv' };
const USER_FLAGS = { movie: 'auto_request_movies', tv: 'auto_request_tv' };
const MAX_ATTEMPTS = 3;          // connector failures before a title is given up on
const MAX_REQUESTS_PER_RUN = 10; // per user per media type; the rest wait for the next run
const PLEX_HEADERS = { Accept: 'application/json', 'X-Plex-Client-Identifier': 'diskovarr-app', 'X-Plex-Product': 'Diskovarr' };

const now = () => Math.floor(Date.now() / 1000);

function globalEnabled(mediaType) {
  return ['true', '1'].includes(String(db.getSetting(GLOBAL_KEYS[mediaType], 'false')));
}

// { movie: bool, tv: bool } — global toggle OR the user's own flag
function enabledTypesFor(userId) {
  const prefs = db.getUserPreferences(userId);
  return Object.fromEntries(MEDIA_TYPES.map(t => [t, globalEnabled(t) || !!prefs[USER_FLAGS[t]]]));
}

// Every title on a user's Plex Watchlist with its TMDB id. Throws unless the
// whole list was read — a partial read must never look like removals.
async function fetchPlexWatchlist(userToken) {
  const keys = [];
  const size = 100;
  for (let offset = 0; ; offset += size) {
    const res = await fetch(
      `https://discover.provider.plex.tv/library/sections/watchlist/all?X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${size}`,
      { headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken }, signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) throw new Error(`watchlist fetch HTTP ${res.status}`);
    const items = (await res.json())?.MediaContainer?.Metadata || [];
    for (const item of items) if (item.ratingKey) keys.push(item.ratingKey);
    if (items.length < size) break;
  }
  const out = [];
  for (let i = 0; i < keys.length; i += 50) {
    const batch = keys.slice(i, i + 50);
    const res = await fetch(
      `https://metadata.provider.plex.tv/library/metadata/${batch.join(',')}`,
      { headers: { ...PLEX_HEADERS, 'X-Plex-Token': userToken }, signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) throw new Error(`watchlist metadata HTTP ${res.status}`);
    for (const item of (await res.json())?.MediaContainer?.Metadata || []) {
      const guid = (item.Guid || []).find(g => String(g.id || '').startsWith('tmdb://'));
      const tmdbId = Number(String(guid?.id || '').slice('tmdb://'.length));
      if (!tmdbId || !['movie', 'show'].includes(item.type)) continue;
      out.push({ tmdbId, mediaType: item.type === 'show' ? 'tv' : 'movie', title: item.title || '', year: item.year || null });
    }
  }
  return out;
}

const stmt = {
  getState: () => db.prepare('SELECT enabled_since FROM watchlist_auto_request_state WHERE user_id = ? AND media_type = ?'),
  setState: () => db.prepare('INSERT OR IGNORE INTO watchlist_auto_request_state (user_id, media_type, enabled_since) VALUES (?, ?, ?)'),
  clearState: () => db.prepare('DELETE FROM watchlist_auto_request_state WHERE user_id = ? AND media_type = ?'),
  clearRows: () => db.prepare('DELETE FROM watchlist_auto_requests WHERE user_id = ? AND media_type = ?'),
  rows: () => db.prepare('SELECT * FROM watchlist_auto_requests WHERE user_id = ? AND media_type = ?'),
  deleteRow: () => db.prepare('DELETE FROM watchlist_auto_requests WHERE user_id = ? AND media_type = ? AND tmdb_id = ?'),
  upsert: () => db.prepare(`
    INSERT INTO watchlist_auto_requests (user_id, media_type, tmdb_id, title, status, request_id, attempts, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, media_type, tmdb_id) DO UPDATE SET
      title = excluded.title, status = excluded.status,
      request_id = COALESCE(excluded.request_id, watchlist_auto_requests.request_id),
      attempts = excluded.attempts, last_error = excluded.last_error, updated_at = excluded.updated_at
  `),
};

function record(userId, mediaType, item, status, { requestId = null, attempts = 0, error = null } = {}) {
  stmt.upsert().run(String(userId), mediaType, Number(item.tmdbId), item.title || null, status, requestId, attempts, error, now());
}

// Forget a user's bookkeeping for a type that's no longer enabled, so turning
// it back on starts from a fresh baseline instead of requesting the backlog.
function disableFor(userId, mediaType) {
  stmt.clearState().run(String(userId), mediaType);
  stmt.clearRows().run(String(userId), mediaType);
}

function userHasRequested(userId, tmdbId, mediaType) {
  // Any status, followers included: a title the user already requested, had
  // denied, or follows is never requested again on their behalf.
  return !!db.prepare('SELECT 1 FROM discover_requests WHERE user_id = ? AND tmdb_id = ? AND media_type = ? LIMIT 1')
    .get(String(userId), Number(tmdbId), String(mediaType));
}

async function processUserType(user, mediaType, items, summary) {
  const userId = String(user.user_id);
  const known = new Map(stmt.rows().all(userId, mediaType).map(r => [Number(r.tmdb_id), r]));
  const onList = new Set(items.map(i => i.tmdbId));

  // Removed from the watchlist → forget it (re-adding later is a new addition)
  for (const tmdbId of known.keys()) {
    if (!onList.has(tmdbId)) stmt.deleteRow().run(userId, mediaType, tmdbId);
  }

  if (!stmt.getState().get(userId, mediaType)) {
    stmt.setState().run(userId, mediaType, now());
    for (const item of items) record(userId, mediaType, item, 'baseline');
    summary.baselined += items.length;
    return;
  }

  const service = policy.resolveDefaultService(mediaType);
  if (service === 'none') { summary.noService = true; return; }
  const libraryKeys = db.getLibraryTmdbKeys();
  const username = db.getKnownUserById(userId)?.username || userId;
  let budget = MAX_REQUESTS_PER_RUN;

  for (const item of items) {
    const row = known.get(item.tmdbId);
    const retryable = !row || row.status === 'limited' || (row.status === 'failed' && row.attempts < MAX_ATTEMPTS);
    if (!retryable) continue;
    if (libraryKeys.has(`${item.tmdbId}:${mediaType}`)) { record(userId, mediaType, item, 'in_library'); continue; }
    if (db.getActiveRequestsForTitle({ tmdbId: item.tmdbId, mediaType }).length || userHasRequested(userId, item.tmdbId, mediaType)) {
      record(userId, mediaType, item, 'already_requested');
      continue;
    }
    if (budget <= 0) { summary.deferred++; continue; }
    budget--;
    try {
      const result = await policy.createRequest({
        userId, username, tmdbId: item.tmdbId, mediaType, title: item.title,
        service, seasons: null, privileged: true, origin: 'watchlist',
      });
      record(userId, mediaType, item, result.status === 'approved' ? 'requested' : 'pending', { requestId: result.requestId });
      summary[result.status === 'approved' ? 'requested' : 'pending']++;
    } catch (e) {
      if (e.status === 429) {
        // Over the user's quota: try again once the window frees up
        record(userId, mediaType, item, 'limited', { attempts: row?.attempts || 0, error: e.message });
        summary.limited++;
      } else if (e.status === 409) {
        record(userId, mediaType, item, 'already_requested');
      } else {
        record(userId, mediaType, item, 'failed', { attempts: (row?.attempts || 0) + 1, error: e.message });
        summary.failed++;
        logger.warn(`[watchlist-autorequest] ${username}: "${item.title}" failed: ${e.message}`);
      }
    }
  }
}

// One pass over every user with the feature on. Cheap no-op when it's off.
async function run() {
  // Requests switched off (the gate POST /api/request applies) counts as the
  // feature being off for everyone: state is cleared, so turning requests back
  // on re-baselines instead of requesting what was watchlisted meanwhile.
  const requestsOn = db.isDiscoverEnabled() && db.hasTmdbKey();
  const users = db.getAllKnownUsersWithTokens()
    .filter(u => u.plex_token && !String(u.user_id).startsWith('__svc_') && u.user_id !== 'autorequest');
  const summary = { users: 0, baselined: 0, requested: 0, pending: 0, limited: 0, failed: 0, deferred: 0, noService: false };
  const anyGlobal = requestsOn && MEDIA_TYPES.some(globalEnabled);

  for (const user of users) {
    const enabled = requestsOn ? enabledTypesFor(user.user_id) : { movie: false, tv: false };
    for (const t of MEDIA_TYPES) if (!enabled[t]) disableFor(user.user_id, t);
    const types = MEDIA_TYPES.filter(t => enabled[t]);
    if (types.length === 0) continue;
    summary.users++;
    let items;
    try {
      items = await fetchPlexWatchlist(user.plex_token);
    } catch (e) {
      logger.warn(`[watchlist-autorequest] skipping ${user.user_id}: ${e.message}`);
      continue;
    }
    for (const t of types) {
      await processUserType(user, t, items.filter(i => i.mediaType === t), summary);
    }
  }
  if (summary.users || anyGlobal) {
    logger.info(`[watchlist-autorequest] ${summary.users} user(s): ${summary.requested} requested, ${summary.pending} pending, ` +
      `${summary.baselined} baselined, ${summary.limited} over limit, ${summary.failed} failed, ${summary.deferred} deferred` +
      (summary.noService ? ' (no request service configured)' : ''));
  }
  return summary;
}

module.exports = { run, fetchPlexWatchlist, enabledTypesFor, MAX_ATTEMPTS, MAX_REQUESTS_PER_RUN };
