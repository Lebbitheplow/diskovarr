// Tiered deletion of one library item: Radarr/Sonarr first (removes files and,
// optionally, adds an import exclusion so the *arr never re-grabs it), falling
// back to Plex's own metadata DELETE (requires "Allow media deletion" on the
// server). Afterwards: best-effort Riven/DUMB removal and request cleanup so
// DUMB's approved-request polling can't immediately re-request the item.
const fs = require('fs');
const db = require('../../db/database');
const plexService = require('../plex');
const tmdbService = require('../tmdb');
const logger = require('../logger');

const PLEX_HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': 'diskovarr-app',
  'X-Plex-Product': 'Diskovarr',
};

async function plexRequest(path, { method = 'GET' } = {}) {
  const res = await fetch(`${plexService.getPlexUrl()}${path}`, {
    method,
    headers: { ...PLEX_HEADERS, 'X-Plex-Token': plexService.getPlexToken() },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const err = new Error(`Plex API error ${res.status} for ${method} ${path}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function arrFetch(baseUrl, apiKey, path, { method = 'GET' } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// Returns true when the item was found and deleted in Radarr.
async function deleteViaRadarr(item, profile, conn) {
  if (!conn.radarrEnabled || !conn.radarrUrl || !conn.radarrApiKey || !item.tmdbId) return false;
  const found = await arrFetch(conn.radarrUrl, conn.radarrApiKey, `/api/v3/movie?tmdbId=${Number(item.tmdbId)}`);
  const movie = Array.isArray(found) ? found[0] : null;
  if (!movie?.id) return false;
  await arrFetch(conn.radarrUrl, conn.radarrApiKey,
    `/api/v3/movie/${movie.id}?deleteFiles=true&addImportExclusion=${profile.arrImportExclusion ? 'true' : 'false'}`,
    { method: 'DELETE' });
  return true;
}

// Returns true when the show was found and deleted in Sonarr.
async function deleteViaSonarr(item, profile, conn) {
  if (!conn.sonarrEnabled || !conn.sonarrUrl || !conn.sonarrApiKey || !item.tmdbId) return false;
  // A transient TMDB failure must abort the delete (candidate marked failed,
  // retried next run) — falling through to a Plex file delete would leave
  // Sonarr still monitoring the show. Only a definitive "no tvdb mapping"
  // answer may fall through.
  let externalIds;
  try {
    externalIds = await tmdbService.tmdbFetchPublic(`/tv/${item.tmdbId}/external_ids`);
  } catch (e) {
    const err = new Error(`TMDB external-ids lookup failed: ${e.message}`);
    err.noFallback = true;
    throw err;
  }
  const tvdbId = externalIds?.tvdb_id;
  if (!tvdbId) return false;
  const found = await arrFetch(conn.sonarrUrl, conn.sonarrApiKey, `/api/v3/series?tvdbId=${Number(tvdbId)}`);
  const series = Array.isArray(found) ? found[0] : null;
  if (!series?.id) return false;
  await arrFetch(conn.sonarrUrl, conn.sonarrApiKey,
    `/api/v3/series/${series.id}?deleteFiles=true&addImportListExclusion=${profile.arrImportExclusion ? 'true' : 'false'}`,
    { method: 'DELETE' });
  return true;
}

async function deleteViaPlex(item) {
  try {
    await plexRequest(`/library/metadata/${item.ratingKey}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new Error('Plex refused the delete — enable "Allow media deletion" in Plex server Library settings, or configure Radarr/Sonarr');
    }
    throw err;
  }
}

// ── Riven / DUMB cleanup ──────────────────────────────────────────────────────

const RIVEN_SETTINGS_PATH = process.env.RIVEN_SETTINGS_PATH || '/opt/riven/settings.json';

function getRivenConfig() {
  if (!['1', 'true'].includes(db.getSetting('riven_enabled', '0'))) return null;
  const url = (db.getSetting('riven_url', '') || 'http://127.0.0.1:8082').replace(/\/$/, '');
  let apiKey = db.getSetting('riven_api_key', '');
  if (!apiKey) {
    try { apiKey = JSON.parse(fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8'))?.api_key || ''; } catch {}
  }
  return apiKey ? { url, apiKey } : null;
}

async function rivenFetch(config, path, { method = 'GET' } = {}) {
  const res = await fetch(`${config.url}/api/v1${path}`, {
    method,
    headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Riven API ${res.status} for ${method} ${path}`);
  return res.json().catch(() => null);
}

// Best-effort: remove the item from Riven so DUMB/decypharr drops it too.
// Returns a short status string for the deletion record.
async function removeFromRiven(item) {
  const config = getRivenConfig();
  if (!config) return null;
  try {
    const extPath = item.type === 'show' ? `/tv/${item.tmdbId}/external_ids` : `/movie/${item.tmdbId}`;
    const ext = await tmdbService.tmdbFetchPublic(extPath).catch(() => null);
    const imdbId = ext?.imdb_id;
    if (!imdbId) return 'riven: no imdb id mapping';
    const found = await rivenFetch(config, `/items/imdb/${encodeURIComponent(imdbId)}`).catch(err => {
      if (String(err.message).includes('404')) return null;
      throw err;
    });
    const items = Array.isArray(found) ? found : (found?.items || (found && found.id ? [found] : []));
    const ids = items.map(i => i?.id).filter(Boolean);
    if (ids.length === 0) return 'riven: not found';
    await rivenFetch(config, `/items/remove?ids=${encodeURIComponent(ids.join(','))}`, { method: 'DELETE' });
    logger.info(`[deletion] removed from Riven: ${ids.join(',')} (${item.title})`);
    return `riven: removed ${ids.length} item(s)`;
  } catch (e) {
    logger.warn(`[deletion] Riven cleanup failed for "${item.title}": ${e.message}`);
    return `riven: cleanup failed (${e.message})`;
  }
}

// Remove old requests for this title so nothing re-requests it: DUMB pull mode
// serves approved discover_requests rows to decypharr, and the watchlist
// auto-request path also consults them. Also flags the title as 'deleted' on any
// monitored list that contains it, so list sync skips it from now on.
function cleanupRequests(item) {
  if (!item.tmdbId) return;
  const requests = db.prepare(
    'DELETE FROM discover_requests WHERE tmdb_id = ? AND media_type = ?'
  ).run(Number(item.tmdbId), item.type === 'show' ? 'tv' : 'movie');
  db.prepare(
    'UPDATE list_source_items SET status = ? WHERE tmdb_id = ? AND media_type = ?'
  ).run('deleted', Number(item.tmdbId), item.type === 'show' ? 'tv' : 'movie');
  if (requests.changes > 0) {
    logger.info(`[deletion] removed ${requests.changes} old request(s) for "${item.title}"`);
  }
}

/**
 * Delete one library item (library_items row shape). Returns
 * { method: 'radarr'|'sonarr'|'plex', notes: [...] }; throws when every
 * applicable path failed (nothing was deleted).
 */
async function deleteItem(item, profile) {
  const conn = db.getConnectionSettings();
  const notes = [];
  let method = null;

  if (item.type === 'movie' && await deleteViaRadarr(item, profile, conn).catch(e => { notes.push(`radarr: ${e.message}`); return false; })) {
    method = 'radarr';
  } else if (item.type === 'show' && await deleteViaSonarr(item, profile, conn).catch(e => { if (e.noFallback) throw e; notes.push(`sonarr: ${e.message}`); return false; })) {
    method = 'sonarr';
  } else {
    await deleteViaPlex(item);
    method = 'plex';
  }

  const rivenNote = await removeFromRiven(item);
  if (rivenNote) notes.push(rivenNote);
  cleanupRequests(item);

  // Drop the cached row immediately (the next section resync would prune it
  // anyway) and flush the in-memory library cache.
  db.prepare('DELETE FROM library_items WHERE rating_key = ?').run(String(item.ratingKey));
  try { plexService.invalidateCache(); } catch {}

  logger.info(`[deletion] deleted "${item.title}" (${item.ratingKey}) via ${method}${notes.length ? ' — ' + notes.join('; ') : ''}`);
  return { method, notes };
}

// After real deletions: make Plex notice missing files and clear its trash so
// items don't linger as "unavailable" entries.
async function refreshAndEmptyTrash(sectionIds) {
  for (const sectionId of new Set(sectionIds)) {
    try {
      await plexRequest(`/library/sections/${sectionId}/refresh`);
      await new Promise(r => setTimeout(r, 10000));
      await plexRequest(`/library/sections/${sectionId}/emptyTrash`, { method: 'PUT' });
      logger.info(`[deletion] refreshed + emptied trash for section ${sectionId}`);
    } catch (e) {
      logger.warn(`[deletion] refresh/emptyTrash failed for section ${sectionId}: ${e.message}`);
    }
  }
}

module.exports = { deleteItem, refreshAndEmptyTrash };
