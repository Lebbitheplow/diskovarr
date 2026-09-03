const db = require('../../db/database');
const client = require('./client');

// Jellyfin library sync. Produces rows in the same library_items table the Plex
// sync fills, with source='jellyfin', rating_key = the Jellyfin Item Id (a GUID,
// so it can never collide with Plex's numeric keys) and section_id = 'jf_<folderId>'.

const SECTION_PREFIX = 'jf_';
const SYNCED_TYPES = new Set(['Movie', 'Series']);

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

// Map a Jellyfin BaseItemDto → the exact item shape plex.js parseMediaItem
// produces, so db.upsertManyItems and everything downstream work unchanged.
// `collectionsById` (itemId → [BoxSet names]) comes from fetchBoxSetMap() on a
// full resync; Tags map onto Plex's labels.
function parseItem(item, { collectionsById = null } = {}) {
  const id = String(item.Id);
  const isShow = item.Type === 'Series';
  const mediaSources = item.MediaSources || [];
  let fileSize = 0;
  for (const src of mediaSources) fileSize += parseInt(src.Size) || 0;
  const addedAt = item.DateCreated ? Math.floor(Date.parse(item.DateCreated) / 1000) || 0 : 0;
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
    collections: collectionsById?.get(id) || [],
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

// Movie/show virtual folders (Jellyfin's equivalent of Plex sections).
async function getFolders() {
  const folders = await client.jfFetch('/Library/VirtualFolders');
  return (folders || [])
    .filter(f => ['movies', 'tvshows'].includes(f.CollectionType))
    .map(f => ({
      id: String(f.ItemId),
      title: f.Name,
      type: f.CollectionType === 'tvshows' ? 'show' : 'movie',
    }));
}

async function fetchFolderItems(folderId) {
  const items = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const params = new URLSearchParams({
      ParentId: folderId,
      IncludeItemTypes: 'Movie,Series',
      Recursive: 'true',
      Fields: ITEM_FIELDS,
      StartIndex: String(start),
      Limit: String(pageSize),
      SortBy: 'SortName',
    });
    const page = await client.jfFetch(`/Items?${params}`, { timeout: 120000 });
    const rows = page?.Items || [];
    items.push(...rows);
    if (rows.length < pageSize) break;
  }
  return items;
}

