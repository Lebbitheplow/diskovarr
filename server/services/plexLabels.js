// Per-list Plex labels backing "unwatched only" smart collections. A label
// ("diskovarr-list-<id>") is stamped on every library item the list resolves
// to and removed from items that fell off the list, so the collection's
// filter (label AND unwatched) tracks the source while Plex evaluates
// "unwatched" per viewing user.
//
// Plex has no add/remove-one-label call: an item's label set is rewritten
// wholesale (label[N].tag.tag=…), so the item's current labels are read first
// and preserved.
const plexService = require('./plex');

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

// Rating keys in a section currently carrying `label`.
async function itemsWithLabel(sectionId, plexType, label) {
  const json = await plexRequest(
    `/library/sections/${sectionId}/all?type=${plexType}&label=${encodeURIComponent(label)}&X-Plex-Container-Size=5000`
  );
  return new Set((json?.MediaContainer?.Metadata || []).map(m => String(m.ratingKey)));
}

async function currentLabels(ratingKey) {
  const json = await plexRequest(`/library/metadata/${ratingKey}`);
  const meta = json?.MediaContainer?.Metadata?.[0];
  return (meta?.Label || []).map(l => l.tag).filter(Boolean);
}

function labelQuery(labelList) {
  if (labelList.length === 0) return 'label[0].tag.tag-=';
  return labelList.map((tag, i) => `label[${i}].tag.tag=${encodeURIComponent(tag)}`).join('&');
}

async function writeLabels(ratingKey, labelList) {
  await plexRequest(`/library/metadata/${ratingKey}?${labelQuery(labelList)}`, { method: 'PUT' });
}

async function addLabel(ratingKey, label) {
  const existing = await currentLabels(ratingKey);
  if (existing.some(t => t.toLowerCase() === label.toLowerCase())) return false;
  await writeLabels(ratingKey, [...existing, label]);
  return true;
}

async function removeLabel(ratingKey, label) {
  const existing = await currentLabels(ratingKey);
  const kept = existing.filter(t => t.toLowerCase() !== label.toLowerCase());
  if (kept.length === existing.length) return false;
  await writeLabels(ratingKey, kept);
  return true;
}

// Make exactly `wantedKeys` carry `label` in the section. Returns counts.
async function syncLabel({ sectionId, plexType, label, wantedKeys }) {
  const wanted = new Set((wantedKeys || []).map(String));
  const have = await itemsWithLabel(sectionId, plexType, label);
  let added = 0, removed = 0;
  for (const key of wanted) {
    if (have.has(key)) continue;
    if (await addLabel(key, label).catch(() => false)) added++;
  }
  for (const key of have) {
    if (wanted.has(key)) continue;
    if (await removeLabel(key, label).catch(() => false)) removed++;
  }
  return { added, removed };
}

module.exports = { syncLabel, itemsWithLabel, addLabel, removeLabel, labelQuery };
