// Plex side of per-user library access. One plex.tv batch with the owner's
// token says which sections each friend was shared; users the batch can't
// answer for exactly — content filters (ratings/labels), managed (restricted)
// users, Home members without a share row — are asked the server itself with
// their own server token, which Plex enforces, so no filter grammar is parsed.
const db = require('../../db/database');
const store = require('./store');

const PLEX_TV = 'https://plex.tv';
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 400; // 200k items per section: a runaway guard, not a real limit
const BATCH_TTL_MS = 60_000; // logins and on-demand refreshes share one batch
const PLEX_HEADERS = {
  'X-Plex-Client-Identifier': 'diskovarr-app',
  'X-Plex-Product': 'Diskovarr',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Web',
};
const FILTER_KEYS = ['filterAll', 'filterMovies', 'filterTelevision'];

function config() {
  const plex = require('../plex');
  return { url: plex.getPlexUrl() || '', token: plex.getPlexToken() || '', serverId: plex.getPlexServerId() || '' };
}

// Tokens ride in a header, never the URL, so they can't end up in logs or errors.
async function plexGet(url, token, { xml = false } = {}) {
  const res = await fetch(url, {
    headers: { ...PLEX_HEADERS, Accept: xml ? 'application/xml' : 'application/json', 'X-Plex-Token': token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} returned ${res.status}`);
  return xml ? res.text() : res.json();
}

// ── Minimal XML reading (plex.tv's sharing endpoints only speak XML) ─────────

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

// SharedServer@accessToken is never read: those are other users' tokens
// (CVE-2025-69417).
function parseAttrs(src) {
  const out = {};
  for (const m of src.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (m[1] !== 'accessToken') out[m[1]] = decodeXml(m[2] ?? m[3]);
  }
  return out;
}

// Every <name> element: its attributes plus those of its direct <child> elements.
function xmlElements(xml, name, child) {
  if (typeof xml !== 'string' || !/<MediaContainer[\s>/]/.test(xml)) throw new Error('unexpected plex.tv response');
  const out = [];
  let cur = null;
  // Quote-aware: a raw '>' inside an attribute value (a user or server name)
  // must not end the tag and drop the filter attributes after it
  const tags = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (const [, closing, tag, attrs, selfClosing] of xml.matchAll(tags)) {
    if (tag === name) {
      if (closing) { cur = null; continue; }
      const el = { attrs: parseAttrs(attrs), children: [] };
      out.push(el);
      cur = selfClosing ? null : el;
    } else if (cur && tag === child && !closing) {
      cur.children.push(parseAttrs(attrs));
    }
  }
  return out;
}

const filtersOf = (a) => Object.fromEntries(FILTER_KEYS.map(k => [k, a[k] || '']));
const hasFilters = (f) => !!f && FILTER_KEYS.some(k => f[k]);

// Section types a user's restrictions apply to (filterAll and managed users:
// every type). Their visible keys are always listed: a section that hides
// nothing today would otherwise be stored whole, and a title added later that
// Plex hides from them would show until the next refresh.
function coveredTypes(meta) {
  if (meta.filterAll || meta.restricted) return new Set(['movie', 'show']);
  const types = new Set();
  if (meta.filterMovies) types.add('movie');
  if (meta.filterTelevision) types.add('show');
  return types;
}

// Whether a stored snapshot came from asking the server under these same
// restrictions (filters, managed flag)
function probedUnder(row, meta) {
  if (!row?.fetched_at) return false;
  let prev = null;
  try { prev = JSON.parse(row.filters || 'null'); } catch { return false; }
  return !!prev?.probed && !!prev.restricted === !!meta.restricted
    && FILTER_KEYS.every(k => (prev[k] || '') === (meta[k] || ''));
}

// ── The plex.tv batch ────────────────────────────────────────────────────────

let _batch = null; // { at, promise }

async function loadBatch(cfg) {
  const [sharedXml, usersXml, me] = await Promise.all([
    plexGet(`${PLEX_TV}/api/servers/${encodeURIComponent(cfg.serverId)}/shared_servers`, cfg.token, { xml: true }),
    plexGet(`${PLEX_TV}/api/users`, cfg.token, { xml: true }),
    plexGet(`${PLEX_TV}/api/v2/user`, cfg.token),
  ]);
  // Section.key is the server's section id (library_items.section_id);
  // Section.id is a plex.tv-global id and is never compared.
  const shares = new Map();
  for (const { attrs: a, children } of xmlElements(sharedXml, 'SharedServer', 'Section')) {
    if (!a.userID) continue;
    shares.set(String(a.userID), {
      allLibraries: a.allLibraries === '1',
      sections: children.filter(c => c.shared === '1' && c.key != null).map(c => String(c.key)),
      filters: filtersOf(a),
      // An invite nobody accepted grants nothing
      pending: 'acceptedAt' in a && (!a.acceptedAt || a.acceptedAt === '0'),
    });
  }
  const users = new Map();
  for (const { attrs: a, children } of xmlElements(usersXml, 'User', 'Server')) {
    if (!a.id) continue;
    const server = children.find(c => c.machineIdentifier === cfg.serverId) || null;
    users.set(String(a.id), {
      home: a.home === '1',
      restricted: a.restricted === '1',
      filters: filtersOf(a),
      hasServer: !!server,
      pending: server?.pending === '1',
    });
  }
  // The admin token's account owns the server. Adopt it as the configured
  // owner when none is set; a different configured owner is kept (and exempt).
  const tokenOwnerId = me?.id != null ? String(me.id) : null;
  if (!tokenOwnerId) throw new Error('plex.tv did not identify the server owner');
  const configured = db.getOwnerUserId();
  if (!configured) db.setOwnerUserId(tokenOwnerId);
  else if (String(configured) !== tokenOwnerId) {
    require('../logger').warn(`[libraryAccess] Plex token belongs to account ${tokenOwnerId}, but the configured server owner is ${configured}`);
  }
  return { shares, users, tokenOwnerId };
}

function fetchBatch(cfg, { fresh = false } = {}) {
  if (!fresh && _batch && Date.now() - _batch.at < BATCH_TTL_MS) return _batch.promise;
  const promise = loadBatch(cfg);
  const entry = { at: Date.now(), promise };
  _batch = entry;
  promise.catch(() => { if (_batch === entry) _batch = null; });
  return promise;
}

// ── Asking the server with the user's own token ──────────────────────────────

// The user's token for this server via plex.tv resources (the normal client
// path), or null when plex.tv no longer lists the server for them.
async function serverTokenFor(userId, cfg) {
  const row = db.getKnownUserById(userId);
  if (!row?.plex_token) throw new Error('No stored Plex sign-in for this user; access is checked again at their next login');
  const resources = await plexGet(`${PLEX_TV}/api/v2/resources?includeHttps=1`, row.plex_token);
  const server = (Array.isArray(resources) ? resources : []).find(r => r.clientIdentifier === cfg.serverId);
  return server ? (server.accessToken || row.plex_token) : null;
}

// Item count of a section as `token` sees it, or null if Plex didn't say
// (then the keys are listed rather than assuming the section is whole).
async function sectionTotal(cfg, sectionId, token) {
  const json = await plexGet(`${cfg.url}/library/sections/${encodeURIComponent(sectionId)}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`, token);
  const n = Number(json?.MediaContainer?.totalSize ?? NaN);
  return Number.isFinite(n) ? n : null;
}

async function sectionKeys(cfg, sectionId, token, total) {
  const keys = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await plexGet(`${cfg.url}/library/sections/${encodeURIComponent(sectionId)}/all`
      + `?X-Plex-Container-Start=${page * PAGE_SIZE}&X-Plex-Container-Size=${PAGE_SIZE}`, token);
    const items = json?.MediaContainer?.Metadata || [];
    for (const m of items) if (m.ratingKey != null) keys.push(String(m.ratingKey));
    if (items.length < PAGE_SIZE || keys.length >= total) break;
  }
  return keys;
}

// What the server shows this user: their sections, and for each one Diskovarr
// holds rows for, whether every item is visible (same count as the admin's)
// or only some — then the visible rating keys are listed. Sections of a
// `covered` type (see coveredTypes) are always listed, never assumed whole.
async function probeSections(cfg, serverToken, adminTotals, covered = new Set()) {
  if (!cfg.url) throw new Error('Plex URL is not configured');
  const json = await plexGet(`${cfg.url}/library/sections`, serverToken);
  const dirs = (json?.MediaContainer?.Directory || [])
    .filter(d => (d.type === 'movie' || d.type === 'show') && d.key != null);
  const withRows = new Set(db.prepare("SELECT DISTINCT section_id FROM library_items WHERE source = 'plex'")
    .all().map(r => String(r.section_id)));
  const filteredSectionIds = [];
  const visibleKeys = new Set();
  for (const d of dirs) {
    const id = String(d.key);
    if (!withRows.has(id)) continue;
    const shortcut = !covered.has(d.type);
    if (shortcut && !adminTotals.has(id)) adminTotals.set(id, sectionTotal(cfg, id, cfg.token));
    const [mine, all] = await Promise.all([sectionTotal(cfg, id, serverToken), shortcut ? adminTotals.get(id) : null]);
    if (shortcut && mine != null && mine === all) continue;
    filteredSectionIds.push(id);
    for (const k of await sectionKeys(cfg, id, serverToken, mine ?? Infinity)) visibleKeys.add(k);
  }
  return { sectionIds: dirs.map(d => String(d.key)), filteredSectionIds, visibleKeys };
}

// ── One user's snapshot ──────────────────────────────────────────────────────

async function snapshotFor(userId, batch, cfg, { serverToken = null, adminTotals }) {
  if (userId === batch.tokenOwnerId) return { role: 'owner', allSections: true };
  const share = batch.shares.get(userId) || null;
  const user = batch.users.get(userId) || null;
  // /api/users carries the filters Plex Web edits; prefer them when set
  const filters = hasFilters(user?.filters) ? user.filters : (share?.filters || filtersOf({}));
  const meta = { ...filters, home: !!user?.home, restricted: !!user?.restricted };
  if (share?.pending || user?.pending) return { role: 'removed', filters: { ...meta, pending: true } };
  const role = user?.home ? 'home' : 'shared';
  // A user plex.tv lists with this server but without a share row (Home
  // members, or an inconsistent answer) is asked the server rather than dropped
  const probe = hasFilters(filters) || !!user?.restricted || (!share && !!(user?.home || user?.hasServer));
  if (!probe) {
    if (!share) return { role: 'removed', filters: meta };
    return {
      role,
      allSections: share.allLibraries,
      sectionIds: share.allLibraries ? [] : share.sections,
      filters: { ...meta, allLibraries: share.allLibraries },
    };
  }
  try {
    const token = serverToken || await serverTokenFor(userId, cfg);
    if (!token) return { role: 'removed', filters: meta };
    return { role, ...await probeSections(cfg, token, adminTotals, coveredTypes(meta)), filters: { ...meta, probed: true } };
  } catch (err) {
    // The last good snapshot only stands in when it was probed under these
    // same restrictions. One from before a filter was added (or never probed)
    // would show the user what the owner just hid: fail closed instead.
    if (probedUnder(store.getRow(userId, 'plex'), meta)) throw err;
    return { failClosed: err.message };
  }
}

/**
 * Refresh the Plex snapshots of these Plex account ids. `serverTokens` maps an
 * id to the server token from a fresh login; `fresh` skips the shared batch.
 * Failures keep each user's last good snapshot and record last_error — unless
 * the user's restrictions changed since that snapshot, which is then cleared.
 * Returns the ids whose access changed.
 */
async function refreshPlex(userIds, { serverTokens = {}, fresh = false } = {}) {
  const ids = [...new Set((userIds || []).map(String))];
  const changed = [];
  if (!ids.length) return changed;
  const cfg = config();
  const fail = (msg) => { for (const id of ids) store.recordError(id, 'plex', msg); };
  if (!cfg.token || !cfg.serverId) {
    fail('Plex is not configured (server id or admin token missing)');
    return changed;
  }
  let batch;
  try {
    batch = await fetchBatch(cfg, { fresh });
  } catch (err) {
    fail(`plex.tv sharing lookup failed: ${err.message}`);
    return changed;
  }
  const adminTotals = new Map(); // section id → Promise<count>, once per run
  for (const id of ids) {
    try {
      const snap = await snapshotFor(id, batch, cfg, { serverToken: serverTokens[id] || null, adminTotals });
      if (snap.failClosed ? store.clearSnapshot(id, 'plex', snap.failClosed) : store.saveSnapshot(id, 'plex', snap)) {
        changed.push(id);
      }
    } catch (err) {
      store.recordError(id, 'plex', err.message);
    }
  }
  return changed;
}

function resetBatch() { _batch = null; }

module.exports = { refreshPlex, resetBatch, xmlElements };
