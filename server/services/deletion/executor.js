// Tiered deletion of one library item: Radarr/Sonarr first (removes files and,
// optionally, adds an import exclusion so the *arr never re-grabs it), falling
// back to Plex's own metadata DELETE (requires "Allow media deletion" on the
// server). Afterwards: best-effort Riven/DUMB removal (symlinks, Riven's record
// and the debrid torrent) and request cleanup so DUMB's approved-request
// polling can't immediately re-request the item.
const db = require('../../db/database');
const plexService = require('../plex');
const tmdbService = require('../tmdb');
const rivenClient = require('../rivenClient');
const debridClient = require('../debridClient');
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

// Jellyfin fallback: DELETE /Items/{id} with the admin API key (the key's user
// needs "Allow media deletion" in Jellyfin). Jellyfin removes the files itself.
async function deleteViaJellyfin(item) {
  const jellyfin = require('../jellyfin');
  if (!jellyfin.isEnabled()) {
    throw new Error(`Jellyfin is not enabled — cannot delete Jellyfin item "${item.title}" (configure Radarr/Sonarr or enable Jellyfin)`);
  }
  try {
    await jellyfin.jfFetch(`/Items/${encodeURIComponent(String(item.ratingKey))}`, { method: 'DELETE', timeout: 60000 });
  } catch (err) {
    if (/ 40[13] /.test(err.message)) {
      throw new Error('Jellyfin refused the delete — enable "Allow media deletion" for the API key\'s user in Jellyfin, or configure Radarr/Sonarr');
    }
    throw err;
  }
}

// ── Riven / DUMB cleanup ──────────────────────────────────────────────────────

// Best-effort teardown of a Riven-acquired item: remove it from Riven (drops
// the library symlinks and Riven's own record, so Riven never re-adds it), then
// delete its torrents from the debrid account Riven downloads with.
// Returns { removed, notes } — `removed` is true once Riven dropped the item.
async function removeFromRiven(item) {
  if (!rivenClient.isRivenEnabled() || !rivenClient.getRivenApiKey() || !item.tmdbId) {
    return { removed: false, notes: [] };
  }
  let removed;
  try {
    removed = await rivenClient.removeByTmdb({ tmdbId: item.tmdbId, mediaType: item.type });
  } catch (e) {
    logger.warn(`[deletion] Riven cleanup failed for "${item.title}": ${e.message}`);
    return { removed: false, notes: [`riven: cleanup failed (${e.message})`] };
  }
  if (!removed) return { removed: false, notes: ['riven: not found'] };
  logger.info(`[deletion] removed from Riven: ${removed.id} (${item.title})`);
  const notes = [`riven: removed ${removed.id}`];

  try {
    const account = await rivenClient.getDebridAccount();
    if (!account) {
      notes.push('debrid: no supported downloader enabled in Riven');
    } else if (removed.folders.length > 0) {
      const { deleted, missing } = await debridClient.deleteTorrentsByName(account, removed.folders);
      logger.info(`[deletion] deleted ${deleted} ${account.provider} torrent(s) for "${item.title}"`);
      notes.push(`${account.provider}: deleted ${deleted} torrent(s)${missing ? `, ${missing} not found` : ''}`);
    }
  } catch (e) {
    logger.warn(`[deletion] debrid cleanup failed for "${item.title}": ${e.message}`);
    notes.push(`debrid: cleanup failed (${e.message})`);
  }
  return { removed: true, notes };
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
 * { method: 'radarr'|'sonarr'|'plex'|'jellyfin'|'riven', notes: [...] }; throws when every
 * applicable path failed (nothing was deleted).
 */
async function deleteItem(item, profile) {
  const source = item.source || 'plex';
  if (source !== 'plex' && source !== 'jellyfin') {
    throw new Error(`Refusing to delete ${source} item "${item.title}" — no delete path for this source`);
  }
  const conn = db.getConnectionSettings();
  const notes = [];
  let method = null;

  if (item.type === 'movie' && await deleteViaRadarr(item, profile, conn).catch(e => { notes.push(`radarr: ${e.message}`); return false; })) {
    method = 'radarr';
  } else if (item.type === 'show' && await deleteViaSonarr(item, profile, conn).catch(e => { if (e.noFallback) throw e; notes.push(`sonarr: ${e.message}`); return false; })) {
    method = 'sonarr';
  }

  // Media-server delete. For a Riven-acquired item a refusal here isn't fatal:
  // Riven's removal below deletes the symlinks, and the post-run library
  // refresh clears the entry.
  let mediaServerError = null;
  if (!method) {
    try {
      // Never the Plex path for a Jellyfin GUID.
      if (source === 'jellyfin') await deleteViaJellyfin(item);
      else await deleteViaPlex(item);
      method = source;
    } catch (e) {
      mediaServerError = e;
    }
  }

  const riven = await removeFromRiven(item);
  notes.push(...riven.notes);
  if (mediaServerError) {
    if (!riven.removed) throw mediaServerError;
    notes.push(`${source}: ${mediaServerError.message}`);
    method = 'riven';
  }
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
  const unique = new Set(sectionIds);
  // Jellyfin has no per-library trash; one library scan picks up the removals.
  if ([...unique].some(id => String(id).startsWith('jf_'))) {
    try {
      const jellyfin = require('../jellyfin');
      if (jellyfin.isEnabled()) {
        await jellyfin.jfFetch('/Library/Refresh', { method: 'POST' });
        logger.info('[deletion] triggered Jellyfin library refresh');
      }
    } catch (e) {
      logger.warn(`[deletion] Jellyfin library refresh failed: ${e.message}`);
    }
  }
  for (const sectionId of unique) {
    if (String(sectionId).startsWith('jf_')) continue; // Plex API below
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

module.exports = { deleteItem, refreshAndEmptyTrash, deleteViaJellyfin };
