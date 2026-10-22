// Per-user library access: users only see titles from the libraries they can
// reach on the media server. Plex sharing (sections, content filters) and
// Jellyfin user policy (folders, parental controls) are mirrored into
// user_library_access snapshots (./plex.js, ./jellyfin.js); this module turns
// them into an Access object for request handlers and background jobs.
//
//   Access = { userId, plex: SourceAccess | null, jellyfin: SourceAccess | null, fp }
//   SourceAccess = { userId /* provider id */, all, sections: Set, filtered: Map<sectionId, Set<ratingKey>> }
//
// null Access = unrestricted: the kill switch is off, or the requester is the
// password admin, the API key, a system principal or the Plex server owner.
// Everyone else (Diskovarr admins included) is limited in user-facing views;
// admin screens stay unfiltered. A null source means no access to that server:
// no snapshot yet fails closed until a refresh succeeds.
const crypto = require('crypto');
const db = require('../../db/database');
const logger = require('../logger');
const store = require('./store');
const plexAccess = require('./plex');
const jellyfinAccess = require('./jellyfin');
const { allowsRow, sqlPredicate } = require('./predicate');

const ENFORCED_SETTING = 'library_access_enforced';
const MEMO_TTL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 8_000;
const ON_DEMAND_TIMEOUT_MS = 8_000;
const RETRY_COOLDOWN_S = 5 * 60; // a user with no snapshot is retried at most this often
const API_KEY_USER_ID = 'api-key'; // middleware/requireAuth

// Used when a request has no identity at all: sees no library
const NO_ACCESS = Object.freeze({ userId: null, plex: null, jellyfin: null, fp: 'none' });

// The checks below take null (unrestricted) or an Access. undefined means the
// caller never looked access up (req.libraryAccess on a router without the
// middleware): it sees nothing rather than everything. Background code passes
// forUser(id) or an explicit null.
const known = (access) => (access === undefined ? NO_ACCESS : access);

function isEnforced() {
  return db.getSetting(ENFORCED_SETTING, '1') !== '0';
}

function setEnforced(on) {
  db.setSetting(ENFORCED_SETTING, on ? '1' : '0');
  changed(null);
}

// Synthetic principals: the API key, auto-request, Overseerr-shim apps and
// service users (__app_*, __svc_*)
function isSystemId(id) {
  return id === API_KEY_USER_ID || id === 'autorequest' || id.startsWith('__');
}

function isOwner(id) {
  const owner = db.getOwnerUserId();
  return !!owner && String(owner) === id;
}

const jellyfinEnabled = () => require('../jellyfin/client').isEnabled();

// A canonical user's provider identities. Plex items are checked against the
// Plex account's snapshot, Jellyfin items against the linked 'jf_' one; an
// unlinked account has no access to the other server.
function identities(userId) {
  const id = db.resolveCanonicalUserId(userId);
  if (id.startsWith('jf_')) return { id, plexId: null, jfId: id };
  const jf = db.getLinkedJellyfinRow(id);
  return { id, plexId: id, jfId: jf ? String(jf.user_id) : null };
}

const parseIds = (json) => { try { return JSON.parse(json || '[]').map(String); } catch { return []; } };

function loadSource(providerId, source) {
  const row = store.getRow(providerId, source);
  if (!row?.fetched_at || row.role === 'removed') return null;
  const sections = new Set(parseIds(row.section_ids));
  const filtered = new Map();
  const filteredIds = parseIds(row.filtered_section_ids);
  if (filteredIds.length) {
    const keys = store.visibleKeys(providerId, source);
    for (const sid of filteredIds) { filtered.set(sid, keys); sections.add(sid); }
  }
  if (!row.all_sections && !sections.size) return null;
  return { userId: providerId, all: !!row.all_sections, sections, filtered };
}

function computeFp(access) {
  const h = crypto.createHash('sha1');
  for (const source of ['plex', 'jellyfin']) {
    const src = access[source];
    if (!src) { h.update(`${source}:-;`); continue; }
    h.update(`${source}:${src.all ? '*' : ''}:${[...src.sections].sort().join(',')}:${[...src.filtered.keys()].sort().join(',')}:`);
    const keys = new Set();
    for (const set of src.filtered.values()) for (const k of set) keys.add(k);
    h.update(`${[...keys].sort().join(',')};`);
  }
  return `r:${h.digest('hex').slice(0, 16)}`;
}

// ── Lookups ──────────────────────────────────────────────────────────────────

const memo = new Map(); // user id → { access, at }

