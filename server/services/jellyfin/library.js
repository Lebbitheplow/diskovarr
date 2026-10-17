const db = require('../../db/database');
const client = require('./client');

// Jellyfin library sync. Produces rows in the same library_items table the Plex
// sync fills, with source='jellyfin', rating_key = the Jellyfin Item Id (a GUID,
// so it can never collide with Plex's numeric keys) and section_id = 'jf_<folderId>'.

const SECTION_PREFIX = 'jf_';
const SYNCED_TYPES = new Set(['Movie', 'Series']);
// Episode/season events resolve to their series — library_items stores shows.
const CHILD_TYPES = new Set(['Episode', 'Season']);
// Ids per by-id request: keeps the query string well under proxy URL limits.
const ID_CHUNK = 50;

const ITEM_FIELDS = [
  'ProviderIds', 'Genres', 'People', 'Studios', 'DateCreated', 'Overview',
  'OfficialRating', 'CommunityRating', 'CriticRating', 'RecursiveItemCount',
  'ProductionYear', 'PremiereDate', 'ProductionLocations', 'MediaSources', 'Taglines',
  'Tags',
].join(',');

function peopleOf(item, type, limit = Infinity) {
  return (item.People || [])
    .filter(p => p.Type === type && p.Name)
    .slice(0, limit)
    .map(p => p.Name);
}

function resolutionOf(mediaSources) {
  let width = 0;
  for (const src of (mediaSources || [])) {
    for (const stream of (src.MediaStreams || [])) {
      if (stream.Type === 'Video' && stream.Width > width) width = stream.Width;
    }
  }
  if (!width) return null;
  if (width >= 3200) return '4k';
  if (width >= 1800) return '1080';
  if (width >= 1200) return '720';
  return 'sd';
}

function tsOf(dateStr) {
  return dateStr ? Math.floor(Date.parse(dateStr) / 1000) || 0 : 0;
}

// Map a Jellyfin BaseItemDto → the exact item shape plex.js parseMediaItem
// produces, so db.upsertManyItems and everything downstream work unchanged.
// `collectionsById` (itemId → [BoxSet names]) comes from fetchBoxSetMap() on a
// full resync; without it membership is unknown, so `collections` is null and
// the upsert keeps what the row already holds. Tags map onto Plex's labels.
function parseItem(item, { collectionsById = null } = {}) {
  const id = String(item.Id);
  const isShow = item.Type === 'Series';
  const mediaSources = item.MediaSources || [];
  let fileSize = 0;
  for (const src of mediaSources) fileSize += parseInt(src.Size) || 0;
  const addedAt = tsOf(item.DateCreated);
  return {
    ratingKey: id,
    title: item.Name || '',
    year: item.ProductionYear || parseInt((item.PremiereDate || '').slice(0, 4)) || 0,
    // Image paths are Jellyfin-relative and served through the poster proxy.
    thumb: item.ImageTags?.Primary ? `/Items/${id}/Images/Primary?tag=${item.ImageTags.Primary}` : null,
    art: (item.BackdropImageTags || []).length ? `/Items/${id}/Images/Backdrop/0` : null,
    type: isShow ? 'show' : 'movie',
    genres: item.Genres || [],
    directors: peopleOf(item, 'Director'),
    cast: peopleOf(item, 'Actor', 10),
    audienceRating: parseFloat(item.CommunityRating) || 0,
    contentRating: item.OfficialRating || '',
    addedAt,
    summary: item.Overview || '',
    // Jellyfin CriticRating is 0–100; the Plex-shaped `rating` field is 0–10.
    rating: item.CriticRating ? Math.round(item.CriticRating) / 10 : 0,
    ratingImage: '',
    audienceRatingImage: '',
    studio: item.Studios?.[0]?.Name || '',
    tmdbId: item.ProviderIds?.Tmdb ? String(item.ProviderIds.Tmdb) : null,
    tvdbId: item.ProviderIds?.Tvdb ? String(item.ProviderIds.Tvdb) : null,
    leafCount: isShow ? (parseInt(item.RecursiveItemCount) || null) : null,
    writers: peopleOf(item, 'Writer'),
    producers: peopleOf(item, 'Producer'),
    countries: item.ProductionLocations || [],
    collections: collectionsById ? (collectionsById.get(id) || []) : null,
    labels: (item.Tags || []).filter(t => t && String(t).trim()),
    edition: '',
    releaseDate: (item.PremiereDate || '').slice(0, 10),
    // RunTimeTicks are 100ns units; the Plex-shaped duration field is ms.
    duration: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : 0,
    videoResolution: isShow ? null : resolutionOf(mediaSources),
    fileSize: fileSize || null,
    source: 'jellyfin',
  };
}

