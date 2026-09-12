// Auto Request job: fetches each enabled monitored list on its own interval,
// resolves entries to TMDB ids, applies the list's policy (exclusions, item
// cap), auto-requests new items (per-list approval mode, season mode), and
// mirrors the list into a Plex collection when enabled.
//
// Between full syncs a quick pass (runQuickSync, every 30 minutes) rebuilds
// collections from the cached list items so newly added library titles show
// up without re-hitting the sources — Agregarr's "collections quick sync".
const db = require('../db/database');
const automation = require('../db/automation');
const listSources = require('./listSources');
const plexCollections = require('./plexCollections');
const plexHubs = require('./plexHubs');
const tmdbService = require('./tmdb');
const logger = require('./logger');
const policy = require('./collectionPolicy');

const SYSTEM_USER_ID = 'autorequest';
const EXCLUSIONS_SETTING = 'autorequest_exclusions';
const DEFAULT_FETCH_LIMIT = 500;
let systemUserSeeded = false;

function ensureSystemUser() {
  if (systemUserSeeded) return;
  db.seedKnownUser(SYSTEM_USER_ID, 'Auto Request', null, null);
  // Drop the identity from the brief pre-rename deploy so it doesn't linger in user lists
  try { db.prepare("DELETE FROM known_users WHERE user_id = 'list-sync'").run(); } catch {}
  systemUserSeeded = true;
}

// Global exclusions: [{ tmdbId, mediaType, title? }] never requested or
// mirrored by any list (Agregarr's globalExclusions).
function getGlobalExclusions() {
  try {
    const arr = JSON.parse(db.getSetting(EXCLUSIONS_SETTING, '[]') || '[]');
    return Array.isArray(arr) ? arr.filter(e => e && Number(e.tmdbId)).map(e => ({
      tmdbId: Number(e.tmdbId), mediaType: e.mediaType === 'tv' ? 'tv' : 'movie', ...(e.title ? { title: String(e.title) } : {}),
    })) : [];
  } catch { return []; }
}

function setGlobalExclusions(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter(e => e && Number(e.tmdbId))
    .map(e => ({ tmdbId: Number(e.tmdbId), mediaType: e.mediaType === 'tv' ? 'tv' : 'movie', ...(e.title ? { title: String(e.title) } : {}) }));
  const seen = new Set();
  const deduped = clean.filter(e => { const k = policy.keyOf(e.tmdbId, e.mediaType); if (seen.has(k)) return false; seen.add(k); return true; });
  db.setSetting(EXCLUSIONS_SETTING, JSON.stringify(deduped));
  return deduped;
}

function activeRequestExists(tmdbId, mediaType) {
  return !!db.prepare(
    "SELECT 1 FROM discover_requests WHERE tmdb_id = ? AND media_type = ? AND status != 'denied' LIMIT 1"
  ).get(Number(tmdbId), String(mediaType));
}

function lastInsertedRequestId(tmdbId, mediaType) {
  const row = db.prepare(
    'SELECT id FROM discover_requests WHERE user_id = ? AND tmdb_id = ? AND media_type = ? ORDER BY id DESC LIMIT 1'
  ).get(SYSTEM_USER_ID, Number(tmdbId), String(mediaType));
  return row ? row.id : null;
}

function notifyAdmins(title, body) {
  try {
    for (const adminId of db.getPrivilegedUserIds()) {
      const notifId = db.createOrBundleNotification({
        userId: adminId, type: 'autorequest', title, body, data: {},
      });
      for (const agent of ['discord', 'pushover']) {
        db.enqueueNotification({ notificationId: notifId, agent, userId: adminId, payload: { type: 'autorequest', title, body } });
      }
    }
  } catch (e) {
    logger.warn(`[autorequest] admin notification failed: ${e.message}`);
  }
}

// Typed entries for the list's media type; a mixed list keeps both.
function filterByMediaType(entries, mediaType) {
  return entries.filter(e => {
    if (mediaType === 'movie') return e.mediaType !== 'tv';
    if (mediaType === 'tv') return e.mediaType === 'tv';
    return true;
  });
}

// Mirror into Plex/Jellyfin and re-apply the section's home layout when the
// list is promoted anywhere (its collection may be new to hub management).
async function mirrorCollection(listSource, items, summary) {
  if (!listSource.collectionEnabled) return;
  try {
    await plexCollections.syncListCollection(listSource, items);
  } catch (e) {
    summary.collectionError = e.message;
    logger.warn(`[autorequest] collection sync failed for "${listSource.name}": ${e.message}`);
  }
}

