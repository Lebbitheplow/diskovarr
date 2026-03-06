const plexService = require('./plex');
const tautulliService = require('./tautulli');
const tmdbService = require('./tmdb');
const { buildPreferenceProfile, partialShuffle, tieredSample } = require('./recommender');
const db = require('../db/database');

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const POOL_SIZES = { topPicks: 150, movies: 200, tvShows: 150, anime: 100 };

// Per-user discover cache: userId -> { pools, builtAt }
const discoverCache = new Map();

function invalidateUserCache(userId) {
  discoverCache.delete(String(userId));
}

function invalidateAllCaches() {
  discoverCache.clear();
}

// Signal rank for reason display (mirrors recommender.js)
const SIGNAL_TYPE_RANK = { director: 0, actor: 1, studio: 2, rating: 3, genre: 99 };

/**
 * Score a TMDB item against the user's preference profile.
 * Uses the same signal budget as the in-library scorer but adapted for TMDB metadata.
 */
function scoreTmdbItem(item, profile) {
  const { genreWeights, directorWeights, actorWeights, studioWeights, decadeWeights,
          directorTriggers, actorTriggers, studioTriggers } = profile;

  const signals = [];

  // ── Director (max 30pts) ──────────────────────────────────────────────────
  let dirPts = 0, topDir = null, dirTrigger = null;
  for (const d of (item.directors || [])) {
    const pts = (directorWeights.get(d) || 0) * 30;
    if (pts > dirPts) { dirPts = pts; topDir = d; dirTrigger = directorTriggers.get(d); }
  }
  dirPts = Math.min(dirPts, 30);
  if (dirPts > 3) {
    const reason = dirTrigger?.isHighlyRated
      ? `Because you loved ${dirTrigger.title}`
      : `Directed by ${topDir}`;
    signals.push({ pts: dirPts, reason, type: 'director' });
  }

  // ── Actor (max 25pts) ─────────────────────────────────────────────────────
  let actPts = 0, topActor = null, actTrigger = null;
  for (const a of (item.cast || []).slice(0, 10)) {
    const w = actorWeights.get(a) || 0;
    if (w > 0) {
      actPts += w * 7;
      if (!topActor || w > (actorWeights.get(topActor) || 0)) {
        topActor = a;
        actTrigger = actorTriggers.get(a);
      }
    }
  }
  actPts = Math.min(actPts, 25);
  if (actPts > 3) {
    const reason = actTrigger?.isHighlyRated
      ? `Because you loved ${actTrigger.title}`
      : `Starring ${topActor}`;
    signals.push({ pts: actPts, reason, type: 'actor' });
  }

  // ── Genre (max 20pts) ─────────────────────────────────────────────────────
  let genrePts = 0;
  const matchedGenres = [];
  for (const g of (item.genres || [])) {
    const w = genreWeights.get(g) || 0;
    genrePts += Math.min(w * 7, 7);
    if (w > 0.2) matchedGenres.push({ g, w });
  }
  genrePts = Math.min(genrePts, 20);
  if (genrePts > 2 && matchedGenres.length > 0) {
    matchedGenres.sort((a, b) => b.w - a.w);
    signals.push({ pts: genrePts, reason: `Because you like ${matchedGenres[0].g}`, type: 'genre' });
  }

  // ── Studio/Network (max 15pts) ────────────────────────────────────────────
  let studioPts = 0;
  if (item.studio) {
    // Studio field may be "Warner Bros., DC" — try each part
    const studioNames = item.studio.split(',').map(s => s.trim());
    for (const s of studioNames) {
      const pts = Math.min((studioWeights.get(s) || 0) * 15, 15);
      if (pts > studioPts) {
        studioPts = pts;
        if (pts > 2) {
          const t = studioTriggers.get(s);
          const reason = t?.isHighlyRated ? `Because you loved ${t.title}` : `More from ${s}`;
          signals.push({ pts, reason, type: 'studio' });
        }
      }
    }
    studioPts = Math.min(studioPts, 15);
  }

  // ── Decade (max 8pts) ─────────────────────────────────────────────────────
  let decadePts = 0;
  if (item.year) {
    const decade = `${Math.floor(item.year / 10) * 10}s`;
    decadePts = Math.min((decadeWeights.get(decade) || 0) * 8, 8);
  }

  // ── Rating bonus ──────────────────────────────────────────────────────────
  // TMDB voteAverage is 0–10; treat similarly to Plex audienceRating
  const ratingBonus = item.voteAverage >= 8.5 ? 5 : item.voteAverage >= 7.5 ? 2 : 0;
  if (ratingBonus >= 5) signals.push({ pts: ratingBonus, reason: 'Highly Rated', type: 'rating' });

  const score = dirPts + actPts + genrePts + studioPts + decadePts + ratingBonus;

  // Sort signals: specific before genre
  const hasSpecific = signals.some(s => s.type !== 'genre' && s.pts > 2);
  signals.sort((a, b) => {
    if (hasSpecific) {
      const ra = SIGNAL_TYPE_RANK[a.type] ?? 50;
      const rb = SIGNAL_TYPE_RANK[b.type] ?? 50;
      if (ra !== rb) return ra - rb;
    }
    return b.pts - a.pts;
  });
  const reasons = signals.slice(0, 3).map(s => s.reason);

  return { ...item, score, reasons };
}

