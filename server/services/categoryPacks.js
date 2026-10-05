// Category packs: Kometa-style automatic collections. Library packs (basic,
// decade, studio, network) become Plex smart collections — Plex evaluates the
// filter, so membership never needs syncing — and static Jellyfin BoxSets
// rebuilt from the library table. The seasonal pack is a set of scheduled
// monitored lists (list_sources rows with pack='seasonal') that the auto
// request job mirrors into a collection only while the holiday is in season.
//
// A collection that already exists under the same title (Kometa's) is adopted:
// its filter is repointed and its artwork kept, so switching over is seamless
// once Kometa stops managing that pack.
const db = require('../db/database');
const automation = require('../db/automation');
const plexService = require('./plex');
const plexCollections = require('./plexCollections');
const policy = require('./categoryPolicy');
const listPolicy = require('./collectionPolicy');
const seasonal = require('./listSources/seasonal');
const logger = require('./logger');

const SETTING = 'category_packs';
const LIBRARY_PACKS = policy.PACK_IDS.filter(p => p !== 'seasonal');
const RECENT_DAYS = 90;
const NEW_EPISODE_DAYS = 7;
const TYPE = { movie: 'movie', tv: 'show' };

const now = () => Math.floor(Date.now() / 1000);

function jellyfinCollections() { return require('./jellyfin/collections'); }
function jellyfinEnabled() {
  try { return require('./jellyfin').isEnabled(); } catch { return false; }
}

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  let parsed = {};
  try { parsed = JSON.parse(db.getSetting(SETTING, '{}') || '{}') || {}; } catch {}
  return Object.fromEntries(policy.PACK_IDS.map(id => [id, policy.normalizeConfig(id, parsed[id])]));
}

function setPackConfig(pack, patch) {
  const config = getConfig();
  config[pack] = policy.normalizeConfig(pack, { ...config[pack], ...patch });
  db.setSetting(SETTING, JSON.stringify(config));
  return config[pack];
}

// ── Rows (collections a library pack currently owns) ──────────────────────────

function rowOf(r) {
  return {
    id: r.id, pack: r.pack, packKey: r.pack_key, media: r.media, title: r.title,
    plexKey: r.plex_key || null, jfId: r.jf_id || null, visibility: r.visibility || 'library',
    itemCount: r.item_count || 0, lastSyncedAt: r.last_synced_at || 0, lastError: r.last_error || null,
  };
}

function getRows(pack) {
  const rows = pack
    ? db.prepare('SELECT * FROM category_collections WHERE pack = ? ORDER BY media, title COLLATE NOCASE').all(pack)
    : db.prepare('SELECT * FROM category_collections ORDER BY pack, media, title COLLATE NOCASE').all();
  return rows.map(rowOf);
}

function saveRow(p, { plexKey, jfId, visibility, error }) {
  db.prepare(`
    INSERT INTO category_collections (pack, pack_key, media, title, plex_key, jf_id, visibility, item_count, last_synced_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pack, pack_key, media) DO UPDATE SET
      title = excluded.title, plex_key = excluded.plex_key, jf_id = excluded.jf_id,
      visibility = excluded.visibility, item_count = excluded.item_count,
      last_synced_at = excluded.last_synced_at, last_error = excluded.last_error
  `).run(p.pack, p.packKey, p.media, p.title, plexKey || null, jfId || null, visibility, p.count || 0, now(), error || null);
}

// ── Library queries ───────────────────────────────────────────────────────────

// Plex packs live in the two main libraries (the sections collections are
// mirrored into everywhere else in the app); Jellyfin has no such split.
function scope(source, media) {
  if (source !== 'plex') return { sql: 'source = ? AND type = ?', params: [source, TYPE[media]] };
  const sectionId = media === 'tv' ? plexService.TV_SECTION : plexService.MOVIES_SECTION;
  return { sql: 'source = ? AND type = ? AND section_id = ?', params: [source, TYPE[media], String(sectionId)] };
}

function recentCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function countRecent(source, media) {
  const s = scope(source, media);
  return db.prepare(`SELECT COUNT(*) AS c FROM library_items WHERE ${s.sql} AND release_date >= ?`)
    .get(...s.params, recentCutoff(RECENT_DAYS)).c;
}

