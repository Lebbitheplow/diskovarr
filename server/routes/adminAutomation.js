// Admin Automation API: monitored list sources (auto-request + collection
// mirroring) and deletion profiles. Mounted at /admin/automation (server.js).
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const automation = require('../db/automation');
const listSources = require('../services/listSources');
const autoRequest = require('../services/autoRequest');
const plexCollections = require('../services/plexCollections');
const plexHubs = require('../services/plexHubs');
const deletionService = require('../services/deletion');
const tmdbService = require('../services/tmdb');
const logger = require('../services/logger');

// JSON 401 (not the redirect admin.js uses) — these endpoints are only called
// by the admin SPA via axios, which handles the status code.
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Admin session required' });
}
router.use(requireAdmin);

const VALID_MEDIA_TYPES = ['all', 'movie', 'tv'];
const VALID_CRITERIA_FIELDS = [
  'audience_rating', 'critic_rating', 'content_rating', 'genre', 'actor', 'director',
  'writer', 'producer', 'country', 'collection', 'label', 'studio', 'edition',
  'runtime_minutes', 'year', 'video_resolution', 'file_size_gb', 'added_days_ago',
  'last_played_days_ago', 'never_played', 'plays',
];
const VALID_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'in', 'not_in'];

// ── List sources ──────────────────────────────────────────────────────────────

router.get('/lists', (req, res) => {
  const lists = automation.getListSources().map(l => ({
    ...l,
    itemCount: automation.countListItems(l.id),
    requestedCount: automation.countListItems(l.id, 'requested'),
    inLibraryCount: automation.countListItems(l.id, 'in_library'),
    syncing: syncing.has(l.id),
  }));
  res.json({ lists });
});

router.get('/presets', (req, res) => {
  res.json({
    presets: listSources.getPresets(),
    hasTraktCredential: !!(db.getSetting('trakt_client_id', null) || process.env.TRAKT_CLIENT_ID),
    hasMdblistCredential: !!(db.getSetting('mdblist_api_key', null) || process.env.MDBLIST_API_KEY),
    hasFlareSolverr: !!(db.getSetting('flaresolverr_url', null) ?? (process.env.FLARESOLVERR_URL || 'http://localhost:8191')),
    collectionSorts: automation.VALID_COLLECTION_SORTS,
    seasonModes: automation.VALID_SEASON_MODES,
    visibilities: automation.VALID_VISIBILITIES,
  });
});

