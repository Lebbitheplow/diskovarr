const plexService = require('./plex');
const tautulliService = require('./tautulli');
const tmdbService = require('./tmdb');
const db = require('../db/database');

// Signal type priority for reason display — genre always shows after specific signals
const SIGNAL_TYPE_RANK = { collection: 0, director: 1, similar: 2, actor: 3, keyword: 4, studio: 5, rating: 6, new: 7, genre: 99 };

function getMoviesSection() { return db.getSetting('plex_movies_section', null) || process.env.PLEX_MOVIES_SECTION_ID || '1'; }
function getTvSection()     { return db.getSetting('plex_tv_section', null)     || process.env.PLEX_TV_SECTION_ID     || '2'; }

// Per-user recommendation cache: userId -> { pools, builtAt }
// pools holds large score-sorted arrays; each request samples randomly from them
// so every page load / shuffle gives different results without re-scoring.
const recCache = new Map();
const REC_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Pool sizes — how many items to keep in cache per section
const POOL_SIZES = { movies: 200, tv: 150, anime: 100, topPicks: 150 };

/**
 * Partial Fisher-Yates shuffle — returns the first n items after shuffling in-place.
 * Used for the Top Picks pool (already curated, just want variety in which subset shows).
 */
function partialShuffle(arr, n) {
  const copy = [...arr];
  const end = Math.min(n, copy.length);
  for (let i = 0; i < end; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, end);
}

/**
 * Tiered random sampling from a score-sorted list.
 * Draws ~60% from the top-25% tier, ~30% from the next-35%, ~10% from the rest.
 * Higher-scored items are strongly favoured but not guaranteed — variety is the point.
 */
function tieredSample(items, n) {
  if (items.length <= n) return partialShuffle(items, items.length);

  const t1End = Math.ceil(items.length * 0.25);
  const t2End = Math.ceil(items.length * 0.60);

  const tier1 = items.slice(0, t1End);
  const tier2 = items.slice(t1End, t2End);
  const tier3 = items.slice(t2End);

  const n1 = Math.min(Math.round(n * 0.60), tier1.length);
  const n2 = Math.min(Math.round(n * 0.30), tier2.length);
  const n3 = Math.min(n - n1 - n2, tier3.length);

  const sample = [
    ...partialShuffle(tier1, n1),
    ...partialShuffle(tier2, n2),
    ...partialShuffle(tier3, n3),
  ];

  // Fill any shortfall if a tier was smaller than its target
  if (sample.length < n) {
    const used = new Set(sample.map(i => i.ratingKey));
    for (const item of items) {
      if (sample.length >= n) break;
      if (!used.has(item.ratingKey)) sample.push(item);
    }
  }

  return sample;
}

function invalidateUserCache(userId) {
  recCache.delete(String(userId));
}

