const { getSetting } = require('../db');

async function sonarrFetch(path, options = {}) {
  const url = getSetting('sonarr_url');
  const apiKey = getSetting('sonarr_api_key');
  if (!url || !apiKey) throw new Error('Sonarr not configured in Tuberr');
  const res = await fetch(`${url}/api/v3${path}`, {
    ...options,
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sonarr ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getSeriesByTvdbId(tvdbId) {
  const list = await sonarrFetch(`/series?tvdbId=${Number(tvdbId)}`);
  return Array.isArray(list) && list.length ? list[0] : null;
}

function getEpisodes(seriesId) {
  return sonarrFetch(`/episode?seriesId=${Number(seriesId)}`);
}

async function ensureTag(label) {
  const tags = await sonarrFetch('/tag');
  const existing = tags.find(t => t.label === label);
  if (existing) return existing.id;
  const created = await sonarrFetch('/tag', { method: 'POST', body: JSON.stringify({ label }) });
  return created.id;
}

function episodeSearch(episodeIds) {
  return sonarrFetch('/command', {
    method: 'POST',
    body: JSON.stringify({ name: 'EpisodeSearch', episodeIds }),
  });
}

function systemStatus() {
  return sonarrFetch('/system/status');
}

module.exports = { sonarrFetch, getSeriesByTvdbId, getEpisodes, ensureTag, episodeSearch, systemStatus };
