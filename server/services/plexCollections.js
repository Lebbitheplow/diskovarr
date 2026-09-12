// Plex collection mirroring for monitored lists. A Plex collection lives in one
// section, so a mixed-media list maps to up to two collections (movie + TV,
// "<name> (TV)"); list_sources.collection_rating_key stores them as a JSON
// object {"movie": key, "tv": key, "jfMovie": boxSetId, "jfTv": boxSetId} —
// the jf* entries are the Jellyfin BoxSets mirrored by jellyfin/collections.js.
//
// Two flavours per list:
//   regular   – items added/removed explicitly, ordered per collection_sort
//   unwatched – a smart collection filtered on a per-list label AND
//               "unwatched" (evaluated per viewing user by Plex); the label is
//               stamped on the list's items (plexLabels.js)
// Presentation (hub promotion, home order, library sort-title prefix) is
// applied here and by plexHubs.js.
const db = require('../db/database');
const plexService = require('./plex');
const policy = require('./collectionPolicy');
const labels = require('./plexLabels');

const PLEX_KEY_NAMES = ['movie', 'tv'];

function plexConfigured() {
  return !!(plexService.getPlexUrl() && plexService.getPlexToken());
}

function jellyfinCollections() {
  return require('./jellyfin/collections');
}

function jellyfinEnabled() {
  try { return require('./jellyfin').isEnabled(); } catch { return false; }
}

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

async function createSmartCollection(sectionId, plexType, title, machineId, filterPath) {
  const uri = encodeURIComponent(`server://${machineId}/com.plexapp.plugins.library${filterPath}`);
  const json = await plexRequest(
    `/library/collections?type=${plexType}&title=${encodeURIComponent(title)}&smart=1&sectionId=${sectionId}&uri=${uri}`,
    { method: 'POST' }
  );
  const key = json?.MediaContainer?.Metadata?.[0]?.ratingKey;
  if (!key) throw new Error('Plex did not return a collection ratingKey');
  return String(key);
}

async function updateSmartFilter(collectionKey, machineId, filterPath) {
  const uri = encodeURIComponent(`server://${machineId}/com.plexapp.plugins.library${filterPath}`);
  await plexRequest(`/library/collections/${collectionKey}/items?uri=${uri}`, { method: 'PUT' });
}

