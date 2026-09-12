// External list sources for the Automation tab. Each adapter turns a pasted list
// URL (or preset) into entries of { tmdbId?, imdbId?, title?, year?, mediaType? };
// resolveEntries() then normalizes everything to { tmdbId, mediaType, title, year }.
//
// A list may combine several URLs (one per line): they are fetched in order and
// concatenated, first occurrence wins — Agregarr's multi-source "list order".
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

// imdbId / letterboxd-slug / title → { tmdbId, mediaType, title, year }.
// Process-lifetime cache: recurring syncs of big lists (IMDb Top 250) would
// otherwise re-hit TMDB /find for every entry on every run.
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

// Split a multi-line/space-separated URL field into individual URLs.
function splitUrls(text) {
  return String(text || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
}

// Parse every URL in a list's url field; throws on the first bad one.
function parseListUrls(text) {
  const urls = splitUrls(text);
  if (urls.length === 0) throw new Error('Not a valid URL');
  return urls.map(parseListUrl);
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
  const parsedUrls = parseListUrls(source.url);
  const out = [];
  for (const parsed of parsedUrls) {
    const adapter = ADAPTERS[parsed.sourceType];
    const entries = await adapter.fetchEntries(parsed, { limit });
    out.push(...entries);
    if (parsedUrls.length > 1 && out.length >= limit) break;
  }
  return out;
}

function fromSearchResult(r, mediaType) {
  return {
    tmdbId: r.id, mediaType,
    title: r.title || r.name,
    year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || null,
  };
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
    const hit = movie ? fromSearchResult(movie, 'movie') : tv ? fromSearchResult(tv, 'tv') : null;
    if (hit) resolveCache.set(cacheKey, hit);
    return hit;
  }
  if (entry.title) {
    // Untyped entries (a chart that mixes movies and shows) go through
    // /search/multi and take the best movie/tv hit.
    const mediaType = entry.mediaType === 'tv' ? 'tv' : entry.mediaType === 'movie' ? 'movie' : null;
    const cacheKey = `search:${mediaType || 'multi'}:${entry.title.toLowerCase()}:${entry.year || ''}`;
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);
    let hit = null;
    if (mediaType) {
      const yearParam = entry.year
        ? (mediaType === 'movie' ? `&year=${entry.year}` : `&first_air_date_year=${entry.year}`) : '';
      const found = await tmdbService.tmdbFetchPublic(
        `/search/${mediaType}?query=${encodeURIComponent(entry.title)}${yearParam}`
      ).catch(() => null);
      const top = found?.results?.[0];
      if (top) hit = { ...fromSearchResult(top, mediaType), year: fromSearchResult(top, mediaType).year || entry.year || null };
    } else {
      const found = await tmdbService.tmdbFetchPublic(
        `/search/multi?query=${encodeURIComponent(entry.title)}`
      ).catch(() => null);
      const top = (found?.results || []).find(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (top) hit = fromSearchResult(top, top.media_type);
    }
    if (hit) resolveCache.set(cacheKey, hit);
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
  parseListUrls,
  splitUrls,
  fetchList,
  resolveEntries,
  getPresets: presets.getPresets,
  CRITERIA_TYPES: criteria.CRITERIA_TYPES,
};
