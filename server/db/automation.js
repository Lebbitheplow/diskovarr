// Automation persistence: monitored external lists (auto-request + Plex collection
// mirroring) and deletion profiles (criteria-based auto-delete). Tables are created
// by the automation_v1 migration in database.js; this module is CRUD only.
const db = require('./database');

const now = () => Math.floor(Date.now() / 1000);

// ── List sources ──────────────────────────────────────────────────────────────

// Plex collection item order. 'list' keeps the source list's order; the rest
// re-sort the mirrored items (smart collections map these to a Plex sort).
const VALID_COLLECTION_SORTS = ['list', 'release_desc', 'release_asc', 'title', 'added_desc', 'rating_desc'];
// Which seasons an auto-request asks for on a TV show.
const VALID_SEASON_MODES = ['all', 'first', 'latest'];
const VALID_VISIBILITIES = ['home', 'owner_home', 'recommended', 'library'];

// Per-list exclusions: [{ tmdbId, mediaType, title? }] — never requested and
// never mirrored into the collection, on top of the global exclusion list.
function parseExclusions(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(e => e && Number(e.tmdbId)).map(normalizeExclusion) : [];
  } catch { return []; }
}

function normalizeExclusion(e) {
  return {
    tmdbId: Number(e.tmdbId),
    mediaType: e.mediaType === 'tv' ? 'tv' : 'movie',
    ...(e.title ? { title: String(e.title) } : {}),
  };
}

function serializeExclusions(list) {
  if (!Array.isArray(list)) return null;
  const clean = list.filter(e => e && Number(e.tmdbId)).map(normalizeExclusion);
  return clean.length ? JSON.stringify(clean) : null;
}