// Sync a single list source. Returns a summary object (also recorded on the row).
async function syncList(listSource) {
  ensureSystemUser();
  const started = Date.now();
  const startedTs = Math.floor(started / 1000);
  logger.info(`[autorequest] syncing "${listSource.name}" (#${listSource.id}, ${listSource.sourceType})`);

  const fetchLimit = listSource.maxItems > 0 ? listSource.maxItems : DEFAULT_FETCH_LIMIT;
  const rawEntries = await listSources.fetchList(listSource, { limit: fetchLimit });
  const typed = filterByMediaType(rawEntries, listSource.mediaType);
  const resolved = await listSources.resolveEntries(typed);
  const { items, excludedCount } = policy.applyListPolicy(resolved.items, {
    maxItems: listSource.maxItems,
    exclusions: listSource.exclusions,
    globalExclusions: getGlobalExclusions(),
  });

  const inLibrary = db.getLibraryTmdbKeys();
  const summary = {
    total: items.length, unresolved: resolved.unresolved, excluded: excludedCount,
    requested: 0, pending: 0, inLibrary: 0, skipped: 0, failed: 0,
  };

  // Lazy requires: routes/api.js and the shim pull in heavy deps and would be a
  // require cycle at module load (they require services that require this file's
  // siblings); both are resolved by the time a sync actually runs.
  const { submitRequestToService } = require('../routes/api');
  const { pickService } = require('../routes/overseerrShim');

  const knownItems = new Map(
    automation.getListItems(listSource.id).map(li => [`${li.tmdbId}:${li.mediaType}`, li])
  );
  let requestBudget = listSource.maxRequestsPerRun;
  let position = 0;
  for (const item of items) {
    position++;
    const libKey = `${item.tmdbId}:${item.mediaType}`;
    const base = { listId: listSource.id, tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, position };
    try {
      if (inLibrary.has(libKey)) {
        automation.upsertListItem({ ...base, status: 'in_library' });
        summary.inLibrary++;
        continue;
      }
      const known = knownItems.get(libKey);
      // 'deleted' = a deletion profile removed this item from the library; never
      // re-request it just because it is still on the external list.
      if (known && known.status === 'deleted') { automation.upsertListItem({ ...base, status: 'deleted' }); summary.skipped++; continue; }
      const existing = known && ['requested', 'pending'].includes(known.status) ? known : null;
      if (existing || activeRequestExists(item.tmdbId, item.mediaType)) {
        automation.upsertListItem({ ...base, status: existing ? existing.status : 'requested' });
        summary.skipped++;
        continue;
      }
      if (requestBudget <= 0) {
        automation.upsertListItem({ ...base, status: 'seen' });
        summary.skipped++;
        continue;
      }

      // Enrich (poster + canonical title + seasons) — also warms tmdb_cache for the UI
      let title = item.title || '';
      let posterUrl = null;
      let details = null;
      try {
        details = await tmdbService.getItemDetails(item.tmdbId, item.mediaType);
        if (details) { title = details.title || title; posterUrl = details.posterUrl || null; }
      } catch {}

      const seasons = item.mediaType === 'tv' ? policy.pickSeasons(listSource.seasonMode, details?.seasonDetails) : null;
      const seasonsCount = seasons ? seasons.length : (details?.numberOfSeasons || 1);
      const service = pickService(item.mediaType);
      const status = listSource.approvalMode === 'auto' ? 'approved' : 'pending';
      db.addDiscoverRequestWithStatus(SYSTEM_USER_ID, item.tmdbId, item.mediaType, title, service, seasonsCount, status, seasons, posterUrl);
      const requestId = lastInsertedRequestId(item.tmdbId, item.mediaType);

      if (status === 'approved' && service !== 'none') {
        await submitRequestToService({ tmdbId: item.tmdbId, mediaType: item.mediaType, title, service, seasons });
      }
      automation.upsertListItem({ ...base, title, status: status === 'approved' ? 'requested' : 'pending', requestId });
      requestBudget--;
      if (status === 'approved') summary.requested++; else summary.pending++;
      logger.info(`[autorequest] ${status === 'approved' ? 'requested' : 'queued pending'}: "${title}" (tmdb:${item.tmdbId} ${item.mediaType}${seasons ? ` S${seasons.join(',')}` : ''}) via ${service}`);
    } catch (e) {
      summary.failed++;
      automation.upsertListItem({ ...base, status: 'failed' });
      logger.warn(`[autorequest] failed to request tmdb:${item.tmdbId}: ${e.message}`);
    }
  }

  await mirrorCollection(listSource, items, summary);

  const statusLine = `ok: ${summary.requested} requested, ${summary.pending} pending, ${summary.inLibrary} in library` +
    (summary.failed ? `, ${summary.failed} failed` : '') +
    (summary.unresolved ? `, ${summary.unresolved} unresolved` : '') +
    (summary.excluded ? `, ${summary.excluded} excluded` : '') +
    (summary.collectionError ? `, collection error: ${summary.collectionError}` : '');
  automation.updateListSource(listSource.id, {
    lastSyncedAt: startedTs,
    lastStatus: statusLine,
    lastError: null,
  });
  logger.info(`[autorequest] "${listSource.name}" done in ${Math.round((Date.now() - started) / 1000)}s — ${statusLine}`);

  if (summary.requested > 0 || summary.pending > 0) {
    notifyAdmins(
      `Auto Request: ${listSource.name}`,
      `${summary.requested} requested, ${summary.pending} pending approval (${summary.total} on list, ${summary.inLibrary} already in library)`
    );
  }
  return summary;
}

