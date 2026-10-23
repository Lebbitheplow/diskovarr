// Keeps Diskovarr from relabelling the Plex server on plex.tv.
//
// plex.tv binds every token to one device and copies a request's
// X-Plex-Version / -Platform / -Platform-Version / -Device* headers onto that
// device's record. When the admin token is the Plex server's own token (the
// PlexOnlineToken from its Preferences.xml), Diskovarr's 'Web' / '1.0.0'
// headers overwrite the server's record, and Plex apps then refuse the server
// as too old ("requires 1.41.2 or newer") or show it offline.
//
// install() wraps global fetch. Before the first plex.tv request made with the
// admin token, one probe finds out whether that token is the server's: it
// stamps a marker into the token's device platform version and checks whether
// the server's resource picked it up. If it did, every plex.tv request with
// that token carries the server's real version and platform, read from the
// server itself. Until the probe has an answer, those identity headers are
// stripped instead — plex.tv leaves a field alone when the header is absent.

const crypto = require('crypto');

const IDENTITY_HEADERS = [
  'X-Plex-Version', 'X-Plex-Platform', 'X-Plex-Platform-Version',
  'X-Plex-Device', 'X-Plex-Device-Name', 'X-Plex-Model',
];
const IDENTITY_TTL_MS = 10 * 60 * 1000;
const RETRY_PROBE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

let realFetch = null;
let getToken = () => null;
let getUrl = () => null;
let probeState = null;    // { token, promise, result: { isServer } | null, at }
let identityCache = null; // { token, identity, at }

function isPlexTv(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'plex.tv' || host.endsWith('.plex.tv');
  } catch { return false; }
}

// The server's real identity, from the server itself.
async function serverIdentity(token) {
  if (identityCache && identityCache.token === token && Date.now() - identityCache.at < IDENTITY_TTL_MS) {
    return identityCache.identity;
  }
  const base = getUrl();
  if (!base) return null;
  try {
    const res = await realFetch(`${base}/`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const mc = (await res.json())?.MediaContainer || {};
    if (!mc.machineIdentifier || !mc.version) return null;
    const identity = {
      machineIdentifier: mc.machineIdentifier,
      version: mc.version,
      platform: mc.platform || '',
      platformVersion: mc.platformVersion || '',
    };
    identityCache = { token, identity, at: Date.now() };
    return identity;
  } catch { return null; }
}

function identityHeaders(identity) {
  const h = { 'X-Plex-Version': identity.version };
  if (identity.platform) h['X-Plex-Platform'] = identity.platform;
  if (identity.platformVersion) h['X-Plex-Platform-Version'] = identity.platformVersion;
  return h;
}

// Is `token` the Plex server's own device token? null when it can't be told.
async function probe(token) {
  const identity = await serverIdentity(token);
  if (!identity) return null;
  const marker = `diskovarr-probe-${crypto.randomUUID()}`;
  const plexTv = (path, extra = {}) => realFetch(`https://plex.tv${path}`, {
    headers: { Accept: 'application/json', 'X-Plex-Token': token, 'X-Plex-Client-Identifier': 'diskovarr-app', ...extra },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  try {
    const stamp = await plexTv('/api/v2/user', { 'X-Plex-Platform-Version': marker });
    if (!stamp.ok) return null;
    const res = await plexTv('/api/v2/resources');
    if (!res.ok) return null;
    const resources = await res.json();
    const server = (Array.isArray(resources) ? resources : []).find(r => r.clientIdentifier === identity.machineIdentifier);
    if (!server) return null;
    const isServer = server.platformVersion === marker;
    // Put the server's real values back right away (version included, in case
    // an older Diskovarr already relabelled it).
    if (isServer) {
      await plexTv('/api/v2/user', identityHeaders(identity));
      console.warn('[plexTvIdentity] the admin Plex token is the Plex server\'s own token — plex.tv requests will carry the server\'s real version. Sign in with Plex under Admin → Connections to give Diskovarr its own token.');
    }
    return { isServer };
  } catch { return null; }
}

function probeFor(token) {
  const stale = probeState && probeState.result === null && Date.now() - probeState.at > RETRY_PROBE_MS;
  if (!probeState || probeState.token !== token || stale) {
    const state = { token, result: null, at: Date.now() };
    state.promise = probe(token).then(result => { state.result = result; state.at = Date.now(); return result; });
    probeState = state;
  }
  return probeState.promise;
}

function requestToken(url, headers) {
  const fromHeader = headers.get('X-Plex-Token');
  if (fromHeader) return fromHeader;
  try { return new URL(url).searchParams.get('X-Plex-Token'); } catch { return null; }
}

// Only string/URL inputs are rewritten — Diskovarr never passes Request objects.
async function guardedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
  if (!url || !isPlexTv(url)) return realFetch(input, init);
  const adminToken = getToken();
  const headers = new Headers(init.headers || {});
  if (!adminToken || requestToken(url, headers) !== adminToken) return realFetch(input, init);

  const result = await probeFor(adminToken);
  if (result && !result.isServer) return realFetch(input, init);

  const target = new URL(url);
  for (const name of IDENTITY_HEADERS) {
    headers.delete(name);
    target.searchParams.delete(name);
  }
  if (result?.isServer) {
    const identity = await serverIdentity(adminToken);
    if (identity) for (const [k, v] of Object.entries(identityHeaders(identity))) headers.set(k, v);
  }
  return realFetch(target.href, { ...init, headers });
}

function install(opts = {}) {
  if (realFetch) return guardedFetch;
  realFetch = opts.fetchImpl || globalThis.fetch;
  if (opts.getToken) getToken = opts.getToken;
  if (opts.getUrl) getUrl = opts.getUrl;
  globalThis.fetch = guardedFetch;
  return guardedFetch;
}

function _reset() {
  if (realFetch && globalThis.fetch === guardedFetch) globalThis.fetch = realFetch;
  realFetch = null;
  getToken = () => null;
  getUrl = () => null;
  probeState = null;
  identityCache = null;
}

module.exports = { install, _reset, IDENTITY_HEADERS };
