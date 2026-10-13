// Jellyfin side of per-user library access, from each user's policy (GET /Users
// with the admin key every 15 min; AuthenticateByName at login). Folder access
// maps onto 'jf_<folderId>' sections. Parental controls (ratings, tags, unrated
// items) are left to Jellyfin: /Items?userId=… applies them server-side, so the
// visible ids come back ready and no rating tables are reimplemented here.
const db = require('../../db/database');
const store = require('./store');

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

const guidN = (id) => String(id || '').toLowerCase().replace(/-/g, '');
const client = () => require('../jellyfin/client');

function hasContentRestrictions(p) {
  return p.maxParentalRating != null || p.maxParentalSubRating != null || p.blockedTags.length > 0
    || p.allowedTags.length > 0 || p.blockUnratedItems.length > 0;
}

// Normalized folder id → the section id stored on library rows
function knownSections() {
  const map = new Map();
  for (const r of db.prepare("SELECT DISTINCT section_id FROM library_items WHERE source = 'jellyfin'").all()) {
    map.set(guidN(String(r.section_id).slice(3)), String(r.section_id));
  }
  return map;
}

// Everything the user can see, from Jellyfin itself. Never pass ParentId here:
// with an API key Jellyfin then skips the user's folder restriction.
async function visibleItems(guid) {
  const keys = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      userId: guid, Recursive: 'true', IncludeItemTypes: 'Movie,Series',
      EnableImages: 'false', EnableUserData: 'false', Fields: '', EnableTotalRecordCount: 'true',
      StartIndex: String(page * PAGE_SIZE), Limit: String(PAGE_SIZE),
    });
    const res = await client().jfFetch(`/Items?${qs}`, { timeout: TIMEOUT_MS });
    const items = res?.Items || [];
    for (const it of items) if (it.Id) keys.add(String(it.Id));
    if (items.length < PAGE_SIZE || keys.size >= (res?.TotalRecordCount ?? Infinity)) break;
  }
  return keys;
}

// Folder rule: blocked folders → every folder but those; else all folders, or
// just the enabled ones. With parental controls every visible folder becomes a
// filtered section listing the ids Jellyfin returns for the user.
async function snapshotFromPolicy(jfId, policy) {
  if (!policy) throw new Error('Jellyfin returned no policy for this user');
  if (policy.isDisabled) return { role: 'removed', filters: policy };
  const restricted = hasContentRestrictions(policy);
  const blocked = new Set(policy.blockedMediaFolders);
  const sections = knownSections();
  let allSections = false;
  let sectionIds = [];
  if (blocked.size || (policy.enableAllFolders && restricted)) {
    // Needs the full folder list. Made explicit, so a folder added later stays
    // hidden from this user until the next refresh (fail closed).
    const { getFolders } = require('../jellyfin/library');
    for (const f of await getFolders()) sections.set(guidN(f.id), `jf_${f.id}`);
    sectionIds = [...sections].filter(([id]) => !blocked.has(id)).map(([, sid]) => sid);
  } else if (policy.enableAllFolders) {
    allSections = true;
  } else {
    sectionIds = policy.enabledFolders.map(id => sections.get(id) || `jf_${id}`);
  }
  if (!restricted) return { role: 'jellyfin', allSections, sectionIds, filters: policy };
  const visibleKeys = await visibleItems(jfId.slice(3));
  return { role: 'jellyfin', sectionIds, filteredSectionIds: sectionIds, visibleKeys, filters: policy };
}

/**
 * Refresh the snapshots of these 'jf_<guid>' identities. `policies` (Map of
 * normalized guid → client.policySummary) saves the /Users call when the caller
 * already holds them. A user missing from Jellyfin's user list is 'removed'.
 * A failure keeps the last good snapshot only if it was taken under the same
 * policy; otherwise it is cleared (fail closed) and the 15-minute policy sync
 * retries it. Returns the ids whose access changed.
 */
async function refreshJellyfin(jfIds, { policies = null } = {}) {
  const ids = [...new Set((jfIds || []).map(String))].filter(id => id.startsWith('jf_'));
  const changed = [];
  if (!ids.length) return changed;
  const c = client();
  const fail = (msg) => { for (const id of ids) store.recordError(id, 'jellyfin', msg); };
  if (!c.getJellyfinUrl() || !c.getJellyfinKey()) {
    fail('Jellyfin is not configured');
    return changed;
  }
  let byGuid = policies;
  if (!byGuid || ids.some(id => !byGuid.get(guidN(id.slice(3))))) {
    try {
      byGuid = new Map((await c.getUsers()).map(u => [guidN(u.id), u.policy]));
    } catch (err) {
      fail(`Jellyfin user lookup failed: ${err.message}`);
      return changed;
    }
  }
  for (const id of ids) {
    const guid = guidN(id.slice(3));
    const policy = byGuid.get(guid) ?? null;
    try {
      const snap = byGuid.has(guid)
        ? await snapshotFromPolicy(id, policy)
        : { role: 'removed', filters: null };
      if (store.saveSnapshot(id, 'jellyfin', snap)) changed.push(id);
    } catch (err) {
      // A policy that newly blocks a folder or adds parental controls must not
      // keep the looser snapshot taken before it
      const row = store.getRow(id, 'jellyfin');
      if (policy && row?.fetched_at && row.filters !== JSON.stringify(policy)) {
        if (store.clearSnapshot(id, 'jellyfin', err.message)) changed.push(id);
      } else {
        store.recordError(id, 'jellyfin', err.message);
      }
    }
  }
  return changed;
}

// From the 15-minute user sync: re-snapshot users whose policy differs from
// the stored one, or who have no snapshot yet.
async function syncPolicies(users) {
  const policies = new Map();
  const due = [];
  for (const u of users || []) {
    if (!u?.id || !u.policy) continue;
    policies.set(guidN(u.id), u.policy);
    const jfId = `jf_${u.id}`;
    const row = store.getRow(jfId, 'jellyfin');
    if (!row?.fetched_at || row.filters !== JSON.stringify(u.policy ?? null)) due.push(jfId);
  }
  return refreshJellyfin(due, { policies });
}

module.exports = { refreshJellyfin, syncPolicies, guidN };
