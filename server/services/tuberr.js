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

function isConfigured() {
  const c = db.getConnectionSettings();
  return c.youtubeEnabled && !!c.tuberrUrl && !!c.tuberrApiKey;
}

module.exports = { manageFetch, health, pushConfig, searchChannels, createMapping, isConfigured };
