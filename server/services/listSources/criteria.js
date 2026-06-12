// Criteria-based list source: instead of an external URL, a list is defined by
// the same criteria vocabulary as Content Monitors (genre, cast, director,
// writer, producer, studio, network, production company, collection, keyword,
// country, language). Criteria resolve against TMDB — discover queries where
// the API supports the dimension, person credits / collection parts where it
// doesn't — so the list yields requestable content, not just library matches.
const tmdbService = require('../tmdb');

// Same names monitors accept (media_type/movie/tv_series are covered by the
// list-level media type setting, so they're not part of this set).
const CRITERIA_TYPES = [
  'genre', 'cast', 'director', 'writer', 'producer',
  'studio', 'network', 'production_company',
  'collection', 'keyword', 'country', 'language',
];

// TMDB has no network search endpoint; common networks/streamers by name.
// Unknown networks fall back to a company search (with_companies).
const NETWORK_MAP = {
  'netflix': 213, 'hbo': 49, 'hbo max': 3186, 'max': 3186, 'disney+': 2739,
  'disney plus': 2739, 'apple tv+': 2552, 'apple tv plus': 2552,
  'prime video': 1024, 'amazon prime video': 1024, 'amazon': 1024,
  'hulu': 453, 'paramount+': 4330, 'paramount plus': 4330, 'peacock': 3353,
  'amc': 174, 'abc': 2, 'nbc': 6, 'cbs': 16, 'fox': 19, 'the cw': 71, 'bbc one': 4,
};

const LANGUAGE_MAP = {
  'english': 'en', 'spanish': 'es', 'french': 'fr', 'german': 'de',
  'japanese': 'ja', 'korean': 'ko', 'chinese': 'zh', 'italian': 'it',
  'portuguese': 'pt', 'russian': 'ru',
};

const COUNTRY_MAP = {
  'united states of america': 'US', 'united states': 'US', 'usa': 'US',
  'united kingdom': 'GB', 'uk': 'GB', 'canada': 'CA', 'france': 'FR',
  'germany': 'DE', 'japan': 'JP', 'south korea': 'KR', 'korea': 'KR',
  'china': 'CN', 'india': 'IN', 'italy': 'IT', 'spain': 'ES', 'mexico': 'MX',
  'brazil': 'BR', 'australia': 'AU', 'russia': 'RU', 'sweden': 'SE',
  'denmark': 'DK', 'norway': 'NO', 'ireland': 'IE', 'new zealand': 'NZ',
};

const norm = s => String(s || '').trim().toLowerCase();

// name → TMDB id via the search endpoints; cached for the process lifetime
const searchCache = new Map();
async function searchId(kind, name) {
  const key = `${kind}:${norm(name)}`;
  if (searchCache.has(key)) return searchCache.get(key);
  const json = await tmdbService.tmdbFetchPublic(
    `/search/${kind}?query=${encodeURIComponent(String(name).trim())}`
  ).catch(() => null);
  const id = json?.results?.[0]?.id || null;
  searchCache.set(key, id);
  return id;
}

function normalizeItem(r, mediaType) {
  return {
    tmdbId: r.id,
    title: r.title || r.name || null,
    year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || null,
    mediaType,
    popularity: r.popularity || 0,
  };
}

// Person-based criteria can't always go through discover (TV discover has no
// people params; crew jobs aren't filterable), so they resolve to explicit
// title sets from the person's combined credits.
async function personCredits(name, role) {
  const personId = await searchId('person', name);
  if (!personId) return null;
  const credits = await tmdbService.tmdbFetchPublic(`/person/${personId}/combined_credits`).catch(() => null);
  if (!credits) return null;
  let rows;
  if (role === 'cast') {
    rows = credits.cast || [];
  } else {
    const crew = credits.crew || [];
    if (role === 'director') rows = crew.filter(r => r.job === 'Director');
    else if (role === 'writer') rows = crew.filter(r => r.department === 'Writing');
    else rows = crew.filter(r => r.job === 'Producer' || r.job === 'Executive Producer');
  }
  const out = { movie: [], tv: [] };
  for (const r of rows) {
    if (r.media_type === 'movie') out.movie.push(normalizeItem(r, 'movie'));
    else if (r.media_type === 'tv') out.tv.push(normalizeItem(r, 'tv'));
  }
  return out;
}