// Virtual folder → section type. Movie and TV libraries map directly; a
// "Mixed movies and shows" library reports no collection type (or 'mixed' on
// 10.9+) and holds both — the scan's Movie/Series filter keeps music, photos
// and home videos out. Every other library type is skipped.
function folderTypeOf(collectionType) {
  const t = String(collectionType || '').toLowerCase();
  if (t === 'movies') return 'movie';
  if (t === 'tvshows') return 'show';
  if (t === '' || t === 'mixed') return 'mixed';
  return null;
}

// Movie/show virtual folders (Jellyfin's equivalent of Plex sections). Throws
// unless the server answered with a folder list, so callers can treat the
// result as authoritative.
async function getFolders() {
  const folders = await client.jfFetch('/Library/VirtualFolders');
  if (!Array.isArray(folders)) throw new Error('Jellyfin returned no library folder list');
  return folders
    .map(f => ({ id: String(f.ItemId || ''), title: f.Name, type: folderTypeOf(f.CollectionType) }))
    .filter(f => f.id && f.type);
}

// Every page of an /Items query. Any failed page throws, so a partial listing
// is never mistaken for the whole set.
async function fetchAllItems(params, { pageSize = 1000, timeout = 15000 } = {}) {
  const items = [];
  for (let start = 0; ; start += pageSize) {
    const qs = new URLSearchParams(params);
    qs.set('StartIndex', String(start));
    qs.set('Limit', String(pageSize));
    const page = await client.jfFetch(`/Items?${qs}`, { timeout });
    const rows = page?.Items || [];
    items.push(...rows);
    const total = Number(page?.TotalRecordCount) || 0;
    if (rows.length < pageSize || (total > 0 && items.length >= total)) break;
  }
  return items;
}

function fetchFolderItems(folderId) {
  return fetchAllItems({
    ParentId: folderId,
    IncludeItemTypes: 'Movie,Series',
    Recursive: 'true',
    Fields: ITEM_FIELDS,
    SortBy: 'SortName',
  }, { timeout: 120000 });
}

// BoxSets are Jellyfin's collections. One pass per full resync: list every
// BoxSet, then its children, and invert into itemId → [names] so parseItem can
// fill `collections` (discover facets, monitor `collection` criterion). Throws
// on any failed page — the resync then keeps the names it already has.
async function fetchBoxSetMap() {
  const map = new Map();
  const boxSets = await fetchAllItems({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Fields: 'ChildCount' });
  for (const box of boxSets) {
    if (!box.Id || !box.Name || box.ChildCount === 0) continue;
    const children = await fetchAllItems({ ParentId: String(box.Id), Fields: 'ProviderIds' });
    for (const child of children) {
      const id = String(child.Id);
      const names = map.get(id) || [];
      if (!names.includes(box.Name)) names.push(box.Name);
      map.set(id, names);
    }
  }
  return map;
}

// One bounded query for the newest episodes in a TV folder; the first occurrence
// per series (sorted desc) is its last-episode-added timestamp. Mirrors
// plex.js syncLastEpisodeAdded — best-effort, never fails the folder sync.
async function syncLastEpisodeAdded(folder) {
  const params = new URLSearchParams({
    ParentId: folder.id,
    IncludeItemTypes: 'Episode',
    Recursive: 'true',
    SortBy: 'DateCreated',
    SortOrder: 'Descending',
    Limit: '500',
    Fields: 'DateCreated',
  });
  const page = await client.jfFetch(`/Items?${params}`, { timeout: 60000 });
  const latestBySeries = new Map();
  for (const ep of (page?.Items || [])) {
    if (!ep.SeriesId) continue;
    const key = String(ep.SeriesId);
    const added = tsOf(ep.DateCreated);
    if (!latestBySeries.has(key) || added > latestBySeries.get(key)) latestBySeries.set(key, added);
  }
  for (const [seriesId, added] of latestBySeries) db.updateLastEpisodeAdded(seriesId, added);
  return latestBySeries.size;
}