// Title lookup for exclusion editors (tmdb cache first, then TMDB).
router.get('/lookup', async (req, res) => {
  const tmdbId = Number(req.query.tmdbId);
  const mediaType = req.query.mediaType === 'tv' ? 'tv' : 'movie';
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' });
  try {
    const d = await tmdbService.getItemDetails(tmdbId, mediaType);
    if (!d) return res.status(404).json({ error: 'Not found on TMDB' });
    res.json({ tmdbId, mediaType, title: d.title, year: d.year || null, posterUrl: d.posterUrl || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Validate a pasted URL, preset, or criteria set and return a resolved preview
// before saving.
router.post('/lists/validate', async (req, res) => {
  const { url, presetKey, criteria, matchMode, mediaType } = req.body || {};
  try {
    let sourceType = 'preset';
    if (Array.isArray(criteria) && criteria.length > 0) {
      const invalid = validateCriteria(criteria);
      if (invalid) return res.status(400).json({ ok: false, error: invalid });
      sourceType = 'criteria';
    } else if (!presetKey) {
      if (!url) return res.status(400).json({ error: 'url, presetKey, or criteria required' });
      const parsed = listSources.parseListUrls(url);
      sourceType = parsed.length > 1 ? 'multi' : parsed[0].sourceType;
    }
    const entries = await listSources.fetchList(
      { url, presetKey, sourceType, criteria, matchMode, mediaType: mediaType || 'all' },
      { limit: 20 }
    );
    const { items, unresolved } = await listSources.resolveEntries(entries);
    res.json({ ok: true, sourceType, preview: items.slice(0, 20), unresolved });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return 'criteria must be a non-empty array';
  for (const c of criteria) {
    if (!listSources.CRITERIA_TYPES.includes(c.type)) return `unknown criterion type: ${c.type}`;
    if (!c.entityName || !String(c.entityName).trim()) return `criterion "${c.type}" needs a value`;
  }
  return null;
}

function validateListBody(body) {
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  const hasCriteria = Array.isArray(body.criteria) && body.criteria.length > 0;
  if (!body.presetKey && !body.url && !hasCriteria) return 'url, presetKey, or criteria is required';
  if (hasCriteria) {
    const invalid = validateCriteria(body.criteria);
    if (invalid) return invalid;
  } else if (body.url && !body.presetKey) {
    try { listSources.parseListUrls(body.url); } catch (e) { return e.message; }
  }
  if (body.mediaType && !VALID_MEDIA_TYPES.includes(body.mediaType)) return 'invalid mediaType';
  if (body.collectionVisibility !== undefined && !automation.VALID_VISIBILITIES.includes(body.collectionVisibility)) return 'invalid collectionVisibility';
  if (body.collectionSort !== undefined && !automation.VALID_COLLECTION_SORTS.includes(body.collectionSort)) return 'invalid collectionSort';
  if (body.seasonMode !== undefined && !automation.VALID_SEASON_MODES.includes(body.seasonMode)) return 'invalid seasonMode';
  if (body.exclusions !== undefined && body.exclusions !== null && !Array.isArray(body.exclusions)) return 'exclusions must be an array';
  return null;
}

function sourceTypeOf(body) {
  if (Array.isArray(body.criteria) && body.criteria.length > 0) return 'criteria';
  if (body.presetKey) return 'preset';
  const parsed = listSources.parseListUrls(body.url);
  return parsed.length > 1 ? 'multi' : parsed[0].sourceType;
}

// Presentation fields that change how/where the collection shows in Plex.
const PRESENTATION_FIELDS = ['collectionVisibility', 'collectionEnabled', 'homeOrder', 'libraryOrder', 'collectionUnwatchedOnly', 'collectionSort', 'collectionSummary'];

router.post('/lists', (req, res) => {
  const body = req.body || {};
  const invalid = validateListBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  const sourceType = sourceTypeOf(body);
  const id = automation.createListSource({ ...body, sourceType });
  logger.info(`[automation] list source created: "${body.name}" (#${id})`);
  res.json({ ok: true, id, list: automation.getListSource(id) });
});

router.put('/lists/:id', async (req, res) => {
  const existing = automation.getListSource(req.params.id);
  if (!existing) return res.status(404).json({ error: 'List not found' });
  const body = req.body || {};
  if (Array.isArray(body.criteria) && body.criteria.length > 0) {
    const invalid = validateCriteria(body.criteria);
    if (invalid) return res.status(400).json({ error: invalid });
  } else if (body.url && !body.presetKey && !existing.presetKey && existing.sourceType !== 'criteria') {
    try { listSources.parseListUrls(body.url); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const invalid = validateListBody({ ...existing, ...body, name: body.name ?? existing.name });
  if (invalid) return res.status(400).json({ error: invalid });
  if (body.url && !body.presetKey && !existing.presetKey && existing.sourceType !== 'criteria') {
    body.sourceType = sourceTypeOf({ url: body.url });
    automation.updateListSource(existing.id, { ...body });
    db.prepare('UPDATE list_sources SET source_type = ? WHERE id = ?').run(body.sourceType, existing.id);
  } else {
    automation.updateListSource(existing.id, body);
  }
  const updated = automation.getListSource(existing.id);
  // Re-apply presentation when it changed and collections exist: visibility
  // straight away, ordering through the section layout.
  const presentationChanged = PRESENTATION_FIELDS.some(f => body[f] !== undefined);
  if (updated.collectionRatingKey && presentationChanged) {
    await plexCollections.applyVisibility(updated).catch(e =>
      logger.warn(`[automation] visibility update failed: ${e.message}`));
    plexHubs.applyAllLayouts().catch(e => logger.warn(`[automation] layout apply failed: ${e.message}`));
  }
  res.json({ ok: true, list: updated });
});

router.delete('/lists/:id', async (req, res) => {
  const existing = automation.getListSource(req.params.id);
  if (!existing) return res.status(404).json({ error: 'List not found' });
  if (String(req.query.deleteCollection) === '1' && existing.collectionRatingKey) {
    await plexCollections.deleteListCollections(existing).catch(e =>
      logger.warn(`[automation] collection delete failed: ${e.message}`));
  }
  automation.deleteListSource(existing.id);
  logger.info(`[automation] list source deleted: "${existing.name}" (#${existing.id})`);
  res.json({ ok: true });
});

// Sync runs in the background (big lists can take minutes); the UI polls /lists.
const syncing = new Set();
router.post('/lists/:id/sync-now', (req, res) => {
  const existing = automation.getListSource(req.params.id);
  if (!existing) return res.status(404).json({ error: 'List not found' });
  if (syncing.has(existing.id)) return res.status(409).json({ error: 'Sync already running' });
  syncing.add(existing.id);
  autoRequest.syncList(existing)
    .catch(e => {
      automation.updateListSource(existing.id, {
        lastSyncedAt: Math.floor(Date.now() / 1000), lastStatus: 'error', lastError: e.message,
      });
    })
    .finally(() => syncing.delete(existing.id));
  res.status(202).json({ ok: true, started: true });
});

router.get('/lists/:id/items', (req, res) => {
  const existing = automation.getListSource(req.params.id);
  if (!existing) return res.status(404).json({ error: 'List not found' });
  res.json({ items: automation.getListItems(existing.id) });
});

// Quick sync: rebuild collections from cached list items (no source fetches).
router.post('/quick-sync', async (req, res) => {
  try {
    res.json({ ok: true, ...(await autoRequest.runQuickSync({ force: true })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Source credentials ────────────────────────────────────────────────────────

router.get('/credentials', (req, res) => {
  res.json({
    traktClientId: db.getSetting('trakt_client_id', '') ? '••••••••' : '',
    mdblistApiKey: db.getSetting('mdblist_api_key', '') ? '••••••••' : '',
    flaresolverrUrl: db.getSetting('flaresolverr_url', null) ?? (process.env.FLARESOLVERR_URL || 'http://localhost:8191'),
  });
});

router.post('/credentials', (req, res) => {
  const { traktClientId, mdblistApiKey, flaresolverrUrl } = req.body || {};
  if (traktClientId !== undefined && traktClientId !== '••••••••') {
    db.setSetting('trakt_client_id', String(traktClientId).trim());
  }
  if (mdblistApiKey !== undefined && mdblistApiKey !== '••••••••') {
    db.setSetting('mdblist_api_key', String(mdblistApiKey).trim());
  }
  if (flaresolverrUrl !== undefined) {
    const v = String(flaresolverrUrl).trim();
    if (v && !/^https?:\/\//i.test(v)) return res.status(400).json({ error: 'FlareSolverr URL must start with http:// or https://' });
    db.setSetting('flaresolverr_url', v);
  }
  res.json({ ok: true });
});

// ── Global exclusions (never requested / mirrored by any list) ────────────────

router.get('/exclusions', (req, res) => {
  res.json({ exclusions: autoRequest.getGlobalExclusions() });
});

router.post('/exclusions', async (req, res) => {
  const list = req.body?.exclusions;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'exclusions must be an array' });
  // Fill in titles for entries that arrive as bare ids (bounded: the editor
  // adds a few at a time; bulk imports carry titles already).
  const withTitles = [];
  let lookups = 0;
  for (const e of list) {
    if (!e || !Number(e.tmdbId)) continue;
    const mediaType = e.mediaType === 'tv' ? 'tv' : 'movie';
    let title = e.title ? String(e.title) : null;
    if (!title && lookups < 25) {
      lookups++;
      try { title = (await tmdbService.getItemDetails(Number(e.tmdbId), mediaType))?.title || null; } catch {}
    }
    withTitles.push({ tmdbId: Number(e.tmdbId), mediaType, ...(title ? { title } : {}) });
  }
  res.json({ ok: true, exclusions: autoRequest.setGlobalExclusions(withTitles) });
});

// ── Plex home / Recommended hub layout ────────────────────────────────────────

router.get('/hubs', async (req, res) => {
  if (!plexCollections.plexConfigured()) return res.json({ sections: [] });
  try {
    res.json({ sections: await plexHubs.describeAllSections() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Body: { items: [{ identifier, listId?, own, shared, rec }] } in the wanted
// order. Built-in hubs are stored in the layout setting; collections write
// their order/visibility back to the owning list. Then the section is applied.
router.put('/hubs/:sectionId', async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  const sectionId = String(req.params.sectionId);
  const hubRows = [];
  let order = 0;
  for (const item of items) {
    if (!item || !item.identifier) continue;
    order++;
    const flags = { rec: !!item.rec, own: !!item.own, shared: !!item.shared };
    if (item.listId) {
      const list = automation.getListSource(item.listId);
      if (!list) continue;
      automation.updateListSource(list.id, {
        homeOrder: order,
        collectionVisibility: require('../services/collectionPolicy').visibilityFromFlags(flags),
      });
      continue;
    }
    if (/^custom\.collection\./.test(item.identifier)) continue; // unmanaged collection (e.g. Kometa's)
    hubRows.push({ identifier: item.identifier, ...flags, order });
  }
  plexHubs.setSectionLayout(sectionId, hubRows);
  try {
    const result = await plexHubs.applySectionLayout(sectionId);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.post('/hubs/apply', async (req, res) => {
  try {
    res.json({ ok: true, results: await plexHubs.applyAllLayouts() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Deletion profiles ─────────────────────────────────────────────────────────

function validateProfileBody(body) {
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  if (body.mode && !['dry_run', 'review', 'auto'].includes(body.mode)) return 'invalid mode';
  if (body.mediaType && !['movie', 'show'].includes(body.mediaType)) return 'mediaType must be movie or show';
  if (body.criteria !== undefined) {
    if (!Array.isArray(body.criteria)) return 'criteria must be an array';
    for (const c of body.criteria) {
      if (!VALID_CRITERIA_FIELDS.includes(c.field)) return `unknown criteria field: ${c.field}`;
      if (c.field !== 'never_played' && !VALID_OPS.includes(c.op)) return `unknown op: ${c.op}`;
      if (c.value === undefined || c.value === null || c.value === '') return `criteria "${c.field}" needs a value`;
    }
  }
  return null;
}

router.get('/profiles', (req, res) => {
  let lastRun = null;
  try { lastRun = JSON.parse(db.getSetting('deletion_last_run', 'null')); } catch {}
  const profiles = automation.getDeletionProfiles().map(p => ({
    ...p,
    matchedCount: automation.getCandidates({ profileId: p.id, status: 'matched' }).length,
    pendingReviewCount: automation.getCandidates({ profileId: p.id, status: 'pending_review' }).length,
    lastRun: lastRun?.profiles?.[p.id] || null,
    lastRunAt: lastRun?.at || null,
  }));
  res.json({ profiles });
});

router.post('/profiles', (req, res) => {
  const invalid = validateProfileBody(req.body || {});
  if (invalid) return res.status(400).json({ error: invalid });
  const id = automation.createDeletionProfile(req.body);
  logger.info(`[automation] deletion profile created: "${req.body.name}" (#${id}, mode=${req.body.mode || 'dry_run'})`);
  res.json({ ok: true, id, profile: automation.getDeletionProfile(id) });
});

router.put('/profiles/:id', (req, res) => {
  const existing = automation.getDeletionProfile(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Profile not found' });
  const body = { ...req.body, name: req.body?.name ?? existing.name };
  const invalid = validateProfileBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  automation.updateDeletionProfile(existing.id, req.body || {});
  res.json({ ok: true, profile: automation.getDeletionProfile(existing.id) });
});

router.delete('/profiles/:id', (req, res) => {
  const existing = automation.getDeletionProfile(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Profile not found' });
  automation.deleteDeletionProfile(existing.id);
  logger.info(`[automation] deletion profile deleted: "${existing.name}" (#${existing.id})`);
  res.json({ ok: true });
});

// Evaluate now, return matches — never deletes, regardless of mode.
router.post('/profiles/:id/preview', (req, res) => {
  const existing = automation.getDeletionProfile(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Profile not found' });
  const result = deletionService.previewProfile(existing);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Preview an unsaved profile straight from the editor form.
router.post('/profiles/preview', (req, res) => {
  const body = { name: 'preview', ...(req.body || {}) };
  const invalid = validateProfileBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  const result = deletionService.previewProfile({
    mediaType: body.mediaType || 'movie',
    criteria: body.criteria || [],
    exclusions: body.exclusions || {},
  });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

let deletionRunInFlight = false;
router.post('/run-now', (req, res) => {
  if (deletionRunInFlight) return res.status(409).json({ error: 'Deletion run already in progress' });
  deletionRunInFlight = true;
  deletionService.runProfiles()
    .catch(e => logger.warn(`[deletion] manual run failed: ${e.message}`))
    .finally(() => { deletionRunInFlight = false; });
  res.status(202).json({ ok: true, started: true });
});

// ── Candidates (review queue + history) ───────────────────────────────────────

router.get('/candidates', (req, res) => {
  const { profileId, status } = req.query;
  res.json({ candidates: automation.getCandidates({ profileId, status }) });
});

router.post('/candidates/approve', async (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
  try {
    const result = await deletionService.executeCandidates(ids);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/candidates/dismiss', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
  for (const id of ids) automation.setCandidateStatus(id, 'dismissed');
  res.json({ ok: true, dismissed: ids.length });
});

router.get('/history', (req, res) => {
  let lastRun = null;
  try { lastRun = JSON.parse(db.getSetting('deletion_last_run', 'null')); } catch {}
  res.json({ history: automation.getDeletionHistory(Number(req.query.limit) || 200), lastRun });
});

module.exports = router;