/**
 * Resolve one criterion to, per media type, either discover params or an
 * explicit item set. Shape: { movieParams, tvParams, movieItems, tvItems }
 * (each may be null). Throws when the named entity can't be found on TMDB.
 */
async function resolveCriterion({ type, entityName }) {
  const name = String(entityName || '').trim();
  if (!name) throw new Error(`criterion "${type}" has no value`);
  const result = { movieParams: null, tvParams: null, movieItems: null, tvItems: null };

  switch (type) {
    case 'genre': {
      const movieIds = tmdbService.MOVIE_GENRE_MAP[Object.keys(tmdbService.MOVIE_GENRE_MAP).find(k => norm(k) === norm(name))];
      const tvIds = tmdbService.TV_GENRE_MAP[Object.keys(tmdbService.TV_GENRE_MAP).find(k => norm(k) === norm(name))];
      if (!movieIds && !tvIds) throw new Error(`unknown genre: "${name}"`);
      if (movieIds) result.movieParams = { with_genres: movieIds.join(',') };
      if (tvIds) result.tvParams = { with_genres: tvIds.join(',') };
      return result;
    }
    case 'keyword': {
      const id = await searchId('keyword', name);
      if (!id) throw new Error(`keyword not found on TMDB: "${name}"`);
      result.movieParams = { with_keywords: String(id) };
      result.tvParams = { with_keywords: String(id) };
      return result;
    }
    case 'studio':
    case 'production_company': {
      const id = await searchId('company', name);
      if (!id) throw new Error(`company not found on TMDB: "${name}"`);
      result.movieParams = { with_companies: String(id) };
      result.tvParams = { with_companies: String(id) };
      return result;
    }
    case 'network': {
      const networkId = NETWORK_MAP[norm(name)];
      if (networkId) {
        result.tvParams = { with_networks: String(networkId) };
        return result;
      }
      const companyId = await searchId('company', name);
      if (!companyId) throw new Error(`network not found: "${name}" (try the exact TMDB network/company name)`);
      result.tvParams = { with_companies: String(companyId) };
      return result;
    }
    case 'country': {
      const code = /^[A-Za-z]{2}$/.test(name) ? name.toUpperCase() : COUNTRY_MAP[norm(name)];
      if (!code) throw new Error(`unknown country: "${name}" (use a 2-letter code like US)`);
      result.movieParams = { with_origin_country: code };
      result.tvParams = { with_origin_country: code };
      return result;
    }
    case 'language': {
      const code = /^[A-Za-z]{2}$/.test(name) ? name.toLowerCase() : LANGUAGE_MAP[norm(name)];
      if (!code) throw new Error(`unknown language: "${name}" (use a 2-letter code like en)`);
      result.movieParams = { with_original_language: code };
      result.tvParams = { with_original_language: code };
      return result;
    }
    case 'cast': {
      // Movie discover supports with_cast natively; TV side uses credits
      const personId = await searchId('person', name);
      if (!personId) throw new Error(`person not found on TMDB: "${name}"`);
      result.movieParams = { with_cast: String(personId) };
      const credits = await personCredits(name, 'cast');
      result.tvItems = credits ? credits.tv : [];
      return result;
    }
    case 'director':
    case 'writer':
    case 'producer': {
      const credits = await personCredits(name, type);
      if (!credits) throw new Error(`person not found on TMDB: "${name}"`);
      result.movieItems = credits.movie;
      result.tvItems = credits.tv;
      return result;
    }
    case 'collection': {
      const id = await searchId('collection', name);
      if (!id) throw new Error(`collection not found on TMDB: "${name}"`);
      const col = await tmdbService.tmdbFetchPublic(`/collection/${id}`).catch(() => null);
      result.movieItems = (col?.parts || []).map(p => normalizeItem(p, 'movie'));
      return result;
    }
    default:
      throw new Error(`unsupported criterion type: "${type}"`);
  }
}