async function syncFolder(folder, { collectionsById = null } = {}) {
  const sectionId = SECTION_PREFIX + folder.id;
  console.log(`[jellyfin] Syncing library folder "${folder.title}" (${sectionId})...`);
  const raw = await fetchFolderItems(folder.id);
  const items = raw.map(i => ({ ...parseItem(i, { collectionsById }), sectionId }));
  // Jellyfin's listing already carries producers/tags, so stamp detail_synced_at
  // here — these rows must never enter the Plex-only detail backfill.
  db.upsertManyItems(items, { withDetails: true });
  // Full-folder fetch is authoritative — prune rows Jellyfin no longer has.
  const pruned = db.pruneLibrarySectionItems(sectionId, items.map(i => i.ratingKey));
  db.setSyncTime(`library_${sectionId}`);
  console.log(`[jellyfin] Synced ${items.length} items for "${folder.title}"${pruned ? ` (pruned ${pruned} stale)` : ''}`);
  if (folder.type !== 'movie') {
    try {
      const n = await syncLastEpisodeAdded(folder);
      console.log(`[jellyfin] Synced last-episode-added for ${n} series in "${folder.title}"`);
    } catch (err) {
      console.warn(`[jellyfin] Last-episode-added sync failed for "${folder.title}": ${err.message}`);
    }
  }
  return items;
}

// A folder the admin explicitly disabled in Synced Libraries is skipped;
// folders never toggled default to enabled.
function isFolderEnabled(folderId) {
  const sid = SECTION_PREFIX + folderId;
  const entry = db.getSyncEnabledSections().find(s => String(s.id) === sid);
  return entry ? !!entry.enabled : true;
}

// Folder ids and the poll watermark belong to one server. A new URL starts
// both over (the next poll re-establishes the watermark); rotating the API key
// on the same server keeps them.
let _folderCache = { folders: null, at: 0 };
let _lastPollAt = 0;
let _connUrl = null;

function checkConnection() {
  const url = client.getJellyfinUrl();
  if (_connUrl !== null && url !== _connUrl) {
    _folderCache = { folders: null, at: 0 };
    _lastPollAt = 0;
  }
  _connUrl = url;
}

async function cachedFolders() {
  checkConnection();
  if (_folderCache.folders && Date.now() - _folderCache.at < 60 * 60 * 1000) return _folderCache.folders;
  _folderCache = { folders: await getFolders(), at: Date.now() };
  return _folderCache.folders;
}

// Library rows of folders the server no longer has (a deleted virtual folder,
// or a replaced server with different libraries). Only called with a folder
// list the server just returned, and never on an empty one, so an outage or a
// half-started server can't wipe the cache.
function retireRemovedFolders(folders) {
  if (folders.length === 0) return 0;
  const live = new Set(folders.map(f => SECTION_PREFIX + f.id));
  const stale = db.prepare("SELECT DISTINCT section_id FROM library_items WHERE source = 'jellyfin'").all()
    .map(r => String(r.section_id))
    .filter(sid => !live.has(sid));
  for (const sid of stale) {
    db.deleteLibraryItems(sid);
    console.log(`[jellyfin] Retired cached section ${sid} (no longer on the server)`);
  }
  return stale.length;
}

function checkFulfillment(label) {
  try {
    require('../requestFulfillment').checkAndNotifyFulfilled(`jellyfin ${label}`);
  } catch (err) {
    console.warn('[jellyfin] Fulfillment check failed:', err.message);
  }
}

// What follows every completed full resync, whichever path started it (boot,
// the 6h job, manual sync, a connection save, enabling a folder): server.js
// registers the cache invalidation and monitor evaluation here.
let _afterResync = null;
function onResynced(fn) { _afterResync = fn; }

// Concurrent callers share the in-flight run, so awaiting resyncAll() always
// means "the library is synced", not "someone else is syncing".
let _resyncInFlight = null;