// Called by the scheduler; each list keeps its own interval.
async function runDueLists() {
  const due = automation.getDueListSources();
  if (due.length === 0) return;
  logger.info(`[autorequest] ${due.length} list(s) due`);
  let promoted = false;
  for (const listSource of due) {
    try {
      await syncList(listSource);
      promoted = promoted || (listSource.collectionEnabled && listSource.collectionVisibility !== 'library');
    } catch (e) {
      logger.warn(`[autorequest] "${listSource.name}" failed: ${e.message}`);
      // Back-date last_synced_at so a transient failure retries in
      // min(1h, interval/2) instead of waiting out the full sync interval —
      // getDueListSources treats a list as due when last_synced_at + interval <= now.
      const intervalSecs = (listSource.syncIntervalHours || 24) * 3600;
      const retryDelay = Math.min(3600, Math.floor(intervalSecs / 2));
      automation.updateListSource(listSource.id, {
        lastSyncedAt: Math.floor(Date.now() / 1000) - intervalSecs + retryDelay,
        lastStatus: 'error',
        lastError: e.message,
      });
    }
  }
  if (promoted) {
    await plexHubs.applyAllLayouts().catch(e => logger.warn(`[autorequest] hub layout apply failed: ${e.message}`));
  }
}

// Quick sync: rebuild every collection from the items cached by its last full
// sync (no source fetches) so titles that arrived in the library since then
// join their collections. Skipped when nothing was added since the last pass.
let lastQuickSyncAt = 0;
async function runQuickSync({ force = false } = {}) {
  if (!plexCollections.plexConfigured()) return { skipped: 'plex not configured' };
  const newest = db.prepare("SELECT MAX(synced_at) AS t FROM library_items WHERE source = 'plex'").get()?.t || 0;
  if (!force && lastQuickSyncAt && newest <= lastQuickSyncAt) return { skipped: 'no new library items' };
  const lists = automation.getListSources().filter(l => l.enabled && l.collectionEnabled && l.lastSyncedAt > 0);
  let updated = 0;
  for (const list of lists) {
    const cached = automation.getListItemsInOrder(list.id, list.lastSyncedAt)
      .filter(i => i.status !== 'deleted')
      .map(i => ({ tmdbId: i.tmdbId, mediaType: i.mediaType, title: i.title }));
    if (cached.length === 0) continue;
    try {
      await plexCollections.syncListCollection(list, cached);
      updated++;
    } catch (e) {
      logger.warn(`[autorequest] quick sync failed for "${list.name}": ${e.message}`);
    }
  }
  lastQuickSyncAt = Math.floor(Date.now() / 1000);
  if (updated > 0) logger.info(`[autorequest] quick sync refreshed ${updated} collection(s)`);
  return { updated, lists: lists.length };
}

module.exports = {
  runDueLists, syncList, runQuickSync, SYSTEM_USER_ID,
  getGlobalExclusions, setGlobalExclusions, EXCLUSIONS_SETTING,
};
