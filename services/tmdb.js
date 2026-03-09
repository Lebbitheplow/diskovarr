const db = require('../db/database');

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

function getApiKey() {
  return db.getSetting('tmdb_api_key', null) || process.env.TMDB_API_KEY || null;
}

async function tmdbFetch(path) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('TMDB API key not configured');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}api_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw new Error('TMDB API key invalid');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB API error ${res.status} for ${path}`);
  return res.json();
}

// Small delay helper for rate-limit–friendly batching
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function posterUrl(path, size = 'w342') {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

function normalizeMovie(details, credits) {
  // Check US certification for R / NC-17
  const usRelease = (details.release_dates?.results || []).find(r => r.iso_3166_1 === 'US');
  const usCert = (usRelease?.release_dates || []).map(r => r.certification).find(c => c);
  const isMatureRated = usCert === 'R' || usCert === 'NC-17';
  return {
    tmdbId: details.id,
    mediaType: 'movie',
    title: details.title,
    year: parseInt((details.release_date || '').slice(0, 4)) || 0,
    releaseDate: details.release_date || null,
    overview: details.overview || '',
    posterUrl: posterUrl(details.poster_path),
    backdropUrl: posterUrl(details.backdrop_path, 'w780'),
    genres: (details.genres || []).map(g => g.name),
    genreIds: (details.genres || []).map(g => g.id),
    voteAverage: details.vote_average || 0,
    voteCount: details.vote_count || 0,
    directors: (credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name).slice(0, 3),
    cast: (credits?.cast || []).slice(0, 10).map(c => c.name),
    studio: (details.production_companies || []).map(c => c.name).slice(0, 2).join(', ') || '',
    originCountry: (details.production_countries || []).map(c => c.iso_3166_1),
    isAnime: false,
    contentRating: usCert || null,
    adult: details.adult || isMatureRated,
    keywords: (details.keywords?.keywords || []).map(k => k.name),
    keywordIds: (details.keywords?.keywords || []).slice(0, 20).map(k => ({ id: k.id, name: k.name })),
    collection: details.belongs_to_collection?.id || null,
    collectionName: details.belongs_to_collection?.name || null,
    trailerKey: (details.videos?.results || [])
      .filter(v => v.site === 'YouTube' && v.type === 'Trailer')
      .sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0))[0]?.key || null,
  };
}

function normalizeTV(details, credits) {
  const originCountries = details.origin_country || [];
  const isAnime = originCountries.includes('JP') &&
    (details.genres || []).some(g => g.id === 16); // Animation genre
  // Check content ratings for explicit material (Rx = hentai) or TV-MA (mature but not explicit)
  const contentRatings = (details.content_ratings?.results || []);
  const isExplicit = contentRatings.some(r => r.rating === 'Rx');
  const isTvMa = contentRatings.some(r => r.iso_3166_1 === 'US' && r.rating === 'TV-MA');
  return {
    tmdbId: details.id,
    mediaType: 'tv',
    title: details.name,
    year: parseInt((details.first_air_date || '').slice(0, 4)) || 0,
    releaseDate: details.first_air_date || null,
    overview: details.overview || '',
    posterUrl: posterUrl(details.poster_path),
    backdropUrl: posterUrl(details.backdrop_path, 'w780'),
    genres: (details.genres || []).map(g => g.name),
    genreIds: (details.genres || []).map(g => g.id),
    voteAverage: details.vote_average || 0,
    voteCount: details.vote_count || 0,
    directors: (details.created_by || []).map(c => c.name).slice(0, 3),
    cast: (credits?.cast || []).slice(0, 10).map(c => c.name),
    studio: (details.networks || []).map(n => n.name).slice(0, 2).join(', ') || '',
    originCountry: originCountries,
    isAnime,
    contentRating: (contentRatings.find(r => r.iso_3166_1 === 'US')?.rating) || null,
    adult: details.adult || isExplicit || isTvMa,
    keywords: (details.keywords?.results || []).map(k => k.name),
    keywordIds: (details.keywords?.results || []).slice(0, 20).map(k => ({ id: k.id, name: k.name })),
    trailerKey: (details.videos?.results || [])
      .filter(v => v.site === 'YouTube' && v.type === 'Trailer')
      .sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0))[0]?.key || null,
  };
}

async function getItemDetails(tmdbId, mediaType) {
  const cached = db.getTmdbCache(tmdbId, mediaType);
  if (cached) return cached;

  try {
    const detailsPath = mediaType === 'tv'
      ? `/tv/${tmdbId}?append_to_response=content_ratings,keywords,videos`
      : `/movie/${tmdbId}?append_to_response=release_dates,keywords,videos`;
    const [details, credits] = await Promise.all([
      tmdbFetch(detailsPath),
      tmdbFetch(`/${mediaType}/${tmdbId}/credits`),
    ]);
    if (!details) return null;

    const item = mediaType === 'movie'
      ? normalizeMovie(details, credits)
      : normalizeTV(details, credits);

    db.setTmdbCache(tmdbId, mediaType, item);
    return item;
  } catch (err) {
    console.warn(`[tmdb] getItemDetails(${tmdbId}, ${mediaType}) failed:`, err.message);
    return null;
  }
}

async function getRecommendations(tmdbId, mediaType, page = 1) {
  try {
    const json = await tmdbFetch(`/${mediaType}/${tmdbId}/recommendations?page=${page}`);
    if (!json) return [];
    return (json.results || []).map(r => ({
      tmdbId: r.id,
      mediaType: r.media_type || mediaType,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

async function getSimilar(tmdbId, mediaType, page = 1) {
  try {
    const json = await tmdbFetch(`/${mediaType}/${tmdbId}/similar?page=${page}`);
    if (!json) return [];
    return (json.results || []).map(r => ({
      tmdbId: r.id,
      mediaType,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

// In-memory caches for person lookups (resets on server restart — acceptable)
const _personIdCache = new Map();    // name -> tmdbPersonId | -1
const _personCreditsCache = new Map(); // `${personId}:${mediaType}` -> candidates[]

async function getPersonCandidates(name, mediaType) {
  let personId = _personIdCache.get(name);
  if (personId === undefined) {
    try {
      const json = await tmdbFetch(`/search/person?query=${encodeURIComponent(name)}&page=1`);
      personId = json?.results?.[0]?.id ?? -1;
    } catch {
      personId = -1;
    }
    _personIdCache.set(name, personId);
  }
  if (personId === -1) return [];

  const cacheKey = `${personId}:${mediaType}`;
  if (_personCreditsCache.has(cacheKey)) return _personCreditsCache.get(cacheKey);

  try {
    const creditsKey = mediaType === 'movie' ? 'movie_credits' : 'tv_credits';
    const json = await tmdbFetch(`/person/${personId}/${creditsKey}`);
    const results = (json?.cast || [])
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, 20)
      .map(r => ({
        tmdbId: r.id,
        mediaType,
        title: r.title || r.name,
        year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
      }));
    _personCreditsCache.set(cacheKey, results);
    return results;
  } catch {
    _personCreditsCache.set(cacheKey, []);
    return [];
  }
}

// Discover movies/TV by genre IDs with configurable sort
async function discoverByGenreIds(mediaType, genreIds, page = 1, sortBy = 'popularity.desc') {
  if (!genreIds || genreIds.length === 0) return [];
  try {
    const genreParam = genreIds.join(',');
    const json = await tmdbFetch(
      `/discover/${mediaType}?with_genres=${genreParam}&sort_by=${sortBy}&vote_average.gte=6.5&vote_count.gte=50&include_adult=false&page=${page}`
    );
    if (!json) return [];
    return (json.results || []).map(r => ({
      tmdbId: r.id,
      mediaType,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

// Discover anime: Animation (16) + JP origin
async function discoverAnime(page = 1) {
  try {
    const json = await tmdbFetch(
      `/discover/tv?with_genres=16&with_origin_country=JP&sort_by=popularity.desc&vote_average.gte=6.5&vote_count.gte=50&include_adult=false&page=${page}`
    );
    if (!json) return [];
    return (json.results || []).map(r => ({
      tmdbId: r.id,
      mediaType: 'tv',
      title: r.name,
      year: parseInt((r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

// Discover by keyword ID (e.g. "time loop", "based on novel") — highly targeted
async function discoverByKeywordId(mediaType, keywordId, page = 1) {
  try {
    const json = await tmdbFetch(
      `/discover/${mediaType}?with_keywords=${keywordId}&sort_by=popularity.desc&vote_average.gte=6.0&vote_count.gte=30&include_adult=false&page=${page}`
    );
    if (!json) return [];
    return (json.results || []).map(r => ({
      tmdbId: r.id,
      mediaType,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

// Trending movies or TV this week
async function getTrending(mediaType, page = 1) {
  try {
    const json = await tmdbFetch(`/trending/${mediaType}/week?page=${page}&include_adult=false`);
    if (!json) return [];
    return (json.results || []).map(r => ({
      tmdbId: r.id,
      mediaType,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

// Batch fetch details for a list of { tmdbId, mediaType } candidates
// Respects rate limits with small delays between uncached requests
async function batchGetDetails(candidates) {
  const results = [];
  for (const { tmdbId, mediaType } of candidates) {
    const details = await getItemDetails(tmdbId, mediaType);
    if (details) results.push(details);
    // Only delay if item wasn't cached (would have returned instantly)
    const wasCached = db.getTmdbCache(tmdbId, mediaType) !== null;
    if (!wasCached) await delay(150);
  }
  return results;
}

// Test that the current API key is valid
async function testApiKey() {
  try {
    const json = await tmdbFetch('/configuration');
    return { ok: true, message: 'TMDB API key is valid' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Map Plex genre names to TMDB movie genre IDs
const MOVIE_GENRE_MAP = {
  'Action': [28], 'Adventure': [12], 'Animation': [16], 'Comedy': [35],
  'Crime': [80], 'Documentary': [99], 'Drama': [18], 'Family': [10751],
  'Fantasy': [14], 'History': [36], 'Horror': [27], 'Music': [10402],
  'Mystery': [9648], 'Romance': [10749], 'Science Fiction': [878],
  'Thriller': [53], 'War': [10752], 'Western': [37],
};

// Map Plex genre names to TMDB TV genre IDs
const TV_GENRE_MAP = {
  'Action': [10759], 'Adventure': [10759], 'Animation': [16], 'Comedy': [35],
  'Crime': [80], 'Documentary': [99], 'Drama': [18], 'Family': [10751],
  'Mystery': [9648], 'Reality': [10764], 'Science Fiction': [10765],
  'Fantasy': [10765], 'Thriller': [10759], 'War': [10768], 'Western': [37],
};

module.exports = {
  getItemDetails, getRecommendations, getSimilar, getPersonCandidates,
  discoverByGenreIds, discoverByKeywordId, discoverAnime, getTrending,
  batchGetDetails, testApiKey, posterUrl,
  tmdbFetchPublic: tmdbFetch,
  MOVIE_GENRE_MAP, TV_GENRE_MAP,
};