/** Access for a (canonical) user id — background code without a request. */
function forUser(userId) {
  if (!isEnforced()) return null;
  if (userId == null || userId === '') return NO_ACCESS;
  const raw = String(userId);
  if (isSystemId(raw)) return null;
  const hit = memo.get(raw);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.access;
  const { id, plexId, jfId } = identities(raw);
  let access = null;
  if (!isOwner(id)) {
    access = {
      userId: id,
      plex: plexId ? loadSource(plexId, 'plex') : null,
      jellyfin: jfId ? loadSource(jfId, 'jellyfin') : null,
    };
    access.fp = computeFp(access);
    // Identities without a successful snapshot (drives the on-demand refresh)
    const missing = [];
    if (plexId && !access.plex && !store.getRow(plexId, 'plex')?.fetched_at) missing.push(['plex', plexId]);
    if (jfId && !access.jellyfin && !store.getRow(jfId, 'jellyfin')?.fetched_at) missing.push(['jellyfin', jfId]);
    Object.defineProperty(access, 'missing', { value: missing, enumerable: false });
  }
  memo.set(raw, { access, at: Date.now() });
  return access;
}

/** Access for a request: null for the password admin and the API key. */
function forRequest(req) {
  if (!isEnforced()) return null;
  const s = req?.session;
  if (req?.apiKeyAuth || s?.isAdmin) return null;
  const id = s?.plexUser?.id;
  return id == null ? NO_ACCESS : forUser(id);
}

/** Whether a library item (sectionId/ratingKey) or row (section_id/rating_key) is visible. */
function allows(access, item) {
  access = known(access);
  if (!access) return true;
  if (!item) return false;
  if ((item.sectionId ?? item.section_id) == null) {
    const key = item.ratingKey ?? item.rating_key;
    // Not a library row (no section, no key): nothing to hide
    return key == null ? true : allowsKey(access, key);
  }
  return allowsRow(access, item);
}

function libraryRowFor(key) {
  const stmt = db.prepare('SELECT rating_key, section_id, source FROM library_items WHERE rating_key = ?');
  const k = String(key);
  // Jellyfin ids arrive with or without dashes; rows hold the 32-hex form
  return stmt.get(k) || (/[A-F-]/.test(k) ? stmt.get(k.toLowerCase().replace(/-/g, '')) : null) || null;
}

/**
 * By rating key. Keys that aren't library rows (episodes, seasons,
 * collections, unknown ids) pass — they aren't a section's title.
 */
function allowsKey(access, ratingKey) {
  access = known(access);
  if (!access) return true;
  if (ratingKey == null || ratingKey === '') return true;
  const row = libraryRowFor(ratingKey);
  return row ? allowsRow(access, row) : true;
}

// The library rating key a /api/poster path shows art for (Plex metadata or a
// Jellyfin item), or null for other art such as collection composites.
function posterRatingKey(posterPath) {
  const p = require('../posterUpstream').parsePosterPath(posterPath);
  if (!p) return null;
  const m = /^\/library\/metadata\/(\d+)\//.exec(p.path) || /^\/Items\/([^/]+)\/Images\//.exec(p.path);
  return m ? m[1] : null;
}

// Accepted risk (design): art for ids that aren't library rows passes, and
// Plex rating keys are sequential, so a restricted user can still walk
// /library/metadata/N for unsynced sections (photos, home video) and for
// seasons/episodes of shows they can't open. A later mitigation could resolve
// unknown Plex ids once via PMS /library/metadata/N (librarySectionID,
// grandparentRatingKey) behind a small LRU and apply allowsRow.
function allowsPoster(access, posterPath) {
  access = known(access);
  return !access || allowsKey(access, posterRatingKey(posterPath));
}

function filter(access, items) {
  access = known(access);
  return access ? (items || []).filter(i => allows(access, i)) : (items || []);
}

/** Stable string for caches built from what the user can see ('all' = unrestricted). */
function fingerprint(access) {
  access = known(access);
  return access ? access.fp : 'all';
}

/**
 * The library a user may browse: Plex's movie and TV sections (the two the
 * pools have always read) when Plex is configured, plus, when Jellyfin is
 * enabled, its rows.
 * source: null (both) | 'plex' | 'jellyfin'; type: null | 'movie' | 'show'.
 */
async function libraryPool(access, { source = null, type = null } = {}) {
  access = known(access);
  const plex = require('../plex');
  const items = [];
  if (source !== 'jellyfin' && (!access || access.plex) && plex.isConfigured()) {
    const sections = [];
    if (type !== 'show') sections.push(plex.MOVIES_SECTION);
    if (type !== 'movie') sections.push(plex.TV_SECTION);
    // A section that can't load (no rows yet and Plex down) throws to the
    // route, as before — an empty pool would show owned titles as requestable
    const lists = await Promise.all(sections.map(s => plex.getLibraryItems(s)));
    for (const list of lists) {
      for (const i of list) if ((!type || i.type === type) && (!access || allowsRow(access, i))) items.push(i);
    }
  }
  if (source !== 'plex' && jellyfinEnabled() && (!access || access.jellyfin)) {
    items.push(...db.getLibraryItemsBySource('jellyfin', type, access));
  }
  return items;
}