function resyncAll() {
  if (!client.isEnabled()) return Promise.resolve();
  if (!_resyncInFlight) {
    _resyncInFlight = runResync().finally(() => { _resyncInFlight = null; });
  }
  return _resyncInFlight;
}

async function runResync() {
  checkConnection();
  const folders = await getFolders();
  _folderCache = { folders, at: Date.now() };
  retireRemovedFolders(folders);
  let collectionsById = null;
  try { collectionsById = await fetchBoxSetMap(); }
  catch (err) { console.warn(`[jellyfin] BoxSet lookup failed (keeping known collections): ${err.message}`); }
  for (const folder of folders) {
    if (!isFolderEnabled(folder.id)) continue;
    try { await syncFolder(folder, { collectionsById }); }
    catch (err) { console.warn(`[jellyfin] Library sync failed for "${folder.title}": ${err.message}`); }
  }
  // Whatever realtime processing missed (episodes for a season request, a
  // burst the poll couldn't cover) is caught here rather than on the next restart.
  checkFulfillment('resync');
  try { _afterResync?.(); }
  catch (err) { console.warn('[jellyfin] Post-resync hook failed:', err.message); }
}

// Shared tail for every incremental add path (poll + websocket ids): persist,
// stamp series that just gained episodes, then let request fulfillment notice
// anything with a TMDB id (season-gated requests re-check their seasons).
function persistFresh(fresh, label, episodeAdded = new Map()) {
  if (fresh.length === 0) return [];
  db.upsertManyItems(fresh, { withDetails: true });
  for (const [seriesId, added] of episodeAdded) {
    const row = db.getLibraryItemByKey(seriesId);
    if (row && added > (row.lastEpisodeAddedAt || 0)) db.updateLastEpisodeAdded(seriesId, added);
  }
  console.log(`[jellyfin] ${label} picked up ${fresh.length} new item(s)`);
  if (fresh.some(i => i.tmdbId)) checkFulfillment(label);
  return fresh;
}

const hasLibraryRow = (key) => !!db.prepare('SELECT 1 FROM library_items WHERE rating_key = ?').get(String(key));

// Lightweight new-item poll: DateCreated-desc pages per enabled folder, read
// back to a margin behind the watermark. The websocket path (upsertItemsByIds)
// is the fast lane; this is the fallback for missed events, with the 6h
// resync reconciling everything else (including items whose DateCreated was
// preserved from an old file and so never sorts as new). The watermark only
// moves once every folder was read, so a failed tick is retried in full.
const POLL_PAGE = 100;
const POLL_MAX_PAGES = 50;
const POLL_OVERLAP_SEC = 300; // rows already stored aren't fresh, so overlap is free

async function pollNewItems() {
  if (!client.isEnabled()) return [];
  checkConnection();
  const startedAt = Math.floor(Date.now() / 1000);
  if (_lastPollAt === 0) { // first tick just establishes the watermark
    _lastPollAt = startedAt;
    return [];
  }
  const since = _lastPollAt - POLL_OVERLAP_SEC;
  const fresh = [];
  let complete = true;
  for (const folder of await cachedFolders()) {
    if (!isFolderEnabled(folder.id)) continue;
    const sectionId = SECTION_PREFIX + folder.id;
    try {
      for (let page = 0; page < POLL_MAX_PAGES; page++) {
        const params = new URLSearchParams({
          ParentId: folder.id,
          IncludeItemTypes: 'Movie,Series',
          Recursive: 'true',
          Fields: ITEM_FIELDS,
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          StartIndex: String(page * POLL_PAGE),
          Limit: String(POLL_PAGE),
        });
        const rows = (await client.jfFetch(`/Items?${params}`))?.Items || [];
        let reachedOlder = false;
        for (const raw of rows) {
          const item = parseItem(raw);
          if (item.addedAt < since) { reachedOlder = true; break; }
          if (SYNCED_TYPES.has(raw.Type) && !hasLibraryRow(item.ratingKey)) fresh.push({ ...item, sectionId });
        }
        if (reachedOlder || rows.length < POLL_PAGE) break;
        if (page === POLL_MAX_PAGES - 1) console.warn(`[jellyfin] Poll of "${folder.title}" hit its page cap — the resync will pick up the rest`);
      }
    } catch (err) {
      complete = false;
      _folderCache = { folders: null, at: 0 }; // a removed folder 404s — re-list next time
      console.warn(`[jellyfin] Poll failed for "${folder.title}": ${err.message}`);
    }
  }
  if (complete) _lastPollAt = startedAt;
  return persistFresh(fresh, 'Poll');
}

