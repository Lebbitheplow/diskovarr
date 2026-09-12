// Pure helpers behind the monitored-list collection manager: exclusion and
// cap filtering, season selection for TV auto-requests, Plex presentation
// (hub visibility flags, library sort-title prefix, smart-collection filter
// URIs, item ordering) and home-hub layout planning. No I/O — every decision
// that matters for Agregarr parity lives here so it can be unit tested.

const keyOf = (tmdbId, mediaType) => `${Number(tmdbId)}:${mediaType === 'tv' ? 'tv' : 'movie'}`;

// Global + per-list exclusions as a Set of "tmdbId:mediaType".
function exclusionSet(...lists) {
  const set = new Set();
  for (const list of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      if (e && Number(e.tmdbId)) set.add(keyOf(e.tmdbId, e.mediaType));
    }
  }
  return set;
}

// Drop excluded items and cap to the list's max_items (0 = no cap). Order is
// preserved; excluded entries don't consume cap slots.
function applyListPolicy(items, { maxItems = 0, exclusions = [], globalExclusions = [] } = {}) {
  const excluded = exclusionSet(exclusions, globalExclusions);
  const kept = items.filter(i => !excluded.has(keyOf(i.tmdbId, i.mediaType)));
  const cap = Math.max(0, parseInt(maxItems) || 0);
  return {
    items: cap > 0 ? kept.slice(0, cap) : kept,
    excludedCount: items.length - kept.length,
  };
}

// Seasons to request for a show: null = every season. `seasonDetails` is the
// TMDB list (specials are season 0 and never auto-requested).
function pickSeasons(seasonMode, seasonDetails) {
  const numbers = (seasonDetails || [])
    .map(s => Number(s.number ?? s.season_number))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (seasonMode === 'first') return numbers.length ? [numbers[0]] : [1];
  if (seasonMode === 'latest') return numbers.length ? [numbers[numbers.length - 1]] : null;
  return null;
}

// Plex hub promotion flags for a list's visibility setting.
//   home        → promoted on the owner's home, shared homes and Recommended
//   owner_home  → owner's home + Recommended (not shared users' homes)
//   recommended → the library's Recommended tab only
//   library     → no promotion at all
function visibilityFlags(visibility) {
  return {
    home: { rec: 1, own: 1, shared: 1 },
    owner_home: { rec: 1, own: 1, shared: 0 },
    recommended: { rec: 1, own: 0, shared: 0 },
    library: { rec: 0, own: 0, shared: 0 },
  }[visibility] || { rec: 0, own: 0, shared: 0 };
}

// Inverse of visibilityFlags for layouts edited flag-by-flag.
function visibilityFromFlags({ rec, own, shared }) {
  if (own && shared) return 'home';
  if (own) return 'owner_home';
  if (rec) return 'recommended';
  return 'library';
}

// Library-tab ordering is a titleSort prefix: more '!' sorts earlier, so the
// list with library order 1 gets the longest prefix (Agregarr's scheme, which
// also sorts ahead of Kometa's "!010_" style prefixes).
function sortTitlePrefix(order, maxOrder) {
  const o = Math.max(1, parseInt(order) || 1);
  const max = Math.max(o, parseInt(maxOrder) || o);
  return '!'.repeat(max - o + 2);
}

// Plex sort parameter for smart collections; list order can't be expressed in
// a filter, so it falls back to newest release first.
const SMART_SORT = {
  list: 'originallyAvailableAt:desc',
  release_desc: 'originallyAvailableAt:desc',
  release_asc: 'originallyAvailableAt',
  title: 'titleSort',
  added_desc: 'addedAt:desc',
  rating_desc: 'rating:desc',
};

// Smart-collection filter: items carrying the list's label that the viewing
// user hasn't watched (Plex evaluates "unwatched" per user), capped and sorted.
function smartFilterPath({ sectionId, mediaType, label, sort = 'list', maxItems = 0 }) {
  const type = mediaType === 'tv' ? 2 : 1;
  const unwatched = mediaType === 'tv' ? 'show.unwatchedLeaves=1' : 'unwatched=1';
  let path = `/library/sections/${sectionId}/all?type=${type}&sort=${SMART_SORT[sort] || SMART_SORT.list}` +
    `&${unwatched}&and=1&label=${encodeURIComponent(label)}`;
  if (maxItems > 0) path += `&limit=${maxItems}`;
  return path;
}

function listLabel(listId) {
  return `diskovarr-list-${listId}`;
}

// Order collection items for a regular (non-smart) collection. `rows` are
// library rows for the list's items in list order; each carries the fields the
// sort needs (releaseDate, addedAt, title, rating).
function orderItems(rows, sort = 'list') {
  const arr = [...rows];
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const date = v => (v ? String(v) : '');
  switch (sort) {
    case 'release_desc': return arr.sort((a, b) => date(b.releaseDate).localeCompare(date(a.releaseDate)));
    case 'release_asc': return arr.sort((a, b) => date(a.releaseDate).localeCompare(date(b.releaseDate)));
    case 'title': return arr.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
    case 'added_desc': return arr.sort((a, b) => num(b.addedAt) - num(a.addedAt));
    case 'rating_desc': return arr.sort((a, b) => num(b.rating) - num(a.rating));
    default: return arr;
  }
}

// Minimal move plan to turn `current` (array of keys) into `wanted`: walk the
// wanted order and move each key after its predecessor only when it is not
// already there. Returns [{ key, after }] (after = null → move to the front).
function planMoves(current, wanted) {
  const wantedSet = new Set(wanted);
  const order = current.filter(k => wantedSet.has(k));
  const moves = [];
  for (let i = 0; i < wanted.length; i++) {
    const key = wanted[i];
    const after = i === 0 ? null : wanted[i - 1];
    const idx = order.indexOf(key);
    if (idx === -1) continue;
    const afterIdx = after === null ? -1 : order.indexOf(after);
    if (idx === afterIdx + 1) continue; // already in place
    order.splice(idx, 1);
    order.splice((after === null ? -1 : order.indexOf(after)) + 1, 0, key);
    moves.push({ key, after });
  }
  return moves;
}

// Unified home layout for one Plex section: default hubs (from the stored
// layout) and list collections (home_order + visibility) sorted into one
// sequence. Items with order 0 stay where Plex has them. Returns the ordered
// identifiers to place after `anchor` (Plex pins Continue Watching / On Deck
// first, which Agregarr also anchors on).
function planHomeLayout({ hubs = [], collections = [], anchor = null }) {
  const entries = [];
  for (const h of hubs) {
    if (!h.identifier || !(h.order > 0)) continue;
    entries.push({ identifier: h.identifier, order: Number(h.order), kind: 'hub' });
  }
  for (const c of collections) {
    if (!c.identifier || !(c.order > 0)) continue;
    entries.push({ identifier: c.identifier, order: Number(c.order), kind: 'collection' });
  }
  entries.sort((a, b) => a.order - b.order || a.identifier.localeCompare(b.identifier));
  const sequence = entries.map(e => e.identifier).filter(id => id !== anchor);
  return { anchor, sequence };
}

// Hub identifier Plex assigns to a promoted collection.
function collectionHubId(sectionId, collectionKey) {
  return `custom.collection.${sectionId}.${collectionKey}`;
}

module.exports = {
  keyOf, exclusionSet, applyListPolicy, pickSeasons,
  visibilityFlags, visibilityFromFlags, sortTitlePrefix,
  SMART_SORT, smartFilterPath, listLabel, orderItems, planMoves,
  planHomeLayout, collectionHubId,
};
