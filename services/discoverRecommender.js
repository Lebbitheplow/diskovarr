const plexService = require('./plex');
const tautulliService = require('./tautulli');
const tmdbService = require('./tmdb');
const { buildPreferenceProfile, partialShuffle, tieredSample } = require('./recommender');
const db = require('../db/database');

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const POOL_SIZES = { topPicks: 300, movies: 400, tvShows: 300, anime: 150 };

// Per-user in-memory cache: userId -> { pools, builtAt }
const discoverCache = new Map();
// Track in-progress background rebuilds to avoid duplicates
const rebuildInProgress = new Set();

function invalidateUserCache(userId) {
  discoverCache.delete(String(userId));
  db.setDiscoverPool(String(userId), {}, 0); // mark DB cache as stale too
}

function invalidateAllCaches() {
  discoverCache.clear();
}

// Signal rank for reason display — mirrors recommender.js exactly
const SIGNAL_TYPE_RANK = { collection: 0, director: 1, similar: 2, actor: 3, keyword: 4, studio: 5, rating: 6, new: 7, genre: 99 };

// Genre names that are clearly titles rather than real genres (e.g. Plex custom genres)
function isRealGenre(g) {
  return g.length <= 20 && g.split(' ').length <= 3;
}

/**
 * Score a TMDB candidate against the user's preference profile.
 * Mirrors scoreItem() in recommender.js — same signal budget and thresholds.
 */
