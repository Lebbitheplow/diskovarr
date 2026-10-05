const db = require('../../db/database');
const client = require('../jellyfin/client');
const sessions = require('../jellyfin/sessions');
const logger = require('../logger');
const PartyError = require('./partyError');

// Watch Together driver for Jellyfin players. Jellyfin lets the server drive
// any signed-in app through its Sessions API, so there is no reachability
// problem to solve — a member's device is simply one of their sessions.

const TICKS_PER_MS = 10000;
// Apps report progress only every several seconds; past this the last report
// is too old to extrapolate from.
const MAX_EXTRAPOLATE_MS = 15000;

const _creds = new Map(); // canonical userId -> { jfUserId, token }

function rememberCreds(sessionUser) {
  if (!sessionUser?.id || !sessionUser.jellyfin?.userId) return;
  _creds.set(String(sessionUser.id), { jfUserId: String(sessionUser.jellyfin.userId), token: sessionUser.jellyfin.token || null });
}

// Falls back to the stored identity: the user's own row for a Jellyfin-only
// account, else the Jellyfin account linked to their Plex one. A missing token
// is fine — the admin API key can drive sessions too.
function credsFor(userId) {
  const cached = _creds.get(String(userId));
  if (cached) return cached;
  const own = db.getKnownUserById(userId);
  const row = own?.auth_provider === 'jellyfin' ? own : db.getLinkedJellyfinRow(userId);
  if (!row) return null;
  return { jfUserId: String(row.user_id).replace(/^jf_/, ''), token: row.jellyfin_token || null };
}

function requireCreds(userId) {
  const creds = client.isEnabled() ? credsFor(userId) : null;
  if (!creds) throw new PartyError('Watching a Jellyfin title together requires a linked Jellyfin account.');
  return creds;
}

// A show is pinned to one episode up front (the host's next up, else the
// first) so every member loads the same item.
async function resolveItem(ratingKey, hostId) {
  const creds = requireCreds(hostId);
  const libItem = db.getLibraryItemByKey(ratingKey);
  const [itemId] = await sessions.resolvePlayableItemIds(ratingKey, creds.jfUserId, { token: creds.token, type: libItem?.type });
  if (!itemId) throw new PartyError('That show has no episodes to play yet.');
  const item = await client.jfFetch(`/Users/${encodeURIComponent(creds.jfUserId)}/Items/${encodeURIComponent(itemId)}`, { token: creds.token })
    .catch(() => null);
  if (!item) throw new PartyError('That title is not available on the Jellyfin server.', 404);
  const episode = item.Type === 'Episode';
  const ownThumb = item.ImageTags?.Primary ? `/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}` : null;
  return {
    ratingKey: String(item.Id),
    title: episode ? (item.SeriesName || item.Name) : item.Name,
    subtitle: episode ? `S${item.ParentIndexNumber}E${item.IndexNumber} · ${item.Name}` : (item.ProductionYear ? String(item.ProductionYear) : null),
    thumb: (episode ? libItem?.thumb : null) || ownThumb || libItem?.thumb || null,
    durationMs: Math.round((Number(item.RunTimeTicks) || 0) / TICKS_PER_MS),
  };
}

async function registerDevice(userId, clientId) {
  const creds = requireCreds(userId);
  const list = await sessions.listControllableSessions(creds.jfUserId, { token: creds.token });
  const session = list.find(s => s.id === String(clientId));
  if (!session) throw new PartyError('That device was not found. Open the Jellyfin app on it and try again.');
  return { clientName: session.name, controlBase: null };
}

async function playerFor(member) {
  const creds = credsFor(member.user_id);
  if (!creds || !member.client_id) return null;
  return { sessionId: member.client_id, jfUserId: creds.jfUserId, token: creds.token, last: null };
}

async function load(party, player, offset) {
  await sessions.playOnSession(player.sessionId, [party.rating_key], {
    startPositionTicks: Math.max(0, Math.round(offset)) * TICKS_PER_MS, token: player.token,
  });
}

const PLAYSTATE = { pause: 'Pause', play: 'Unpause', seekTo: 'Seek' };

async function sendCommand(player, action, { offset } = {}) {
  try {
    await sessions.command(player.sessionId, PLAYSTATE[action], {
      seekPositionTicks: action === 'seekTo' ? Math.round(offset) * TICKS_PER_MS : null, token: player.token,
    });
    return true;
  } catch (e) {
    logger.debug(`watchParty: jellyfin ${action} → ${player.sessionId} failed: ${e.message}`);
    return false;
  }
}

// Position between an app's progress reports is estimated from when the
// reported value last changed, so the sync engine sees a steadily advancing
// clock rather than one that stalls and then leaps (which reads as a seek).
function estimateTime(player, positionMs, paused, now, checkedInAt) {
  if (!player.last) {
    // First sight of this session: the report may already be seconds old.
    const age = now - checkedInAt;
    player.last = { positionMs, paused, at: age > 0 && age < MAX_EXTRAPOLATE_MS ? checkedInAt : now };
  } else if (player.last.positionMs !== positionMs || player.last.paused !== paused) {
    player.last = { positionMs, paused, at: now };
  }
  if (paused) return positionMs;
  return positionMs + Math.min(now - player.last.at, MAX_EXTRAPOLATE_MS);
}

async function pollTimeline(player, now = Date.now()) {
  try {
    const params = new URLSearchParams({ ControllableByUserId: player.jfUserId });
    const list = await client.jfFetch(`/Sessions?${params}`, { token: player.token, timeout: 2500 });
    const session = (Array.isArray(list) ? list : []).find(s => String(s.Id) === player.sessionId);
    if (!session) return null;
    if (!session.NowPlayingItem?.Id) { player.last = null; return { state: 'stopped', time: 0, duration: 0, ratingKey: null }; }
    const paused = !!session.PlayState?.IsPaused;
    const positionMs = Math.round((Number(session.PlayState?.PositionTicks) || 0) / TICKS_PER_MS);
    return {
      state: paused ? 'paused' : 'playing',
      time: estimateTime(player, positionMs, paused, now, Date.parse(session.LastPlaybackCheckIn)),
      duration: Math.round((Number(session.NowPlayingItem.RunTimeTicks) || 0) / TICKS_PER_MS),
      ratingKey: String(session.NowPlayingItem.Id),
    };
  } catch {
    return null;
  }
}

module.exports = {
  appName: 'Jellyfin',
  rememberCreds, resolveItem, registerDevice, playerFor, load, sendCommand, pollTimeline,
};