function decadeCounts(source, media) {
  const s = scope(source, media);
  return db.prepare(
    `SELECT (year / 10) * 10 AS decade, COUNT(*) AS c FROM library_items WHERE ${s.sql} AND year >= 1880 GROUP BY decade ORDER BY decade`
  ).all(...s.params);
}

function studioCounts(source, media) {
  const s = scope(source, media);
  return db.prepare(
    `SELECT MIN(studio) AS name, COUNT(*) AS c FROM library_items WHERE ${s.sql} AND studio != '' GROUP BY studio COLLATE NOCASE ORDER BY name COLLATE NOCASE`
  ).all(...s.params);
}

// Jellyfin item ids matching a rule (BoxSets are static, so they are rebuilt
// from the library table). Jellyfin files a show's network under Studios.
function jellyfinIdsFor(media, rule) {
  const s = scope('jellyfin', media);
  const ids = (sql, ...params) => db.prepare(`SELECT rating_key FROM library_items WHERE ${s.sql} AND ${sql}`)
    .all(...s.params, ...params).map(r => String(r.rating_key));
  switch (rule.kind) {
    case 'recent': return ids('release_date >= ? ORDER BY release_date DESC', recentCutoff(rule.days));
    case 'decade': return ids('year >= ? AND year < ? ORDER BY COALESCE(NULLIF(rating, 0), audience_rating) DESC LIMIT ?', rule.decade, rule.decade + 10, rule.limit);
    case 'studio': return ids('studio = ? COLLATE NOCASE ORDER BY release_date DESC', rule.value);
    case 'network': return ids('studio = ? COLLATE NOCASE ORDER BY release_date DESC', rule.name);
    default: return [];
  }
}

// ── Planning: which collections should exist for a pack ───────────────────────

function mediaList(source) {
  return ['movie', 'tv'].filter(media => {
    const s = scope(source, media);
    return db.prepare(`SELECT 1 FROM library_items WHERE ${s.sql} LIMIT 1`).get(...s.params);
  });
}

async function plexNetworks(sectionId) {
  const json = await plexCollections.plexRequest(`/library/sections/${sectionId}/network`);
  const out = [];
  for (const d of json?.MediaContainer?.Directory || []) {
    const page = await plexCollections.plexRequest(
      `/library/sections/${sectionId}/all?type=2&network=${encodeURIComponent(d.key)}&X-Plex-Container-Start=0&X-Plex-Container-Size=0`
    );
    const c = page?.MediaContainer || {};
    out.push({ id: String(d.key), name: String(d.title), c: Number(c.totalSize ?? c.size ?? 0) });
  }
  return out;
}

// Planned collections for a library pack: [{ pack, packKey, media, title, count, rule }].
// Counts come from the primary server (Plex when configured, else Jellyfin).
async function planPack(pack, cfg) {
  const source = plexCollections.plexConfigured() ? 'plex' : 'jellyfin';
  const item = (packKey, media, title, count, rule) => ({ pack, packKey: String(packKey), media, title, count, rule });
  const planned = [];
  const medias = mediaList(source);

  if (pack === 'basic') {
    for (const media of medias) {
      planned.push(item('released', media, 'Newly Released', countRecent(source, media), { kind: 'recent', days: RECENT_DAYS }));
    }
    // Episode-level collection: Plex only (a BoxSet holds movies and series).
    if (source === 'plex' && medias.includes('tv')) {
      const s = scope('plex', 'tv');
      const count = db.prepare(`SELECT COUNT(*) AS c FROM library_items WHERE ${s.sql} AND last_episode_added_at >= ?`)
        .get(...s.params, now() - NEW_EPISODE_DAYS * 86400).c;
      planned.push(item('episodes', 'tv', 'New Episodes', Math.max(1, count), { kind: 'new_episodes', days: NEW_EPISODE_DAYS }));
    }
  } else if (pack === 'decade') {
    for (const media of medias) {
      for (const d of decadeCounts(source, media)) {
        planned.push(item(d.decade, media, `Best of ${d.decade}s`, d.c, { kind: 'decade', decade: d.decade, limit: cfg.limit }));
      }
    }
  } else if (pack === 'studio') {
    for (const media of medias) {
      for (const st of studioCounts(source, media)) {
        if (!policy.filterableName(st.name)) continue;
        planned.push(item(st.name, media, st.name, st.c, { kind: 'studio', value: st.name }));
      }
    }
  } else if (pack === 'network' && medias.includes('tv')) {
    const networks = source === 'plex'
      ? await plexNetworks(plexService.TV_SECTION)
      : studioCounts('jellyfin', 'tv').map(st => ({ id: null, name: st.name, c: st.c }));
    for (const n of networks) {
      planned.push(item(n.name, 'tv', n.name, n.c, { kind: 'network', id: n.id, name: n.name }));
    }
  }
  return planned.filter(p => p.count >= cfg.minItems);
}

