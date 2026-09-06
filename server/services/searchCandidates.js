// Text-search candidate pool helpers.
//
// TMDB's /search/multi payload already carries everything a result card needs
// (title, year, poster, overview, score, genre ids, popularity). Only the
// details fetch adds content rating, credits and studio — two more TMDB round
// trips per title. Fetching those for up to 60 candidates before answering
// page 1 was the bulk of search latency, so the pool is now built from cached
// details where they exist and lightweight entries otherwise; the placeholders
// are upgraded in place by a background pass (enrichPending) that later pages
// and filter changes benefit from.
//
// Pure functions only — no database or network access here.

const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Official TMDB genre ids -> the names the details endpoint returns, so
// lightweight and enriched entries filter identically.
const MOVIE_GENRE_NAMES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
};
const TV_GENRE_NAMES = {
  10759: 'Action & Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 10762: 'Kids', 9648: 'Mystery',
  10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap',
  10767: 'Talk', 10768: 'War & Politics', 37: 'Western',
};

function isTitle(r) {
  return !!r && (r.media_type === 'movie' || r.media_type === 'tv');
}

// One /search/multi result -> the subset of the normalized details shape the
// list view and filters use. `enriched: false` marks it for the background pass.
function fromMultiResult(r) {
  const mediaType = r.media_type;
  const date = (mediaType === 'tv' ? r.first_air_date : r.release_date) || null;
  const names = mediaType === 'tv' ? TV_GENRE_NAMES : MOVIE_GENRE_NAMES;
  return {
    tmdbId: r.id,
    mediaType,
    title: (mediaType === 'tv' ? r.name : r.title) || r.original_name || r.original_title || '',
    year: parseInt((date || '').slice(0, 4)) || 0,
    releaseDate: date,
    overview: r.overview || '',
    posterUrl: r.poster_path ? `${IMAGE_BASE}/w342${r.poster_path}` : null,
    backdropUrl: r.backdrop_path ? `${IMAGE_BASE}/w780${r.backdrop_path}` : null,
    genres: (r.genre_ids || []).map(id => names[id]).filter(Boolean),
    genreIds: r.genre_ids || [],
    voteAverage: r.vote_average || 0,
    voteCount: r.vote_count || 0,
    popularity: r.popularity || 0,
    originalLanguage: r.original_language || null,
    adult: !!r.adult,
    contentRating: null,
    directors: [],
    cast: [],
    studio: '',
    enriched: false,
  };
}

// Raw multi-search results -> { pool, pending }. `getCached(tmdbId, mediaType)`
// returns a normalized details entry or null. Order is preserved.
function buildPool(rawResults, getCached) {
  const pool = [];
  const pending = [];
  const seen = new Set();
  for (const r of rawResults || []) {
    if (!isTitle(r)) continue;
    const key = `${r.id}:${r.media_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = getCached(r.id, r.media_type);
    if (cached) { pool.push(cached); continue; }
    const lite = fromMultiResult(r);
    pool.push(lite);
    pending.push(lite);
  }
  return { pool, pending };
}

// Upgrade placeholders in place as details arrive. Bounded concurrency keeps a
// cold pool from hammering TMDB; failures leave the placeholder as-is so a
// later pass can retry. Resolves to the number of entries upgraded.
async function enrichPending(pending, getDetails, concurrency = 8) {
  const todo = (pending || []).filter(i => i && i.enriched === false);
  let next = 0;
  let upgraded = 0;
  async function worker() {
    while (next < todo.length) {
      const item = todo[next++];
      let details = null;
      try { details = await getDetails(item.tmdbId, item.mediaType); } catch { details = null; }
      if (!details) continue;
      Object.assign(item, details);
      delete item.enriched;
      upgraded++;
    }
  }
  const workers = Math.min(concurrency, todo.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return upgraded;
}

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Append Sonarr /series/lookup hits that TMDB didn't return (YouTube web
// series, mostly) as TVDB-only entries. Mutates and returns `pool`.
function mergeSonarrLookup(pool, lookup, limit = 20) {
  if (!Array.isArray(lookup) || lookup.length === 0) return pool;
  const seen = new Set(pool.map(i => `${normTitle(i.title)}|${i.year || ''}`));
  const seenTvdb = new Set(pool.map(i => i.tvdbId).filter(Boolean).map(String));
  for (const s of lookup.slice(0, limit)) {
    if (!s || !s.tvdbId || seenTvdb.has(String(s.tvdbId))) continue;
    const key = `${normTitle(s.title)}|${s.year || ''}`;
    if (seen.has(key) || seen.has(`${normTitle(s.title)}|`)) continue;
    seen.add(key);
    seenTvdb.add(String(s.tvdbId));
    pool.push({
      tmdbId: null,
      tvdbId: s.tvdbId,
      mediaType: 'tv',
      title: s.title,
      year: s.year || null,
      overview: s.overview || '',
      posterUrl: (s.images || []).find(i => i.coverType === 'poster')?.remoteUrl || null,
      voteAverage: s.ratings?.value || 0,
      genres: s.genres || [],
      contentRating: s.certification || null,
      seasons: (s.seasons || []).map(x => x.seasonNumber).filter(n => n > 0),
      source: 'tvdb',
    });
  }
  return pool;
}

module.exports = {
  fromMultiResult,
  buildPool,
  enrichPending,
  mergeSonarrLookup,
  isTitle,
  MOVIE_GENRE_NAMES,
  TV_GENRE_NAMES,
};
