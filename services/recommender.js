const plexService = require('./plex');
const tautulliService = require('./tautulli');
const db = require('../db/database');

const MOVIES_SECTION = process.env.PLEX_MOVIES_SECTION_ID || '1';
const TV_SECTION = process.env.PLEX_TV_SECTION_ID || '2';

// Per-user recommendation cache: userId -> { data, builtAt }
const recCache = new Map();
const REC_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function invalidateUserCache(userId) {
  recCache.delete(String(userId));
}

function normalizeMap(map) {
  const max = Math.max(...map.values(), 1);
  const normalized = new Map();
  for (const [k, v] of map.entries()) {
    normalized.set(k, v / max);
  }
  return normalized;
}

/**
 * Build preference weights from Tautulli watch history.
 * Only used for scoring (genre/director/actor/decade affinity).
 * Watched filtering is handled separately via Plex API to avoid stale ratingKeys.
 * libraryMap is passed in to avoid re-fetching it.
 */
async function buildPreferenceProfile(userId, libraryMap) {
  const history = await tautulliService.getFullHistory(userId);
  if (!history.length) return null;

  // Sort by recency for recency multiplier
  const sorted = [...history].sort((a, b) => b.watched_at - a.watched_at);
  const top50Keys = new Set(sorted.slice(0, 50).map(h => h.rating_key));

  const genreWeights = new Map();
  const directorWeights = new Map();
  const actorWeights = new Map();
  const decadeWeights = new Map();

  for (const entry of history) {
    // Try exact ratingKey match first, then title fallback for stale keys
    const item = libraryMap.get(entry.rating_key);
    if (!item) continue;

    const recency = top50Keys.has(entry.rating_key) ? 1.5 : 1.0;
    const completion = entry.percent_complete >= 95 ? 1.3 : 1.0;
    const weight = recency * completion;

    for (const g of item.genres) {
      genreWeights.set(g, (genreWeights.get(g) || 0) + weight);
    }
    for (const d of item.directors) {
      directorWeights.set(d, (directorWeights.get(d) || 0) + weight * 1.5);
    }
    for (const a of item.cast) {
      actorWeights.set(a, (actorWeights.get(a) || 0) + weight);
    }
    if (item.year) {
      const decade = `${Math.floor(item.year / 10) * 10}s`;
      decadeWeights.set(decade, (decadeWeights.get(decade) || 0) + weight);
    }
  }

  return {
    genreWeights: normalizeMap(genreWeights),
    directorWeights: normalizeMap(directorWeights),
    actorWeights: normalizeMap(actorWeights),
    decadeWeights: normalizeMap(decadeWeights),
  };
}

function scoreItem(item, profile, dismissedKeys, watchedKeys) {
  const key = item.ratingKey;

  if (dismissedKeys.has(key)) return null;
  if (watchedKeys.has(key)) return null;

  const { genreWeights, directorWeights, actorWeights, decadeWeights } = profile;

  let score = 0;
  const reasons = [];

  // Genre score (max 40pts)
  let genreScore = 0;
  const matchedGenres = [];
  for (const g of item.genres) {
    const w = genreWeights.get(g) || 0;
    genreScore += w * 40;
    if (w > 0.3) matchedGenres.push(g);
  }
  genreScore = Math.min(genreScore, 40);
  score += genreScore;
  if (matchedGenres.length > 0) {
    reasons.push(`Because you like ${matchedGenres[0]}`);
  }

  // Director score (max 25pts)
  let dirScore = 0;
  let topDir = null;
  for (const d of item.directors) {
    const w = directorWeights.get(d) || 0;
    const s = w * 25 * 1.5;
    if (s > dirScore) { dirScore = s; topDir = d; }
  }
  dirScore = Math.min(dirScore, 25);
  score += dirScore;
  if (topDir && dirScore > 5) reasons.push(`Directed by ${topDir}`);

  // Actor score (max 20pts)
  let actScore = 0;
  const matchedActors = [];
  for (const a of item.cast.slice(0, 10)) {
    const w = actorWeights.get(a) || 0;
    actScore += w * 8;
    if (w > 0.2) matchedActors.push(a);
    if (actScore >= 20) break;
  }
  actScore = Math.min(actScore, 20);
  score += actScore;
  if (matchedActors.length > 0 && !reasons.some(r => r.startsWith('Directed'))) {
    reasons.push(`Starring ${matchedActors[0]}`);
  }

  // Decade score (max 10pts)
  if (item.year) {
    const decade = `${Math.floor(item.year / 10) * 10}s`;
    const w = decadeWeights.get(decade) || 0;
    score += w * 10;
  }

  // Rating bonus
  if (item.audienceRating >= 8.0) {
    score += 5;
    if (reasons.length < 3) reasons.push('Highly Rated');
  }

  // New addition bonus (added within 7 days)
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  if (item.addedAt && item.addedAt > sevenDaysAgo) {
    score += 3;
    if (reasons.length < 3) reasons.push('Recently Added');
  }

  return {
    ...item,
    score,
    reasons: reasons.slice(0, 3),
  };
}