// Titles other packs already own, so a preview/sync of one pack dedupes the
// same way a full run does.
function takenByOtherPacks(pack) {
  const order = policy.PACK_IDS.indexOf(pack);
  const taken = new Set();
  for (const row of getRows()) {
    if (policy.PACK_IDS.indexOf(row.pack) < order) taken.add(`${row.media}:${row.title.toLowerCase()}`);
  }
  return taken;
}

async function previewPack(pack) {
  if (pack === 'seasonal') return seasonalStatus();
  const cfg = getConfig()[pack];
  return policy.dedupeTitles(await planPack(pack, cfg), takenByOtherPacks(pack))
    .map(({ packKey, media, title, count }) => ({ packKey, media, title, count }));
}

// ── Plex / Jellyfin apply ─────────────────────────────────────────────────────

// Create, adopt or repoint the smart collection for one planned entry.
async function applyPlex(p, row, cfg, collectionsByTitle) {
  const sectionId = p.media === 'tv' ? plexService.TV_SECTION : plexService.MOVIES_SECTION;
  const machineId = await plexCollections.getMachineId();
  const filterPath = policy.filterPath({ sectionId, media: p.media, rule: p.rule });
  let key = row?.plexKey || null;
  let live = key ? await plexCollections.getCollection(key) : null;
  if (!live) {
    key = null;
    const sameTitle = (await collectionsByTitle(sectionId)).get(p.title.toLowerCase());
    if (sameTitle && String(sameTitle.smart) !== '1') {
      throw new Error(`A manual collection named "${p.title}" already exists in Plex`);
    }
    if (sameTitle) { key = String(sameTitle.ratingKey); live = sameTitle; }
  }
  const created = !key;
  if (created) {
    key = await plexCollections.createSmartCollection(sectionId, policy.plexTypeFor(p.media, p.rule), p.title, machineId, filterPath);
  } else {
    await plexCollections.updateSmartFilter(key, machineId, filterPath);
  }
  // Unpromoted collections stay out of Plex's hub manager unless they were
  // promoted before (then the flags have to be cleared).
  if (cfg.visibility !== 'library' || (row && row.visibility !== 'library') || (!created && !row)) {
    await plexCollections.setVisibility(sectionId, key, cfg.visibility);
  }
  const wantedSort = policy.sortTitle(p.pack, p.title);
  if (live?.titleSort !== wantedSort) await plexCollections.setCollectionSortTitle(key, wantedSort).catch(() => {});
  if (created) {
    await plexCollections.setCollectionPoster(key, policy.posterUrl(p.pack, p.packKey, p.title)).catch(() => {});
  }
  return key;
}

async function removeRow(row) {
  if (row.plexKey && plexCollections.plexConfigured()) await plexCollections.deleteCollection(row.plexKey);
  if (row.jfId && jellyfinEnabled()) await jellyfinCollections().deleteBoxSet(row.jfId);
  db.prepare('DELETE FROM category_collections WHERE id = ?').run(row.id);
}

