// Watch Together: a host and their invitees play one title in sync, each on
// their own Plex or Jellyfin player. This module owns the party lifecycle and
// the runtime loop; the decisions are in syncEngine.js and the wire calls in
// the per-server drivers.
// No video passes through Diskovarr, and once a party is playing nobody needs
// the page open — pause/seek on any member's own remote is picked up here.
const db = require('../../db/database');
const engine = require('./syncEngine');
const PartyError = require('./partyError');
const logger = require('../logger');
const libraryAccess = require('../libraryAccess');
const { RESTRICTED_MESSAGE } = require('../requestPolicy');
const { enqueueForUser } = require('../notificationAgents');

// A party lives on one media server; its driver knows how to load, command and
// observe that server's players.
const DRIVERS = { plex: require('./plexDriver'), jellyfin: require('./jellyfinDriver') };

const TICK_MS = 1000;
const LOAD_TIMEOUT_MS = 30000;
const LOG_LIMIT = 30;
const SEND_GAP_MS = 300;

const _live = new Map(); // partyId -> runtime (see startParty)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function rememberCreds(sessionUser) {
  for (const driver of Object.values(DRIVERS)) driver.rememberCreds(sessionUser);
}

// The library row for a key, or null (episodes, unknown ids). Jellyfin ids
// arrive with or without dashes; rows hold the 32-hex form.
function libraryRow(key) {
  const k = String(key);
  return db.getLibraryItemByKey(k) || (/[A-F-]/.test(k) ? db.getLibraryItemByKey(k.toLowerCase().replace(/-/g, '')) : null);
}

// Jellyfin item ids are GUIDs; anything numeric that the library does not
// place on Jellyfin is a Plex rating key.
function sourceOf(ratingKey) {
  const libItem = libraryRow(ratingKey);
  if (libItem) return (libItem.source || 'plex') === 'jellyfin' ? 'jellyfin' : 'plex';
  return /^\d+$/.test(String(ratingKey)) ? 'plex' : 'jellyfin';
}

function displayName(userId) {
  return db.getKnownUserById(userId)?.username || 'Someone';
}

// Whether a user may watch the party's title: the library row the host
// started from (Plex sharing / Jellyfin policy). `access` defaults to the
// user's own. Parties from before the row was stored check their own key; a
// key that isn't a library row (an episode) can't be placed in a section, so
// only unrestricted users may watch it.
function canWatch(party, userId, access = libraryAccess.forUser(userId)) {
  if (party.section_id) {
    return libraryAccess.allows(access, { sectionId: party.section_id, ratingKey: party.library_key, source: party.source });
  }
  if (access === null) return true;
  const row = libraryRow(party.library_key || party.rating_key);
  return !!row && libraryAccess.allows(access, row);
}

function requireAccess(party, userId, access) {
  if (!canWatch(party, userId, access)) throw new PartyError(RESTRICTED_MESSAGE, 403);
}

// Invites each new guest once. Users who can't access the title are left out
// and returned in `skipped` ({ userId, username }) so the host can be told.
function invite(party, userIds) {
  const host = displayName(party.host_id);
  const skipped = [];
  for (const userId of [...new Set((userIds || []).map(String))]) {
    if (userId === party.host_id || !db.getKnownUserById(userId)) continue;
    if (!db.getWatchPartyMember(party.id, userId) && !canWatch(party, userId)) {
      skipped.push({ userId, username: displayName(userId) });
      continue;
    }
    if (!db.addWatchPartyMember(party.id, userId)) continue;
    const title = `${host} invited you to watch ${party.title}`;
    const body = 'Open the invite, pick the TV you are watching on, and the host will start everyone together.';
    const data = { partyId: party.id, thumb: party.thumb };
    const notifId = db.createOrBundleNotification({
      userId, type: 'watch_party_invite', title, body, data, bundleKey: `watch_party_invite:${party.id}:${userId}`,
    });
    enqueueForUser({ notificationId: notifId, userId, payload: { type: 'watch_party_invite', title, body, userId } });
  }
  return { skipped };
}

// `access` is the host's (req.libraryAccess; defaults to forUser(hostId)): a
// title in a library they can't access is refused. So is a key that isn't a
// library row, for a restricted host: an episode or unknown id can't be placed
// in a section, and a Jellyfin party may load on the admin key. The UI only
// starts parties from library rows. Resolves { party, skipped }.
async function createParty({ hostId, ratingKey, userIds, access = libraryAccess.forUser(hostId) }) {
  const libItem = libraryRow(ratingKey);
  if (libItem ? !libraryAccess.allows(access, libItem) : access !== null) throw new PartyError(RESTRICTED_MESSAGE, 403);
  const source = sourceOf(ratingKey);
  const item = await DRIVERS[source].resolveItem(String(libItem?.ratingKey ?? ratingKey), hostId);
  const party = db.createWatchParty({
    hostId, source, ...item, libraryKey: libItem?.ratingKey ?? String(ratingKey), sectionId: libItem?.sectionId ?? null,
  });
  const { skipped } = invite(party, userIds);
  return { party, skipped };
}

