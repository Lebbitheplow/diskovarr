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
  };
}

function normalizeTV(details, credits) {
  const originCountries = details.origin_country || [];
  const isAnime = originCountries.includes('JP') &&
    (details.genres || []).some(g => g.id === 16); // Animation genre
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
  };
}

async function getItemDetails(tmdbId, mediaType) {
  const cached = db.getTmdbCache(tmdbId, mediaType);
  if (cached) return cached;

  try {
    const [details, credits] = await Promise.all([
      tmdbFetch(`/${mediaType}/${tmdbId}`),
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

async function getRecommendations(tmdbId, mediaType) {
  try {
    const json = await tmdbFetch(`/${mediaType}/${tmdbId}/recommendations?page=1`);
    if (!json) return [];
    return (json.results || []).slice(0, 20).map(r => ({
      tmdbId: r.id,
      mediaType: r.media_type || mediaType,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0,
    }));
  } catch {
    return [];
  }
}

// Discover movies/TV by genre IDs, sorted by popularity (not vote_average — avoids returning
// all-time classics that are almost certainly already in the library)
async function discoverByGenreIds(mediaType, genreIds, page = 1) {
  if (!genreIds || genreIds.length === 0) return [];
  try {
    const genreParam = genreIds.join(',');
    const json = await tmdbFetch(
      `/discover/${mediaType}?with_genres=${genreParam}&sort_by=popularity.desc&vote_average.gte=6.5&vote_count.gte=50&page=${page}`
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
      `/discover/tv?with_genres=16&with_origin_country=JP&sort_by=popularity.desc&vote_average.gte=6.5&vote_count.gte=50&page=${page}`
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

// Trending movies or TV this week
async function getTrending(mediaType) {
  try {
    const json = await tmdbFetch(`/trending/${mediaType}/week?page=1`);
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
  getItemDetails, getRecommendations, discoverByGenreIds, discoverAnime, getTrending,
  batchGetDetails, testApiKey, posterUrl,
  MOVIE_GENRE_MAP, TV_GENRE_MAP,
};