async function discover(mediaType, params, limit) {
  const out = [];
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  for (let page = 1; page <= 5 && out.length < limit; page++) {
    const json = await tmdbService.tmdbFetchPublic(
      `/discover/${mediaType}?${qs}&sort_by=popularity.desc&page=${page}`
    );
    const results = json?.results || [];
    out.push(...results.map(r => normalizeItem(r, mediaType)));
    if (page >= (json?.total_pages || 1) || results.length === 0) break;
  }
  return out;
}

// Merge params from multiple criteria; same key AND-combines (TMDB comma = AND)
function mergeParams(paramsList) {
  const merged = {};
  for (const params of paramsList) {
    for (const [k, v] of Object.entries(params)) {
      merged[k] = merged[k] ? `${merged[k]},${v}` : v;
    }
  }
  return merged;
}

async function fetchForMediaType(resolved, mediaType, matchMode, limit) {
  const paramsKey = mediaType === 'tv' ? 'tvParams' : 'movieParams';
  const itemsKey = mediaType === 'tv' ? 'tvItems' : 'movieItems';

  if (matchMode === 'ANY') {
    const union = new Map();
    for (const r of resolved) {
      let items = [];
      if (r[paramsKey]) items = await discover(mediaType, r[paramsKey], limit);
      else if (r[itemsKey]) items = r[itemsKey];
      for (const item of items) if (!union.has(item.tmdbId)) union.set(item.tmdbId, item);
    }
    return [...union.values()].sort((a, b) => b.popularity - a.popularity).slice(0, limit);
  }

  // ALL mode: every criterion must apply to this media type, otherwise the
  // combination is unsatisfiable here (e.g. a network criterion on movies)
  if (resolved.some(r => !r[paramsKey] && !r[itemsKey])) return [];

  const paramsList = resolved.filter(r => r[paramsKey]).map(r => r[paramsKey]);
  const itemSets = resolved.filter(r => r[itemsKey]).map(r => r[itemsKey]);

  let candidates;
  if (paramsList.length > 0) {
    // Over-fetch so post-filtering by credit sets still fills the cap
    candidates = await discover(mediaType, mergeParams(paramsList), itemSets.length ? limit * 4 : limit);
  } else {
    candidates = itemSets.shift();
  }
  for (const set of itemSets) {
    const ids = new Set(set.map(i => i.tmdbId));
    candidates = candidates.filter(c => ids.has(c.tmdbId));
  }
  return candidates.sort((a, b) => b.popularity - a.popularity).slice(0, limit);
}

async function fetchEntries(listSource, { limit = 100 } = {}) {
  const criteria = listSource.criteria || [];
  if (criteria.length === 0) throw new Error('criteria list has no criteria');
  const matchMode = listSource.matchMode === 'ANY' ? 'ANY' : 'ALL';
  const mediaTypes = listSource.mediaType === 'movie' ? ['movie']
    : listSource.mediaType === 'tv' ? ['tv'] : ['movie', 'tv'];

  const resolved = [];
  for (const criterion of criteria) resolved.push(await resolveCriterion(criterion));

  const out = [];
  for (const mediaType of mediaTypes) {
    out.push(...await fetchForMediaType(resolved, mediaType, matchMode, limit));
  }
  return out.slice(0, limit).map(({ tmdbId, title, year, mediaType }) => ({ tmdbId, title, year, mediaType }));
}

module.exports = { fetchEntries, resolveCriterion, CRITERIA_TYPES };