/**
 * Get the user's top watched items (by recency + frequency) that have TMDB IDs.
 * Returns { topMovieIds: string[], topTvIds: string[] }
 */
async function getTopWatchedTmdbIds(userId) {
  const history = await tautulliService.getFullHistory(userId);
  if (!history.length) return { topMovieIds: [], topTvIds: [] };

  // Count watches per rating key
  const counts = new Map();
  const latestAt = new Map();
  for (const e of history) {
    counts.set(e.rating_key, (counts.get(e.rating_key) || 0) + 1);
    const cur = latestAt.get(e.rating_key) || 0;
    if (e.watched_at > cur) latestAt.set(e.rating_key, e.watched_at);
  }

  // Score: watch count × 1 + recency bonus
  const now = Math.floor(Date.now() / 1000);
  const scored = [...counts.entries()].map(([key, count]) => {
    const agedays = (now - (latestAt.get(key) || 0)) / 86400;
    const recency = agedays < 30 ? 3 : agedays < 90 ? 2 : agedays < 365 ? 1 : 0;
    return { key, score: count + recency };
  }).sort((a, b) => b.score - a.score);

  // Look up TMDB IDs from library DB
  const topMovieIds = [], topTvIds = [];
  for (const { key } of scored) {
    if (topMovieIds.length >= 20 && topTvIds.length >= 10) break;
    const item = db.getLibraryItemByKey(key);
    if (!item?.tmdbId) continue;
    if (item.type === 'movie' && topMovieIds.length < 20) topMovieIds.push(item.tmdbId);
    else if (item.type === 'show' && topTvIds.length < 10) topTvIds.push(item.tmdbId);
  }

  return { topMovieIds, topTvIds };
}

