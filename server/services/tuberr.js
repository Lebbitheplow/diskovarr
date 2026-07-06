const db = require('../db/database');

// Thin client for the Tuberr companion service's /manage API.
// All calls are server-side; the frontend goes through /api and /admin proxies.

async function manageFetch(path, options = {}) {
  const c = db.getConnectionSettings();
  if (!c.tuberrUrl || !c.tuberrApiKey) throw new Error('Tuberr not configured');
  const res = await fetch(`${c.tuberrUrl.replace(/\/$/, '')}/manage${path}`, {
    ...options,
    headers: {
      'X-Api-Key': c.tuberrApiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Tuberr ${path} returned ${res.status}`);
  return body;
}

function health() {
  return manageFetch('/health');
}

// Keeps Tuberr's own config in sync with what the admin saves in Diskovarr
function pushConfig({ sonarrUrl, sonarrApiKey, youtubeApiKey }) {
  return manageFetch('/config', {
    method: 'PUT',
    body: JSON.stringify({ sonarrUrl, sonarrApiKey, youtubeApiKey }),
  });
}

function searchChannels(q) {
  return manageFetch(`/youtube/channels?q=${encodeURIComponent(q)}`, { timeoutMs: 15000 });
}

function createMapping({ tvdbId, title, channelId, channelTitle, playlistIds, sonarrSeriesId }) {
  return manageFetch('/mappings', {
    method: 'POST',
    body: JSON.stringify({ tvdbId, title, channelId, channelTitle, playlistIds, sonarrSeriesId }),
    timeoutMs: 30000,
  });
}

// Rotate Tuberr's management API key end-to-end: ask Tuberr to mint a new key
// (authenticated with the current one), persist it as Diskovarr's tuberr_api_key,
// then re-run the Sonarr wiring so the Torznab indexer carries the new key. If
// Sonarr isn't configured yet the rotation still succeeds — setupSonarr is best
// effort and its outcome is surfaced to the caller.
async function regenerateKey() {
  const { apiKey } = await manageFetch('/regenerate-key', { method: 'POST' });
  if (!apiKey) throw new Error('Tuberr did not return a new key');
  db.setSetting('tuberr_api_key', apiKey);
  let sonarr = null;
  try {
    sonarr = await setupSonarr();
  } catch (e) {
    sonarr = { ok: false, message: e.message };
  }
  return { ok: true, apiKey, sonarr };
}

function isConfigured() {
  const c = db.getConnectionSettings();
  return c.youtubeEnabled && !!c.tuberrUrl && !!c.tuberrApiKey;
}

// One-click Sonarr wiring: registers (or updates) the Tuberr Torznab indexer
// and qBittorrent-compatible download client in Sonarr, both tagged `yt` and
// linked, so YouTube series route exclusively through Tuberr. Idempotent —
// entries are found by name and updated in place.
const SONARR_ENTRY_NAME = 'Tuberr (YouTube)';

async function setupSonarr() {
  const c = db.getConnectionSettings();
  if (!c.sonarrUrl || !c.sonarrApiKey) throw new Error('Sonarr is not configured');
  if (!c.tuberrUrl || !c.tuberrApiKey) throw new Error('Tuberr is not configured');

  const tuberr = new URL(c.tuberrUrl);
  // A loopback Tuberr address only works if Sonarr runs on the same host —
  // otherwise Sonarr can't reach it and the admin must enter a LAN address.
  const sonarrHost = new URL(c.sonarrUrl).hostname;
  const loopback = ['127.0.0.1', 'localhost', '::1'];
  if (loopback.includes(tuberr.hostname) && !loopback.includes(sonarrHost)) {
    throw new Error('Tuberr address is localhost, which Sonarr cannot reach — set the Tuberr address to this machine\'s LAN IP first');
  }

  const sonarrFetch = async (path, options = {}) => {
    const res = await fetch(`${c.sonarrUrl.replace(/\/$/, '')}/api/v3${path}`, {
      ...options,
      headers: { 'X-Api-Key': c.sonarrApiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sonarr ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  };

  // 1. yt tag
  const tags = await sonarrFetch('/tag');
  let ytTag = tags.find(t => t.label === 'yt');
  if (!ytTag) ytTag = await sonarrFetch('/tag', { method: 'POST', body: JSON.stringify({ label: 'yt' }) });

  // 2. download client (qBittorrent-compatible)
  const clientBody = {
    enable: true, protocol: 'torrent', priority: 1,
    removeCompletedDownloads: true, removeFailedDownloads: true,
    name: SONARR_ENTRY_NAME,
    implementation: 'QBittorrent', configContract: 'QBittorrentSettings',
    tags: [ytTag.id],
    fields: [
      { name: 'host', value: tuberr.hostname },
      { name: 'port', value: Number(tuberr.port) || 9832 },
      { name: 'useSsl', value: tuberr.protocol === 'https:' },
      { name: 'urlBase', value: '' },
      { name: 'username', value: 'tuberr' },
      { name: 'password', value: 'tuberr' },
      { name: 'tvCategory', value: 'tv-youtube' },
      { name: 'recentTvPriority', value: 0 },
      { name: 'olderTvPriority', value: 0 },
      { name: 'initialState', value: 0 },
      { name: 'sequentialOrder', value: false },
      { name: 'firstAndLast', value: false },
    ],
  };
  const clients = await sonarrFetch('/downloadclient');
  const existingClient = clients.find(x => x.name === SONARR_ENTRY_NAME);
  const client = existingClient
    ? await sonarrFetch(`/downloadclient/${existingClient.id}`, { method: 'PUT', body: JSON.stringify({ ...clientBody, id: existingClient.id }) })
    : await sonarrFetch('/downloadclient', { method: 'POST', body: JSON.stringify(clientBody) });

  // 3. Torznab indexer, pinned to the download client
  const indexerBody = {
    enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true,
    name: SONARR_ENTRY_NAME, protocol: 'torrent', priority: 25,
    implementation: 'Torznab', configContract: 'TorznabSettings',
    downloadClientId: client.id,
    tags: [ytTag.id],
    fields: [
      { name: 'baseUrl', value: `${c.tuberrUrl.replace(/\/$/, '')}/torznab` },
      { name: 'apiPath', value: '/api' },
      { name: 'apiKey', value: c.tuberrApiKey },
      { name: 'categories', value: [5000] },
      { name: 'animeCategories', value: [] },
      { name: 'minimumSeeders', value: 1 },
    ],
  };
  const indexers = await sonarrFetch('/indexer');
  const existingIndexer = indexers.find(x => x.name === SONARR_ENTRY_NAME);
  if (existingIndexer) {
    await sonarrFetch(`/indexer/${existingIndexer.id}`, { method: 'PUT', body: JSON.stringify({ ...indexerBody, id: existingIndexer.id }) });
  } else {
    await sonarrFetch('/indexer', { method: 'POST', body: JSON.stringify(indexerBody) });
  }

  return {
    ok: true,
    updated: !!(existingClient || existingIndexer),
    message: `Sonarr wired up: '${SONARR_ENTRY_NAME}' indexer + download client (tag 'yt', category tv-youtube)`,
  };
}

module.exports = { manageFetch, health, pushConfig, searchChannels, createMapping, isConfigured, setupSonarr, regenerateKey };
