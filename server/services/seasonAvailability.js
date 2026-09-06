// Season-level availability for a TV show: which seasons TMDB lists, how many
// episodes of each the library already holds, and which are already requested.
// Powers the request modal's grayed-out season chips and "request missing".
//
// The merge is pure so it can be unit-tested; the fetchers require their
// service modules lazily so loading this file never opens the database.

const LIBRARY_SEASONS_TTL_MS = 2 * 60 * 1000;
const _libSeasonsCache = new Map(); // ratingKey -> { seasons, ts }

// discover_requests rows ({ seasons_json }) -> { all, seasons:Set<number> }.
// A null/empty seasons_json means the whole show was requested.
function parseRequestedSeasons(rows) {
  const out = { all: false, seasons: new Set() };
  for (const row of rows || []) {
    let list = null;
    try { list = row.seasons_json ? JSON.parse(row.seasons_json) : null; } catch { list = null; }
    if (!Array.isArray(list) || list.length === 0) { out.all = true; continue; }
    for (const n of list) if (Number(n) > 0) out.seasons.add(Number(n));
  }
  return out;
}

// tmdbSeasons:    [{ number, name, episodeCount, airDate }]
// librarySeasons: [{ number, episodeCount }] for a show in the library, or
//                 null when the show is not in the library at all.
// requested:      output of parseRequestedSeasons
function mergeSeasonAvailability({ tmdbSeasons = [], librarySeasons = null, requested = null } = {}) {
  const req = requested || { all: false, seasons: new Set() };
  const inLibrary = Array.isArray(librarySeasons);
  const byNumber = new Map();
  for (const s of tmdbSeasons) {
    const n = Number(s.number);
    if (!(n > 0)) continue;
    byNumber.set(n, {
      number: n,
      name: s.name || `Season ${n}`,
      episodeCount: s.episodeCount == null ? null : Number(s.episodeCount),
      airDate: s.airDate || null,
      libraryCount: 0,
    });
  }
  if (inLibrary) {
    for (const s of librarySeasons) {
      const n = Number(s.number);
      if (!(n > 0)) continue;
      const row = byNumber.get(n) || { number: n, name: `Season ${n}`, episodeCount: null, airDate: null, libraryCount: 0 };
      row.libraryCount = Number(s.episodeCount) || 0;
      byNumber.set(n, row);
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => a.number - b.number)
    .map(row => {
      // Complete when the library holds at least as many episodes as TMDB
      // lists; a season TMDB doesn't know counts as complete once anything of
      // it is present.
      const complete = row.libraryCount > 0 && (row.episodeCount == null || row.libraryCount >= row.episodeCount);
      // Whole-show requests are considered fulfilled once the show is in the
      // library, so only explicit per-season requests still gray a season out.
      const isRequested = !complete && (req.seasons.has(row.number) || (!inLibrary && req.all));
      return { ...row, complete, requested: isRequested, selectable: !complete && !isRequested };
    });
}

// Season list for a TMDB show. Uses the cached details entry when it carries
// seasonDetails (entries written after that field was added), otherwise one
// base /tv/{id} call.
async function fetchTmdbSeasons(tmdbId) {
  const db = require('../db/database');
  const tmdb = require('./tmdb');
  const cached = db.getTmdbCache(tmdbId, 'tv');
  if (cached && Array.isArray(cached.seasonDetails)) return cached.seasonDetails;
  const json = await tmdb.tmdbFetchPublic(`/tv/${tmdbId}`);
  return tmdb.seasonDetailsOf(json);
}

// Per-season episode counts for a library show (Plex or Jellyfin), briefly
// cached so reopening the request modal doesn't re-hit the media server.
async function fetchLibrarySeasons(libItem) {
  if (!libItem || !libItem.ratingKey) return null;
  const key = String(libItem.ratingKey);
  const hit = _libSeasonsCache.get(key);
  if (hit && Date.now() - hit.ts < LIBRARY_SEASONS_TTL_MS) return hit.seasons;
  const source = libItem.source || 'plex';
  const seasons = source === 'jellyfin'
    ? await require('./jellyfin').getShowSeasons(key)
    : await require('./plex').getShowSeasons(key);
  _libSeasonsCache.set(key, { seasons, ts: Date.now() });
  return seasons;
}

function invalidateLibrarySeasons(ratingKey) {
  if (ratingKey == null) _libSeasonsCache.clear();
  else _libSeasonsCache.delete(String(ratingKey));
}

module.exports = {
  parseRequestedSeasons,
  mergeSeasonAvailability,
  fetchTmdbSeasons,
  fetchLibrarySeasons,
  invalidateLibrarySeasons,
};