// Bring one library pack in line with its plan. Returns a summary.
async function syncLibraryPack(pack, taken) {
  const cfg = getConfig()[pack];
  const rows = new Map(getRows(pack).map(r => [`${r.packKey}:${r.media}`, r]));
  const planned = policy.dedupeTitles(await planPack(pack, cfg), taken);
  const summary = { pack, collections: planned.length, created: 0, removed: 0, failed: 0 };

  const titleCache = new Map();
  const collectionsByTitle = async (sectionId) => {
    if (!titleCache.has(sectionId)) {
      const all = await plexCollections.listCollections(sectionId);
      titleCache.set(sectionId, new Map(all.map(c => [String(c.title).toLowerCase(), c])));
    }
    return titleCache.get(sectionId);
  };

  for (const p of planned) {
    const rowKey = `${p.packKey}:${p.media}`;
    const row = rows.get(rowKey) || null;
    rows.delete(rowKey);
    let plexKey = row?.plexKey || null;
    let jfId = row?.jfId || null;
    const errors = [];
    if (plexCollections.plexConfigured()) {
      try { plexKey = await applyPlex(p, row, cfg, collectionsByTitle); }
      catch (e) { errors.push(`plex: ${e.message}`); }
    }
    if (jellyfinEnabled() && p.rule.kind !== 'new_episodes') {
      try {
        jfId = await jellyfinCollections().syncTypeBoxSet({ title: p.title, itemIds: jellyfinIdsFor(p.media, p.rule), existingId: jfId });
      } catch (e) { errors.push(`jellyfin: ${e.message}`); }
    }
    if (!row && (plexKey || jfId)) summary.created++;
    if (errors.length) {
      summary.failed++;
      logger.warn(`[categories] "${p.title}" (${pack}/${p.media}): ${errors.join('; ')}`);
    }
    if (row || plexKey || jfId || errors.length) {
      saveRow(p, { plexKey, jfId, visibility: cfg.visibility, error: errors.join('; ') || null });
    }
  }

  // Whatever is left no longer qualifies (fell below the minimum, or the
  // library lost the studio): Kometa's delete_below_minimum.
  for (const row of rows.values()) {
    try { await removeRow(row); summary.removed++; }
    catch (e) { summary.failed++; logger.warn(`[categories] could not remove "${row.title}": ${e.message}`); }
  }
  logger.info(`[categories] ${pack}: ${summary.collections} collections (${summary.created} new, ${summary.removed} removed, ${summary.failed} failed)`);
  return summary;
}

// Stop managing a library pack. Collections stay in Plex/Jellyfin unless
// deleteCollections is set.
async function releaseLibraryPack(pack, { deleteCollections = false } = {}) {
  for (const row of getRows(pack)) {
    if (deleteCollections) {
      await removeRow(row).catch(e => logger.warn(`[categories] could not remove "${row.title}": ${e.message}`));
    } else {
      db.prepare('DELETE FROM category_collections WHERE id = ?').run(row.id);
    }
  }
}

// ── Seasonal pack (scheduled monitored lists) ─────────────────────────────────

function seasonalLists() {
  return automation.getListSources().filter(l => l.pack === 'seasonal');
}

function seasonalStatus() {
  const lists = new Map(seasonalLists().map(l => [l.packKey, l]));
  return seasonal.HOLIDAYS.map(h => {
    const list = lists.get(h.key) || null;
    return {
      packKey: h.key, media: 'movie', title: list?.collectionName || list?.name || seasonal.titleFor(h),
      start: h.start, end: h.end,
      inSeason: listPolicy.inSchedule({ scheduleStart: list?.scheduleStart || h.start, scheduleEnd: list?.scheduleEnd || h.end }),
      listId: list?.id || null, enabled: !!list?.enabled,
      count: list ? automation.countListItems(list.id, 'in_library') : 0,
      lastStatus: list?.lastStatus || null, lastError: list?.lastError || null,
    };
  });
}

