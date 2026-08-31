const db = require('../../db/database');

// Low-level Jellyfin API client. Mirrors the plex.js/tautulli.js config pattern:
// settings table first, env fallback. All server-to-server calls authenticate
// with the admin API key; user-scoped writes go through /Users/{id}/… which the
// admin key is authorized for.

function getJellyfinUrl() {
  const url = db.getSetting('jellyfin_url', null) || process.env.JELLYFIN_URL || '';
  return url.replace(/\/+$/, '');
}
function getJellyfinKey() {
  return db.getSetting('jellyfin_api_key', null) || process.env.JELLYFIN_API_KEY || '';
}
function isEnabled() {
  return db.getSetting('jellyfin_enabled', '0') === '1' && !!getJellyfinUrl() && !!getJellyfinKey();
}

// Jellyfin requires this header shape on anonymous auth endpoints; on
// authenticated calls the token rides along in X-Emby-Token.
const JF_AUTH_HEADER =
  'MediaBrowser Client="Diskovarr", Device="Diskovarr", DeviceId="diskovarr-app", Version="1.0.0"';

async function jfFetch(path, { method = 'GET', token = null, body = null, timeout = 15000, baseUrl = null, apiKey = null } = {}) {
  const url = `${baseUrl != null ? baseUrl.replace(/\/+$/, '') : getJellyfinUrl()}${path}`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': JF_AUTH_HEADER,
    'X-Emby-Token': token || apiKey || getJellyfinKey(),
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

// Jellyfin web deep link. Uses the configured server URL, so the admin should
// configure the externally reachable one for links to work outside the LAN.
function getDeepLink(itemId) {
  return `${getJellyfinUrl()}/web/index.html#!/details?id=${itemId}`;
}

module.exports = {
  getJellyfinUrl, getJellyfinKey, isEnabled,
  jfFetch, authenticateByName, getUsers, testConnection,
  getAvatarPath, getDeepLink,
};