// ── Refreshing ───────────────────────────────────────────────────────────────

const listeners = new Set();
const inflight = new Map(); // 'source:providerId' → { promise: Promise<changed ids>, given }
let _refreshAll = null;
let _lastRefreshAll = null;

/** Subscribe to access changes: fn(canonicalUserId | null) — null means everyone. */
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function invalidate() {
  memo.clear();
}

// Something about `canonicalId`'s access (or everyone's, when null) changed:
// drop memoised access and that user's recommendation/discover caches.
function changed(canonicalId) {
  invalidate();
  try {
    const recommender = require('../recommender');
    const discover = require('../discoverRecommender');
    if (canonicalId == null) {
      recommender.invalidateAllCaches();
      discover.invalidateAllCaches();
    } else {
      recommender.invalidateUserCache(canonicalId);
      discover.invalidateUserCache(canonicalId);
    }
  } catch (err) {
    logger.warn(`[libraryAccess] cache invalidation failed: ${err.message}`);
  }
  for (const fn of listeners) {
    try { fn(canonicalId); } catch (err) { logger.warn(`[libraryAccess] change listener failed: ${err.message}`); }
  }
}

function applyChanges(changedIds) {
  invalidate(); // owner detection or error rows can change access too
  for (const id of new Set(changedIds.map(pid => db.resolveCanonicalUserId(pid)))) changed(id);
  return changedIds;
}

// One run per identity at a time; concurrent callers share it. A login's
// server token or policy isn't dropped by joining a run started without one:
// its own run is chained after that one.
function refreshSource(source, providerId, { serverToken = null, policy = null, fresh = false } = {}) {
  const key = `${source}:${providerId}`;
  const given = !!(serverToken || policy);
  const prev = inflight.get(key);
  if (prev && (prev.given || !given)) return prev.promise;
  const start = () => (source === 'plex'
    ? plexAccess.refreshPlex([providerId], { serverTokens: serverToken ? { [providerId]: serverToken } : {}, fresh })
    : jellyfinAccess.refreshJellyfin([providerId], {
      policies: policy ? new Map([[jellyfinAccess.guidN(providerId.slice(3)), policy]]) : null,
    }));
  const entry = { given };
  entry.promise = (prev ? prev.promise.catch(() => {}).then(start) : start())
    .then(applyChanges)
    .finally(() => { if (inflight.get(key) === entry) inflight.delete(key); });
  inflight.set(key, entry);
  return entry.promise;
}