function normalizeMap(map) {
  const max = Math.max(1, ...Array.from(map.values()));
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

  const genreWeights      = new Map();
  const directorWeights   = new Map();
  const actorWeights      = new Map();
  const studioWeights     = new Map();
  const decadeWeights     = new Map();
  const keywordWeights    = new Map();
  const keywordIdWeights  = new Map(); // keyword tmdb id -> { weight, name }
  const collectionWeights = new Map(); // tmdb collection id -> weight

  // Trigger tracking: for each signal key, the watched item that contributed most weight
  const directorTriggers = new Map(); // director -> { title, weight, isHighlyRated }
  const actorTriggers    = new Map();
  const studioTriggers   = new Map();

  // Pre-fetch TMDB keywords for top 60 watched items (all cached after first run)
  const seenForKeywords = new Set();
  const keywordFetchList = [];
  for (const entry of byRecency) {
    if (seenForKeywords.has(entry.rating_key)) continue;
    seenForKeywords.add(entry.rating_key);
    const item = libraryMap.get(entry.rating_key);
    if (item?.tmdbId) keywordFetchList.push(item);
    if (keywordFetchList.length >= 60) break;
  }
  const keywordMap    = new Map(); // ratingKey -> string[]
  const keywordIdMap  = new Map(); // ratingKey -> [{ id, name }]
  const collectionMap = new Map(); // ratingKey -> collectionId
  await Promise.all(keywordFetchList.map(async item => {
    const mt = item.type === 'movie' ? 'movie' : 'tv';
    const details = await tmdbService.getItemDetails(item.tmdbId, mt).catch(() => null);
    if (!details) return;
    if (details.keywords?.length) keywordMap.set(item.ratingKey, details.keywords);
    if (details.keywordIds?.length) keywordIdMap.set(item.ratingKey, details.keywordIds);
    if (details.collection) collectionMap.set(item.ratingKey, details.collection);
  }));

  // Fetch TMDB recommendations + similar for top 20 watched items.
  // Seeds are ranked by recency × star-rating so a loved film outranks a recent-but-meh one.
  // sourceTitle = the seed with highest importance (shown as "Similar to X").
  // Keys stored as Numbers to match TMDB API response types.
  const seedsWithImportance = keywordFetchList.map((seedItem, idx) => {
    const recency = idx < 5 ? 3 : idx < 10 ? 2 : 1;
    const starRating = userRatings.get(seedItem.ratingKey) || 0;
    const starMult = starRating >= 9 ? 2.5 : starRating >= 7 ? 2.0 : starRating >= 5 ? 1.5 : 1.0;
    return { item: seedItem, importance: recency * starMult };
  });
  seedsWithImportance.sort((a, b) => b.importance - a.importance);
  const similarSeeds = seedsWithImportance.slice(0, 20).map(s => s.item);
  const seedImportanceMap = new Map(seedsWithImportance.map(s => [s.item.ratingKey, s.importance]));

  const tmdbSimilarMap = new Map();
  await Promise.all(similarSeeds.map(async item => {
    const mt = item.type === 'movie' ? 'movie' : 'tv';
    const seedWeight = seedImportanceMap.get(item.ratingKey) || 1;
    const [recs, similar] = await Promise.all([
      tmdbService.getRecommendations(item.tmdbId, mt).catch(() => []),
      tmdbService.getSimilar(item.tmdbId, mt).catch(() => []),
    ]);
    for (const r of [...recs, ...similar]) {
      const rid = Number(r.tmdbId);
      const existing = tmdbSimilarMap.get(rid);
      if (existing) {
        existing.weight += seedWeight;
        if (seedWeight > (existing._bestWeight || 0)) {
          existing.sourceTitle = item.title;
          existing._bestWeight = seedWeight;
        }
      } else {
        tmdbSimilarMap.set(rid, { weight: seedWeight, sourceTitle: item.title, _bestWeight: seedWeight });
      }
    }
  }));

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

    // Keywords (from TMDB pre-fetch)
    for (const kw of (keywordMap.get(entry.rating_key) || [])) {
      keywordWeights.set(kw, (keywordWeights.get(kw) || 0) + weight);
    }
    for (const kw of (keywordIdMap.get(entry.rating_key) || [])) {
      const existing = keywordIdWeights.get(kw.id);
      if (existing) existing.weight += weight;
      else keywordIdWeights.set(kw.id, { weight, name: kw.name });
    }

    // Collection/franchise (from TMDB pre-fetch)
    const collectionId = collectionMap.get(entry.rating_key);
    if (collectionId) {
      collectionWeights.set(collectionId, (collectionWeights.get(collectionId) || 0) + weight * 3);
    }
  }

  return {
    genreWeights:      normalizeMap(genreWeights),
    directorWeights:   normalizeMap(directorWeights),
    actorWeights:      normalizeMap(actorWeights),
    studioWeights:     normalizeMap(studioWeights),
    decadeWeights:     normalizeMap(decadeWeights),
    keywordWeights:    normalizeMap(keywordWeights),
    keywordIdWeights,
    collectionWeights: normalizeMap(collectionWeights),
    tmdbSimilarMap,
    directorTriggers,
    actorTriggers,
    studioTriggers,
  };
}

// Genre names that look like titles rather than real genres are filtered out.
// A genre is considered real if it's short (≤20 chars) and ≤3 words.
function isRealGenre(g) {
  return g.length <= 20 && g.split(' ').length <= 3;
}

/**
 * Score an unwatched, non-dismissed item against the preference profile.
 *
 * Scoring budget:
 *   Collection 30pts — same franchise/series
 *   Director   30pts — highest-confidence taste signal
 *   Actor      25pts — accumulates from multiple cast matches
 *   Keywords   25pts — theme/plot similarity
 *   Studio     20pts — A24, Ghibli, HBO etc.
 *   Genre      15pts — supporting signal, capped so it can't dominate
 *   Decade      8pts
 *   Audience rating ≥ 8.5: +5, ≥ 7.5: +2
 *   Recently added (7 days): +3
 */
