// Auto Request job: fetches each enabled monitored list on its own interval,
// resolves entries to TMDB ids, auto-requests new items (per-list approval
// mode), and mirrors the list into a Plex collection when enabled.
const db = require('../db/database');
const automation = require('../db/automation');
const listSources = require('./listSources');
const plexCollections = require('./plexCollections');
const tmdbService = require('./tmdb');
const logger = require('./logger');

const SYSTEM_USER_ID = 'autorequest';
let systemUserSeeded = false;

function ensureSystemUser() {
  if (systemUserSeeded) return;
  db.seedKnownUser(SYSTEM_USER_ID, 'Auto Request', null, null);
  // Drop the identity from the brief pre-rename deploy so it doesn't linger in user lists
  try { db.prepare("DELETE FROM known_users WHERE user_id = 'list-sync'").run(); } catch {}
  systemUserSeeded = true;
}

function libraryIdSet() {
  const rows = db.prepare('SELECT tmdb_id, type FROM library_items WHERE tmdb_id IS NOT NULL').all();
  return new Set(rows.map(r => `${r.tmdb_id}:${r.type === 'show' ? 'tv' : 'movie'}`));
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

// Sync a single list source. Returns a summary object (also recorded on the row).
async function syncList(listSource) {
  ensureSystemUser();
  const started = Date.now();
  logger.info(`[autorequest] syncing "${listSource.name}" (#${listSource.id}, ${listSource.sourceType})`);

  const rawEntries = await listSources.fetchList(listSource, { limit: 500 });
  const typed = rawEntries.filter(e => {
    if (listSource.mediaType === 'movie') return e.mediaType !== 'tv';
    if (listSource.mediaType === 'tv') return e.mediaType === 'tv';
    return true;
  });
  const { items, unresolved } = await listSources.resolveEntries(typed);

  const inLibrary = libraryIdSet();
  const summary = { total: items.length, unresolved, requested: 0, pending: 0, inLibrary: 0, skipped: 0, failed: 0 };

  // Lazy requires: routes/api.js and the shim pull in heavy deps and would be a
  // require cycle at module load (they require services that require this file's
  // siblings); both are resolved by the time a sync actually runs.
  const { submitRequestToService } = require('../routes/api');
  const { pickService } = require('./overseerrShim');

  const knownItems = new Map(
    automation.getListItems(listSource.id).map(li => [`${li.tmdbId}:${li.mediaType}`, li])
  );
  let requestBudget = listSource.maxRequestsPerRun;
  for (const item of items) {
    const libKey = `${item.tmdbId}:${item.mediaType}`;
    try {
      if (inLibrary.has(libKey)) {
        automation.upsertListItem({ listId: listSource.id, tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, status: 'in_library' });
        summary.inLibrary++;
        continue;
      }
      const known = knownItems.get(libKey);
      // 'deleted' = a deletion profile removed this item from the library; never
      // re-request it just because it is still on the external list.
      if (known && known.status === 'deleted') { summary.skipped++; continue; }
      const existing = known && ['requested', 'pending'].includes(known.status) ? known : null;
      if (existing || activeRequestExists(item.tmdbId, item.mediaType)) {
        automation.upsertListItem({ listId: listSource.id, tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, status: existing ? existing.status : 'requested' });
        summary.skipped++;
        continue;
      }
      if (requestBudget <= 0) {
        automation.upsertListItem({ listId: listSource.id, tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, status: 'seen' });
        summary.skipped++;
        continue;
      }

      // Enrich (poster + canonical title) — also warms tmdb_cache for the UI
      let title = item.title || '';
      let posterUrl = null;
      try {
        const details = await tmdbService.getItemDetails(item.tmdbId, item.mediaType);
        if (details) { title = details.title || title; posterUrl = details.posterUrl || null; }
      } catch {}

      const service = pickService(item.mediaType);
      const status = listSource.approvalMode === 'auto' ? 'approved' : 'pending';
      db.addDiscoverRequestWithStatus(SYSTEM_USER_ID, item.tmdbId, item.mediaType, title, service, 1, status, null, posterUrl);
      const requestId = lastInsertedRequestId(item.tmdbId, item.mediaType);

      if (status === 'approved' && service !== 'none') {
        await submitRequestToService({ tmdbId: item.tmdbId, mediaType: item.mediaType, title, service, seasons: null });
      }
      automation.upsertListItem({
        listId: listSource.id, tmdbId: item.tmdbId, mediaType: item.mediaType, title,
        status: status === 'approved' ? 'requested' : 'pending', requestId,
      });
      requestBudget--;
      if (status === 'approved') summary.requested++; else summary.pending++;
      logger.info(`[autorequest] ${status === 'approved' ? 'requested' : 'queued pending'}: "${title}" (tmdb:${item.tmdbId} ${item.mediaType}) via ${service}`);
    } catch (e) {
      summary.failed++;
      automation.upsertListItem({ listId: listSource.id, tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, status: 'failed' });
      logger.warn(`[autorequest] failed to request tmdb:${item.tmdbId}: ${e.message}`);
    }
  }

  if (listSource.collectionEnabled) {
    try {
      await plexCollections.syncListCollection(listSource, items);
    } catch (e) {
      summary.collectionError = e.message;
      logger.warn(`[autorequest] collection sync failed for "${listSource.name}": ${e.message}`);
    }
  }

  const statusLine = `ok: ${summary.requested} requested, ${summary.pending} pending, ${summary.inLibrary} in library` +
    (summary.failed ? `, ${summary.failed} failed` : '') +
    (summary.unresolved ? `, ${summary.unresolved} unresolved` : '') +
    (summary.collectionError ? `, collection error: ${summary.collectionError}` : '');
  automation.updateListSource(listSource.id, {
    lastSyncedAt: Math.floor(Date.now() / 1000),
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
  for (const listSource of due) {
    try {
      await syncList(listSource);
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
}

module.exports = { runDueLists, syncList, SYSTEM_USER_ID };
