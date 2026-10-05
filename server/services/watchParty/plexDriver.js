const db = require('../../db/database');
const plexService = require('../plex');
const plexCast = require('../plexCast');
const logger = require('../logger');
const PartyError = require('./partyError');

// Watch Together driver for Plex players. Players such as Plex for Samsung
// register with the PMS and long-poll it for commands, so sending to the PMS
// with the target header reaches them wherever they are. Players that only
// listen on their own LAN address are reachable when they share the server's
// network — probe() works out which base URL applies.

// Players drop commands whose commandID is not above the last one they saw
// from this controller.
let _commandId = Math.floor(Date.now() / 1000) % 100000;

function headers(token, clientId) {
  return {
    'Accept': 'application/xml',
    'X-Plex-Token': token,
    'X-Plex-Target-Client-Identifier': clientId,
    'X-Plex-Client-Identifier': plexCast.CAST_CLIENT_ID,
    'X-Plex-Product': 'Diskovarr',
    'X-Plex-Device-Name': 'Diskovarr',
  };
}

function pmsBase() {
  return String(plexService.getPlexUrl() || '').replace(/\/$/, '');
}

// player: { base, clientId, token, userToken }
async function request(player, action, params = {}) {
  const qs = new URLSearchParams({ type: 'video', ...params, commandID: String(++_commandId) });
  try {
    const res = await fetch(`${player.base}/player/playback/${action}?${qs}`, {
      headers: headers(player.token, player.clientId),
      // Replies normally take well under a second. A player can act on a
      // command the PMS never answers, so waiting longer only delays the next one.
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) logger.debug(`watchParty: ${action} → ${player.clientId} HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    logger.debug(`watchParty: ${action} → ${player.clientId} failed: ${e.message}`);
    return false;
  }
}

// action: 'pause' | 'play' | 'seekTo' (with offset in ms)
function sendCommand(player, action, { offset } = {}) {
  return request(player, action, action === 'seekTo' ? { offset: String(Math.round(offset)) } : {});
}

function parseTimeline(xml) {
  for (const tag of String(xml).match(/<Timeline\b[^>]*>/g) || []) {
    const attrs = {};
    for (const a of tag.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    if (attrs.type !== 'video') continue;
    return {
      state: attrs.state || 'stopped',
      time: Number(attrs.time) || 0,
      duration: Number(attrs.duration) || 0,
      ratingKey: attrs.ratingKey || null,
    };
  }
  return null;
}

// The player's own view of what it is doing; null when it cannot be reached.
async function pollTimeline(player, timeoutMs = 2500) {
  try {
    const res = await fetch(`${player.base}/player/timeline/poll?wait=0&commandID=${++_commandId}`, {
      headers: headers(player.token, player.clientId),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parseTimeline(await res.text());
  } catch {
    return null;
  }
}

// Whether the player answers through `base`. An idle player has no timeline to
// poll (the PMS answers 400), so this asks for its Companion resources instead.
async function isReachable(player) {
  try {
    const res = await fetch(`${player.base}/resources`, {
      headers: headers(player.token, player.clientId),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok && (await res.text()).includes(`machineIdentifier="${player.clientId}"`);
  } catch {
    return false;
  }
}

// Finds a base URL this server can control the player through: the PMS proxy
// first, then the player's own published addresses. Null = not controllable.
async function probe({ clientId, token, connections = [] }) {
  const bases = [pmsBase(), ...connections.map(c => String(c.uri || '').replace(/\/$/, ''))].filter(Boolean);
  for (const base of [...new Set(bases)]) {
    if (await isReachable({ base, clientId, token })) return base;
  }
  return null;
}

const _creds = new Map(); // userId -> { userToken, serverToken }

// Called on every party request so a member's tokens are on hand when the
// host starts, whether or not that member still has the page open.
function rememberCreds(sessionUser) {
  if (!sessionUser?.id || !sessionUser.token) return;
  _creds.set(String(sessionUser.id), { userToken: sessionUser.token, serverToken: sessionUser.serverToken || sessionUser.token });
}

// After a restart the session-fed cache is empty; rebuild from the stored
// plex.tv token, whose resources list carries the user's token for this PMS.
async function credsFor(userId) {
  const cached = _creds.get(String(userId));
  if (cached) return cached;
  const userToken = db.getKnownUserById(userId)?.plex_token;
  if (!userToken) return null;
  const resources = await plexCast.fetchUserResources(userToken);
  const server = resources.find(r => r.clientIdentifier === plexService.getPlexServerId());
  const creds = { userToken, serverToken: server?.accessToken || userToken };
  _creds.set(String(userId), creds);
  return creds;
}

async function fetchMetadata(path, token) {
  const res = await fetch(`${pmsBase()}${path}`, {
    headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new PartyError('That title is not available on the Plex server.', 404);
  return (await res.json())?.MediaContainer?.Metadata || [];
}

// Everyone must load the same playable item, so a show or season is pinned to
// one episode up front: the host's first unwatched, else the first.
async function resolveItem(ratingKey, hostId) {
  const creds = await credsFor(hostId);
  if (!creds) throw new PartyError('Watching a Plex title together requires a Plex account.');
  let [item] = await fetchMetadata(`/library/metadata/${ratingKey}`, creds.serverToken);
  if (!item) throw new PartyError('That title is not available on the Plex server.', 404);
  if (item.type === 'show' || item.type === 'season') {
    const leaves = await fetchMetadata(`/library/metadata/${ratingKey}/allLeaves`, creds.serverToken);
    // Specials (season 0) sort first but are not where a show starts.
    const regular = leaves.filter(e => Number(e.parentIndex) > 0);
    const episodes = regular.length ? regular : leaves;
    item = episodes.find(e => !e.viewCount) || episodes[0];
    if (!item) throw new PartyError('That show has no episodes to play yet.');
  }
  const episode = item.type === 'episode';
  return {
    ratingKey: String(item.ratingKey),
    title: episode ? item.grandparentTitle : item.title,
    subtitle: episode ? `S${item.parentIndex}E${item.index} · ${item.title}` : (item.year ? String(item.year) : null),
    thumb: (episode ? item.grandparentThumb : item.thumb) || item.thumb || null,
    durationMs: Number(item.duration) || 0,
  };
}

// Proves this server can control the device before a member is marked ready.
async function registerDevice(userId, clientId) {
  const creds = await credsFor(userId);
  if (!creds) throw new PartyError('Watching a Plex title together requires a Plex account.');
  const resources = await plexCast.fetchUserResources(creds.userToken);
  const resource = resources.find(r => r.clientIdentifier === clientId && r.owned === true);
  if (!resource) throw new PartyError('That device was not found. Open the Plex app on it and try again.');
  const base = await probe({ clientId, token: creds.serverToken, connections: resource.connections || [] });
  if (!base) {
    throw new PartyError("Diskovarr can't reach that device to keep it in sync. Make sure the Plex app is open on it; some Plex apps can't be controlled from outside your home.");
  }
  return { clientName: resource.name || clientId, controlBase: base };
}

async function playerFor(member) {
  const creds = await credsFor(member.user_id);
  if (!creds || !member.client_id) return null;
  return { base: member.control_base || pmsBase(), clientId: member.client_id, token: creds.serverToken, userToken: creds.userToken };
}

// Tells the player to start the party's title at `offset` ms. Resolves once the
// command is on its way; the caller watches the timeline for the result.
async function load(party, player, offset) {
  const resources = await plexCast.fetchUserResources(player.userToken);
  const containerKey = await plexCast.createPlayQueue(party.rating_key, player.token);
  const params = plexCast.buildPlayMediaParams({
    ratingKey: party.rating_key, containerKey,
    endpoint: plexCast.resolveServerEndpoint(resources), serverToken: player.token,
  });
  params.offset = String(Math.max(0, Math.round(offset)));
  // Not awaited: through the PMS proxy a playMedia request is never answered
  // even though the player acts on it, so the timeline is the only real signal.
  request(player, 'playMedia', params);
}

module.exports = {
  appName: 'Plex',
  rememberCreds, resolveItem, registerDevice, playerFor, load, sendCommand, pollTimeline,
  parseTimeline, probe, pmsBase,
};