// BoxSets are Jellyfin's collections. One pass per full resync: list every
// BoxSet, then its children, and invert into itemId → [names] so parseItem can
// fill `collections` (discover facets, monitor `collection` criterion).
async function fetchBoxSetMap() {
  const map = new Map();
  const listParams = new URLSearchParams({
    IncludeItemTypes: 'BoxSet', Recursive: 'true', Fields: 'ChildCount', Limit: '1000',
  });
  const boxSets = (await client.jfFetch(`/Items?${listParams}`))?.Items || [];
  for (const box of boxSets) {
    if (!box.Id || !box.Name || box.ChildCount === 0) continue;
    const childParams = new URLSearchParams({ ParentId: String(box.Id), Fields: 'ProviderIds', Limit: '1000' });
    const children = (await client.jfFetch(`/Items?${childParams}`))?.Items || [];
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
    const added = ep.DateCreated ? Math.floor(Date.parse(ep.DateCreated) / 1000) || 0 : 0;
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
  if (folder.type === 'show') {
    try {
      const n = await syncLastEpisodeAdded(folder);
      console.log(`[jellyfin] Synced last-episode-added for ${n} series in "${folder.title}"`);
    } catch (err) {
      console.warn(`[jellyfin] Last-episode-added sync failed for "${folder.title}": ${err.message}`);
    }
  }
  return items;
}

let _syncInProgress = false;

// A folder the admin explicitly disabled in Synced Libraries is skipped;
// folders never toggled default to enabled.
function isFolderEnabled(folderId) {
  const sid = SECTION_PREFIX + folderId;
  const entry = db.getSyncEnabledSections().find(s => String(s.id) === sid);
  return entry ? !!entry.enabled : true;
}

async function resyncAll() {
  if (!client.isEnabled() || _syncInProgress) return;
  _syncInProgress = true;
  try {
    const folders = await getFolders();
    let collectionsById = null;
    try { collectionsById = await fetchBoxSetMap(); }
    catch (err) { console.warn(`[jellyfin] BoxSet lookup failed (collections left empty): ${err.message}`); }
    for (const folder of folders) {
      if (!isFolderEnabled(folder.id)) continue;
      try { await syncFolder(folder, { collectionsById }); }
      catch (err) { console.warn(`[jellyfin] Library sync failed for "${folder.title}": ${err.message}`); }
    }
  } finally {
    _syncInProgress = false;
  }
}

let _folderCache = { folders: null, at: 0 };

async function cachedFolders() {
  if (_folderCache.folders && Date.now() - _folderCache.at < 60 * 60 * 1000) return _folderCache.folders;
  _folderCache = { folders: await getFolders(), at: Date.now() };
  return _folderCache.folders;
}

// Shared tail for every incremental add path (poll + websocket ids): persist,
// then let request fulfillment notice anything with a TMDB id.
function persistFresh(fresh, label) {
  if (fresh.length === 0) return [];
  db.upsertManyItems(fresh, { withDetails: true });
  console.log(`[jellyfin] ${label} picked up ${fresh.length} new item(s)`);
  if (fresh.some(i => i.tmdbId)) {
    try {
      require('../requestFulfillment').checkAndNotifyFulfilled(`jellyfin ${label}`);
    } catch (err) {
      console.warn('[jellyfin] Fulfillment check failed:', err.message);
    }
  }
  return fresh;
}

// Lightweight new-item poll: a bounded DateCreated-desc query per enabled
// folder. The websocket path (upsertItemsByIds) is the fast lane; this is the
// fallback for missed events, with the 6h resync reconciling everything else.
let _lastPollAt = 0;

async function pollNewItems() {
  if (!client.isEnabled()) return [];
  const since = _lastPollAt;
  _lastPollAt = Math.floor(Date.now() / 1000);
  if (since === 0) return []; // first tick just establishes the watermark
  const fresh = [];
  for (const folder of await cachedFolders()) {
    if (!isFolderEnabled(folder.id)) continue;
    const params = new URLSearchParams({
      ParentId: folder.id,
      IncludeItemTypes: 'Movie,Series',
      Recursive: 'true',
      Fields: ITEM_FIELDS,
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: '50',
    });
    const page = await client.jfFetch(`/Items?${params}`);
    for (const raw of (page?.Items || [])) {
      const item = parseItem(raw);
      if (item.addedAt > since) fresh.push({ ...item, sectionId: SECTION_PREFIX + folder.id });
    }
  }
  return persistFresh(fresh, 'Poll');
}

// Realtime add-by-id: the websocket's LibraryChanged carries Data.ItemsAdded.
// Scoped per enabled folder (ParentId + Recursive) so section_id is known and
// disabled folders stay out; only Movie/Series survive (episodes/seasons in the
// same event are dropped — the series row is what library_items stores).
async function upsertItemsByIds(ids) {
  if (!client.isEnabled()) return [];
  const wanted = [...new Set((ids || []).map(id => String(id || '')).filter(Boolean))];
  if (wanted.length === 0) return [];
  const wantedSet = new Set(wanted);
  const seen = new Set();
  const fresh = [];
  for (const folder of await cachedFolders()) {
    if (!isFolderEnabled(folder.id)) continue;
    const params = new URLSearchParams({
      ParentId: folder.id,
      Ids: wanted.join(','),
      IncludeItemTypes: 'Movie,Series',
      Recursive: 'true',
      Fields: ITEM_FIELDS,
    });
    const page = await client.jfFetch(`/Items?${params}`);
    for (const raw of (page?.Items || [])) {
      const id = String(raw.Id || '');
      if (!SYNCED_TYPES.has(raw.Type) || !wantedSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      fresh.push({ ...parseItem(raw), sectionId: SECTION_PREFIX + folder.id });
    }
  }
  return persistFresh(fresh, 'LibraryChanged');
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

module.exports = {
  parseItem, getFolders, syncFolder, resyncAll, pollNewItems, upsertItemsByIds,
  getSimilar, fetchBoxSetMap, syncLastEpisodeAdded, isFolderEnabled,
  SECTION_PREFIX, ITEM_FIELDS,
};
