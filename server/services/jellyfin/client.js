const db = require('../../db/database');

// Low-level Jellyfin API client. Mirrors the plex.js/tautulli.js config pattern:
// settings table first, env fallback. All server-to-server calls authenticate
// with the admin API key; user-scoped writes go through /Users/{id}/… which the
// admin key is authorized for.

function getJellyfinUrl() {
  const url = db.getSetting('jellyfin_url', null) || process.env.JELLYFIN_URL || '';
  return url.replace(/\/+$/, '');
}
function getJellyfinExternalUrl() {
  const url = db.getSetting('jellyfin_external_url', null) || process.env.JELLYFIN_EXTERNAL_URL || '';
  return url.replace(/\/+$/, '');
}
function getJellyfinKey() {
  return db.getSetting('jellyfin_api_key', null) || process.env.JELLYFIN_API_KEY || '';
}
function isEnabled() {
  if (!getJellyfinUrl() || !getJellyfinKey()) return false;
  const flag = db.getSetting('jellyfin_enabled', null);
  // Never toggled in the admin UI: env-only deployments (JELLYFIN_URL +
  // JELLYFIN_API_KEY in docker-compose) count as enabled, matching the docs.
  if (flag === null) return !!(process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY);
  return flag === '1';
}

// Jellyfin requires this header shape on anonymous auth endpoints; on
// authenticated calls use the Token parameter accepted by current Jellyfin.
const JF_AUTH_HEADER =
  'MediaBrowser Client="Diskovarr", Device="Diskovarr", DeviceId="diskovarr-app", Version="1.0.0"';

function getJellyfinAuthorization(token = getJellyfinKey()) {
  return `${JF_AUTH_HEADER}, Token="${token}"`;
}

async function jfFetch(path, { method = 'GET', token = null, body = null, timeout = 15000, baseUrl = null, apiKey = null } = {}) {
  const url = `${baseUrl != null ? baseUrl.replace(/\/+$/, '') : getJellyfinUrl()}${path}`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': getJellyfinAuthorization(token || apiKey || getJellyfinKey()),
  };
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Jellyfin API error ${res.status} for ${path}`);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

// Username/password login against the configured Jellyfin server. Jellyfin has
// no central account service or OAuth — auth is always server-local.
async function authenticateByName(username, password) {
  const res = await fetch(`${getJellyfinUrl()}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': JF_AUTH_HEADER,
    },
    body: JSON.stringify({ Username: String(username), Pw: String(password ?? '') }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) return null; // bad credentials
  if (!res.ok) throw new Error(`Jellyfin auth error ${res.status}`);
  const data = await res.json();
  if (!data?.User?.Id || !data?.AccessToken) return null;
  return {
    userId: String(data.User.Id),
    name: data.User.Name || username,
    primaryImageTag: data.User.PrimaryImageTag || null,
    isAdmin: !!data.User.Policy?.IsAdministrator,
    accessToken: data.AccessToken,
    policy: policySummary(data.User.Policy),
  };
}

const guidN = (id) => String(id || '').toLowerCase().replace(/-/g, '');

// The parts of a Jellyfin UserPolicy that decide what the user may see —
// library folders and parental controls — for services/libraryAccess. Folder
// ids are normalized to Jellyfin's 32-hex "N" form; lists are sorted so two
// summaries of the same policy compare equal as JSON.
function policySummary(p) {
  if (!p) return null;
  const ids = (arr) => (Array.isArray(arr) ? arr : []).map(guidN).filter(Boolean).sort();
  const strs = (arr) => (Array.isArray(arr) ? arr : []).map(String).sort();
  return {
    isAdministrator: !!p.IsAdministrator,
    isDisabled: !!p.IsDisabled,
    enableAllFolders: !!p.EnableAllFolders,
    enabledFolders: ids(p.EnabledFolders),
    blockedMediaFolders: ids(p.BlockedMediaFolders),
    maxParentalRating: p.MaxParentalRating ?? null,
    maxParentalSubRating: p.MaxParentalSubRating ?? null,
    blockUnratedItems: strs(p.BlockUnratedItems),
    blockedTags: strs(p.BlockedTags),
    allowedTags: strs(p.AllowedTags),
  };
}

async function getUsers() {
  const users = await jfFetch('/Users');
  return (users || []).map(u => ({
    id: String(u.Id),
    name: u.Name,
    primaryImageTag: u.PrimaryImageTag || null,
    isAdmin: !!u.Policy?.IsAdministrator,
    isDisabled: !!u.Policy?.IsDisabled,
    policy: policySummary(u.Policy),
  }));
}

async function testConnection(url, apiKey) {
  const info = await jfFetch('/System/Info', { baseUrl: url, apiKey, timeout: 8000 });
  return { serverName: info?.ServerName || 'Jellyfin', version: info?.Version || '?' };
}

// Relative proxy path served by GET /api/jellyfin/avatar/:jfUserId — keeps the
// Jellyfin origin (often LAN-only) out of the browser, matching the poster proxy.
function getAvatarPath(jfGuid, primaryImageTag) {
  if (!primaryImageTag) return null;
  return `/api/jellyfin/avatar/${jfGuid}?tag=${encodeURIComponent(primaryImageTag)}`;
}

// Browser links use the separate external URL. Never expose a Docker-only API
// address to users; without a browser URL, no Play link is available.
function getDeepLink(itemId) {
  const url = getJellyfinExternalUrl();
  return url ? `${url}/web/index.html#!/details?id=${itemId}` : null;
}

module.exports = {
  getJellyfinUrl, getJellyfinExternalUrl, getJellyfinKey, getJellyfinAuthorization, isEnabled,
  jfFetch, authenticateByName, getUsers, policySummary, testConnection,
  getAvatarPath, getDeepLink,
};