// Registers the player a member will watch on, after the driver has proved
// this server can actually control it. A member who lost access to the title
// since the invite is refused (`access` defaults to their own).
async function setDevice(party, userId, clientId, access = undefined) {
  if (party.status === 'ended') throw new PartyError('This party has ended.');
  requireAccess(party, userId, access);
  const device = await DRIVERS[party.source].registerDevice(userId, clientId);
  db.setWatchPartyMemberDevice(party.id, userId, { clientId, ...device });
}

// Starts the title on one player at `offset` and waits until it is really
// playing. Leaves it paused when asked, so a group can be released together.
async function loadPlayer(party, driver, player, offset, { pause }) {
  // Already on the title (a re-run, or someone who started early): reloading
  // would look "playing" before the new load lands, so reposition instead.
  const before = await driver.pollTimeline(player);
  if (before && before.ratingKey === party.rating_key && before.state !== 'stopped') {
    await driver.sendCommand(player, pause ? 'pause' : 'play');
    await driver.sendCommand(player, 'seekTo', { offset });
    return true;
  }
  await driver.load(party, player, offset);
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    const t = await driver.pollTimeline(player);
    if (t && t.ratingKey === party.rating_key && t.state === 'playing') {
      if (pause) await driver.sendCommand(player, 'pause');
      return true;
    }
  }
  return false;
}

