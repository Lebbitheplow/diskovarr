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
  const out = new Map();
  for (const [k, v] of map) out.set(k, v / max);
  return out;
}

/**
 * Build preference weights from Tautulli watch history + Plex user ratings.
 *
 * Signals tracked:
 *   genre, director, actor, studio, decade
 *
 * Weight multipliers per watched item:
 *   recency    — top-30 most recent: ×1.8, next 70: ×1.3, rest: ×1.0
 *   completion — ≥95% watched: ×1.3
 *   rewatched  — watched N times: ×(1 + 0.4*(N-1)), capped at ×2.5
 *   star rating— 5★(10): ×2.5, 4★(8): ×2.0, 3★(6): ×1.5, ≤2★: ×0.4 (negative signal)
 *
 * For each director/actor/studio we also track the "trigger" item —
 * the watched item with the highest weight — so we can say
 * "Because you loved [title]" when that item was highly rated.
 */
async function buildPreferenceProfile(userId, libraryMap) {
  const [history, userRatings] = await Promise.all([
    tautulliService.getFullHistory(userId),
    db.getUserRatingsFromDb(userId),
  ]);
  if (!history.length) return null;

  // Count how many times each item was watched (re-watch detection)
  const watchCounts = new Map();
  for (const e of history) watchCounts.set(e.rating_key, (watchCounts.get(e.rating_key) || 0) + 1);

  // Recency tiers: top-30 = 1.8×, 31-100 = 1.3×, rest = 1.0×
  const byRecency = [...history].sort((a, b) => b.watched_at - a.watched_at);
  const tier1 = new Set(byRecency.slice(0, 30).map(h => h.rating_key));
  const tier2 = new Set(byRecency.slice(30, 100).map(h => h.rating_key));

  const genreWeights    = new Map();
  const directorWeights = new Map();
  const actorWeights    = new Map();
  const studioWeights   = new Map();
  const decadeWeights   = new Map();

  // Trigger tracking: for each signal key, the watched item that contributed most weight
  const directorTriggers = new Map(); // director -> { title, weight, isHighlyRated }
  const actorTriggers    = new Map();
  const studioTriggers   = new Map();

  for (const entry of history) {
    const item = libraryMap.get(entry.rating_key);
    if (!item) continue;

    // --- Multipliers ---
    const recency    = tier1.has(entry.rating_key) ? 1.8 : tier2.has(entry.rating_key) ? 1.3 : 1.0;
    const completion = entry.percent_complete >= 95 ? 1.3 : 1.0;
    const count      = watchCounts.get(entry.rating_key) || 1;
    const rewatch    = Math.min(1 + (count - 1) * 0.4, 2.5);
    const starRating = userRatings.get(entry.rating_key) || 0;
    const starMult   = starRating >= 9 ? 2.5
                     : starRating >= 7 ? 2.0
                     : starRating >= 5 ? 1.5
                     : starRating > 0  ? 0.4  // rated poorly → down-weight
                     : 1.0;

    const weight = recency * completion * rewatch * starMult;
    const isHighlyRated = starRating >= 8;
    const trigger = { title: item.title, weight, isHighlyRated };

    // Genre — spread across all matching genres
    for (const g of item.genres) {
      genreWeights.set(g, (genreWeights.get(g) || 0) + weight);
    }

    // Director — higher per-item weight since it's a precise signal
    for (const d of item.directors) {
      const w = (directorWeights.get(d) || 0) + weight * 2.0;
      directorWeights.set(d, w);
      const ex = directorTriggers.get(d);
      if (!ex || trigger.weight > ex.weight) directorTriggers.set(d, trigger);
    }

    // Actor
    for (const a of item.cast) {
      const w = (actorWeights.get(a) || 0) + weight;
      actorWeights.set(a, w);
      const ex = actorTriggers.get(a);
      if (!ex || trigger.weight > ex.weight) actorTriggers.set(a, trigger);
    }

    // Studio
    if (item.studio) {
      const w = (studioWeights.get(item.studio) || 0) + weight * 1.5;
      studioWeights.set(item.studio, w);
      const ex = studioTriggers.get(item.studio);
      if (!ex || trigger.weight > ex.weight) studioTriggers.set(item.studio, trigger);
    }

    // Decade
    if (item.year) {
      const decade = `${Math.floor(item.year / 10) * 10}s`;
      decadeWeights.set(decade, (decadeWeights.get(decade) || 0) + weight);
    }
  }

  return {
    genreWeights:    normalizeMap(genreWeights),
    directorWeights: normalizeMap(directorWeights),
    actorWeights:    normalizeMap(actorWeights),
    studioWeights:   normalizeMap(studioWeights),
    decadeWeights:   normalizeMap(decadeWeights),
    directorTriggers,
    actorTriggers,
    studioTriggers,
  };
}