function scoreItem(item, profile, dismissedKeys, watchedKeys, tmdbEnrich) {
  if (dismissedKeys.has(item.ratingKey)) return null;
  if (watchedKeys.has(item.ratingKey)) return null;

  const { genreWeights, directorWeights, actorWeights, studioWeights, decadeWeights,
          keywordWeights, collectionWeights, tmdbSimilarMap,
          directorTriggers, actorTriggers, studioTriggers } = profile;

  const signals = []; // { pts, reason, type }

  // ── TMDB Similarity (max 40pts) ───────────────────────────────────────────
  // TMDB's own recommendation/similar engine cross-referenced against your library.
  // Weight = sum of how many watched titles point here (higher-recency seeds count more).
  // Plex tmdbId is a string; TMDB API returns numbers — normalise both to Number.
  let similarPts = 0;
  const rawTmdbId = tmdbEnrich?.tmdbId ?? item.tmdbId ?? null;
  const numericTmdbId = rawTmdbId ? Number(rawTmdbId) : null;
  if (numericTmdbId && tmdbSimilarMap) {
    const entry = tmdbSimilarMap.get(numericTmdbId);
    if (entry) {
      similarPts = Math.min(entry.weight * 8, 40);
      if (similarPts > 3) {
        signals.push({ pts: similarPts, reason: `Similar to ${entry.sourceTitle}`, type: 'similar' });
      }
    }
  }

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

  // ── Actor (max 35pts) ─────────────────────────────────────────────────────
  // Each matching cast member contributes w*15; multiple matches stack.
  // Cap raised to 35 — seeing 3 films with the same actor is a strong signal.
  let actPts = 0, topActor = null, actTrigger = null;
  for (const a of item.cast.slice(0, 10)) {
    const w = actorWeights.get(a) || 0;
    if (w > 0.1) {  // require actor to be a meaningful pattern, not a one-off
      actPts += w * 15;
      if (!topActor || w > (actorWeights.get(topActor) || 0)) {
        topActor = a;
        actTrigger = actorTriggers.get(a);
      }
    }
  }
  actPts = Math.min(actPts, 35);
  if (actPts > 3) {
    const reason = (actTrigger?.isHighlyRated)
      ? `Because you loved ${actTrigger.title}`
      : `Starring ${topActor}`;
    signals.push({ pts: actPts, reason, type: 'actor' });
  }

  // ── Genre (max 8pts, tiebreaker only) ───────────────────────────────────────
  // Genre reason only shown when no other signal exists at all — prevents "Because you
  // like Comedy" from crowding out actor/director/similar which are far more personal.
  let genrePts = 0;
  const matchedGenres = [];
  for (const g of item.genres) {
    const w = genreWeights.get(g) || 0;
    genrePts += Math.min(w * 4, 4);
    if (w > 0.35 && isRealGenre(g)) matchedGenres.push({ g, w });
  }
  genrePts = Math.min(genrePts, 8);

  // ── Keywords (max 25pts) ──────────────────────────────────────────────────
  let kwPts = 0, topKw = null;
  const enrichKeywords = tmdbEnrich?.keywords || [];
  for (const kw of enrichKeywords) {
    const w = keywordWeights?.get(kw) || 0;
    if (w > 0.1) {
      kwPts += Math.min(w * 5, 5);
      if (!topKw || w > (keywordWeights.get(topKw) || 0)) topKw = kw;
    }
  }
  kwPts = Math.min(kwPts, 25);
  if (kwPts > 3) {
    signals.push({ pts: kwPts, reason: `Matches themes you enjoy`, type: 'keyword' });
  }

  // ── Collection/franchise (max 30pts) ──────────────────────────────────────
  let collectionPts = 0;
  const enrichCollection = tmdbEnrich?.collection || null;
  if (enrichCollection && collectionWeights) {
    collectionPts = Math.min((collectionWeights.get(enrichCollection) || 0) * 30, 30);
    if (collectionPts > 5) {
      signals.push({ pts: collectionPts, reason: `Part of a series you watch`, type: 'collection' });
    }
  }

  // ── Studio (max 10pts, supporting context only) ────────────────────────────
  let studioPts = 0;
  if (item.studio) {
    studioPts = Math.min((studioWeights.get(item.studio) || 0) * 10, 10);
    // Only show studio as a supporting reason, not the headline
    const hasPersonalSignal = signals.some(s => ['similar', 'director', 'actor', 'keyword', 'collection'].includes(s.type));
    if (studioPts > 3 && hasPersonalSignal) {
      const t = studioTriggers.get(item.studio);
      const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `More from ${item.studio}`;
      signals.push({ pts: studioPts, reason, type: 'studio' });
    }
  }

  // ── Genre (max 8pts) ──────────────────────────────────────────────────────
  // Show genre reason only if fewer than 2 personal signals already exist,
  // and require a meaningful rating (keeps some genre variety without flooding).
  {
    const personalCount = signals.filter(s => ['similar', 'director', 'actor', 'keyword', 'collection'].includes(s.type)).length;
    if (genrePts > 2 && matchedGenres.length > 0 && personalCount < 2) {
      matchedGenres.sort((a, b) => b.w - a.w);
      // Prefer high-rated genre picks — suppress genre reason if item is mediocre
      if (item.audienceRating >= 7.0 || personalCount === 0) {
        signals.push({ pts: genrePts, reason: `Because you like ${matchedGenres[0].g}`, type: 'genre' });
      }
    }
  }

  // ── Decade (max 8pts) ─────────────────────────────────────────────────────
  let decadePts = 0;
  if (item.year) {
    const decade = `${Math.floor(item.year / 10) * 10}s`;
    decadePts = Math.min((decadeWeights.get(decade) || 0) * 8, 8);
  }

  // ── Bonuses ───────────────────────────────────────────────────────────────
  // Rating is a tiebreaker only — small pts, and reason only shown when no
  // specific signals exist (so "Highly Rated" never crowds out actor/director).
  const ratingBonus = item.audienceRating >= 9.0 ? 3
                    : item.audienceRating >= 8.0 ? 1 : 0;
  const hasAnySpecific = signals.some(s => s.type !== 'genre');
  if (ratingBonus >= 3 && !hasAnySpecific) {
    signals.push({ pts: ratingBonus, reason: 'Highly Rated', type: 'rating' });
  }

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const newBonus = (item.addedAt && item.addedAt > sevenDaysAgo) ? 3 : 0;
  if (newBonus) signals.push({ pts: newBonus, reason: 'Recently Added', type: 'new' });

  const score = similarPts + dirPts + actPts + kwPts + collectionPts + genrePts + studioPts + decadePts + ratingBonus + newBonus;

  // Sort signals: specific signals (director/actor/studio/rating) always before genre,
  // so "Because you like Comedy" never crowds out "Directed by X" or "Starring Y"
  const hasSpecific = signals.some(s => s.type !== 'genre' && s.pts > 2);
  signals.sort((a, b) => {
    const ra = SIGNAL_TYPE_RANK[a.type] ?? 50;
    const rb = SIGNAL_TYPE_RANK[b.type] ?? 50;
    if (hasSpecific && ra !== rb) return ra - rb;
    return b.pts - a.pts;
  });
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

  // Seed: top 4 pure-score items
  const combined = [...scoredMovies, ...scoredTV, ...scoredAnime].sort((a, b) => b.score - a.score);
  for (const item of combined.slice(0, 4)) {
    if (!used.has(item.ratingKey)) { picks.push(item); used.add(item.ratingKey); }
  }

  // Director diversity: best 2 items per top-6 directors in profile
  const topDirs = [...profile.directorWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [dir] of topDirs) {
    const t = profile.directorTriggers.get(dir);
    const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `Directed by ${dir}`;
    tryAdd(combined, i => i.directors.includes(dir), reason);
    tryAdd(combined, i => i.directors.includes(dir), reason);
  }

  // Actor diversity: best 2 items per top-6 actors
  const topActors = [...profile.actorWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [actor] of topActors) {
    const t = profile.actorTriggers.get(actor);
    const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `Starring ${actor}`;
    tryAdd(combined, i => i.cast.includes(actor), reason);
    tryAdd(combined, i => i.cast.includes(actor), reason);
  }

  // Studio diversity: best 2 items from top-4 studios
  const topStudios = [...profile.studioWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [studio] of topStudios) {
    const t = profile.studioTriggers.get(studio);
    const reason = (t?.isHighlyRated) ? `Because you loved ${t.title}` : `More from ${studio}`;
    tryAdd(combined, i => i.studio === studio, reason);
    tryAdd(combined, i => i.studio === studio, reason);
  }

  // Fill remainder from top of scored pool
  for (const item of combined) {
    if (picks.length >= POOL_SIZES.topPicks) break;
    if (!used.has(item.ratingKey)) { picks.push(item); used.add(item.ratingKey); }
  }

  return picks.sort((a, b) => b.score - a.score);
}