function scoreTmdbItem(item, profile) {
  const { genreWeights, directorWeights, actorWeights, studioWeights, decadeWeights,
          keywordWeights, collectionWeights, tmdbSimilarMap,
          directorTriggers, actorTriggers, studioTriggers } = profile;

  const signals = [];

  // ── TMDB Similarity (max 40pts) ───────────────────────────────────────────
  // Discover items already have numeric tmdbId from the TMDB API.
  let similarPts = 0;
  if (item.tmdbId && tmdbSimilarMap) {
    const entry = tmdbSimilarMap.get(Number(item.tmdbId));
    if (entry) {
      similarPts = Math.min(entry.weight * 8, 40);
      if (similarPts > 3) {
        signals.push({ pts: similarPts, reason: `Similar to ${entry.sourceTitle}`, type: 'similar' });
      }
    }
  }

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

  // ── Actor (max 35pts) ─────────────────────────────────────────────────────
  let actPts = 0, topActor = null, actTrigger = null;
  for (const a of (item.cast || []).slice(0, 10)) {
    const w = actorWeights.get(a) || 0;
    if (w > 0.1) {
      actPts += w * 15;
      if (!topActor || w > (actorWeights.get(topActor) || 0)) {
        topActor = a;
        actTrigger = actorTriggers.get(a);
      }
    }
  }
  actPts = Math.min(actPts, 35);
  if (actPts > 3) {
    const reason = actTrigger?.isHighlyRated
      ? `Because you loved ${actTrigger.title}`
      : `Starring ${topActor}`;
    signals.push({ pts: actPts, reason, type: 'actor' });
  }

  // ── Keywords / themes (max 25pts) ─────────────────────────────────────────
  let kwPts = 0;
  for (const kw of (item.keywords || [])) {
    const w = keywordWeights?.get(kw) || 0;
    if (w > 0.1) kwPts += Math.min(w * 5, 5);
  }
  kwPts = Math.min(kwPts, 25);
  if (kwPts > 3) {
    signals.push({ pts: kwPts, reason: `Matches themes you enjoy`, type: 'keyword' });
  }

  // ── Franchise/Collection (max 30pts) ──────────────────────────────────────
  let collectionPts = 0;
  if (item.collection && collectionWeights) {
    collectionPts = Math.min((collectionWeights.get(item.collection) || 0) * 30, 30);
    if (collectionPts > 5) {
      signals.push({ pts: collectionPts, reason: `Part of a series you watch`, type: 'collection' });
    }
  }

  // ── Studio/Network (max 10pts, supporting context only) ───────────────────
  let studioPts = 0, topStudio = null;
  if (item.studio) {
    for (const s of item.studio.split(',').map(s => s.trim())) {
      const pts = Math.min((studioWeights.get(s) || 0) * 10, 10);
      if (pts > studioPts) { studioPts = pts; topStudio = s; }
    }
  }

  // ── Genre (max 8pts) ──────────────────────────────────────────────────────
  let genrePts = 0;
  const matchedGenres = [];
  for (const g of (item.genres || [])) {
    const w = genreWeights.get(g) || 0;
    genrePts += Math.min(w * 4, 4);
    if (w > 0.35 && isRealGenre(g)) matchedGenres.push({ g, w });
  }
  genrePts = Math.min(genrePts, 8);

  // ── Decade (max 8pts) ─────────────────────────────────────────────────────
  let decadePts = 0;
  if (item.year) {
    const decade = `${Math.floor(item.year / 10) * 10}s`;
    decadePts = Math.min((decadeWeights.get(decade) || 0) * 8, 8);
  }

  // ── Conditional pushes: studio, genre, rating ─────────────────────────────
  const hasPersonalSignal = signals.some(s => ['similar', 'director', 'actor', 'keyword', 'collection'].includes(s.type));

  // Studio only as supporting context
  if (studioPts > 3 && hasPersonalSignal && topStudio) {
    const t = studioTriggers.get(topStudio);
    const reason = t?.isHighlyRated ? `Because you loved ${t.title}` : `More from ${topStudio}`;
    signals.push({ pts: studioPts, reason, type: 'studio' });
  }

  // Genre when fewer than 2 personal signals and item is decent quality
  const personalCount = signals.filter(s => ['similar', 'director', 'actor', 'keyword', 'collection'].includes(s.type)).length;
  if (genrePts > 2 && matchedGenres.length > 0 && personalCount < 2) {
    matchedGenres.sort((a, b) => b.w - a.w);
    if (item.voteAverage >= 7.0 || personalCount === 0) {
      signals.push({ pts: genrePts, reason: `Because you like ${matchedGenres[0].g}`, type: 'genre' });
    }
  }

  // Rating only when nothing personal matched at all
  const ratingBonus = item.voteAverage >= 9.0 ? 3 : item.voteAverage >= 8.0 ? 1 : 0;
  if (ratingBonus >= 3 && !hasPersonalSignal) {
    signals.push({ pts: ratingBonus, reason: 'Highly Rated', type: 'rating' });
  }

  const score = similarPts + dirPts + actPts + kwPts + collectionPts + genrePts + studioPts + decadePts + ratingBonus;

  signals.sort((a, b) => {
    const ra = SIGNAL_TYPE_RANK[a.type] ?? 50;
    const rb = SIGNAL_TYPE_RANK[b.type] ?? 50;
    if (ra !== rb) return ra - rb;
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
    if (topMovieIds.length >= 30 && topTvIds.length >= 20) break;
    const item = db.getLibraryItemByKey(key);
    if (!item?.tmdbId) continue;
    if (item.type === 'movie' && topMovieIds.length < 30) topMovieIds.push(item.tmdbId);
    else if (item.type === 'show' && topTvIds.length < 20) topTvIds.push(item.tmdbId);
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

  // 1. TMDB recommendations + similar for user's top watched movies
  // Top 10 seeds get pages 1-3, next 20 get pages 1-2, rest page 1
  const movieRecPromises = topMovieIds.slice(0, 30).flatMap((id, i) => {
    const pages = i < 10 ? [1, 2, 3] : i < 25 ? [1, 2] : [1];
    return pages.map(p => tmdbService.getRecommendations(id, 'movie', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))));
  });
  const movieSimPromises = topMovieIds.slice(0, 25).flatMap((id, i) => {
    const pages = i < 15 ? [1, 2] : [1];
    return pages.map(p => tmdbService.getSimilar(id, 'movie', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))));
  });

  // 2. TMDB recommendations + similar for user's top watched shows
  const tvRecPromises = topTvIds.slice(0, 20).flatMap((id, i) => {
    const pages = i < 15 ? [1, 2] : [1];
    return pages.map(p => tmdbService.getRecommendations(id, 'tv', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))));
  });
  const tvSimPromises = topTvIds.slice(0, 20).flatMap((id, i) => {
    const pages = i < 12 ? [1, 2] : [1];
    return pages.map(p => tmdbService.getSimilar(id, 'tv', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))));
  });

  // 3. Genre-based discovery — top 8 genres, 10 pages popularity + 5 pages by rating
  // Two passes per genre: popularity (mainstream) + vote_average (hidden gems)
  let genreDiscoverPromises = [];
  if (profile) {
    const topMovieGenres = [...profile.genreWeights.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);
    const topTvGenres = [...profile.genreWeights.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);

    const popularPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ratedPages = [1, 2, 3, 4, 5];

    genreDiscoverPromises = [
      ...topMovieGenres.flatMap(g => {
        const ids = tmdbService.MOVIE_GENRE_MAP[g];
        if (!ids) return [];
        return [
          ...popularPages.map(p => tmdbService.discoverByGenreIds('movie', ids, p, 'popularity.desc').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)))),
          ...ratedPages.map(p => tmdbService.discoverByGenreIds('movie', ids, p, 'vote_average.desc').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)))),
        ];
      }),
      ...topTvGenres.flatMap(g => {
        const ids = tmdbService.TV_GENRE_MAP[g];
        if (!ids) return [];
        return [
          ...popularPages.map(p => tmdbService.discoverByGenreIds('tv', ids, p, 'popularity.desc').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)))),
          ...ratedPages.map(p => tmdbService.discoverByGenreIds('tv', ids, p, 'vote_average.desc').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)))),
        ];
      }),
    ];
  }

  // 4. Trending movies + TV (5 pages each)
  const trendingMoviePromise = Promise.all([1,2,3,4,5].map(p => tmdbService.getTrending('movie', p)))
    .then(pages => pages.flat().forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)));
  const trendingTvPromise = Promise.all([1,2,3,4,5].map(p => tmdbService.getTrending('tv', p)))
    .then(pages => pages.flat().forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)));

  // 5. Anime discover (8 pages)
  const animePromise = Promise.all([1,2,3,4,5,6,7,8].map(p => tmdbService.discoverAnime(p)))
    .then(pages => pages.flat().forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)));

  // 6. Person-based candidates: top 20 actors + top 12 directors (movie + TV)
  let personPromises = [];
  if (profile) {
    const topActors = [...profile.actorWeights.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name]) => name);
    const topDirectors = [...profile.directorWeights.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name);

    personPromises = [
      ...topActors.map(name =>
        tmdbService.getPersonCandidates(name, 'movie').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)))
      ),
      ...topDirectors.map(name =>
        tmdbService.getPersonCandidates(name, 'movie').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year)))
      ),
      ...topActors.slice(0, 12).map(name =>
        tmdbService.getPersonCandidates(name, 'tv').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)))
      ),
      ...topDirectors.slice(0, 6).map(name =>
        tmdbService.getPersonCandidates(name, 'tv').then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year)))
      ),
    ];
  }

  // 7. Keyword-based discovery — top 20 keywords, pages 1+2+3 each
  // Very targeted: surfaces content matching specific themes you've enjoyed
  let keywordPromises = [];
  if (profile?.keywordIdWeights?.size) {
    const topKeywords = [...profile.keywordIdWeights.entries()]
      .sort((a, b) => b[1].weight - a[1].weight).slice(0, 20);
    keywordPromises = topKeywords.flatMap(([id]) => [
      tmdbService.discoverByKeywordId('movie', id, 1).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))),
      tmdbService.discoverByKeywordId('movie', id, 2).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))),
      tmdbService.discoverByKeywordId('movie', id, 3).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))),
      tmdbService.discoverByKeywordId('tv', id, 1).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))),
      tmdbService.discoverByKeywordId('tv', id, 2).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))),
      tmdbService.discoverByKeywordId('tv', id, 3).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))),
    ]);
  }

  await Promise.all([...movieRecPromises, ...movieSimPromises, ...tvRecPromises, ...tvSimPromises, ...genreDiscoverPromises, trendingMoviePromise, trendingTvPromise, animePromise, ...personPromises, ...keywordPromises]);

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