/**
 * Score an unwatched, non-dismissed item against the preference profile.
 *
 * Scoring budget:
 *   Director  30pts  — highest-confidence taste signal
 *   Actor     25pts  — accumulates from multiple cast matches
 *   Genre     20pts  — still important but capped so it can't drown everything
 *   Studio    15pts  — A24, Ghibli, HBO etc.
 *   Decade    8pts
 *   Audience rating ≥ 8.5: +5, ≥ 7.5: +2
 *   Recently added (7 days): +3
 */
function scoreItem(item, profile, dismissedKeys, watchedKeys) {
  if (dismissedKeys.has(item.ratingKey)) return null;
  if (watchedKeys.has(item.ratingKey)) return null;

  const { genreWeights, directorWeights, actorWeights, studioWeights, decadeWeights,
          directorTriggers, actorTriggers, studioTriggers } = profile;

  const signals = []; // { pts, reason, type }

  // ── Director (max 30pts) ──────────────────────────────────────────────────
  let dirPts = 0, topDir = null, dirTrigger = null;
  for (const d of item.directors) {
    const pts = (directorWeights.get(d) || 0) * 30;
    if (pts > dirPts) { dirPts = pts; topDir = d; dirTrigger = directorTriggers.get(d); }
  }
  dirPts = Math.min(dirPts, 30);
  if (dirPts > 3) {
    const reason = (dirTrigger?.isHighlyRated)
      ? `Because you loved ${dirTrigger.title}`
      : `Directed by ${topDir}`;
    signals.push({ pts: dirPts, reason, type: 'director' });
  }

  // ── Actor (max 25pts) ─────────────────────────────────────────────────────
  let actPts = 0, topActor = null, actTrigger = null;
  for (const a of item.cast.slice(0, 10)) {
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
    const reason = (actTrigger?.isHighlyRated)
      ? `Because you loved ${actTrigger.title}`
      : `Starring ${topActor}`;
    signals.push({ pts: actPts, reason, type: 'actor' });
  }

  // ── Genre (max 20pts, each genre capped at 7pts to prevent single-genre flood) ──
  let genrePts = 0;
  const matchedGenres = [];
  for (const g of item.genres) {
    const w = genreWeights.get(g) || 0;
    genrePts += Math.min(w * 7, 7);
    if (w > 0.2) matchedGenres.push({ g, w });
  }
  genrePts = Math.min(genrePts, 20);
  if (genrePts > 2 && matchedGenres.length > 0) {
    matchedGenres.sort((a, b) => b.w - a.w);
    signals.push({ pts: genrePts, reason: `Because you like ${matchedGenres[0].g}`, type: 'genre' });
  }

  // ── Studio (max 15pts) ────────────────────────────────────────────────────
  let studioPts = 0;
  if (item.studio) {
    studioPts = Math.min((studioWeights.get(item.studio) || 0) * 15, 15);
    if (studioPts > 2) {
      const t = studioTriggers.get(item.studio);
      const reason = (t?.isHighlyRated)
        ? `Because you loved ${t.title}`
        : `More from ${item.studio}`;
      signals.push({ pts: studioPts, reason, type: 'studio' });
    }
  }

  // ── Decade (max 8pts) ─────────────────────────────────────────────────────
  let decadePts = 0;
  if (item.year) {
    const decade = `${Math.floor(item.year / 10) * 10}s`;
    decadePts = Math.min((decadeWeights.get(decade) || 0) * 8, 8);
  }

  // ── Bonuses ───────────────────────────────────────────────────────────────
  const ratingBonus = item.audienceRating >= 8.5 ? 5
                    : item.audienceRating >= 7.5 ? 2 : 0;
  if (ratingBonus >= 5) signals.push({ pts: ratingBonus, reason: 'Highly Rated', type: 'rating' });

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const newBonus = (item.addedAt && item.addedAt > sevenDaysAgo) ? 3 : 0;
  if (newBonus) signals.push({ pts: newBonus, reason: 'Recently Added', type: 'new' });

  const score = dirPts + actPts + genrePts + studioPts + decadePts + ratingBonus + newBonus;

  // Top 3 reasons by pts, deduplicated
  signals.sort((a, b) => b.pts - a.pts);
  const reasons = signals.slice(0, 3).map(s => s.reason);

  return { ...item, score, reasons, _primarySignal: signals[0]?.type };
}