// Realtime add-by-id: the websocket's LibraryChanged carries Data.ItemsAdded.
// Scoped per enabled folder (ParentId + Recursive) so section_id is known and
// disabled folders stay out. Ids are fetched in chunks, so a bulk import is
// handled by id like a single add. Episodes and seasons resolve to their
// series, which is refreshed (counts, metadata) and stamped with the newest
// episode's date — the row a season request's fulfillment check looks for.
async function upsertItemsByIds(ids) {
  if (!client.isEnabled()) return [];
  const wanted = [...new Set((ids || []).map(id => String(id || '')).filter(Boolean))];
  if (wanted.length === 0) return [];
  const folders = (await cachedFolders()).filter(f => isFolderEnabled(f.id));
  const seen = new Set();
  const fresh = [];
  const episodeAdded = new Map(); // seriesId → newest episode DateCreated
  const fetchInFolder = async (folder, chunk, types) => {
    const params = new URLSearchParams({
      ParentId: folder.id,
      Ids: chunk.join(','),
      IncludeItemTypes: types,
      Recursive: 'true',
      Fields: ITEM_FIELDS,
    });
    return (await client.jfFetch(`/Items?${params}`))?.Items || [];
  };
  for (const folder of folders) {
    const sectionId = SECTION_PREFIX + folder.id;
    const seriesIds = new Set();
    for (let i = 0; i < wanted.length; i += ID_CHUNK) {
      const chunk = wanted.slice(i, i + ID_CHUNK);
      const chunkSet = new Set(chunk);
      for (const raw of await fetchInFolder(folder, chunk, 'Movie,Series,Season,Episode')) {
        const id = String(raw.Id || '');
        if (!chunkSet.has(id) || seen.has(id)) continue;
        if (SYNCED_TYPES.has(raw.Type)) {
          seen.add(id);
          fresh.push({ ...parseItem(raw), sectionId });
        } else if (CHILD_TYPES.has(raw.Type) && raw.SeriesId) {
          seen.add(id);
          const seriesId = String(raw.SeriesId);
          seriesIds.add(seriesId);
          if (raw.Type === 'Episode') {
            episodeAdded.set(seriesId, Math.max(episodeAdded.get(seriesId) || 0, tsOf(raw.DateCreated)));
          }
        }
      }
    }
    const parents = [...seriesIds].filter(id => !fresh.some(f => f.ratingKey === id));
    for (let i = 0; i < parents.length; i += ID_CHUNK) {
      for (const raw of await fetchInFolder(folder, parents.slice(i, i + ID_CHUNK), 'Series')) {
        const id = String(raw.Id || '');
        if (raw.Type !== 'Series' || fresh.some(f => f.ratingKey === id)) continue;
        fresh.push({ ...parseItem(raw), sectionId });
      }
    }
  }
  return persistFresh(fresh, 'LibraryChanged', episodeAdded);
}

// ItemsUpdated: refresh rows already in the library — late metadata (the
// TMDB id usually lands after the add), new counts. Unknown ids are left to
// the add path and the resync. Returns only rows that just gained a TMDB id:
// that's the first moment fulfillment and monitors can match them, so they
// count as fresh.
const MAX_UPDATED_IDS = 500;

