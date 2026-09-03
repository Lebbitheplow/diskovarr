const db = require('../../db/database');
const client = require('./client');

// Jellyfin BoxSet mirroring for monitored lists — the Jellyfin half of
// plexCollections.js. A BoxSet can mix movies and series, but to match the
// Plex layout (and the per-type keys the list source stores) a mixed list
// still maps to two BoxSets: "<name>" and "<name> (TV)". Ids persist next to
// the Plex keys in list_sources.collection_rating_key as jfMovie / jfTv.

async function getBoxSetItemIds(boxSetId) {
  const params = new URLSearchParams({ ParentId: String(boxSetId), Limit: '1000' });
  const page = await client.jfFetch(`/Items?${params}`);
  return new Set((page?.Items || []).map(i => String(i.Id)));
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
async function syncListBoxSets(listSource, entries, keys) {
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
    if (id) keys[plan.keyName] = id;
    else delete keys[plan.keyName];
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
};
