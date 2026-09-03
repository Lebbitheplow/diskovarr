const { getSetting } = require('../db');

function isConfigured() {
  return !!(getSetting('sonarr_url') && getSetting('sonarr_api_key'));
}

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
  // DELETE and some commands answer 200/204 with an empty body
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getSeriesByTvdbId(tvdbId) {
  const list = await sonarrFetch(`/series?tvdbId=${Number(tvdbId)}`);
  return Array.isArray(list) && list.length ? list[0] : null;
}

function getEpisodes(seriesId) {
  return sonarrFetch(`/episode?seriesId=${Number(seriesId)}`);
}

function getEpisode(episodeId) {
  return sonarrFetch(`/episode/${Number(episodeId)}`);
}

// Series carrying a given tag label (e.g. 'yt') — used to discover shows the
// admin tagged directly in Sonarr without going through Diskovarr's request flow
async function seriesWithTag(label) {
  const tags = await sonarrFetch('/tag');
  const tag = tags.find(t => t.label === label);
  if (!tag) return [];
  const all = await sonarrFetch('/series');
  return all.filter(s => (s.tags || []).includes(tag.id));
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

// Asks Sonarr to re-pull the series from TVDB (new episodes show up sooner
// than its own 12h cycle). Costly for Sonarr — callers rate-limit per series.
function refreshSeries(seriesId) {
  return sonarrFetch('/command', {
    method: 'POST',
    body: JSON.stringify({ name: 'RefreshSeries', seriesId: Number(seriesId) }),
  });
}

function monitorEpisodes(episodeIds, monitored) {
  return sonarrFetch('/episode/monitor', {
    method: 'PUT',
    body: JSON.stringify({ episodeIds: episodeIds.map(Number), monitored: !!monitored }),
  });
}

// History rows for one download client id (our fake infohash). Sonarr stores
// the id uppercased; pass whichever case you have and both are tried.
async function historyForDownload(infoHash) {
  const hash = String(infoHash || '');
  const seen = new Set();
  for (const id of [hash.toUpperCase(), hash.toLowerCase()]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const data = await sonarrFetch(`/history?pageSize=50&downloadId=${encodeURIComponent(id)}`);
    const records = Array.isArray(data) ? data : (Array.isArray(data?.records) ? data.records : []);
    if (records.length) return records;
  }
  return [];
}

function systemStatus() {
  return sonarrFetch('/system/status');
}

// Best-effort blocklist cleanup after an episode is "un-broken" (cookies fixed,
// manual match set): removes entries whose sourceTitle starts with any of the
// given Series.SxxExx prefixes and ends with -TUBERR, so Sonarr will accept
// the same release title again. Returns the number of entries removed.
function normalizeTitle(text) {
  return String(text || '').toLowerCase().replace(/[.\s_]+/g, ' ').trim();
}

async function clearBlocklistFor(prefixes) {
  const wanted = (prefixes || []).map(normalizeTitle).filter(Boolean);
  if (wanted.length === 0) return 0;
  const data = await sonarrFetch('/blocklist?pageSize=500');
  const records = Array.isArray(data?.records) ? data.records : [];
  let removed = 0;
  for (const r of records) {
    const title = normalizeTitle(r.sourceTitle);
    if (!title.endsWith('-tuberr')) continue;
    if (!wanted.some(p => title === p || title.startsWith(p + ' '))) continue;
    try {
      await sonarrFetch(`/blocklist/${r.id}`, { method: 'DELETE' });
      removed++;
      console.log(`[sonarr] removed blocklist entry ${r.id} "${r.sourceTitle}"`);
    } catch (e) {
      console.error(`[sonarr] blocklist delete ${r.id} failed: ${e.message}`);
    }
  }
  return removed;
}

module.exports = {
  sonarrFetch, isConfigured, getSeriesByTvdbId, getEpisodes, getEpisode, ensureTag, episodeSearch,
  refreshSeries, monitorEpisodes, historyForDownload, systemStatus, seriesWithTag, clearBlocklistFor,
};