function logEvent(rt, text) {
  rt.log.unshift({ at: Date.now(), text });
  rt.log.length = Math.min(rt.log.length, LOG_LIMIT);
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

function describe(event) {
  const who = event.userId ? displayName(event.userId) : '';
  switch (event.type) {
    case 'pause': return `${who} paused`;
    case 'play': return `${who} resumed`;
    case 'seek': return `${who} jumped to ${fmt(event.offset)}`;
    case 'hold': return `Held ${who} for ${(event.ms / 1000).toFixed(1)}s to resync`;
    case 'left': return `${who} stopped watching`;
    case 'unsynced': return `${who}'s player is not responding to sync`;
    default: return null;
  }
}

// Players often act on a command without the server ever answering it, so
// nothing time-sensitive waits on the reply — only long enough to keep one
// player's commands in order.
function sendPromptly(driver, player, action, opts) {
  const sent = driver.sendCommand(player, action, opts).catch(() => false);
  return Promise.race([sent, sleep(SEND_GAP_MS)]);
}

// One player gets its commands in order; different players run in parallel.
function dispatch(partyId, rt, commands) {
  const byUser = new Map();
  for (const c of commands) byUser.set(c.userId, [...(byUser.get(c.userId) || []), c]);
  for (const [userId, list] of byUser) {
    const player = rt.players.get(userId);
    if (!player) continue;
    (async () => {
      for (const c of list) {
        // The hold clock starts when the pause is sent, not when it is answered.
        if (c.holdMs) {
          clearTimeout(rt.holdTimers.get(userId));
          rt.holdTimers.set(userId, setTimeout(() => {
            if (_live.get(partyId) === rt) dispatch(partyId, rt, engine.releaseHold(rt.state, userId, Date.now()));
          }, c.holdMs));
        }
        await sendPromptly(rt.driver, player, c.action, { offset: c.offset });
      }
    })().catch(err => logger.debug('watchParty: dispatch failed:', err.message));
  }
}

async function tickParty(partyId) {
  const rt = _live.get(partyId);
  if (!rt || rt.ticking) return;
  rt.ticking = true;
  try {
    const observations = new Map();
    await Promise.all(engine.activeMembers(rt.state).map(async (m) => {
      const t = await rt.driver.pollTimeline(rt.players.get(m.userId));
      const watching = t && t.ratingKey === rt.ratingKey && t.state !== 'stopped';
      observations.set(m.userId, watching ? { state: t.state, time: t.time } : null);
    }));
    if (_live.get(partyId) !== rt) return;
    const { commands, events } = engine.tick(rt.state, observations, Date.now());
    for (const e of events) {
      const text = describe(e);
      if (text) logEvent(rt, text);
    }
    dispatch(partyId, rt, commands);
    if (events.some(e => e.type === 'ended')) endParty(partyId);
  } catch (err) {
    logger.warn('watchParty: tick failed:', err.message);
  } finally {
    rt.ticking = false;
  }
}

async function startParty(party) {
  if (party.status !== 'lobby') throw new PartyError('This party has already started.');
  const picked = db.getWatchPartyMembers(party.id).filter(m => m.status === 'ready');
  if (!picked.some(m => m.user_id === party.host_id)) throw new PartyError('Pick the TV you are watching on first.');
  // Access is re-checked: a member may have lost the share since picking a TV
  requireAccess(party, party.host_id);
  const ready = picked.filter(m => m.user_id === party.host_id || canWatch(party, m.user_id));
  const driver = DRIVERS[party.source];
  db.setWatchPartyStatus(party.id, 'starting');
  try {
    const players = new Map();
    await Promise.all(ready.map(async (m) => {
      try {
        const player = await driver.playerFor(m);
        if (player && await loadPlayer(party, driver, player, 0, { pause: true })) players.set(m.user_id, player);
      } catch (err) {
        logger.warn(`watchParty: could not start ${m.user_id}:`, err.message);
      }
    }));
    if (!players.size) throw new PartyError(`None of the TVs started playing. Make sure the ${driver.appName} app is open on each one.`, 502);

    const rt = {
      driver, ratingKey: party.rating_key, players, holdTimers: new Map(), log: [], ticking: false,
      state: engine.createState({ hostId: party.host_id, desired: 'playing' }),
    };
    await Promise.all([...players.values()].map(p => sendPromptly(driver, p, 'play')));
    const now = Date.now();
    for (const userId of players.keys()) engine.addMember(rt.state, userId, now, { commanded: 'playing' });
    const missed = ready.filter(m => !players.has(m.user_id)).map(m => displayName(m.user_id));
    logEvent(rt, `Started on ${players.size} ${players.size === 1 ? 'TV' : 'TVs'}`);
    if (missed.length) logEvent(rt, `Could not start: ${missed.join(', ')}`);
    rt.timer = setInterval(() => tickParty(party.id), TICK_MS);
    _live.set(party.id, rt);
    db.setWatchPartyStatus(party.id, 'playing');
  } catch (err) {
    db.setWatchPartyStatus(party.id, 'lobby');
    throw err;
  }
}

// A member who missed the start (or dropped out) jumps in at the party's spot
// (if they can still access the title; `access` defaults to their own).
async function joinPlaying(party, userId, access = undefined) {
  const rt = _live.get(party.id);
  if (!rt) throw new PartyError('This party is not playing.');
  requireAccess(party, userId, access);
  const member = db.getWatchPartyMember(party.id, userId);
  const player = member && await rt.driver.playerFor(member);
  if (!player) throw new PartyError('Pick the TV you are watching on first.');
  const paused = rt.state.desired === 'paused';
  engine.dropMember(rt.state, userId);
  if (!await loadPlayer(party, rt.driver, player, engine.partyPosition(rt.state, Date.now()), { pause: paused })) {
    throw new PartyError(`That TV did not start playing. Make sure the ${rt.driver.appName} app is open on it.`, 502);
  }
  if (_live.get(party.id) !== rt) return;
  rt.players.set(String(userId), player);
  engine.addMember(rt.state, userId, Date.now(), { commanded: rt.state.desired });
  logEvent(rt, `${displayName(userId)} joined`);
}

function control(party, userId, action) {
  const rt = _live.get(party.id);
  if (!rt) throw new PartyError('This party is not playing.');
  const commands = engine.userCommand(rt.state, action, Date.now());
  if (commands.length) logEvent(rt, `${displayName(userId)} ${action === 'pause' ? 'paused' : 'resumed'} from Diskovarr`);
  dispatch(party.id, rt, commands);
}

// Ending only stops the syncing; whatever is on each TV keeps playing.
function endParty(partyId) {
  const rt = _live.get(partyId);
  if (rt) {
    clearInterval(rt.timer);
    for (const timer of rt.holdTimers.values()) clearTimeout(timer);
    _live.delete(partyId);
  }
  db.setWatchPartyStatus(partyId, 'ended');
}

function snapshot(party, viewerId) {
  const rt = _live.get(party.id);
  const now = Date.now();
  const position = rt ? engine.partyPosition(rt.state, now) : 0;
  const members = db.getWatchPartyMembers(party.id).map(m => {
    const live = rt?.state.members.get(m.user_id);
    return {
      userId: m.user_id,
      username: m.username || m.user_id,
      avatar: m.thumb || null,
      role: m.role,
      status: m.status,
      deviceName: m.client_name || null,
      playback: live ? {
        active: live.active,
        state: live.hold ? 'syncing' : (live.obs?.state || (live.active ? 'waiting' : 'left')),
        time: live.obs?.time ?? null,
        offsetMs: live.obs && !live.hold ? Math.round(live.obs.time - position) : null,
        unsynced: live.unsynced,
      } : null,
    };
  });
  return {
    id: party.id,
    source: party.source,
    status: party.status,
    isHost: String(viewerId) === party.host_id,
    hostId: party.host_id,
    ratingKey: party.rating_key,
    title: party.title,
    subtitle: party.subtitle,
    thumb: party.thumb,
    durationMs: party.duration_ms,
    members,
    playback: rt ? { state: rt.state.desired, position: Math.round(position) } : null,
    log: rt ? rt.log : [],
  };
}

function init() {
  db.closeStaleWatchParties();
}

module.exports = {
  PartyError, rememberCreds, createParty, invite, setDevice, startParty, joinPlaying, control, endParty, snapshot, init,
};
