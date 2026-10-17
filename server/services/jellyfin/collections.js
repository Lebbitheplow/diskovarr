const db = require('../../db/database');
const client = require('./client');

// Jellyfin BoxSet mirroring for monitored lists — the Jellyfin half of
// plexCollections.js. A BoxSet can mix movies and series, but to match the
// Plex layout (and the per-type keys the list source stores) a mixed list
// still maps to two BoxSets: "<name>" and "<name> (TV)". Ids persist next to
// the Plex keys in list_sources.collection_rating_key as jfMovie / jfTv.

const PAGE_SIZE = 1000;

// Every child of a BoxSet. Membership is reconciled against this set (members
// missing from the list are removed), so it must be complete: any failed page,
// or a short page while TotalRecordCount says more remain, throws instead.
async function getBoxSetItemIds(boxSetId) {
  const ids = new Set();
  for (let start = 0; ; start += PAGE_SIZE) {
    const params = new URLSearchParams({
      ParentId: String(boxSetId), StartIndex: String(start), Limit: String(PAGE_SIZE), EnableTotalRecordCount: 'true',
    });
    const page = await client.jfFetch(`/Items?${params}`);
    const rows = page?.Items || [];
    for (const i of rows) ids.add(String(i.Id));
    if (rows.length < PAGE_SIZE) {
      const total = Number(page?.TotalRecordCount);
      if (Number.isFinite(total) && start + rows.length < total) {
        throw new Error(`BoxSet ${boxSetId} membership read incomplete (${start + rows.length} of ${total})`);
      }
      return ids;
    }
  }
}

// Verify a stored BoxSet still exists (the admin may have deleted it in Jellyfin).
async function boxSetExists(boxSetId) {
  const params = new URLSearchParams({ Ids: String(boxSetId), IncludeItemTypes: 'BoxSet', Recursive: 'true' });
  const page = await client.jfFetch(`/Items?${params}`).catch(err => {
    if (String(err.message).includes(' 404 ')) return null;
    throw err;
  });
  return !!(page?.Items || []).find(i => String(i.Id) === String(boxSetId));
}

async function createBoxSet(name, itemIds) {
  const params = new URLSearchParams({ Name: name, Ids: itemIds.join(',') });
  const created = await client.jfFetch(`/Collections?${params}`, { method: 'POST' });
  const id = created?.Id;
  if (!id) throw new Error('Jellyfin did not return a collection Id');
  return String(id);
}

async function addItems(boxSetId, itemIds) {
  if (!itemIds.length) return;
  await client.jfFetch(`/Collections/${encodeURIComponent(boxSetId)}/Items?Ids=${encodeURIComponent(itemIds.join(','))}`, { method: 'POST' });
}

async function removeItems(boxSetId, itemIds) {
  if (!itemIds.length) return;
  await client.jfFetch(`/Collections/${encodeURIComponent(boxSetId)}/Items?Ids=${encodeURIComponent(itemIds.join(','))}`, { method: 'DELETE' });
}

async function deleteBoxSet(boxSetId) {
  await client.jfFetch(`/Items/${encodeURIComponent(boxSetId)}`, { method: 'DELETE' })
    .catch(err => { if (!String(err.message).includes(' 404 ')) throw err; });
}

// Diskovarr item orders a BoxSet can express. BoxSet.DisplayOrder is parsed as
// an ItemSortBy and always sorted ascending; 'Default' keeps insertion order,
// and items are added in list order. Descending orders have no equivalent, so
// those lists leave the BoxSet's own order alone (the editor says so).
const DISPLAY_ORDERS = { list: 'Default', release_asc: 'PremiereDate', title: 'SortName' };

// What POST /Items/{id} needs to round-trip: it replaces the item's editable
// metadata wholesale (a missing Tags or ProviderIds is a server error), so the
// current DTO is read with these fields and sent back with only ours changed.
const EDIT_FIELDS = 'Overview,Genres,Tags,ProviderIds,Settings,Studios,Taglines,DateCreated,OriginalTitle,CustomRating,SortName';

// Presentation the list/pack settings can express on a BoxSet: `overview`
// (summary; locked like Plex's summary.locked so a metadata refresh keeps it),
// `displayOrder` and `forcedSortName` (library order, the Plex titleSort
// prefix). `dropSortPrefix` clears a sort name we prefixed earlier (leading
// '!') when there is no library order any more. Undefined fields are left
// alone; nothing is written when the BoxSet already matches. Returns true
// when it wrote.
async function updateBoxSetMetadata(boxSetId, { overview, displayOrder, forcedSortName, dropSortPrefix = false } = {}) {
  const params = new URLSearchParams({ Ids: String(boxSetId), IncludeItemTypes: 'BoxSet', Recursive: 'true', Fields: EDIT_FIELDS });
  const dto = ((await client.jfFetch(`/Items?${params}`))?.Items || []).find(i => String(i.Id) === String(boxSetId));
  if (!dto) return false;
  const next = { ...dto };
  if (overview !== undefined && (dto.Overview || '') !== overview) {
    next.Overview = overview;
    next.LockedFields = [...new Set([...(dto.LockedFields || []), 'Overview'])];
  }
  if (displayOrder !== undefined && (dto.DisplayOrder || null) !== displayOrder) next.DisplayOrder = displayOrder;
  if (forcedSortName !== undefined && (dto.ForcedSortName || null) !== forcedSortName) next.ForcedSortName = forcedSortName;
  else if (forcedSortName === undefined && dropSortPrefix && /^!+/.test(dto.ForcedSortName || '')) next.ForcedSortName = null;
  if (next.Overview === dto.Overview && next.DisplayOrder === dto.DisplayOrder && next.ForcedSortName === dto.ForcedSortName) return false;
  await client.jfFetch(`/Items/${encodeURIComponent(boxSetId)}`, {
    method: 'POST',
    body: { ...next, Tags: next.Tags || [], Genres: next.Genres || [], ProviderIds: next.ProviderIds || {} },
  });
  return true;
}

