const db = require('../../db/database');
const client = require('./client');

// Jellyfin "play on device": the analog of plexCast.js. Jellyfin exposes every
// signed-in app as a Session that any user it is controllable by can drive
// remotely (POST /Sessions/{id}/Playing…). Calls use the user's own Jellyfin
// token when the session carries one (so "controllable by" is evaluated for
// that user), else the admin API key.

const OWN_DEVICE_ID = 'diskovarr-app'; // Diskovarr's own login sessions — never a playback target

function authOpts(token) {
  return token ? { token } : {};
}

function isPlayableSession(s) {
  if (!s?.Id) return false;
  if (s.DeviceId === OWN_DEVICE_ID) return false;
  if (s.SupportsRemoteControl === false) return false;
  const types = s.Capabilities?.PlayableMediaTypes || [];
  return types.some(t => String(t).toLowerCase() === 'video');
}

function nameOf(s) {
  const device = s.DeviceName || '';
  const app = s.Client || '';
  if (device && app && !device.toLowerCase().includes(app.toLowerCase())) return `${device} (${app})`;
  return device || app || s.Id;
}

// Client shape the cast picker already consumes for Plex players, tagged with
// source so the frontend can gate it per item.
function toClient(session) {
  return {
    name: session.name,
    machineIdentifier: session.id,
    product: session.client,
    platform: session.deviceName,
    source: 'jellyfin',
    nowPlaying: session.nowPlayingItemId ? { itemId: session.nowPlayingItemId, title: session.nowPlayingTitle } : null,
  };
}

// GET /Sessions?ControllableByUserId=<id> → normalized playable sessions.
async function listControllableSessions(jfUserId, { token = null } = {}) {
  if (!client.isEnabled() || !jfUserId) return [];
  const params = new URLSearchParams({ ControllableByUserId: String(jfUserId) });
  const sessions = await client.jfFetch(`/Sessions?${params}`, { ...authOpts(token), timeout: 10000 });
  return (Array.isArray(sessions) ? sessions : [])
    .filter(isPlayableSession)
    .map(s => ({
      id: String(s.Id),
      name: nameOf(s),
      client: s.Client || '',
      deviceName: s.DeviceName || '',
      deviceId: s.DeviceId || '',
      userId: s.UserId ? String(s.UserId) : null,
      userName: s.UserName || '',
      nowPlayingItemId: s.NowPlayingItem?.Id ? String(s.NowPlayingItem.Id) : null,
      nowPlayingTitle: s.NowPlayingItem?.Name || null,
    }));
}

// POST /Sessions/{id}/Playing?ItemIds=a,b&PlayCommand=PlayNow
async function playOnSession(sessionId, itemIds, { startPositionTicks = null, token = null } = {}) {
  const ids = (itemIds || []).map(String).filter(Boolean);
  if (!sessionId || ids.length === 0) throw new Error('sessionId and itemIds required');
  const params = new URLSearchParams({ ItemIds: ids.join(','), PlayCommand: 'PlayNow' });
  if (startPositionTicks != null) params.set('StartPositionTicks', String(startPositionTicks));
  await client.jfFetch(`/Sessions/${encodeURIComponent(String(sessionId))}/Playing?${params}`, {
    method: 'POST', ...authOpts(token), timeout: 15000,
  });
  return { ok: true };
}

const PLAYSTATE_COMMANDS = new Set(['Stop', 'Pause', 'Unpause', 'NextTrack', 'PreviousTrack', 'Seek', 'Rewind', 'FastForward', 'PlayPause']);

// POST /Sessions/{id}/Playing/{Pause|Unpause|Stop|Seek…}
async function command(sessionId, cmd, { seekPositionTicks = null, token = null } = {}) {
  const name = String(cmd || '');
  const canonical = [...PLAYSTATE_COMMANDS].find(c => c.toLowerCase() === name.toLowerCase());
  if (!sessionId || !canonical) throw new Error(`Unsupported playstate command "${cmd}"`);
  const params = new URLSearchParams();
  if (canonical === 'Seek' && seekPositionTicks != null) params.set('SeekPositionTicks', String(seekPositionTicks));
  const qs = params.toString();
  await client.jfFetch(`/Sessions/${encodeURIComponent(String(sessionId))}/Playing/${canonical}${qs ? `?${qs}` : ''}`, {
    method: 'POST', ...authOpts(token), timeout: 10000,
  });
  return { ok: true };
}

// First unplayed episode of a series for this user (NextUp), else its first
// episode. Returns null when the series has no episodes at all.
async function resolveFirstEpisodeId(seriesId, jfUserId, { token = null } = {}) {
  const sid = String(seriesId);
  if (jfUserId) {
    const params = new URLSearchParams({ SeriesId: sid, UserId: String(jfUserId), Limit: '1' });
    const nextUp = await client.jfFetch(`/Shows/NextUp?${params}`, { ...authOpts(token), timeout: 10000 }).catch(() => null);
    const ep = nextUp?.Items?.[0];
    if (ep?.Id) return String(ep.Id);
  }
  const params = new URLSearchParams({ Limit: '1' });
  if (jfUserId) params.set('UserId', String(jfUserId));
  const first = await client.jfFetch(`/Shows/${encodeURIComponent(sid)}/Episodes?${params}`, { ...authOpts(token), timeout: 10000 });
  const ep = first?.Items?.[0];
  return ep?.Id ? String(ep.Id) : null;
}

// Library rating key → the item ids a player should be handed. Movies play
// directly; shows resolve to one episode so the queue doesn't explode.
async function resolvePlayableItemIds(ratingKey, jfUserId, { token = null, type = null } = {}) {
  const key = String(ratingKey);
  const itemType = type || db.getLibraryItemByKey(key)?.type || 'movie';
  if (itemType !== 'show') return [key];
  const ep = await resolveFirstEpisodeId(key, jfUserId, { token });
  return ep ? [ep] : [];
}

module.exports = {
  listControllableSessions, playOnSession, command, resolveFirstEpisodeId, resolvePlayableItemIds,
  toClient, isPlayableSession, OWN_DEVICE_ID,
};
