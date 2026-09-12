// Plex home/Recommended hub management: the per-section hub list Plex exposes
// at /hubs/sections/{id}/manage (built-in hubs like "Recently Added" plus
// promoted collections), their promotion flags, and their order — the same
// endpoints Agregarr's hub sync uses. The desired layout for built-in hubs is
// stored in the plex_hub_layout setting; list collections carry their own
// home_order/visibility on the list row. applySectionLayout() merges both.
const db = require('../db/database');
const plexService = require('./plex');
const automation = require('../db/automation');
const logger = require('./logger');
const policy = require('./collectionPolicy');

const LAYOUT_SETTING = 'plex_hub_layout';
// Plex keeps these first; ordering is applied after them (Agregarr anchors the
// same way).
const ANCHORS = { movie: 'movie.inprogress', show: 'tv.ondeck' };

const HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': 'diskovarr-app',
  'X-Plex-Product': 'Diskovarr',
};

async function plexRequest(path, { method = 'GET' } = {}) {
  const res = await fetch(`${plexService.getPlexUrl()}${path}`, {
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

function hubRow(h) {
  return {
    identifier: h.identifier,
    title: h.title,
    own: !!h.promotedToOwnHome,
    shared: !!h.promotedToSharedHome,
    rec: !!h.promotedToRecommended,
    isCollection: /^custom\.collection\./.test(h.identifier || ''),
    collectionKey: (String(h.identifier || '').match(/^custom\.collection\.\d+\.(\d+)$/) || [])[1] || null,
  };
}

// Current managed hubs of a section, in Plex's order.
async function getManagedHubs(sectionId) {
  const json = await plexRequest(`/hubs/sections/${sectionId}/manage`);
  return (json?.MediaContainer?.Hub || []).map(hubRow);
}

async function setHubFlags(sectionId, identifier, { rec, own, shared }) {
  await plexRequest(
    `/hubs/sections/${sectionId}/manage/${encodeURIComponent(identifier)}` +
    `?promotedToRecommended=${rec ? 1 : 0}&promotedToOwnHome=${own ? 1 : 0}&promotedToSharedHome=${shared ? 1 : 0}`,
    { method: 'PUT' }
  );
}

async function moveHub(sectionId, identifier, afterIdentifier) {
  const path = `/hubs/sections/${sectionId}/manage/${encodeURIComponent(identifier)}/move` +
    (afterIdentifier ? `?after=${encodeURIComponent(afterIdentifier)}` : '');
  await plexRequest(path, { method: 'PUT' });
}

// ── Stored layout ─────────────────────────────────────────────────────────────

function getStoredLayout() {
  try {
    const parsed = JSON.parse(db.getSetting(LAYOUT_SETTING, '{}') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function getSectionLayout(sectionId) {
  const rows = getStoredLayout()[String(sectionId)];
  return Array.isArray(rows) ? rows : [];
}

// rows: [{ identifier, own, shared, rec, order }] for built-in hubs only.
function setSectionLayout(sectionId, rows) {
  const layout = getStoredLayout();
  layout[String(sectionId)] = (rows || [])
    .filter(r => r && r.identifier && !/^custom\.collection\./.test(r.identifier))
    .map(r => ({
      identifier: String(r.identifier),
      own: !!r.own, shared: !!r.shared, rec: !!r.rec,
      order: Math.max(0, parseInt(r.order) || 0),
    }));
  db.setSetting(LAYOUT_SETTING, JSON.stringify(layout));
}

// Lists that mirror a collection into this section, with the collection key
// they currently own there.
function sectionCollections(sectionId) {
  const plexCollections = require('./plexCollections');
  const media = String(sectionId) === String(plexService.MOVIES_SECTION) ? 'movie'
    : String(sectionId) === String(plexService.TV_SECTION) ? 'tv' : null;
  if (!media) return [];
  return automation.getCollectionListsForMedia(media)
    .map(list => {
      const key = plexCollections.parseCollectionKeys(list.collectionRatingKey)[media];
      return key ? { list, key: String(key), identifier: policy.collectionHubId(sectionId, key) } : null;
    })
    .filter(Boolean);
}

// The merged view the admin UI edits: Plex's current hubs, decorated with the
// stored layout for built-ins and the owning list for collections, in the
// order Plex currently shows them.
async function describeSection(section) {
  const hubs = await getManagedHubs(section.id);
  const stored = new Map(getSectionLayout(section.id).map(r => [r.identifier, r]));
  const owned = new Map(sectionCollections(section.id).map(c => [c.identifier, c]));
  return {
    id: section.id,
    title: section.title,
    type: section.type,
    hubs: hubs.map(h => {
      const list = owned.get(h.identifier)?.list || null;
      const layout = stored.get(h.identifier) || null;
      return {
        ...h,
        listId: list ? list.id : null,
        listName: list ? list.name : null,
        order: list ? list.homeOrder : (layout ? layout.order : 0),
        managed: !!(list || layout),
      };
    }),
  };
}

async function describeAllSections() {
  const sections = await plexService.getPlexSections();
  const out = [];
  for (const section of sections) {
    try { out.push(await describeSection(section)); }
    catch (e) { out.push({ id: section.id, title: section.title, type: section.type, hubs: [], error: e.message }); }
  }
  return out;
}

// Push flags + order for one section. Built-in hubs come from the stored
// layout; collections from their lists. Returns { moved, flagged }.
async function applySectionLayout(sectionId) {
  const section = (await plexService.getPlexSections()).find(s => String(s.id) === String(sectionId));
  if (!section) throw new Error(`Unknown Plex section ${sectionId}`);
  const current = await getManagedHubs(sectionId);
  const present = new Set(current.map(h => h.identifier));
  const stored = getSectionLayout(sectionId);
  const collections = sectionCollections(sectionId);
  let flagged = 0;

  for (const row of stored) {
    if (!present.has(row.identifier)) continue;
    const live = current.find(h => h.identifier === row.identifier);
    if (live.own === row.own && live.shared === row.shared && live.rec === row.rec) continue;
    await setHubFlags(sectionId, row.identifier, row);
    flagged++;
  }
  for (const c of collections) {
    const flags = policy.visibilityFlags(c.list.collectionVisibility);
    const live = current.find(h => h.identifier === c.identifier);
    if (!live) {
      if (!flags.rec && !flags.own && !flags.shared) continue;
      // Promote into hub management first, then set the flags.
      await plexRequest(`/hubs/sections/${sectionId}/manage?metadataItemId=${c.key}`, { method: 'POST' }).catch(() => {});
      await setHubFlags(sectionId, c.identifier, flags).catch(() => {});
      present.add(c.identifier);
      flagged++;
      continue;
    }
    if (!!live.own === !!flags.own && !!live.shared === !!flags.shared && !!live.rec === !!flags.rec) continue;
    await setHubFlags(sectionId, c.identifier, flags);
    flagged++;
  }

  const anchor = ANCHORS[section.type] && present.has(ANCHORS[section.type]) ? ANCHORS[section.type] : null;
  const { sequence } = policy.planHomeLayout({
    hubs: stored,
    collections: collections.map(c => ({ identifier: c.identifier, order: c.list.homeOrder })),
    anchor,
  });
  const wanted = sequence.filter(id => present.has(id));
  if (wanted.length === 0) return { moved: 0, flagged };

  const order = (await getManagedHubs(sectionId)).map(h => h.identifier);
  // Anchor is a fixed prefix: ask for [anchor, ...wanted] so the first wanted
  // hub lands right after it.
  const target = anchor ? [anchor, ...wanted] : wanted;
  const moves = policy.planMoves(order, target).filter(m => m.key !== anchor);
  for (const m of moves) {
    // planMoves' first entry (after=null) means "front of the list"; with an
    // anchor it becomes "right after the anchor".
    await moveHub(sectionId, m.key, m.after === null ? anchor : m.after);
  }
  return { moved: moves.length, flagged };
}

async function applyAllLayouts() {
  if (!plexService.getPlexUrl() || !plexService.getPlexToken()) return [];
  const sections = await plexService.getPlexSections();
  const results = [];
  for (const section of sections) {
    try {
      const r = await applySectionLayout(section.id);
      results.push({ sectionId: section.id, ...r });
    } catch (e) {
      logger.warn(`[hubs] layout apply failed for section ${section.id}: ${e.message}`);
      results.push({ sectionId: section.id, error: e.message });
    }
  }
  return results;
}

module.exports = {
  getManagedHubs, setHubFlags, moveHub,
  getSectionLayout, setSectionLayout, describeSection, describeAllSections,
  applySectionLayout, applyAllLayouts, LAYOUT_SETTING,
};