// Resolves true if `promise` settled within `ms`; the work carries on either way.
function bounded(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
  return Promise.race([promise.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Refresh one user's snapshots now. A Plex id also refreshes its linked
 * Jellyfin identity; a 'jf_' id only Jellyfin. `serverToken` (Plex login) and
 * `policy` (Jellyfin login) save a lookup. Resolves { changed }.
 */
async function refreshUser(userId, { serverToken = null, policy = null } = {}) {
  const raw = String(userId);
  const jobs = [];
  if (raw.startsWith('jf_')) {
    jobs.push(refreshSource('jellyfin', raw, { policy }));
  } else {
    jobs.push(refreshSource('plex', raw, { serverToken, fresh: true }));
    const jf = db.getLinkedJellyfinRow(raw);
    if (jf && jellyfinEnabled()) jobs.push(refreshSource('jellyfin', String(jf.user_id)));
  }
  const ids = (await Promise.all(jobs)).flat();
  return { changed: ids.length > 0 };
}

// Login hook: refresh, but never hold sign-in up for more than a few seconds.
// A failure keeps the previous snapshot (or none: fail closed). The server
// owner is exempt, so their sign-in skips it.
async function refreshOnLogin(providerId, opts = {}) {
  try {
    if (isOwner(db.resolveCanonicalUserId(String(providerId)))) return;
    await bounded(refreshUser(providerId, opts), LOGIN_TIMEOUT_MS);
  } catch (err) {
    logger.warn(`[libraryAccess] login refresh failed for ${providerId}: ${err.message}`);
  }
}

/** Every known Plex and Jellyfin user (boot, every 6 h, Admin → Users). */
function refreshAll() {
  if (_refreshAll) return _refreshAll;
  _refreshAll = (async () => {
    const started = Date.now();
    const ids = db.prepare('SELECT user_id FROM known_users').all().map(r => String(r.user_id));
    const plexIds = ids.filter(id => /^\d+$/.test(id));
    const jfIds = jellyfinEnabled() ? ids.filter(id => id.startsWith('jf_')) : [];
    const changedIds = [
      ...applyChanges(await plexAccess.refreshPlex(plexIds, { fresh: true })),
      ...applyChanges(await jellyfinAccess.refreshJellyfin(jfIds)),
    ];
    const errors = store.allRows().filter(r => r.last_error && r.last_attempt_at >= Math.floor(started / 1000)).length;
    _lastRefreshAll = { at: Math.floor(Date.now() / 1000), users: plexIds.length + jfIds.length, changed: changedIds.length, errors };
    logger.info(`[libraryAccess] refreshed ${_lastRefreshAll.users} user(s): ${changedIds.length} changed, ${errors} failed`);
    return _lastRefreshAll;
  })().finally(() => { _refreshAll = null; });
  return _refreshAll;
}

/** From the 15-minute Jellyfin user sync (users from client.getUsers). */
async function syncJellyfinPolicies(users) {
  try {
    applyChanges(await jellyfinAccess.syncPolicies(users));
  } catch (err) {
    logger.warn(`[libraryAccess] Jellyfin policy sync failed: ${err.message}`);
  }
}

// A user with no snapshot yet (first visit after deploy, refreshes failing):
// one bounded refresh, retried at most every RETRY_COOLDOWN_S. Only the request
// that starts it waits; requests arriving while it runs (a page's poster burst)
// fail closed at once instead of each stalling for the bound. Resolves true
// when it refreshed anything.
async function ensureSnapshot(access) {
  const due = (access?.missing || []).filter(([source, pid]) => {
    if (source === 'jellyfin' && !jellyfinEnabled()) return false;
    if (inflight.has(`${source}:${pid}`)) return false;
    const row = store.getRow(pid, source);
    return !row || (!row.fetched_at && Math.floor(Date.now() / 1000) - (row.last_attempt_at || 0) >= RETRY_COOLDOWN_S);
  });
  if (!due.length) return false;
  await bounded(Promise.all(due.map(([source, pid]) => refreshSource(source, pid))), ON_DEMAND_TIMEOUT_MS);
  return true;
}

/** Express middleware (after requireAuth): sets req.libraryAccess. */
async function middleware(req, res, next) {
  try {
    let access = forRequest(req);
    if (access?.missing?.length && await ensureSnapshot(access)) {
      invalidate();
      access = forRequest(req);
    }
    req.libraryAccess = access;
  } catch (err) {
    logger.warn(`[libraryAccess] access lookup failed: ${err.message}`);
    req.libraryAccess = NO_ACCESS;
  }
  next();
}

/** Admin status: per known user, their snapshots (no tokens). */
function status() {
  const owner = db.getOwnerUserId();
  const rows = new Map();
  for (const r of store.allRows()) {
    if (!rows.has(r.user_id)) rows.set(r.user_id, []);
    rows.get(r.user_id).push(r);
  }
  const counts = new Map(db.prepare('SELECT user_id, source, COUNT(*) AS n FROM user_visible_items GROUP BY user_id, source')
    .all().map(r => [`${r.user_id}:${r.source}`, r.n]));
  const users = db.prepare('SELECT user_id, username, auth_provider, linked_user_id FROM known_users ORDER BY username COLLATE NOCASE').all()
    .filter(u => !isSystemId(String(u.user_id)))
    .map(u => ({
      userId: String(u.user_id),
      username: u.username,
      provider: u.auth_provider || 'plex',
      linkedTo: u.linked_user_id || null,
      owner: !!owner && String(owner) === String(u.user_id),
      snapshots: (rows.get(String(u.user_id)) || []).map(r => ({
        source: r.source,
        role: r.role,
        allSections: !!r.all_sections,
        sectionIds: parseIds(r.section_ids),
        filteredSectionIds: parseIds(r.filtered_section_ids),
        visibleItems: counts.get(`${r.user_id}:${r.source}`) || 0,
        fetchedAt: r.fetched_at || null,
        lastAttemptAt: r.last_attempt_at || null,
        lastError: r.last_error || null,
      })),
    }));
  return {
    enforced: isEnforced(),
    ownerId: owner ? String(owner) : null,
    refreshing: !!_refreshAll,
    lastRefresh: _lastRefreshAll,
    users,
  };
}

module.exports = {
  forUser, forRequest, middleware,
  allows, allowsKey, allowsPoster, filter, sqlPredicate, fingerprint, libraryPool,
  refreshUser, refreshOnLogin, refreshAll, syncJellyfinPolicies, status,
  isEnforced, setEnforced, invalidate, onChange, changed,
  // Fixtures/tests: store a snapshot directly (then call changed(canonicalId))
  saveSnapshot: store.saveSnapshot,
  NO_ACCESS,
};