// null when the collection no longer exists (admin deleted it in Plex).
async function getCollection(collectionKey) {
  try {
    const json = await plexRequest(`/library/collections/${collectionKey}`);
    return json?.MediaContainer?.Metadata?.[0] || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getCollectionItemKeys(collectionKey) {
  const json = await plexRequest(`/library/collections/${collectionKey}/children?X-Plex-Container-Size=5000`);
  return (json?.MediaContainer?.Metadata || []).map(m => String(m.ratingKey));
}

// Same hub-manage endpoint Kometa/plexapi use for collection visibility.
async function setVisibility(sectionId, collectionKey, visibility) {
  const flags = policy.visibilityFlags(visibility);
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

async function setCollectionSortTitle(collectionKey, sortTitle) {
  await plexRequest(
    `/library/metadata/${collectionKey}?type=18&id=${collectionKey}&titleSort.value=${encodeURIComponent(sortTitle)}&titleSort.locked=1`,
    { method: 'PUT' }
  );
}

async function setCollectionSummary(collectionKey, summary) {
  await plexRequest(
    `/library/metadata/${collectionKey}?type=18&id=${collectionKey}&summary.value=${encodeURIComponent(summary)}&summary.locked=1`,
    { method: 'PUT' }
  );
}

// 0 = release date, 1 = alphabetical, 2 = custom (our explicit order)
async function setCollectionCustomSort(collectionKey) {
  await plexRequest(`/library/collections/${collectionKey}/prefs?collectionSort=2`, { method: 'PUT' });
}

async function arrangeItems(collectionKey, wantedKeys) {
  const current = await getCollectionItemKeys(collectionKey);
  const moves = policy.planMoves(current, wantedKeys);
  for (const m of moves) {
    await plexRequest(
      `/library/collections/${collectionKey}/items/${m.key}/move${m.after ? `?after=${m.after}` : ''}`,
      { method: 'PUT' }
    ).catch(() => {});
  }
  return moves.length;
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

// Library rows for the list's entries (Plex only — a Jellyfin GUID would be
// built into a Plex metadata URI), in list order, with the fields sorting needs.
function plexRowsFor(entries, media) {
  const stmt = db.prepare(
    "SELECT rating_key, title, release_date, added_at, audience_rating, rating FROM library_items WHERE tmdb_id = ? AND type = ? AND source = 'plex'"
  );
  const plexItemType = media === 'tv' ? 'show' : 'movie';
  const rows = [];
  for (const entry of entries) {
    if ((entry.mediaType === 'tv' ? 'tv' : 'movie') !== media) continue;
    const row = stmt.get(String(entry.tmdbId), plexItemType);
    if (row) {
      rows.push({
        ratingKey: String(row.rating_key), title: row.title, releaseDate: row.release_date,
        addedAt: row.added_at, rating: row.audience_rating || row.rating || 0,
      });
    }
  }
  return rows;
}

// Mirror one media type of the list into a collection in its section.
// Returns the (possibly newly created) collection key, or null if no items.
async function syncTypeCollection({ list, media, title, sectionId, plexType, rows, existingKey, sortPrefix }) {
  const machineId = await getMachineId();
  const wantSmart = !!list.collectionUnwatchedOnly;
  const label = policy.listLabel(list.id);
  let key = existingKey || null;
  let existing = key ? await getCollection(key) : null;
  if (!existing) key = null;

  if (wantSmart) {
    // Keep the label set in step with the list, then point the smart filter at it.
    await labels.syncLabel({ sectionId, plexType, label, wantedKeys: rows.map(r => r.ratingKey) });
    const filterPath = policy.smartFilterPath({ sectionId, mediaType: media, label, sort: list.collectionSort, maxItems: list.maxItems });
    if (existing && String(existing.smart) !== '1') {
      // Converting a regular collection: the smart one replaces it.
      await deleteCollection(key);
      key = null;
    }
    if (!key) {
      if (rows.length === 0) return null;
      key = await createSmartCollection(sectionId, plexType, title, machineId, filterPath);
    } else {
      await updateSmartFilter(key, machineId, filterPath);
    }
  } else {
    const wanted = policy.orderItems(rows, list.collectionSort).map(r => r.ratingKey);
    if (existing && String(existing.smart) === '1') {
      await labels.syncLabel({ sectionId, plexType, label, wantedKeys: [] }).catch(() => {});
      await deleteCollection(key);
      key = null;
    }
    if (!key) {
      if (wanted.length === 0) return null;
      key = await createCollection(sectionId, plexType, title, machineId, wanted);
    } else {
      const current = new Set(await getCollectionItemKeys(key));
      const wantedSet = new Set(wanted);
      const toAdd = wanted.filter(k => !current.has(k));
      const toRemove = [...current].filter(k => !wantedSet.has(k));
      if (toAdd.length > 0) {
        await plexRequest(`/library/collections/${key}/items?uri=${metadataUri(machineId, toAdd)}`, { method: 'PUT' });
      }
      for (const itemKey of toRemove) {
        await plexRequest(`/library/collections/${key}/items/${itemKey}`, { method: 'DELETE' })
          .catch(err => { if (err.status !== 404) throw err; });
      }
    }
    await setCollectionCustomSort(key).catch(() => {});
    await arrangeItems(key, wanted).catch(() => {});
  }

  await setVisibility(sectionId, key, list.collectionVisibility);
  const current = existing || await getCollection(key);
  const plainTitle = current?.title || title;
  if (sortPrefix) {
    const wantedSort = `${sortPrefix}${plainTitle}`;
    if (current?.titleSort !== wantedSort) await setCollectionSortTitle(key, wantedSort).catch(() => {});
  } else if (current?.titleSort && /^!+/.test(current.titleSort) && current.titleSort !== plainTitle) {
    // No library order any more: drop the prefix we (or Agregarr) added.
    await setCollectionSortTitle(key, plainTitle).catch(() => {});
  }
  if (list.collectionSummary && current?.summary !== list.collectionSummary) {
    await setCollectionSummary(key, list.collectionSummary).catch(() => {});
  }
  return key;
}

// Library-order prefix for this list within its section, from every list
// that mirrors into the same media type (max order defines the prefix length).
function sortPrefixFor(list, media) {
  const automation = require('../db/automation');
  if (!(list.libraryOrder > 0)) return null;
  const peers = automation.getCollectionListsForMedia(media);
  const maxOrder = Math.max(list.libraryOrder, ...peers.map(p => p.libraryOrder || 0));
  return policy.sortTitlePrefix(list.libraryOrder, maxOrder);
}

// Entry point used by the list sync job. `entries` are resolved list items
// ({ tmdbId, mediaType }) in list order; only those present in the library end
// up in the collection. Persists collection keys back onto the list source.
async function syncListCollection(listSource, entries) {
  const automation = require('../db/automation');
  const name = listSource.collectionName || listSource.name;
  const keys = parseCollectionKeys(listSource.collectionRatingKey);

  const plans = [
    { media: 'movie', sectionId: plexService.MOVIES_SECTION, plexType: 1, title: name },
    { media: 'tv', sectionId: plexService.TV_SECTION, plexType: 2, title: listSource.mediaType === 'all' ? `${name} (TV)` : name },
  ];
  const updatedKeys = { ...keys };
  const errors = [];
  // Each server mirrors independently so a Plex outage (or a Jellyfin-only
  // deployment) never blocks the other; keys are persisted either way.
  if (plexConfigured()) {
    try {
      for (const plan of plans) {
        if (listSource.mediaType !== 'all' && listSource.mediaType !== plan.media) continue;
        const key = await syncTypeCollection({
          list: listSource,
          media: plan.media,
          title: plan.title,
          sectionId: plan.sectionId,
          plexType: plan.plexType,
          rows: plexRowsFor(entries, plan.media),
          existingKey: updatedKeys[plan.media] || null,
          sortPrefix: sortPrefixFor(listSource, plan.media),
        });
        if (key) updatedKeys[plan.media] = key;
        else delete updatedKeys[plan.media];
      }
    } catch (e) {
      errors.push(`plex: ${e.message}`);
    }
  }
  if (jellyfinEnabled()) {
    try { await jellyfinCollections().syncListBoxSets(listSource, entries, updatedKeys); }
    catch (e) { errors.push(`jellyfin: ${e.message}`); }
  }

  automation.updateListSource(listSource.id, {
    collectionRatingKey: Object.keys(updatedKeys).length ? JSON.stringify(updatedKeys) : null,
  });
  if (errors.length) throw new Error(errors.join('; '));
  return updatedKeys;
}

// Re-apply visibility after the admin edits a list's collection settings.
async function applyVisibility(listSource) {
  const keys = parseCollectionKeys(listSource.collectionRatingKey);
  if (keys.movie) await setVisibility(plexService.MOVIES_SECTION, keys.movie, listSource.collectionVisibility);
  if (keys.tv) await setVisibility(plexService.TV_SECTION, keys.tv, listSource.collectionVisibility);
}

// Delete the Plex collections backing a list (used when removing a list and the
// admin opts to also remove its collection). Smart collections also drop their label.
async function deleteListCollections(listSource) {
  const keys = parseCollectionKeys(listSource.collectionRatingKey);
  for (const name of PLEX_KEY_NAMES) if (keys[name]) await deleteCollection(keys[name]);
  if (listSource.collectionUnwatchedOnly && plexConfigured()) {
    const label = policy.listLabel(listSource.id);
    for (const [name, sectionId, plexType] of [['movie', plexService.MOVIES_SECTION, 1], ['tv', plexService.TV_SECTION, 2]]) {
      if (keys[name]) await labels.syncLabel({ sectionId, plexType, label, wantedKeys: [] }).catch(() => {});
    }
  }
  if (keys.jfMovie || keys.jfTv) await jellyfinCollections().deleteListBoxSets(keys);
}

module.exports = {
  syncListCollection, applyVisibility, deleteListCollections, parseCollectionKeys,
  getCollection, setCollectionSortTitle, plexConfigured,
};
