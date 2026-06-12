// Plex collection mirroring for monitored lists. A Plex collection lives in one
// section, so a mixed-media list maps to up to two collections (movie + TV,
// "<name> (TV)"); list_sources.collection_rating_key stores them as a JSON
// object {"movie": key, "tv": key}.
const db = require('../db/database');
const plexService = require('./plex');

const HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': 'diskovarr-app',
  'X-Plex-Product': 'Diskovarr',
};

async function plexRequest(path, { method = 'GET' } = {}) {
  const url = `${plexService.getPlexUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...HEADERS, 'X-Plex-Token': plexService.getPlexToken() },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = new Error(`Plex API error ${res.status} for ${method} ${path}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

let cachedMachineId = null;
async function getMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const envId = plexService.getPlexServerId();
  if (envId) { cachedMachineId = envId; return envId; }
  const root = await plexRequest('/');
  cachedMachineId = root?.MediaContainer?.machineIdentifier;
  if (!cachedMachineId) throw new Error('Could not determine Plex machine identifier');
  return cachedMachineId;
}

function metadataUri(machineId, ratingKeys) {
  return encodeURIComponent(
    `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`
  );
}

async function createCollection(sectionId, plexType, title, machineId, ratingKeys) {
  const json = await plexRequest(
    `/library/collections?type=${plexType}&title=${encodeURIComponent(title)}&smart=0&sectionId=${sectionId}&uri=${metadataUri(machineId, ratingKeys)}`,
    { method: 'POST' }
  );
  const key = json?.MediaContainer?.Metadata?.[0]?.ratingKey;
  if (!key) throw new Error('Plex did not return a collection ratingKey');
  return String(key);
}

async function getCollectionItemKeys(collectionKey) {
  const json = await plexRequest(`/library/collections/${collectionKey}/children?X-Plex-Container-Size=5000`);
  return new Set((json?.MediaContainer?.Metadata || []).map(m => String(m.ratingKey)));
}

// Same hub-manage endpoint Kometa/plexapi use for collection visibility.
// home → promoted on the server owner's home (and shared homes) + recommended;
// recommended → only the library's Recommended tab; library → no promotion.
async function setVisibility(sectionId, collectionKey, visibility) {
  const flags = {
    home: { rec: 1, own: 1, shared: 1 },
    recommended: { rec: 1, own: 0, shared: 0 },
    library: { rec: 0, own: 0, shared: 0 },
  }[visibility] || { rec: 0, own: 0, shared: 0 };
  await plexRequest(
    `/hubs/sections/${sectionId}/manage?metadataItemId=${collectionKey}` +
    `&promotedToRecommended=${flags.rec}&promotedToOwnHome=${flags.own}&promotedToSharedHome=${flags.shared}`,
    { method: 'POST' }
  );
}

async function deleteCollection(collectionKey) {
  await plexRequest(`/library/collections/${collectionKey}`, { method: 'DELETE' })
    .catch(err => { if (err.status !== 404) throw err; });
}

function parseCollectionKeys(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  // Legacy/simple value: a bare key is assumed to be the movie collection
  return { movie: String(raw) };
}

// Mirror one media type of the list into a collection in its section.
// Returns the (possibly newly created) collection key, or null if no items.
async function syncTypeCollection({ title, sectionId, plexType, ratingKeys, existingKey, visibility }) {
  const machineId = await getMachineId();
  let key = existingKey;

  if (key) {
    // Verify it still exists (admin may have deleted it in Plex)
    try { await plexRequest(`/library/collections/${key}`); }
    catch (err) { if (err.status === 404) key = null; else throw err; }
  }

  if (!key) {
    if (ratingKeys.length === 0) return null;
    key = await createCollection(sectionId, plexType, title, machineId, ratingKeys);
    await setVisibility(sectionId, key, visibility);
    return key;
  }

  const current = await getCollectionItemKeys(key);
  const wanted = new Set(ratingKeys.map(String));
  const toAdd = ratingKeys.filter(k => !current.has(String(k)));
  const toRemove = [...current].filter(k => !wanted.has(k));
  if (toAdd.length > 0) {
    await plexRequest(`/library/collections/${key}/items?uri=${metadataUri(machineId, toAdd)}`, { method: 'PUT' });
  }
  for (const itemKey of toRemove) {
    await plexRequest(`/library/collections/${key}/items/${itemKey}`, { method: 'DELETE' })
      .catch(err => { if (err.status !== 404) throw err; });
  }
  await setVisibility(sectionId, key, visibility);
  return key;
}

// Entry point used by the list sync job. `entries` are resolved list items
// ({ tmdbId, mediaType }); only those present in the library end up in the
// collection. Persists collection keys back onto the list source.
async function syncListCollection(listSource, entries) {
  const automation = require('../db/automation');
  const name = listSource.collectionName || listSource.name;
  const keys = parseCollectionKeys(listSource.collectionRatingKey);

  const byType = { movie: [], tv: [] };
  const stmt = db.prepare('SELECT rating_key FROM library_items WHERE tmdb_id = ? AND type = ?');
  for (const entry of entries) {
    const plexItemType = entry.mediaType === 'tv' ? 'show' : 'movie';
    const row = stmt.get(String(entry.tmdbId), plexItemType);
    if (row) byType[entry.mediaType === 'tv' ? 'tv' : 'movie'].push(String(row.rating_key));
  }

  const plans = [
    { media: 'movie', sectionId: plexService.MOVIES_SECTION, plexType: 1, title: name },
    { media: 'tv', sectionId: plexService.TV_SECTION, plexType: 2, title: listSource.mediaType === 'all' ? `${name} (TV)` : name },
  ];
  const updatedKeys = { ...keys };
  for (const plan of plans) {
    if (listSource.mediaType !== 'all' && listSource.mediaType !== plan.media) continue;
    const key = await syncTypeCollection({
      title: plan.title,
      sectionId: plan.sectionId,
      plexType: plan.plexType,
      ratingKeys: byType[plan.media],
      existingKey: updatedKeys[plan.media] || null,
      visibility: listSource.collectionVisibility,
    });
    if (key) updatedKeys[plan.media] = key;
    else delete updatedKeys[plan.media];
  }

  automation.updateListSource(listSource.id, {
    collectionRatingKey: Object.keys(updatedKeys).length ? JSON.stringify(updatedKeys) : null,
  });
  return updatedKeys;
}

// Re-apply visibility after the admin edits a list's collection settings.
async function applyVisibility(listSource) {
  const keys = parseCollectionKeys(listSource.collectionRatingKey);
  if (keys.movie) await setVisibility(plexService.MOVIES_SECTION, keys.movie, listSource.collectionVisibility);
  if (keys.tv) await setVisibility(plexService.TV_SECTION, keys.tv, listSource.collectionVisibility);
}

// Delete the Plex collections backing a list (used when removing a list and the
// admin opts to also remove its collection).
async function deleteListCollections(listSource) {
  const keys = parseCollectionKeys(listSource.collectionRatingKey);
  for (const key of Object.values(keys)) await deleteCollection(key);
}

module.exports = { syncListCollection, applyVisibility, deleteListCollections, parseCollectionKeys };