function scoreFallback(item, dismissedKeys, watchedKeys) {
  if (dismissedKeys.has(item.ratingKey)) return null;
  if (watchedKeys.has(item.ratingKey)) return null;
  return { ...item, score: item.audienceRating, reasons: item.audienceRating >= 8 ? ['Highly Rated'] : [] };
}

/**
 * Build Top Picks with diversity injection.
 * Ensures at least one pick each for top director, actor, studio, and genre
 * so Top Picks isn't just "your favourite genre × 12".
 */
function buildTopPicks(scoredMovies, scoredTV, scoredAnime, profile) {
  const used = new Set();
  const picks = [];

  function tryAdd(pool, predicate, overrideReason) {
    const match = pool.find(i => !used.has(i.ratingKey) && predicate(i));
    if (match) {
      const item = overrideReason
        ? { ...match, reasons: [overrideReason, ...match.reasons.filter(r => r !== overrideReason)].slice(0, 3) }
        : match;
      picks.push(item);
      used.add(match.ratingKey);
    }
  }

  // Seed: top 3 pure-score items from combined pool (likely genre/director picks)
  const combined = [...scoredMovies, ...scoredTV, ...scoredAnime].sort((a, b) => b.score - a.score);
  for (const item of combined.slice(0, 3)) {
    if (!used.has(item.ratingKey)) { picks.push(item); used.add(item.ratingKey); }
  }

  // Director diversity: best item per top-2 directors in profile
  const topDirs = [...profile.directorWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [dir] of topDirs) {
    const t = profile.directorTriggers.get(dir);
    const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `Directed by ${dir}`;
    tryAdd(combined, i => i.directors.includes(dir), reason);
  }

  // Actor diversity: best item per top-2 actors
  const topActors = [...profile.actorWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [actor] of topActors) {
    const t = profile.actorTriggers.get(actor);
    const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `Starring ${actor}`;
    tryAdd(combined, i => i.cast.includes(actor), reason);
  }

  // Studio diversity: best item from top studio
  const topStudios = [...profile.studioWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1);
  for (const [studio] of topStudios) {
    const t = profile.studioTriggers.get(studio);
    const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `More from ${studio}`;
    tryAdd(combined, i => i.studio === studio, reason);
  }

  // Fill remainder from top of each pool in order
  for (const item of combined) {
    if (picks.length >= 12) break;
    if (!used.has(item.ratingKey)) { picks.push(item); used.add(item.ratingKey); }
  }

  return picks.sort((a, b) => b.score - a.score).slice(0, 12);
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

  // Top Picks: diversity-injected blend
  const topPicks = profile
    ? buildTopPicks(scoredMovies, scoredTV, scoredAnime, profile)
    : [...scoredMovies.slice(0, 5), ...scoredTV.slice(0, 4), ...scoredAnime.slice(0, 3)]
        .sort((a, b) => b.score - a.score).slice(0, 12);

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

function invalidateAllCaches() {
  recCache.clear();
}

module.exports = { getRecommendations, invalidateUserCache, invalidateAllCaches };
