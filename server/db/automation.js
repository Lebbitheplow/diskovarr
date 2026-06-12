// Automation persistence: monitored external lists (auto-request + Plex collection
// mirroring) and deletion profiles (criteria-based auto-delete). Tables are created
// by the automation_v1 migration in database.js; this module is CRUD only.
const db = require('./database');

const now = () => Math.floor(Date.now() / 1000);

// ── List sources ──────────────────────────────────────────────────────────────

function listSourceRow(r) {
  let criteria = null;
  try { criteria = r.criteria_json ? JSON.parse(r.criteria_json) : null; } catch {}
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
    lastSyncedAt: r.last_synced_at || 0,
    lastStatus: r.last_status || null,
    lastError: r.last_error || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function createListSource({ name, sourceType, url, presetKey, criteria, matchMode, enabled, mediaType, approvalMode, syncIntervalHours, maxRequestsPerRun, collectionEnabled, collectionName, collectionVisibility }) {
  // 0 is valid (collection-only list that never requests); absent/garbage → 10
  const maxPerRun = Number.isFinite(parseInt(maxRequestsPerRun)) ? Math.max(0, parseInt(maxRequestsPerRun)) : 10;
  const result = db.prepare(`
    INSERT INTO list_sources
      (name, source_type, url, preset_key, criteria_json, match_mode, enabled, media_type, approval_mode,
       sync_interval_hours, max_requests_per_run,
       collection_enabled, collection_name, collection_visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ['home', 'recommended', 'library'].includes(collectionVisibility) ? collectionVisibility : 'library'
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
  collectionRatingKey: 'collection_rating_key',
  lastStatus: 'last_status', lastError: 'last_error',
};
const LIST_SOURCE_BOOLS = { enabled: 'enabled', collectionEnabled: 'collection_enabled' };
const LIST_SOURCE_TIMES = { lastSyncedAt: 'last_synced_at' };

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

function upsertListItem({ listId, tmdbId, mediaType, title, status, requestId }) {
  db.prepare(`
    INSERT INTO list_source_items (list_id, tmdb_id, media_type, title, status, request_id, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(list_id, tmdb_id, media_type) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      request_id = COALESCE(excluded.request_id, list_source_items.request_id),
      requested_at = COALESCE(excluded.requested_at, list_source_items.requested_at),
      last_seen_at = unixepoch()
  `).run(
    Number(listId), Number(tmdbId), String(mediaType), title || null,
    status || 'seen', requestId ? Number(requestId) : null,
    status === 'requested' || status === 'pending' ? now() : null
  );
}

function getListItems(listId) {
  return db.prepare('SELECT * FROM list_source_items WHERE list_id = ? ORDER BY last_seen_at DESC').all(Number(listId)).map(r => ({
    id: r.id,
    listId: r.list_id,
    tmdbId: r.tmdb_id,
    mediaType: r.media_type,
    title: r.title,
    status: r.status,
    requestId: r.request_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    requestedAt: r.requested_at,
  }));
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

module.exports = {
  createListSource, getListSources, getListSource, updateListSource, deleteListSource, getDueListSources,
  upsertListItem, getListItems, countListItems,
  createDeletionProfile, getDeletionProfiles, getDeletionProfile, updateDeletionProfile, deleteDeletionProfile, getEnabledDeletionProfiles,
  upsertCandidate, getCandidates, getCandidateById, setCandidateStatus, pruneStaleCandidates, getDeletionHistory,
};
