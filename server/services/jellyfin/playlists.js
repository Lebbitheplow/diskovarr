const client = require('./client');
const sessions = require('./sessions');

// Jellyfin playlists (Wrapped "top titles" playlist). Replace semantics like
// plex.createPlaylistWithItems: an existing playlist with the same name for
// the user is deleted first.

function authOpts(token) {
  return token ? { token } : {};
}

async function findPlaylistByName(jfUserId, name, { token = null } = {}) {
  const params = new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true', Limit: '200' });
  const page = await client.jfFetch(`/Users/${encodeURIComponent(String(jfUserId))}/Items?${params}`, { ...authOpts(token) });
  const hit = (page?.Items || []).find(p => (p.Name || '') === name);
  return hit?.Id ? String(hit.Id) : null;
}

// Shows become one episode (NextUp / first) so a series isn't expanded whole.
async function resolvePlaylistIds(ratingKeys, jfUserId, { token = null } = {}) {
  const ids = [];
  for (const rk of ratingKeys) {
    const resolved = await sessions.resolvePlayableItemIds(rk, jfUserId, { token }).catch(() => []);
    ids.push(...resolved);
  }
  return [...new Set(ids)];
}

// POST /Playlists { Name, Ids, UserId, MediaType: 'Video' } → { playlistId, count }
async function createPlaylistWithItems(jfUserId, name, ratingKeys, { token = null } = {}) {
  const ids = await resolvePlaylistIds(ratingKeys, jfUserId, { token });
  if (!ids.length) throw new Error('No playlist items to add');
  const existing = await findPlaylistByName(jfUserId, name, { token }).catch(() => null);
  if (existing) await client.jfFetch(`/Items/${encodeURIComponent(existing)}`, { method: 'DELETE', ...authOpts(token) });
  const created = await client.jfFetch('/Playlists', {
    method: 'POST', ...authOpts(token),
    body: { Name: name, Ids: ids, UserId: String(jfUserId), MediaType: 'Video' },
  });
  const playlistId = created?.Id ? String(created.Id) : '';
  if (!playlistId) throw new Error('Playlist created but no id returned');
  return { playlistId, count: ids.length };
}

function getPlaylistDeepLink(playlistId) {
  return client.getDeepLink(playlistId);
}

module.exports = { createPlaylistWithItems, findPlaylistByName, resolvePlaylistIds, getPlaylistDeepLink };
