const db = require('../../db/database');
const client = require('./client');

// Jellyfin library sync. Produces rows in the same library_items table the Plex
// sync fills, with source='jellyfin', rating_key = the Jellyfin Item Id (a GUID,
// so it can never collide with Plex's numeric keys) and section_id = 'jf_<folderId>'.

const SECTION_PREFIX = 'jf_';

const ITEM_FIELDS = [
  'ProviderIds', 'Genres', 'People', 'Studios', 'DateCreated', 'Overview',
  'OfficialRating', 'CommunityRating', 'CriticRating', 'RecursiveItemCount',
  'ProductionYear', 'PremiereDate', 'ProductionLocations', 'MediaSources', 'Taglines',
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
function parseItem(item) {
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
    collections: [],
    labels: [],
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

async function syncFolder(folder) {
  const sectionId = SECTION_PREFIX + folder.id;
  console.log(`[jellyfin] Syncing library folder "${folder.title}" (${sectionId})...`);
  const raw = await fetchFolderItems(folder.id);
  const items = raw.map(i => ({ ...parseItem(i), sectionId }));
  db.upsertManyItems(items);
  // Full-folder fetch is authoritative — prune rows Jellyfin no longer has.
  const pruned = db.pruneLibrarySectionItems(sectionId, items.map(i => i.ratingKey));
  db.setSyncTime(`library_${sectionId}`);
  console.log(`[jellyfin] Synced ${items.length} items for "${folder.title}"${pruned ? ` (pruned ${pruned} stale)` : ''}`);
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
    for (const folder of folders) {
      if (!isFolderEnabled(folder.id)) continue;
      try { await syncFolder(folder); }
      catch (err) { console.warn(`[jellyfin] Library sync failed for "${folder.title}": ${err.message}`); }
    }
  } finally {
    _syncInProgress = false;
  }
}

// Lightweight new-item poll (Jellyfin's websocket needs a session token dance;
// a bounded DateCreated-desc query per folder every few minutes covers request
// fulfillment, with the 6h resync reconciling everything else).
let _lastPollAt = 0;
let _folderCache = { folders: null, at: 0 };

async function cachedFolders() {
  if (_folderCache.folders && Date.now() - _folderCache.at < 60 * 60 * 1000) return _folderCache.folders;
  _folderCache = { folders: await getFolders(), at: Date.now() };
  return _folderCache.folders;
}

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
  if (fresh.length === 0) return [];
  db.upsertManyItems(fresh);
  console.log(`[jellyfin] Poll picked up ${fresh.length} new item(s)`);
  if (fresh.some(i => i.tmdbId)) {
    try {
      require('../requestFulfillment').checkAndNotifyFulfilled('jellyfin poll');
    } catch (err) {
      console.warn('[jellyfin] Fulfillment check failed:', err.message);
    }
  }
  return fresh;
}

module.exports = { parseItem, getFolders, syncFolder, resyncAll, pollNewItems, SECTION_PREFIX };
