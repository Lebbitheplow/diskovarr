const plexService = require('./plex');
const logger = require('./logger');

// Client identifier for the whole cast path (prepare payload, server fallback,
// browser delivery). Players correlate controllers by this value, so the
// browser and server must present the same one.
const CAST_CLIENT_ID = 'DISKOVARR';

// plex.tv resources are needed twice per cast (player lookup + PMS endpoint)
// and again on retries; a short per-token cache keeps retries snappy without
// serving stale connection info for long.
const _resourcesCache = new Map(); // userToken -> { resources, at }
const RESOURCES_CACHE_TTL = 60 * 1000;

async function fetchUserResources(userToken) {
  const cached = _resourcesCache.get(userToken);
  if (cached && Date.now() - cached.at < RESOURCES_CACHE_TTL) return cached.resources;
  const res = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1', {
    headers: {
      'X-Plex-Token': userToken,
      'X-Plex-Client-Identifier': CAST_CLIENT_ID,
      'X-Plex-Product': 'Diskovarr',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`plex.tv resources error ${res.status}`);
  const resources = await res.json().catch(() => []);
  const list = Array.isArray(resources) ? resources : [];
  _resourcesCache.set(userToken, { resources: list, at: Date.now() });
  return list;
}

// Connection candidates for the *browser* to try, best first. The user's
// browser sits on the same LAN as their player, so local https plex.direct
// URIs are the happy path; plain http goes last because an https page will
// mixed-content-block it (the frontend filters those out itself).
function resolvePlayerConnections(resources, clientId) {
  const r = resources.find(x => x.clientIdentifier === clientId && x.owned === true);
  if (!r || !Array.isArray(r.connections) || !r.connections.length) return null;
  const score = (c) => {
    if (!(c.uri || '').startsWith('https')) return 3;
    if (c.relay) return 2;
    return c.local ? 0 : 1;
  };
  const connections = r.connections
    .filter(c => c.uri)
    .sort((a, b) => score(a) - score(b))
    .map(c => ({ uri: c.uri, local: !!c.local, relay: !!c.relay }));
  return { name: r.name || clientId, product: r.product || '', connections };
}

// Order for *server-side* delivery (the fallback path): relay would work from
// anywhere if a player ever had one, local URIs work when the player is on the
// server's LAN. Mirrors the pre-rework sort.
function sortForServerDelivery(connections) {
  return [...connections].sort((a, b) => (b.relay ? 1 : 0) - (a.relay ? 1 : 0));
}

// Address the *player* should pull media from. A remote user's player cannot
// reach the LAN PLEX_URL, so prefer the PMS's remote plex.direct connection,
// then its local plex.direct one, and only fall back to PLEX_URL if plex.tv
// gave us nothing (same-LAN setups keep working offline). IPv6 entries are
// skipped — PMSes commonly publish ULA (fd00::/8) addresses there that are
// not reachable from other networks. The address handed to the player is the
// plex.direct *hostname* from the connection URI, not the bare IP, so the
// player's HTTPS connection validates against Plex's wildcard certs.
function resolveServerEndpoint(resources) {
  const serverId = plexService.getPlexServerId();
  const r = resources.find(x => x.clientIdentifier === serverId);
  const conns = (r && Array.isArray(r.connections))
    ? r.connections.filter(c => c.uri && !c.relay && !c.IPv6 && c.uri.startsWith('https'))
    : [];
  const lanHost = (() => { try { return new URL(plexService.getPlexUrl()).hostname; } catch { return null; } })();
  const conn = conns.find(c => !c.local)
    || conns.find(c => c.local && c.address === lanHost)
    || conns.find(c => c.local);
  if (conn) {
    const u = new URL(conn.uri);
    return { address: u.hostname, port: u.port || '32400', protocol: 'https' };
  }
  const u = new URL(plexService.getPlexUrl());
  return { address: u.hostname, port: u.port || '32400', protocol: u.protocol.replace(':', '') };
}

async function createPlayQueue(ratingKey, token) {
  const plexUrl = plexService.getPlexUrl();
  const serverId = plexService.getPlexServerId();
  try {
    const pqParams = new URLSearchParams({
      type: 'video',
      uri: `server://${serverId}/com.plexapp.plugins.library/library/metadata/${ratingKey}`,
      shuffle: '0', repeat: '0', continuous: '0', own: '1', includeChapters: '1',
    });
    const pqRes = await fetch(`${plexUrl}/playQueues?${pqParams}`, {
      method: 'POST',
      headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': CAST_CLIENT_ID, 'Accept': 'application/xml' },
      signal: AbortSignal.timeout(8000),
    });
    if (pqRes.ok) {
      const pqXml = await pqRes.text();
      const m = pqXml.match(/playQueueID="(\d+)"/);
      if (m) return `/playQueues/${m[1]}?window=200&own=1`;
    }
  } catch (e) {
    logger.debug('plexCast: PlayQueue creation failed, continuing without:', e.message);
  }
  return null;
}

// The `token` here is the user's OWN access token for this PMS — the prepare
// payload hands it to that same user's browser, exactly as app.plex.tv holds
// the user's token client-side. The admin PLEX_TOKEN must never enter this
// object; callers only pass session tokens.
function buildPlayMediaParams({ ratingKey, containerKey, endpoint, serverToken }) {
  const params = {
    key: `/library/metadata/${ratingKey}`,
    ratingKey: String(ratingKey),
    machineIdentifier: plexService.getPlexServerId(),
    address: endpoint.address,
    port: endpoint.port,
    protocol: endpoint.protocol,
    offset: '0',
    type: 'video',
    token: serverToken,
  };
  if (containerKey) params.containerKey = containerKey;
  return params;
}

// Server-side delivery for the fallback route. Only reaches players on the
// server's LAN (or the rare player with a relay connection).
async function sendPlayMediaFromServer({ connections, clientId, params, userToken }) {
  let lastStatus = null;
  for (const c of sortForServerDelivery(connections)) {
    const qs = new URLSearchParams({ ...params, commandID: '1' });
    const castUrl = `${c.uri}/player/playback/playMedia?${qs}`;
    try {
      const r = await fetch(castUrl, {
        headers: {
          'Accept': 'application/json',
          'X-Plex-Token': userToken,
          'X-Plex-Target-Client-Identifier': clientId,
          'X-Plex-Client-Identifier': CAST_CLIENT_ID,
        },
        signal: AbortSignal.timeout(5000),
      });
      logger.debug(`plexCast: server delivery ${c.uri} → ${r.status}`);
      if (r.ok) return { ok: true };
      lastStatus = r.status;
    } catch (e) {
      logger.debug(`plexCast: server delivery ${c.uri} failed:`, e.message);
    }
  }
  return { ok: false, status: lastStatus };
}

// User-facing message for transport-level failures — raw undici text like
// "The operation was aborted due to timeout" must never reach a toast.
function friendlyCastError(err) {
  const msg = err?.message || '';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out/i.test(msg)) {
    return 'Timed out reaching the player. Make sure the Plex app is open on the device.';
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|fetch failed/i.test(msg)) {
    return 'Could not connect to the player. Make sure the Plex app is open on the device.';
  }
  return 'Cast failed. Make sure the Plex app is open on the device and try again.';
}

module.exports = {
  CAST_CLIENT_ID,
  fetchUserResources,
  resolvePlayerConnections,
  sortForServerDelivery,
  resolveServerEndpoint,
  createPlayQueue,
  buildPlayMediaParams,
  sendPlayMediaFromServer,
  friendlyCastError,
};
