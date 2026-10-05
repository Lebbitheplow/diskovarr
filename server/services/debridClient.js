'use strict';

// Deletes torrents from a debrid account (AllDebrid or Real-Debrid).
//
// Used by the deletion flow after an item is removed from Riven: Riven's own
// /items/remove drops its database rows and library symlinks but leaves the
// torrent in the debrid account. Riven's API doesn't expose the torrent id, so
// torrents are matched by name — the item's `folder` in Riven is the torrent's
// directory under the debrid mount, which is the torrent's name in the account.

const TIMEOUT_MS = 30000;
const ALLDEBRID_URL = 'https://api.alldebrid.com';
const REALDEBRID_URL = 'https://api.real-debrid.com/rest/1.0';
const AGENT = 'Diskovarr';
const RD_PAGE_SIZE = 2500;

async function debridFetch(url, apiKey, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Authorization': `Bearer ${apiKey}`, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${new URL(url).pathname} → ${res.status}`);
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// AllDebrid wraps everything in { status, data | error } with HTTP 200.
async function allDebridFetch(apiKey, pathname, opts) {
  const payload = await debridFetch(`${ALLDEBRID_URL}${pathname}${pathname.includes('?') ? '&' : '?'}agent=${AGENT}`, apiKey, opts);
  if (payload?.status !== 'success') {
    throw new Error(`AllDebrid ${pathname.split('?')[0]}: ${payload?.error?.message || payload?.error?.code || 'invalid response'}`);
  }
  return payload.data;
}

async function listAllDebrid(apiKey) {
  const data = await allDebridFetch(apiKey, '/v4.1/magnet/status');
  const magnets = Array.isArray(data?.magnets) ? data.magnets : Object.values(data?.magnets || {});
  return magnets.map(m => ({ id: m.id, names: [m.filename] }));
}

async function deleteAllDebrid(apiKey, id) {
  await allDebridFetch(apiKey, '/v4/magnet/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: String(id) }).toString(),
  });
}

async function listRealDebrid(apiKey) {
  const torrents = [];
  for (let page = 1; ; page++) {
    const batch = await debridFetch(`${REALDEBRID_URL}/torrents?limit=${RD_PAGE_SIZE}&page=${page}`, apiKey);
    if (!Array.isArray(batch) || batch.length === 0) break;
    // Zurg names the mount directory after either field depending on its config
    torrents.push(...batch.map(t => ({ id: t.id, names: [t.filename, t.original_filename] })));
    if (batch.length < RD_PAGE_SIZE) break;
  }
  return torrents;
}

async function deleteRealDebrid(apiKey, id) {
  await debridFetch(`${REALDEBRID_URL}/torrents/delete/${encodeURIComponent(String(id))}`, apiKey, { method: 'DELETE' });
}

const PROVIDERS = {
  alldebrid: { list: listAllDebrid, remove: deleteAllDebrid },
  realdebrid: { list: listRealDebrid, remove: deleteRealDebrid },
};

/**
 * Delete every torrent whose name exactly matches one of `names`.
 * account: { provider: 'alldebrid'|'realdebrid', apiKey }.
 * Returns { deleted, missing } — `missing` counts names with no torrent.
 */
async function deleteTorrentsByName(account, names) {
  const provider = PROVIDERS[account?.provider];
  if (!provider) throw new Error(`Unsupported debrid provider: ${account?.provider}`);
  const wanted = new Set((names || []).filter(Boolean));
  if (wanted.size === 0) return { deleted: 0, missing: 0 };

  const torrents = await provider.list(account.apiKey);
  const found = new Set();
  let deleted = 0;
  for (const torrent of torrents) {
    const name = torrent.names.find(n => wanted.has(n));
    if (!name) continue;
    found.add(name);
    await provider.remove(account.apiKey, torrent.id);
    deleted++;
  }
  return { deleted, missing: wanted.size - found.size };
}

module.exports = { deleteTorrentsByName };
