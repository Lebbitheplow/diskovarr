// External list sources for the Automation tab. Each adapter turns a pasted list
// URL (or preset) into entries of { tmdbId?, imdbId?, title?, year?, mediaType? };
// resolveEntries() then normalizes everything to { tmdbId, mediaType, title, year }.
const tmdbService = require('../tmdb');
const trakt = require('./trakt');
const mdblist = require('./mdblist');
const tmdbList = require('./tmdbList');
const imdb = require('./imdb');
const letterboxd = require('./letterboxd');
const anilist = require('./anilist');
const presets = require('./presets');
const criteria = require('./criteria');

const ADAPTERS = { trakt, mdblist, tmdb: tmdbList, imdb, letterboxd, anilist };

// imdbId / letterboxd-slug → { tmdbId, mediaType, title, year }. Process-lifetime
// cache: recurring syncs of big lists (IMDb Top 250) would otherwise re-hit TMDB
// /find for every entry on every run.
const resolveCache = new Map();

function parseListUrl(url) {
  const trimmed = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Not a valid URL');
  for (const [sourceType, adapter] of Object.entries(ADAPTERS)) {
    const parsed = adapter.parseUrl(trimmed);
    if (parsed) return { sourceType, ...parsed };
  }
  throw new Error('Unsupported list URL — supported: Trakt, IMDb, TMDB, Letterboxd, MDBList, AniList');
}

// Fetch raw entries for a saved list source (or a transient one from /validate).
// limit caps how many entries are fetched/returned where the source supports it.
async function fetchList(source, { limit = 500 } = {}) {
  if (source.sourceType === 'criteria' || (Array.isArray(source.criteria) && source.criteria.length > 0)) {
    return criteria.fetchEntries(source, { limit: Math.min(limit, 100) });
  }
  if (source.sourceType === 'preset' || source.presetKey) {
    const preset = presets.byKey(source.presetKey);
    if (!preset) throw new Error(`Unknown preset: ${source.presetKey}`);
    return presets.fetchPreset(preset, { limit });
  }
  const parsed = parseListUrl(source.url);
  const adapter = ADAPTERS[parsed.sourceType];
  return adapter.fetchEntries(parsed, { limit });
}

async function resolveOne(entry) {
  if (entry.tmdbId) {
    return {
      tmdbId: Number(entry.tmdbId),
      mediaType: entry.mediaType === 'tv' ? 'tv' : 'movie',
      title: entry.title || null,
      year: entry.year || null,
    };
  }
  if (entry.imdbId) {
    const cacheKey = `imdb:${entry.imdbId}`;
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);
    const found = await tmdbService.tmdbFetchPublic(
      `/find/${encodeURIComponent(entry.imdbId)}?external_source=imdb_id`
    ).catch(() => null);
    const movie = found?.movie_results?.[0];
    const tv = found?.tv_results?.[0];
    const hit = movie
      ? { tmdbId: movie.id, mediaType: 'movie', title: movie.title, year: parseInt((movie.release_date || '').slice(0, 4)) || null }
      : tv
        ? { tmdbId: tv.id, mediaType: 'tv', title: tv.name, year: parseInt((tv.first_air_date || '').slice(0, 4)) || null }
        : null;
    if (hit) resolveCache.set(cacheKey, hit);
    return hit;
  }
  if (entry.title) {
    const mediaType = entry.mediaType === 'tv' ? 'tv' : 'movie';
    const cacheKey = `search:${mediaType}:${entry.title.toLowerCase()}:${entry.year || ''}`;
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);
    const yearParam = entry.year
      ? (mediaType === 'movie' ? `&year=${entry.year}` : `&first_air_date_year=${entry.year}`) : '';
    const found = await tmdbService.tmdbFetchPublic(
      `/search/${mediaType}?query=${encodeURIComponent(entry.title)}${yearParam}`
    ).catch(() => null);
    const top = found?.results?.[0];
    if (!top) return null;
    const hit = {
      tmdbId: top.id, mediaType,
      title: top.title || top.name,
      year: parseInt((top.release_date || top.first_air_date || '').slice(0, 4)) || entry.year || null,
    };
    resolveCache.set(cacheKey, hit);
    return hit;
  }
  return null;
}

// Resolve raw adapter entries to TMDB ids, preserving list order and dropping
// duplicates/unresolvable entries. Sequential with a tiny stagger between
// uncached network lookups — list syncs are background work, not latency-bound.
async function resolveEntries(entries) {
  const out = [];
  const seen = new Set();
  let unresolved = 0;
  for (const entry of entries) {
    let hit = null;
    try {
      const needsNetwork = !entry.tmdbId;
      hit = await resolveOne(entry);
      if (needsNetwork && hit) await new Promise(r => setTimeout(r, 60));
    } catch { hit = null; }
    if (!hit) { unresolved++; continue; }
    const key = `${hit.tmdbId}:${hit.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return { items: out, unresolved };
}

module.exports = {
  parseListUrl,
  fetchList,
  resolveEntries,
  getPresets: presets.getPresets,
  CRITERIA_TYPES: criteria.CRITERIA_TYPES,
};