async function buildDiscoverPools(userId, userToken) {
  const [movies, tv, watchedKeys] = await Promise.all([
    plexService.getLibraryItems(db.getSetting('plex_movies_section', null) || process.env.PLEX_MOVIES_SECTION_ID || '1'),
    plexService.getLibraryItems(db.getSetting('plex_tv_section', null) || process.env.PLEX_TV_SECTION_ID || '2'),
    plexService.getWatchedKeys(userId, userToken),
  ]);

  const libraryMap = new Map([...movies, ...tv].map(i => [i.ratingKey, i]));
  const [profile, { topMovieIds, topTvIds }] = await Promise.all([
    buildPreferenceProfile(userId, libraryMap),
    getTopWatchedTmdbIds(userId),
  ]);

  // Library TMDB IDs to exclude from results
  const libraryTmdbIds = db.getLibraryTmdbIds();
  // Title+year fallback for when TMDB IDs aren't populated yet
  const libraryTitleYears = db.getLibraryTitleYearSet();
  // Previously requested items for this user
  const requestedIds = db.getRequestedTmdbIds(userId);

  function normTitle(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function isInLibraryByTitle(title, year) {
    const norm = normTitle(title);
    // Exact title+year match
    if (libraryTitleYears.has(norm + '|' + (year || ''))) return true;
    // Title match within ±1 year (handles slight year discrepancies)
    if (year) {
      if (libraryTitleYears.has(norm + '|' + (year - 1))) return true;
      if (libraryTitleYears.has(norm + '|' + (year + 1))) return true;
    }
    return false;
  }

  function isAlreadyHave(tmdbId, mediaType, title, year) {
    if (libraryTmdbIds.has(String(tmdbId))) return true;
    if (requestedIds.has(`${tmdbId}:${mediaType}`)) return true;
    if (isInLibraryByTitle(title, year)) return true;
    return false;
  }

  // ── Gather candidates ────────────────────────────────────────────────────

  const candidateSet = new Map(); // key: `${tmdbId}:${mediaType}` -> { tmdbId, mediaType }

  function addCandidate(tmdbId, mediaType, title, year) {
    if (!tmdbId) return;
    const mt = mediaType === 'tv' || mediaType === 'show' ? 'tv' : 'movie';
    const key = `${tmdbId}:${mt}`;
    if (!isAlreadyHave(tmdbId, mt, title, year)) candidateSet.set(key, { tmdbId, mediaType: mt });
  }

  // 1. TMDB recommendations for user's top watched movies
  const movieRecPromises = topMovieIds.slice(0, 15).map(id =>
    tmdbService.getRecommendations(id, 'movie').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)))
  );

  // 2. TMDB recommendations for user's top watched shows
  const tvRecPromises = topTvIds.slice(0, 8).map(id =>
    tmdbService.getRecommendations(id, 'tv').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)))
  );

  // 3. Genre-based discovery using top genres from preference profile
  let genreDiscoverPromises = [];
  if (profile) {
    const topMovieGenres = [...profile.genreWeights.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
    const topTvGenres = [...profile.genreWeights.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);

    genreDiscoverPromises = [
      ...topMovieGenres.map(g => {
        const ids = tmdbService.MOVIE_GENRE_MAP[g];
        if (!ids) return Promise.resolve();
        return Promise.all([
          tmdbService.discoverByGenreIds('movie', ids, 1),
          tmdbService.discoverByGenreIds('movie', ids, 2),
        ]).then(([p1, p2]) => [...p1, ...p2].forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)));
      }),
      ...topTvGenres.map(g => {
        const ids = tmdbService.TV_GENRE_MAP[g];
        if (!ids) return Promise.resolve();
        return Promise.all([
          tmdbService.discoverByGenreIds('tv', ids, 1),
          tmdbService.discoverByGenreIds('tv', ids, 2),
        ]).then(([p1, p2]) => [...p1, ...p2].forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)));
      }),
    ];
  }

  // 4. Trending movies + TV
  const trendingMoviePromise = tmdbService.getTrending('movie')
    .then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)));
  const trendingTvPromise = tmdbService.getTrending('tv')
    .then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)));

  // 5. Anime discover (2 pages)
  const animePromise = Promise.all([
    tmdbService.discoverAnime(1),
    tmdbService.discoverAnime(2),
  ]).then(([p1, p2]) => [...p1, ...p2].forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)));

  await Promise.all([...movieRecPromises, ...tvRecPromises, ...genreDiscoverPromises, trendingMoviePromise, trendingTvPromise, animePromise]);

  // ── Fetch details for all candidates ────────────────────────────────────
  const candidates = [...candidateSet.values()];
  console.log(`[discoverRec] Fetching details for ${candidates.length} candidates for user ${userId}`);

  // Fetch in batches of 10 to be rate-limit friendly, with small delays for uncached items
  const detailedItems = [];
  const BATCH = 10;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(({ tmdbId, mediaType }) =>
      tmdbService.getItemDetails(tmdbId, mediaType)
    ));
    const today = new Date().toISOString().slice(0, 10);
    detailedItems.push(...batchResults.filter(item => {
      if (!item) return false;
      if (isAlreadyHave(item.tmdbId, item.mediaType, item.title, item.year)) return false;
      // Exclude items with a future release date
      if (item.releaseDate && item.releaseDate > today) return false;
      return true;
    }));
    // Small delay between batches only if any were uncached
    if (i + BATCH < candidates.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // ── Score items ───────────────────────────────────────────────────────────

  const scoreFallback = (item) => ({
    ...item,
    score: item.voteAverage || 0,
    reasons: item.voteAverage >= 8 ? ['Highly Rated'] : [],
  });

  const scoredItems = detailedItems.map(item =>
    profile ? scoreTmdbItem(item, profile) : scoreFallback(item)
  );

  // Split into sections
  const scored = {
    movies: scoredItems.filter(i => i.mediaType === 'movie' && !i.isAnime),
    tvShows: scoredItems.filter(i => i.mediaType === 'tv' && !i.isAnime),
    anime: scoredItems.filter(i => i.isAnime),
  };

  for (const key of Object.keys(scored)) {
    scored[key].sort((a, b) => b.score - a.score);
  }

  // Top picks: highest-scored blend of all types
  const topPicksPool = [...scoredItems]
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL_SIZES.topPicks);

  return {
    topPicks: topPicksPool,
    movies: scored.movies.slice(0, POOL_SIZES.movies),
    tvShows: scored.tvShows.slice(0, POOL_SIZES.tvShows),
    anime: scored.anime.slice(0, POOL_SIZES.anime),
  };
}

async function getDiscoverRecommendations(userId, userToken) {
  const userIdStr = String(userId);
  const cached = discoverCache.get(userIdStr);

  let pools;
  if (cached && Date.now() - cached.builtAt < CACHE_TTL) {
    pools = cached.pools;
  } else {
    pools = await buildDiscoverPools(userId, userToken);
    discoverCache.set(userIdStr, { pools, builtAt: Date.now() });
  }

  // Sample fresh results from pools on every call
  const requestedIds = db.getRequestedTmdbIds(userId);
  function markRequested(items) {
    return items.map(item => ({
      ...item,
      isRequested: requestedIds.has(`${item.tmdbId}:${item.mediaType}`),
    }));
  }

  return {
    topPicks: markRequested(partialShuffle(pools.topPicks, Math.min(72, pools.topPicks.length))),
    movies: markRequested(tieredSample(pools.movies, 60)),
    tvShows: markRequested(tieredSample(pools.tvShows, 60)),
    anime: markRequested(tieredSample(pools.anime, 60)),
  };
}

module.exports = {
  getDiscoverRecommendations,
  invalidateUserCache,
  invalidateAllCaches,
};