async function getRecommendations(userId, userToken) {
  const userIdStr = String(userId);
  const cached = recCache.get(userIdStr);

  let pools;
  if (cached && cached.pools && Date.now() - cached.builtAt < REC_CACHE_TTL) {
    // Pools already built — just re-sample (fast, no Plex/Tautulli calls)
    pools = cached.pools;
  } else {
    // Fetch library + watched keys in parallel (library from DB/cache, watched from DB)
    const [movies, tv, watchedKeys, dismissedKeys] = await Promise.all([
      plexService.getLibraryItems(getMoviesSection()),
      plexService.getLibraryItems(getTvSection()),
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

    // Build TMDB enrich map. Keywords/collection from DB cache (no new calls).
    // Similar score comes from tmdbSimilarMap built during profile construction.
    const tmdbEnrichMap = new Map();
    for (const item of [...movies, ...tv]) {
      if (!item.tmdbId) continue;
      const mt = item.type === 'movie' ? 'movie' : 'tv';
      const cached = db.getTmdbCache(item.tmdbId, mt);
      const similarEntry = profile?.tmdbSimilarMap?.get(item.tmdbId);
      if (cached || similarEntry) {
        tmdbEnrichMap.set(item.ratingKey, {
          tmdbId: item.tmdbId,
          keywords: cached?.keywords || [],
          collection: cached?.collection || null,
        });
      } else if (item.tmdbId) {
        // Always pass tmdbId so similarPts lookup works even without cache
        tmdbEnrichMap.set(item.ratingKey, { tmdbId: item.tmdbId, keywords: [], collection: null });
      }
    }

    let scoredMovies, scoredTV, scoredAnime;

    if (!profile) {
      // No history fallback — sort by rating, filter watched
      scoredMovies = movies.map(i => scoreFallback(i, dismissedKeys, watchedKeys)).filter(Boolean);
      scoredTV = tvOnlyItems.map(i => scoreFallback(i, dismissedKeys, watchedKeys)).filter(Boolean);
      scoredAnime = animeItems.map(i => scoreFallback(i, dismissedKeys, watchedKeys)).filter(Boolean);
    } else {
      scoredMovies = movies
        .map(item => scoreItem(item, profile, dismissedKeys, watchedKeys, tmdbEnrichMap.get(item.ratingKey)))
        .filter(Boolean);
      scoredTV = tvOnlyItems
        .map(item => scoreItem(item, profile, dismissedKeys, watchedKeys, tmdbEnrichMap.get(item.ratingKey)))
        .filter(Boolean);
      scoredAnime = animeItems
        .map(item => scoreItem(item, profile, dismissedKeys, watchedKeys, tmdbEnrichMap.get(item.ratingKey)))
        .filter(Boolean);
    }

    // Sort descending — pools are score-sorted so tieredSample tiers work correctly
    scoredMovies.sort((a, b) => b.score - a.score);
    scoredTV.sort((a, b) => b.score - a.score);
    scoredAnime.sort((a, b) => b.score - a.score);

    // Top Picks: diversity-injected blend — buildTopPicks returns full pool sorted by score
    const topPicksPool = profile
      ? buildTopPicks(scoredMovies, scoredTV, scoredAnime, profile)
      : [...scoredMovies.slice(0, 40), ...scoredTV.slice(0, 30), ...scoredAnime.slice(0, 20)]
          .sort((a, b) => b.score - a.score);

    pools = {
      topPicks: topPicksPool,
      movies: scoredMovies.slice(0, POOL_SIZES.movies),
      tvShows: scoredTV.slice(0, POOL_SIZES.tv),
      anime: scoredAnime.slice(0, POOL_SIZES.anime),
    };

    recCache.set(userIdStr, { pools, builtAt: Date.now() });
  }

  // Sample fresh results from the pools on every call — this is what creates variety
  // Top Picks: simple shuffle of the curated pool (all items are good, just vary the subset)
  // Movies/TV/Anime: tiered sampling so higher-scored items are favoured but not always shown
  const result = {
    topPicks: partialShuffle(pools.topPicks, Math.min(72, pools.topPicks.length)),
    movies:   tieredSample(pools.movies,  60),
    tvShows:  tieredSample(pools.tvShows, 60),
    anime:    tieredSample(pools.anime,   60),
  };

  const watchlistKeys = new Set(db.getWatchlistFromDb(userIdStr));
  return attachWatchlistStatus(result, watchlistKeys);
}

function attachWatchlistStatus(result, watchlistKeys) {
  function markItems(items) {
    return items.map(item => ({
      ...item,
      isInWatchlist: watchlistKeys.has(item.ratingKey),
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

module.exports = {
  getRecommendations, invalidateUserCache, invalidateAllCaches,
  // Exported for use by discoverRecommender
  buildPreferenceProfile, partialShuffle, tieredSample,
};