function scoreFallback(item, dismissedKeys, watchedKeys) {
  if (dismissedKeys.has(item.ratingKey)) return null;
  if (watchedKeys.has(item.ratingKey)) return null;
  return {
    ...item,
    score: item.audienceRating,
    reasons: item.audienceRating >= 8 ? ['Highly Rated'] : [],
  };
}

async function getRecommendations(userId, userToken) {
  const userIdStr = String(userId);
  const cached = recCache.get(userIdStr);
  if (cached && Date.now() - cached.builtAt < REC_CACHE_TTL) {
    // Refresh watchlist status
    const watchlist = await plexService.getWatchlist(userToken);
    const watchlistKeys = new Set(watchlist.items.map(i => i.ratingKey));
    const watchlistMap = new Map(watchlist.items.map(i => [i.ratingKey, i]));
    return attachWatchlistStatus(cached.data, watchlistKeys, watchlistMap, watchlist.playlistId);
  }

  // Fetch library + watched keys in parallel (library from DB/cache, watched from DB)
  const [movies, tv, watchedKeys, dismissedKeys] = await Promise.all([
    plexService.getLibraryItems(MOVIES_SECTION),
    plexService.getLibraryItems(TV_SECTION),
    plexService.getWatchedKeys(userId, userToken),
    Promise.resolve(db.getDismissals(userId)),
  ]);

  // Build library map from already-fetched items, then build profile (reuses same data)
  const libraryMap = new Map([...movies, ...tv].map(i => [i.ratingKey, i]));
  const profile = await buildPreferenceProfile(userId, libraryMap);

  // Anime = TV items with 'anime' genre (case-insensitive)
  const animeItems = tv.filter(item =>
    item.genres.some(g => g.toLowerCase() === 'anime')
  );
  const tvOnlyItems = tv.filter(item =>
    !item.genres.some(g => g.toLowerCase() === 'anime')
  );

  let scoredMovies, scoredTV, scoredAnime;

  if (!profile) {
    // No history fallback — sort by rating, filter watched
    scoredMovies = movies.map(i => scoreFallback(i, dismissedKeys, watchedKeys)).filter(Boolean);
    scoredTV = tvOnlyItems.map(i => scoreFallback(i, dismissedKeys, watchedKeys)).filter(Boolean);
    scoredAnime = animeItems.map(i => scoreFallback(i, dismissedKeys, watchedKeys)).filter(Boolean);
  } else {
    scoredMovies = movies
      .map(item => scoreItem(item, profile, dismissedKeys, watchedKeys))
      .filter(Boolean);
    scoredTV = tvOnlyItems
      .map(item => scoreItem(item, profile, dismissedKeys, watchedKeys))
      .filter(Boolean);
    scoredAnime = animeItems
      .map(item => scoreItem(item, profile, dismissedKeys, watchedKeys))
      .filter(Boolean);
  }

  // Sort descending
  scoredMovies.sort((a, b) => b.score - a.score);
  scoredTV.sort((a, b) => b.score - a.score);
  scoredAnime.sort((a, b) => b.score - a.score);

  // Top Picks: best from each category
  const topPicksRaw = [
    ...scoredMovies.slice(0, 5),
    ...scoredTV.slice(0, 4),
    ...scoredAnime.slice(0, 3),
  ];
  topPicksRaw.sort((a, b) => b.score - a.score);
  const topPicks = topPicksRaw.slice(0, 12);

  const result = {
    topPicks,
    movies: scoredMovies.slice(0, 30),
    tvShows: scoredTV.slice(0, 30),
    anime: scoredAnime.slice(0, 30),
  };

  recCache.set(userIdStr, { data: result, builtAt: Date.now() });

  // Attach watchlist status
  const watchlist = await plexService.getWatchlist(userToken);
  const watchlistKeys = new Set(watchlist.items.map(i => i.ratingKey));
  const watchlistMap = new Map(watchlist.items.map(i => [i.ratingKey, i]));
  return attachWatchlistStatus(result, watchlistKeys, watchlistMap, watchlist.playlistId);
}

function attachWatchlistStatus(result, watchlistKeys, watchlistMap, playlistId) {
  function markItems(items) {
    return items.map(item => ({
      ...item,
      isInWatchlist: watchlistKeys.has(item.ratingKey),
      watchlistPlaylistId: playlistId,
      watchlistItemId: watchlistMap.get(item.ratingKey)?.playlistItemId || null,
    }));
  }
  return {
    topPicks: markItems(result.topPicks),
    movies: markItems(result.movies),
    tvShows: markItems(result.tvShows),
    anime: markItems(result.anime),
  };
}

module.exports = { getRecommendations, invalidateUserCache };