function scheduleRebuild(userId, userToken) {
  const userIdStr = String(userId);
  if (rebuildInProgress.has(userIdStr)) return;
  rebuildInProgress.add(userIdStr);
  buildDiscoverPools(userId, userToken)
    .then(pools => {
      const builtAt = Date.now();
      discoverCache.set(userIdStr, { pools, builtAt });
      db.setDiscoverPool(userIdStr, pools, builtAt);
      console.log(`[discover] Pool rebuilt for user ${userIdStr}`);
    })
    .catch(err => console.error(`[discover] Background rebuild failed for ${userIdStr}:`, err.message))
    .finally(() => rebuildInProgress.delete(userIdStr));
}

async function getDiscoverRecommendations(userId, userToken, { mature = false } = {}) {
  const userIdStr = String(userId);

  // 1. Check in-memory cache
  let cached = discoverCache.get(userIdStr);

  // 2. Fall back to DB cache (survives server restarts)
  if (!cached) {
    const dbCached = db.getDiscoverPool(userIdStr);
    if (dbCached?.pools && dbCached.builtAt) {
      cached = dbCached;
      discoverCache.set(userIdStr, dbCached);
    }
  }

  const isStale = !cached || Date.now() - cached.builtAt > CACHE_TTL;

  let pools;
  if (cached?.pools && Object.keys(cached.pools).length > 0) {
    // Serve existing cache immediately (fresh or stale)
    pools = cached.pools;
    // Kick off background rebuild if stale
    if (isStale) scheduleRebuild(userId, userToken);
  } else {
    // No cache at all — must build synchronously (first time only)
    console.log(`[discover] No cache for user ${userIdStr}, building now...`);
    pools = await buildDiscoverPools(userId, userToken);
    const builtAt = Date.now();
    discoverCache.set(userIdStr, { pools, builtAt });
    db.setDiscoverPool(userIdStr, pools, builtAt);
  }

  // Sample fresh results from pools on every call
  const requestedIds = db.getRequestedTmdbIds(userId);
  const dismissedIds = db.getExploreDismissedIds(userId);

  function filterAndMark(items) {
    return items
      .filter(item => !dismissedIds.has(`${item.tmdbId}:${item.mediaType}`))
      .filter(item => mature || !item.adult)
      .map(item => ({ ...item, isRequested: requestedIds.has(`${item.tmdbId}:${item.mediaType}`) }));
  }

  return {
    topPicks: filterAndMark(partialShuffle(pools.topPicks, Math.min(72, pools.topPicks.length))),
    movies: filterAndMark(tieredSample(pools.movies, 60)),
    tvShows: filterAndMark(tieredSample(pools.tvShows, 60)),
    anime: filterAndMark(tieredSample(pools.anime, 60)),
  };
}

module.exports = {
  getDiscoverRecommendations,
  invalidateUserCache,
  invalidateAllCaches,
  scheduleRebuild,
};