// Create the holiday lists that don't exist yet and switch them all on. The
// lists are collection-only (no auto-requests) until the admin edits them.
async function enableSeasonal(cfg, { applyVisibility = false } = {}) {
  const existing = new Map(seasonalLists().map(l => [l.packKey, l]));
  let adoptable = null;
  for (const h of seasonal.HOLIDAYS) {
    const list = existing.get(h.key);
    if (list) {
      automation.updateListSource(list.id, {
        enabled: true, lastSyncedAt: 0,
        ...(applyVisibility ? { collectionVisibility: cfg.visibility } : {}),
      });
      continue;
    }
    // Adopt Kometa's collection for a holiday that is running right now, so
    // the row is replaced instead of doubled.
    let adoptedKey = null;
    if (plexCollections.plexConfigured() && listPolicy.inSchedule({ scheduleStart: h.start, scheduleEnd: h.end })) {
      try {
        adoptable = adoptable || await plexCollections.listCollections(plexService.MOVIES_SECTION);
        const match = adoptable.find(c => String(c.title).toLowerCase() === seasonal.titleFor(h).toLowerCase());
        if (match) adoptedKey = String(match.ratingKey);
      } catch (e) {
        logger.warn(`[categories] seasonal adoption lookup failed: ${e.message}`);
      }
    }
    automation.createListSource({
      name: seasonal.titleFor(h), sourceType: 'preset', presetKey: `seasonal_${h.key}`,
      mediaType: 'movie', maxRequestsPerRun: 0, syncIntervalHours: 24,
      collectionEnabled: true, collectionVisibility: cfg.visibility, collectionSort: 'list',
      collectionRatingKey: adoptedKey ? JSON.stringify({ movie: adoptedKey }) : null,
      pack: 'seasonal', packKey: h.key, scheduleStart: h.start, scheduleEnd: h.end,
    });
  }
}

async function disableSeasonal({ deleteCollections = false } = {}) {
  for (const list of seasonalLists()) {
    if (deleteCollections && list.collectionRatingKey) {
      await plexCollections.deleteListCollections(list)
        .then(() => automation.updateListSource(list.id, { collectionRatingKey: null }))
        .catch(e => logger.warn(`[categories] could not remove "${list.name}": ${e.message}`));
    }
    automation.updateListSource(list.id, { enabled: false });
  }
}

// ── Entry points ──────────────────────────────────────────────────────────────

const running = new Set();
function isRunning(pack) { return running.has(pack); }

async function syncPack(pack) {
  if (running.has(pack)) return { pack, skipped: 'already running' };
  running.add(pack);
  try {
    const cfg = getConfig()[pack];
    if (pack === 'seasonal') {
      await enableSeasonal(cfg);
      // Lazy: autoRequest pulls in the request routes.
      await require('./autoRequest').runDueLists();
      return { pack, collections: seasonalStatus().filter(h => h.inSeason).length };
    }
    return await syncLibraryPack(pack, takenByOtherPacks(pack));
  } finally {
    running.delete(pack);
  }
}

// Scheduler entry: every enabled library pack, in clash-resolution order.
// (Seasonal lists ride the auto request job's own schedule.)
async function syncAll() {
  const config = getConfig();
  const results = [];
  for (const pack of LIBRARY_PACKS) {
    if (!config[pack].enabled) continue;
    try { results.push(await syncPack(pack)); }
    catch (e) {
      logger.warn(`[categories] ${pack} sync failed: ${e.message}`);
      results.push({ pack, error: e.message });
    }
  }
  return results;
}

// Admin edit of a pack: persists the config, then applies the transition.
// Enabling/re-syncing is slow (Plex round-trips), so callers run sync
// separately; disabling is applied here.
async function updatePack(pack, patch, { deleteCollections = false } = {}) {
  const before = getConfig()[pack];
  const after = setPackConfig(pack, patch);
  if (before.enabled && !after.enabled) {
    if (pack === 'seasonal') await disableSeasonal({ deleteCollections });
    else await releaseLibraryPack(pack, { deleteCollections });
  } else if (after.enabled && pack === 'seasonal') {
    await enableSeasonal(after, { applyVisibility: patch.visibility !== undefined });
  }
  return after;
}

function describe() {
  const config = getConfig();
  return policy.PACK_IDS.map(id => ({
    id,
    label: policy.PACKS[id].label,
    description: policy.PACKS[id].description,
    config: config[id],
    syncing: running.has(id),
    collections: id === 'seasonal' ? seasonalStatus() : getRows(id),
  }));
}

module.exports = {
  getConfig, setPackConfig, getRows, planPack, previewPack, syncPack, syncAll, updatePack, describe,
  isRunning, seasonalStatus, jellyfinIdsFor, LIBRARY_PACKS,
};