function listSourceRow(r) {
  let criteria = null;
  try { criteria = r.criteria_json ? JSON.parse(r.criteria_json) : null; } catch {}
  const exclusions = parseExclusions(r.exclusions_json);
  return {
    id: r.id,
    name: r.name,
    sourceType: r.source_type,
    url: r.url || null,
    presetKey: r.preset_key || null,
    criteria,
    matchMode: r.match_mode === 'ANY' ? 'ANY' : 'ALL',
    enabled: !!r.enabled,
    mediaType: r.media_type,
    approvalMode: r.approval_mode,
    syncIntervalHours: r.sync_interval_hours,
    maxRequestsPerRun: r.max_requests_per_run,
    collectionEnabled: !!r.collection_enabled,
    collectionName: r.collection_name || null,
    collectionVisibility: r.collection_visibility,
    collectionRatingKey: r.collection_rating_key || null,
    collectionUnwatchedOnly: !!r.collection_unwatched_only,
    collectionSort: VALID_COLLECTION_SORTS.includes(r.collection_sort) ? r.collection_sort : 'list',
    collectionSummary: r.collection_summary || null,
    homeOrder: r.home_order || 0,
    libraryOrder: r.library_order || 0,
    maxItems: r.max_items || 0,
    seasonMode: VALID_SEASON_MODES.includes(r.season_mode) ? r.season_mode : 'all',
    exclusions,
    lastSyncedAt: r.last_synced_at || 0,
    lastStatus: r.last_status || null,
    lastError: r.last_error || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function createListSource({
  name, sourceType, url, presetKey, criteria, matchMode, enabled, mediaType, approvalMode,
  syncIntervalHours, maxRequestsPerRun, collectionEnabled, collectionName, collectionVisibility,
  collectionUnwatchedOnly, collectionSort, collectionSummary, homeOrder, libraryOrder,
  maxItems, seasonMode, exclusions, collectionRatingKey,
}) {
  // 0 is valid (collection-only list that never requests); absent/garbage → 10
  const maxPerRun = Number.isFinite(parseInt(maxRequestsPerRun)) ? Math.max(0, parseInt(maxRequestsPerRun)) : 10;
  const result = db.prepare(`
    INSERT INTO list_sources
      (name, source_type, url, preset_key, criteria_json, match_mode, enabled, media_type, approval_mode,
       sync_interval_hours, max_requests_per_run,
       collection_enabled, collection_name, collection_visibility,
       collection_unwatched_only, collection_sort, collection_summary, home_order, library_order,
       max_items, season_mode, exclusions_json, collection_rating_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(name), String(sourceType), url || null, presetKey || null,
    Array.isArray(criteria) && criteria.length ? JSON.stringify(criteria) : null,
    matchMode === 'ANY' ? 'ANY' : 'ALL',
    enabled === false ? 0 : 1,
    mediaType === 'movie' || mediaType === 'tv' ? mediaType : 'all',
    approvalMode === 'pending' ? 'pending' : 'auto',
    Math.max(1, parseInt(syncIntervalHours) || 24),
    maxPerRun,
    collectionEnabled ? 1 : 0, collectionName || null,
    VALID_VISIBILITIES.includes(collectionVisibility) ? collectionVisibility : 'library',
    collectionUnwatchedOnly ? 1 : 0,
    VALID_COLLECTION_SORTS.includes(collectionSort) ? collectionSort : 'list',
    collectionSummary || null,
    Math.max(0, parseInt(homeOrder) || 0),
    Math.max(0, parseInt(libraryOrder) || 0),
    Math.max(0, parseInt(maxItems) || 0),
    VALID_SEASON_MODES.includes(seasonMode) ? seasonMode : 'all',
    serializeExclusions(exclusions),
    collectionRatingKey || null
  );
  return Number(result.lastInsertRowid);
}

function getListSources() {
  return db.prepare('SELECT * FROM list_sources ORDER BY created_at DESC').all().map(listSourceRow);
}

function getListSource(id) {
  const r = db.prepare('SELECT * FROM list_sources WHERE id = ?').get(Number(id));
  return r ? listSourceRow(r) : null;
}

const LIST_SOURCE_COLUMNS = {
  name: 'name', url: 'url', presetKey: 'preset_key',
  mediaType: 'media_type', approvalMode: 'approval_mode',
  syncIntervalHours: 'sync_interval_hours', maxRequestsPerRun: 'max_requests_per_run',
  collectionName: 'collection_name', collectionVisibility: 'collection_visibility',
  collectionRatingKey: 'collection_rating_key', collectionSummary: 'collection_summary',
  lastStatus: 'last_status', lastError: 'last_error',
};
const LIST_SOURCE_BOOLS = {
  enabled: 'enabled', collectionEnabled: 'collection_enabled',
  collectionUnwatchedOnly: 'collection_unwatched_only',
};
const LIST_SOURCE_TIMES = { lastSyncedAt: 'last_synced_at' };
const LIST_SOURCE_INTS = { homeOrder: 'home_order', libraryOrder: 'library_order', maxItems: 'max_items' };
const LIST_SOURCE_ENUMS = {
  collectionSort: ['collection_sort', VALID_COLLECTION_SORTS, 'list'],
  seasonMode: ['season_mode', VALID_SEASON_MODES, 'all'],
};

function updateListSource(id, fields) {
  const updates = [];
  const params = [];
  if (fields.criteria !== undefined) {
    updates.push('criteria_json = ?');
    params.push(Array.isArray(fields.criteria) && fields.criteria.length ? JSON.stringify(fields.criteria) : null);
  }
  if (fields.matchMode !== undefined) {
    updates.push('match_mode = ?');
    params.push(fields.matchMode === 'ANY' ? 'ANY' : 'ALL');
  }
  if (fields.exclusions !== undefined) {
    updates.push('exclusions_json = ?');
    params.push(serializeExclusions(fields.exclusions));
  }
  if (fields.collectionVisibility !== undefined && !VALID_VISIBILITIES.includes(fields.collectionVisibility)) {
    fields = { ...fields, collectionVisibility: 'library' };
  }
  for (const [key, col] of Object.entries(LIST_SOURCE_INTS)) {
    if (fields[key] !== undefined) { updates.push(`${col} = ?`); params.push(Math.max(0, parseInt(fields[key]) || 0)); }
  }
  for (const [key, [col, valid, dflt]] of Object.entries(LIST_SOURCE_ENUMS)) {
    if (fields[key] !== undefined) { updates.push(`${col} = ?`); params.push(valid.includes(fields[key]) ? fields[key] : dflt); }
  }
  for (const [key, col] of Object.entries(LIST_SOURCE_COLUMNS)) {
    if (fields[key] !== undefined) { updates.push(`${col} = ?`); params.push(fields[key] ?? null); }
  }
  for (const [key, col] of Object.entries(LIST_SOURCE_BOOLS)) {
    if (fields[key] !== undefined) { updates.push(`${col} = ?`); params.push(fields[key] ? 1 : 0); }
  }
  for (const [key, col] of Object.entries(LIST_SOURCE_TIMES)) {
    if (fields[key] !== undefined) { updates.push(`${col} = ?`); params.push(Number(fields[key]) || 0); }
  }
  if (updates.length === 0) return;
  updates.push('updated_at = ?');
  params.push(now(), Number(id));
  db.prepare(`UPDATE list_sources SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

function deleteListSource(id) {
  db.prepare('DELETE FROM list_sources WHERE id = ?').run(Number(id));
}

function getDueListSources() {
  return db.prepare('SELECT * FROM list_sources WHERE enabled = 1').all()
    .map(listSourceRow)
    .filter(l => now() - (l.lastSyncedAt || 0) >= l.syncIntervalHours * 3600);
}

// ── List source items (per-list seen/requested tracking) ─────────────────────

function upsertListItem({ listId, tmdbId, mediaType, title, status, requestId, position }) {
  db.prepare(`
    INSERT INTO list_source_items (list_id, tmdb_id, media_type, title, status, request_id, requested_at, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(list_id, tmdb_id, media_type) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      request_id = COALESCE(excluded.request_id, list_source_items.request_id),
      requested_at = COALESCE(excluded.requested_at, list_source_items.requested_at),
      position = COALESCE(excluded.position, list_source_items.position),
      last_seen_at = unixepoch()
  `).run(
    Number(listId), Number(tmdbId), String(mediaType), title || null,
    status || 'seen', requestId ? Number(requestId) : null,
    status === 'requested' || status === 'pending' ? now() : null,
    Number.isFinite(Number(position)) ? Number(position) : null
  );
}

function listItemRow(r) {
  return {
    id: r.id,
    listId: r.list_id,
    tmdbId: r.tmdb_id,
    mediaType: r.media_type,
    title: r.title,
    status: r.status,
    requestId: r.request_id,
    position: r.position,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    requestedAt: r.requested_at,
  };
}

function getListItems(listId) {
  return db.prepare('SELECT * FROM list_source_items WHERE list_id = ? ORDER BY last_seen_at DESC').all(Number(listId)).map(listItemRow);
}

// Items seen on the most recent sync, in source order — the cached list used
// to rebuild collections between full syncs. `sinceTs` is that sync's start.
function getListItemsInOrder(listId, sinceTs = 0) {
  return db.prepare(
    'SELECT * FROM list_source_items WHERE list_id = ? AND last_seen_at >= ? AND position IS NOT NULL ORDER BY position ASC'
  ).all(Number(listId), Number(sinceTs) || 0).map(listItemRow);
}

function countListItems(listId, status) {
  if (status) {
    return db.prepare('SELECT COUNT(*) AS c FROM list_source_items WHERE list_id = ? AND status = ?')
      .get(Number(listId), String(status)).c;
  }
  return db.prepare('SELECT COUNT(*) AS c FROM list_source_items WHERE list_id = ?').get(Number(listId)).c;
}

// ── Deletion profiles ─────────────────────────────────────────────────────────

function profileRow(r) {
  let criteria = [];
  let exclusions = {};
  try { criteria = JSON.parse(r.criteria_json || '[]'); } catch {}
  try { exclusions = JSON.parse(r.exclusions_json || '{}'); } catch {}
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    mode: r.mode,
    mediaType: r.media_type,
    criteria,
    exclusions,
    gracePeriodDays: r.grace_period_days,
    maxDeletionsPerRun: r.max_deletions_per_run,
    arrImportExclusion: !!r.arr_import_exclusion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function createDeletionProfile({ name, enabled, mode, mediaType, criteria, exclusions, gracePeriodDays, maxDeletionsPerRun, arrImportExclusion }) {
  const result = db.prepare(`
    INSERT INTO deletion_profiles
      (name, enabled, mode, media_type, criteria_json, exclusions_json,
       grace_period_days, max_deletions_per_run, arr_import_exclusion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(name), enabled === false ? 0 : 1,
    ['dry_run', 'review', 'auto'].includes(mode) ? mode : 'dry_run',
    mediaType === 'show' ? 'show' : 'movie',
    JSON.stringify(criteria || []), JSON.stringify(exclusions || {}),
    Math.max(0, parseInt(gracePeriodDays) || 0),
    Math.max(1, parseInt(maxDeletionsPerRun) || 10),
    arrImportExclusion === false ? 0 : 1
  );
  return Number(result.lastInsertRowid);
}

function getDeletionProfiles() {
  return db.prepare('SELECT * FROM deletion_profiles ORDER BY created_at DESC').all().map(profileRow);
}

function getDeletionProfile(id) {
  const r = db.prepare('SELECT * FROM deletion_profiles WHERE id = ?').get(Number(id));
  return r ? profileRow(r) : null;
}

function updateDeletionProfile(id, fields) {
  const updates = [];
  const params = [];
  if (fields.name !== undefined) { updates.push('name = ?'); params.push(String(fields.name)); }
  if (fields.enabled !== undefined) { updates.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
  if (fields.mode !== undefined) {
    updates.push('mode = ?');
    params.push(['dry_run', 'review', 'auto'].includes(fields.mode) ? fields.mode : 'dry_run');
  }
  if (fields.mediaType !== undefined) { updates.push('media_type = ?'); params.push(fields.mediaType === 'show' ? 'show' : 'movie'); }
  if (fields.criteria !== undefined) { updates.push('criteria_json = ?'); params.push(JSON.stringify(fields.criteria || [])); }
  if (fields.exclusions !== undefined) { updates.push('exclusions_json = ?'); params.push(JSON.stringify(fields.exclusions || {})); }
  if (fields.gracePeriodDays !== undefined) { updates.push('grace_period_days = ?'); params.push(Math.max(0, parseInt(fields.gracePeriodDays) || 0)); }
  if (fields.maxDeletionsPerRun !== undefined) { updates.push('max_deletions_per_run = ?'); params.push(Math.max(1, parseInt(fields.maxDeletionsPerRun) || 10)); }
  if (fields.arrImportExclusion !== undefined) { updates.push('arr_import_exclusion = ?'); params.push(fields.arrImportExclusion ? 1 : 0); }
  if (updates.length === 0) return;
  updates.push('updated_at = ?');
  params.push(now(), Number(id));
  db.prepare(`UPDATE deletion_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

function deleteDeletionProfile(id) {
  db.prepare('DELETE FROM deletion_profiles WHERE id = ?').run(Number(id));
}

function getEnabledDeletionProfiles() {
  return db.prepare('SELECT * FROM deletion_profiles WHERE enabled = 1').all().map(profileRow);
}

// ── Deletion candidates (review queue + grace tracking + history) ─────────────

function candidateRow(r) {
  let details = null;
  try { details = r.details_json ? JSON.parse(r.details_json) : null; } catch {}
  return {
    id: r.id,
    profileId: r.profile_id,
    ratingKey: r.rating_key,
    tmdbId: r.tmdb_id,
    title: r.title,
    mediaType: r.media_type,
    status: r.status,
    firstMatchedAt: r.first_matched_at,
    deletedAt: r.deleted_at,
    deleteMethod: r.delete_method,
    details,
  };
}

// Upsert a current match. Preserves first_matched_at (grace-period anchor) and never
// downgrades terminal states — deleted/dismissed/failed rows are history, not matches.
function upsertCandidate({ profileId, ratingKey, tmdbId, title, mediaType, status, details }) {
  db.prepare(`
    INSERT INTO deletion_candidates (profile_id, rating_key, tmdb_id, title, media_type, status, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, rating_key) DO UPDATE SET
      title = excluded.title,
      details_json = excluded.details_json,
      status = CASE WHEN deletion_candidates.status IN ('matched', 'pending_review')
                    THEN excluded.status ELSE deletion_candidates.status END
  `).run(
    Number(profileId), String(ratingKey), tmdbId ? String(tmdbId) : null,
    title || null, mediaType || null,
    status === 'pending_review' ? 'pending_review' : 'matched',
    details ? JSON.stringify(details) : null
  );
}

function getCandidates({ profileId, status, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (profileId) { where.push('profile_id = ?'); params.push(Number(profileId)); }
  if (status) { where.push('status = ?'); params.push(String(status)); }
  const sql = `SELECT * FROM deletion_candidates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY first_matched_at DESC LIMIT ?`;
  params.push(Math.min(2000, Number(limit) || 500));
  return db.prepare(sql).all(...params).map(candidateRow);
}

function getCandidateById(id) {
  const r = db.prepare('SELECT * FROM deletion_candidates WHERE id = ?').get(Number(id));
  return r ? candidateRow(r) : null;
}

function setCandidateStatus(id, status, { deleteMethod, error } = {}) {
  const deletedAt = status === 'deleted' ? now() : null;
  let detailsUpdate = '';
  const params = [String(status), deletedAt, deleteMethod || null];
  if (error) {
    detailsUpdate = ", details_json = json_set(COALESCE(details_json, '{}'), '$.error', ?)";
    params.push(String(error));
  }
  params.push(Number(id));
  db.prepare(`
    UPDATE deletion_candidates
    SET status = ?, deleted_at = COALESCE(?, deleted_at), delete_method = COALESCE(?, delete_method)${detailsUpdate}
    WHERE id = ?
  `).run(...params);
}

// Drop open candidates (matched / pending_review) that no longer match the profile.
// Terminal rows (deleted/dismissed/failed) are kept as history.
function pruneStaleCandidates(profileId, currentRatingKeys) {
  const open = db.prepare(
    "SELECT id, rating_key FROM deletion_candidates WHERE profile_id = ? AND status IN ('matched', 'pending_review')"
  ).all(Number(profileId));
  const keep = new Set((currentRatingKeys || []).map(String));
  const del = db.prepare('DELETE FROM deletion_candidates WHERE id = ?');
  let pruned = 0;
  for (const row of open) {
    if (!keep.has(String(row.rating_key))) { del.run(row.id); pruned++; }
  }
  return pruned;
}

function getDeletionHistory(limit = 200) {
  return db.prepare(`
    SELECT dc.*, dp.name AS profile_name FROM deletion_candidates dc
    LEFT JOIN deletion_profiles dp ON dp.id = dc.profile_id
    WHERE dc.status IN ('deleted', 'failed', 'dismissed')
    ORDER BY COALESCE(dc.deleted_at, dc.first_matched_at) DESC LIMIT ?
  `).all(Math.min(1000, Number(limit) || 200)).map(r => ({ ...candidateRow(r), profileName: r.profile_name }));
}

// Lists that mirror a collection in a given media type, for home/library
// ordering passes (a mixed list contributes to both sections).
function getCollectionListsForMedia(media) {
  return getListSources().filter(l =>
    l.collectionEnabled && (l.mediaType === 'all' || l.mediaType === media));
}

module.exports = {
  VALID_COLLECTION_SORTS, VALID_SEASON_MODES, VALID_VISIBILITIES,
  createListSource, getListSources, getListSource, updateListSource, deleteListSource, getDueListSources,
  getCollectionListsForMedia,
  upsertListItem, getListItems, getListItemsInOrder, countListItems,
  createDeletionProfile, getDeletionProfiles, getDeletionProfile, updateDeletionProfile, deleteDeletionProfile, getEnabledDeletionProfiles,
  upsertCandidate, getCandidates, getCandidateById, setCandidateStatus, pruneStaleCandidates, getDeletionHistory,
};