async function refreshKnownItems(ids) {
  if (!client.isEnabled()) return [];
  const wanted = [...new Set((ids || []).map(id => String(id || '')).filter(Boolean))];
  if (wanted.length === 0) return [];
  const known = new Map();
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = db.prepare(
      `SELECT rating_key, section_id, tmdb_id FROM library_items WHERE source = 'jellyfin' AND rating_key IN (${chunk.map(() => '?').join(',')})`
    ).all(...chunk);
    for (const r of rows) known.set(String(r.rating_key), r);
  }
  if (known.size === 0) return [];
  if (known.size > MAX_UPDATED_IDS) {
    console.log(`[jellyfin] ${known.size} items updated at once — leaving them to the scheduled resync`);
    return [];
  }
  const bySection = new Map();
  for (const [key, row] of known) {
    const list = bySection.get(row.section_id) || [];
    list.push(key);
    bySection.set(row.section_id, list);
  }
  const refreshed = [];
  for (const [sectionId, keys] of bySection) {
    const folderId = String(sectionId).slice(SECTION_PREFIX.length);
    if (!isFolderEnabled(folderId)) continue;
    for (let i = 0; i < keys.length; i += ID_CHUNK) {
      const params = new URLSearchParams({
        ParentId: folderId,
        Ids: keys.slice(i, i + ID_CHUNK).join(','),
        IncludeItemTypes: 'Movie,Series',
        Recursive: 'true',
        Fields: ITEM_FIELDS,
      });
      for (const raw of (await client.jfFetch(`/Items?${params}`))?.Items || []) {
        if (SYNCED_TYPES.has(raw.Type) && known.has(String(raw.Id))) refreshed.push({ ...parseItem(raw), sectionId });
      }
    }
  }
  if (refreshed.length === 0) return [];
  db.upsertManyItems(refreshed, { withDetails: true });
  const identified = refreshed.filter(i => i.tmdbId && !known.get(i.ratingKey).tmdb_id);
  if (identified.length) {
    console.log(`[jellyfin] ItemsUpdated identified ${identified.length} item(s)`);
    checkFulfillment('ItemsUpdated');
  }
  return identified;
}

// Jellyfin's analog of Plex /related: GET /Items/{id}/Similar. Returns the same
// hub shape plex.getRelated does — [{ context, title, items: [{ ratingKey,
// tmdbId, title, year, type }] }] — under one 'hub.jellyfin.similar' hub, so
// the recommenders can consume both servers' results through one code path.
async function getSimilar(itemId, limit = 20, jfUserId = null) {
  if (!client.isEnabled() || !itemId) return [];
  const params = new URLSearchParams({ Limit: String(limit), Fields: 'ProviderIds' });
  if (jfUserId) params.set('UserId', String(jfUserId));
  try {
    const page = await client.jfFetch(`/Items/${encodeURIComponent(String(itemId))}/Similar?${params}`, { timeout: 10000 });
    const items = (page?.Items || [])
      .filter(i => i?.Id && SYNCED_TYPES.has(i.Type))
      .map(i => ({
        ratingKey: String(i.Id),
        tmdbId: i.ProviderIds?.Tmdb ? String(i.ProviderIds.Tmdb) : null,
        title: i.Name || '',
        year: i.ProductionYear || null,
        type: i.Type === 'Series' ? 'show' : 'movie',
      }));
    return items.length ? [{ context: 'hub.jellyfin.similar', title: 'Similar', items }] : [];
  } catch (err) {
    console.warn('[jellyfin] getSimilar error:', err.message);
    return [];
  }
}

// Seasons of one series with per-season episode counts, in the same shape
// plex.getShowSeasons returns.
async function getShowSeasons(seriesId) {
  const params = new URLSearchParams({ Fields: 'RecursiveItemCount,ChildCount' });
  const page = await client.jfFetch(`/Shows/${encodeURIComponent(String(seriesId))}/Seasons?${params}`);
  return (page?.Items || [])
    .filter(s => Number(s.IndexNumber) > 0)
    .map(s => ({
      number: Number(s.IndexNumber),
      episodeCount: parseInt(s.RecursiveItemCount ?? s.ChildCount) || 0,
      ratingKey: String(s.Id),
    }))
    .sort((a, b) => a.number - b.number);
}

module.exports = {
  parseItem, getFolders, syncFolder, resyncAll, onResynced, pollNewItems, upsertItemsByIds, refreshKnownItems,
  getShowSeasons, getSimilar, fetchBoxSetMap, syncLastEpisodeAdded, isFolderEnabled,
  SECTION_PREFIX, ITEM_FIELDS,
};