// Jellyfin downloads the artwork itself, like Plex's /posters?url=.
async function setBoxSetImage(boxSetId, url) {
  if (!url) return;
  const params = new URLSearchParams({ type: 'Primary', imageUrl: url });
  await client.jfFetch(`/Items/${encodeURIComponent(boxSetId)}/RemoteImages/Download?${params}`, { method: 'POST' });
}

// The BoxSet half of a list's collection settings. Plex-only options (hub
// promotion, home position, the per-viewer unwatched smart filter) have no
// BoxSet equivalent and are not applied — a shared BoxSet is never filtered
// by one user's watched state.
function listPresentation(listSource, title, sortPrefix) {
  return {
    overview: listSource.collectionSummary || undefined,
    displayOrder: DISPLAY_ORDERS[listSource.collectionSort || 'list'],
    ...(sortPrefix ? { forcedSortName: `${sortPrefix}${title}` } : { dropSortPrefix: true }),
  };
}

// Mirror one media type of a list into a BoxSet. Returns the (possibly new)
// BoxSet id, or null when there is nothing to put in it.
async function syncTypeBoxSet({ title, itemIds, existingId }) {
  let id = existingId || null;
  if (id && !(await boxSetExists(id))) id = null;
  if (!id) {
    if (itemIds.length === 0) return null;
    return createBoxSet(title, itemIds);
  }
  const current = await getBoxSetItemIds(id);
  const wanted = new Set(itemIds.map(String));
  await addItems(id, itemIds.filter(i => !current.has(String(i))));
  await removeItems(id, [...current].filter(i => !wanted.has(i)));
  return id;
}

// Jellyfin items for the resolved list entries ({ tmdbId, mediaType }), split by type.
function jellyfinItemsFor(entries) {
  const byType = { movie: [], tv: [] };
  const stmt = db.prepare("SELECT rating_key FROM library_items WHERE tmdb_id = ? AND type = ? AND source = 'jellyfin'");
  for (const entry of entries) {
    const media = entry.mediaType === 'tv' ? 'tv' : 'movie';
    const row = stmt.get(String(entry.tmdbId), media === 'tv' ? 'show' : 'movie');
    if (row) byType[media].push(String(row.rating_key));
  }
  return byType;
}

// Called by plexCollections.syncListCollection alongside the Plex mirror.
// Mutates and returns `keys` with jfMovie / jfTv set or removed.
// `sortPrefixes` ({ movie, tv }) are the library-order prefixes the Plex side
// computes for the same list.
async function syncListBoxSets(listSource, entries, keys, { sortPrefixes = {} } = {}) {
  if (!client.isEnabled()) return keys;
  const name = listSource.collectionName || listSource.name;
  const byType = jellyfinItemsFor(entries);
  const plans = [
    { media: 'movie', keyName: 'jfMovie', title: name },
    { media: 'tv', keyName: 'jfTv', title: listSource.mediaType === 'all' ? `${name} (TV)` : name },
  ];
  for (const plan of plans) {
    if (listSource.mediaType !== 'all' && listSource.mediaType !== plan.media) continue;
    const id = await syncTypeBoxSet({ title: plan.title, itemIds: byType[plan.media], existingId: keys[plan.keyName] || null });
    if (id) {
      keys[plan.keyName] = id;
      // Cosmetic, like the Plex summary/sort-title writes: never fails the mirror.
      await updateBoxSetMetadata(id, listPresentation(listSource, plan.title, sortPrefixes[plan.media]))
        .catch(err => console.warn(`[jellyfin] BoxSet presentation update failed for "${plan.title}": ${err.message}`));
    } else {
      delete keys[plan.keyName];
    }
  }
  return keys;
}

async function deleteListBoxSets(keys) {
  for (const keyName of ['jfMovie', 'jfTv']) {
    if (keys[keyName]) await deleteBoxSet(keys[keyName]);
  }
}

module.exports = {
  syncListBoxSets, deleteListBoxSets, syncTypeBoxSet, jellyfinItemsFor,
  createBoxSet, addItems, removeItems, deleteBoxSet, getBoxSetItemIds, boxSetExists,
  updateBoxSetMetadata, setBoxSetImage, DISPLAY_ORDERS,
};
