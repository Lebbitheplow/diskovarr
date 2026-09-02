const plexService = require('./plex');
const tautulliService = require('./tautulli');
const tmdbService = require('./tmdb');
const db = require('../db/database');
const logger = require('./logger');
const C = require('./recommend/constants');
const affinity = require('./recommend/affinity');
const tasteProfile = require('./recommend/tasteProfile');

// Signal type priority for reason display — genre always shows after specific signals
const SIGNAL_TYPE_RANK = { collection: 0, director: 1, similar: 2, taste: 3, actor: 3, social: 4, keyword: 5, studio: 6, rating: 7, new: 8, recent_release: 9, genre: 99 };

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

// "tmdbId:mediaType" → [usernames] of followed users who reviewed it ≥4★.
function buildSocialLovedMap(userId) {
  const map = new Map();
  try {
    for (const row of db.getFolloweeLoved(userId, {
      minRating: C.SOCIAL_REVIEW_MIN_RATING, maxAgeDays: C.SOCIAL_REVIEW_MAX_AGE_DAYS,
    })) {
      const key = `${row.tmdb_id}:${row.media_type}`;
      const names = map.get(key) || [];
      if (row.username && !names.includes(row.username)) names.push(row.username);
      map.set(key, names);
    }
  } catch { /* social signal is optional */ }
  return map;
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
 *   episodes   — TV only: ×2.0 if ≥90% of show watched; else ×(1 + log10(watched)), capped ×2.0
 *
 * For each director/actor/studio we also track the "trigger" item —
 * the watched item with the highest weight — so we can say
 * "Because you loved [title]" when that item was highly rated.
 */
async function buildPreferenceProfile(userId, libraryMap) {
  const [tautulliHistory, userRatings, userReviews] = await Promise.all([
    tautulliService.getFullHistory(userId),
    db.getUserRatingsFromDb(userId),
    Promise.resolve(db.getReviewsForRecommendation(userId)),
  ]);
  // Blend in Jellyfin plays (mirrored into watch_history by the jellyfin
  // service) — one merged profile per canonical user, so a linked account's
  // Plex history informs Jellyfin recommendations and vice versa.
  const jellyfinService = require('./jellyfin');
  const history = [...tautulliHistory, ...jellyfinService.getFullHistoryFromDb(userId)];

  // Quiz-derived taste (loves/avoids). Also the cold-start path: with no
  // watch history at all, a completed quiz still yields a usable profile.
  const taste = tasteProfile.loadTaste(userId);
  const socialLovedMap = buildSocialLovedMap(userId);
  if (!history.length) {
    if (!taste) return null;
    const tasteOnly = await tasteProfile.buildTasteOnlyProfile(taste);
    tasteOnly.socialLovedMap = socialLovedMap;
    return tasteOnly;
  }

  // Build review rating map: tmdbId -> rating (0.5-5 scale)
  const reviewRatings = new Map(); // tmdbId -> rating
  for (const r of userReviews) {
    reviewRatings.set(String(r.tmdb_id), r.rating);
  }

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

  // Signed-affinity inputs: RAW (un-normalized) weighted category distributions
  // keyed by normalized names, plus the totals they're fractions of. Keyword
  // data only exists for the top-60 keyword-fetched items, so keywords get
  // their own denominator — otherwise sparse coverage would read as avoidance.
  const normGenreWatchWeights   = new Map();
  const normKeywordWatchWeights = new Map();
  let totalWatchWeight = 0;
  let totalKeywordWatchWeight = 0;
  const distinctWatched = new Set();
  const distinctKeywordItems = new Set();

  // Actor context: which genres the user actually watches each actor in.
  const actorGenreRaw   = new Map(); // actor -> Map(normalized genre -> weight)
  const actorTotalRaw   = new Map(); // actor -> total weight
  const actorItemSets   = new Map(); // actor -> Set(rating_key)

  // Trigger tracking: for each signal key, the watched item that contributed most weight
  const directorTriggers = new Map(); // director -> { title, weight, isHighlyRated }
  const actorTriggers    = new Map();
  const studioTriggers   = new Map();

  // Review-based preference signals (positive and negative)
  const reviewPositiveGenres = new Map();
  const reviewPositiveDirectors = new Map();
  const reviewPositiveActors = new Map();
  const reviewNegativeGenres = new Map();
  const reviewNegativeDirectors = new Map();
  const reviewNegativeActors = new Map();

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

  // ── Interest seeds: watchlisted + requested items not yet watched ───────────
  // These give the "Because you're interested in [X]" signal.
  const watchedFromDb = db.getWatchedKeysFromDb(userId);
  const watchlistRatingKeys = db.getWatchlistFromDb(userId); // array of ratingKeys
  const recentRequests = db.getRecentRequests(userId, 15);   // [{tmdb_id, media_type, title}]

  // Build tmdbId→ratingKey map for checking if a requested item has since been watched
  const tmdbToRatingKey = new Map();
  for (const [ratingKey, item] of libraryMap) {
    if (item.tmdbId) tmdbToRatingKey.set(String(item.tmdbId), ratingKey);
  }

  // Watchlisted library items not yet watched (capped at 10)
  const interestLibSeeds = watchlistRatingKeys
    .filter(key => !watchedFromDb.has(key))
    .map(key => libraryMap.get(key))
    .filter(Boolean)
    .slice(0, 10);

  // Requested external items not yet watched in the library (capped at 8)
  const interestReqSeeds = recentRequests.filter(r => {
    const libKey = tmdbToRatingKey.get(String(r.tmdb_id));
    return !(libKey && watchedFromDb.has(libKey));
  }).slice(0, 8);

  // ── Dismissal penalty profile ─────────────────────────────────────────────
  // Extract genre/director/actor patterns from items the user has dismissed
  // so content similar to those patterns gets down-ranked.
  const dismissalPenaltyGenres    = new Map();
  const dismissalPenaltyDirs      = new Map();
  const dismissalPenaltyActors    = new Map();
  for (const key of db.getDismissals(userId)) {
    const item = libraryMap.get(key);
    if (!item) continue;
    for (const g of item.genres)    dismissalPenaltyGenres.set(g,  (dismissalPenaltyGenres.get(g)  || 0) + 1);
    for (const d of item.directors) dismissalPenaltyDirs.set(d,    (dismissalPenaltyDirs.get(d)    || 0) + 1);
    for (const a of item.cast)      dismissalPenaltyActors.set(a,  (dismissalPenaltyActors.get(a)  || 0) + 1);
  }
  const dismissalProfile = {
    genreWeights:    normalizeMap(dismissalPenaltyGenres),
    directorWeights: normalizeMap(dismissalPenaltyDirs),
    actorWeights:    normalizeMap(dismissalPenaltyActors),
  };

  // Category-level dismissal counts (normalized genre + keyword names) feeding
  // the signed-affinity model. Library dismissals contribute their genres and
  // (via the TMDB cache — no network calls) keywords; explore dismissals,
  // which previously only hard-excluded, now teach the profile too.
  const dismissGenreCounts = new Map();
  const dismissKeywordCounts = new Map();
  const countDismissed = (genres, keywords) => {
    for (const g of affinity.normalizedGenreSet(genres)) {
      dismissGenreCounts.set(g, (dismissGenreCounts.get(g) || 0) + 1);
    }
    for (const k of affinity.normalizedKeywordSet(keywords)) {
      dismissKeywordCounts.set(k, (dismissKeywordCounts.get(k) || 0) + 1);
    }
  };
  for (const key of db.getDismissals(userId)) {
    const item = libraryMap.get(key);
    if (!item) continue;
    const cachedTmdb = item.tmdbId
      ? db.getTmdbCache(item.tmdbId, item.type === 'movie' ? 'movie' : 'tv')
      : null;
    countDismissed(item.genres, cachedTmdb?.keywords);
  }
  try {
    for (const row of db.getUserExploreDismissalRows(userId)) {
      const cachedTmdb = db.getTmdbCache(row.tmdb_id, row.media_type);
      if (cachedTmdb) countDismissed(cachedTmdb.genres, cachedTmdb.keywords);
    }
  } catch { /* explore dismissal enrichment is best-effort */ }
  const dismissCategoryCounts = { genres: dismissGenreCounts, keywords: dismissKeywordCounts };

  const tmdbSimilarMap = new Map();
  const plexRelatedMap = new Map(); // ratingKey (string) -> { sourceTitle, weight }
  const interestSimilarMap     = new Map(); // numericTmdbId -> { sourceTitle, mediaType, fromSearch? }
  const interestPlexRelatedMap = new Map(); // ratingKey (string) -> { sourceTitle }
  const tasteTitleDetails = [];             // [{ details, title }] loved-title TMDB details
  const searchClickSeeds = (() => {         // recent search clicks → interest seeds
    try {
      return db.getRecentSearchClicks(userId, C.SEARCH_CLICK_MAX_AGE_DAYS, 15)
        .filter(c => c.title).slice(0, C.SEARCH_CLICK_SEEDS);
    } catch { return []; }
  })();

  await Promise.all([
    // TMDB recommendations + similar
    Promise.all(similarSeeds.map(async item => {
      const mt = item.type === 'movie' ? 'movie' : 'tv';
      const seedWeight = seedImportanceMap.get(item.ratingKey) || 1;
      const [recs, similar] = await Promise.all([
        tmdbService.getRecommendations(item.tmdbId, mt).catch(() => []),
        tmdbService.getSimilar(item.tmdbId, mt).catch(() => []),
      ]);
      // Recommendations get "watchers liked" label; similar gets "Similar to"
      const recSet = new Set(recs.map(r => Number(r.tmdbId)));
      for (const r of [...recs, ...similar]) {
        const rid = Number(r.tmdbId);
        const fromRec = recSet.has(rid);
        const existing = tmdbSimilarMap.get(rid);
        if (existing) {
          existing.weight += seedWeight;
          if (seedWeight > (existing._bestWeight || 0)) {
            existing.sourceTitle = item.title;
            existing.fromRec = fromRec;
            existing._bestWeight = seedWeight;
          }
        } else {
          tmdbSimilarMap.set(rid, { weight: seedWeight, sourceTitle: item.title, fromRec, _bestWeight: seedWeight });
        }
      }
    })),

    // Plex /related — surfaces unwatched library items Plex considers related
    // to watched seeds. All hub types used; labeled "[sourceTitle] watchers liked".
    Promise.all(similarSeeds.slice(0, 12).map(async seedItem => {
      const seedWeight = seedImportanceMap.get(seedItem.ratingKey) || 1;
      const hubs = await plexService.getRelated(seedItem.ratingKey).catch(() => []);
      for (const hub of hubs) {
        for (const relItem of hub.items) {
          const key = String(relItem.ratingKey);
          if (key === String(seedItem.ratingKey)) continue; // skip the seed itself
          const existing = plexRelatedMap.get(key);
          if (existing) {
            existing.weight += seedWeight;
            if (seedWeight > (existing._bestWeight || 0)) {
              existing.sourceTitle = seedItem.title;
              existing._bestWeight = seedWeight;
            }
          } else {
            plexRelatedMap.set(key, { sourceTitle: seedItem.title, weight: seedWeight, _bestWeight: seedWeight });
          }
        }
      }
    })),

    // ── Interest: TMDB recs from watchlisted library items ───────────────────
    Promise.all(interestLibSeeds.filter(i => i.tmdbId).map(async item => {
      const mt = item.type === 'movie' ? 'movie' : 'tv';
      const recs = await tmdbService.getRecommendations(item.tmdbId, mt).catch(() => []);
      for (const r of recs) {
        const rid = Number(r.tmdbId);
        if (!interestSimilarMap.has(rid)) {
          interestSimilarMap.set(rid, { sourceTitle: item.title, mediaType: mt });
        }
      }
    })),

    // ── Interest: TMDB recs from requested external items ────────────────────
    Promise.all(interestReqSeeds.map(async req => {
      const mt = req.media_type === 'tv' ? 'tv' : 'movie';
      const recs = await tmdbService.getRecommendations(Number(req.tmdb_id), mt).catch(() => []);
      for (const r of recs) {
        const rid = Number(r.tmdbId);
        if (!interestSimilarMap.has(rid)) {
          interestSimilarMap.set(rid, { sourceTitle: req.title, mediaType: mt });
        }
      }
    })),

    // ── Interest: Plex /related from watchlisted library items ───────────────
    Promise.all(interestLibSeeds.slice(0, 6).map(async seedItem => {
      const hubs = await plexService.getRelated(seedItem.ratingKey).catch(() => []);
      for (const hub of hubs) {
        for (const relItem of hub.items) {
          const key = String(relItem.ratingKey);
          if (key === String(seedItem.ratingKey)) continue;
          if (!interestPlexRelatedMap.has(key)) {
            interestPlexRelatedMap.set(key, { sourceTitle: seedItem.title });
          }
        }
      }
    })),

    // ── Taste: loved-title seeds from the quiz ───────────────────────────────
    // Recs/similar merge into tmdbSimilarMap at a fixed weight; details feed a
    // virtual watch after the history loop so genres/keywords/cast get priors.
    Promise.all((taste?.loveTitles || []).map(async ({ tmdbId, mediaType, title }) => {
      const [recs, similar, details] = await Promise.all([
        tmdbService.getRecommendations(tmdbId, mediaType).catch(() => []),
        tmdbService.getSimilar(tmdbId, mediaType).catch(() => []),
        tmdbService.getItemDetails(tmdbId, mediaType).catch(() => null),
      ]);
      const recSet = new Set(recs.map(r => Number(r.tmdbId)));
      for (const r of [...recs, ...similar]) {
        const rid = Number(r.tmdbId);
        const existing = tmdbSimilarMap.get(rid);
        if (existing) {
          existing.weight += C.TASTE_LOVE_TITLE_SEED_WEIGHT;
        } else {
          tmdbSimilarMap.set(rid, {
            weight: C.TASTE_LOVE_TITLE_SEED_WEIGHT, sourceTitle: title,
            fromRec: recSet.has(rid), _bestWeight: C.TASTE_LOVE_TITLE_SEED_WEIGHT,
          });
        }
      }
      if (details) tasteTitleDetails.push({ details, title });
    })),

    // ── Interest: recent search-result clicks ────────────────────────────────
    Promise.all(searchClickSeeds.map(async click => {
      const mt = click.media_type === 'tv' ? 'tv' : 'movie';
      const recs = await tmdbService.getRecommendations(Number(click.tmdb_id), mt).catch(() => []);
      for (const r of recs) {
        const rid = Number(r.tmdbId);
        if (!interestSimilarMap.has(rid)) {
          interestSimilarMap.set(rid, { sourceTitle: click.title, mediaType: mt, fromSearch: true });
        }
      }
    })),
  ]);

 for (const entry of history) {
    const item = libraryMap.get(entry.rating_key);
    if (!item) continue;

    // --- Multipliers ---
    const recency    = tier1.has(entry.rating_key) ? 1.8 : tier2.has(entry.rating_key) ? 1.3 : 1.0;
    const completion = entry.percent_complete >= 95 ? 1.3 : 1.0;
    const count      = watchCounts.get(entry.rating_key) || 1;
    const rewatch    = Math.min(1 + (count - 1) * 0.4, 2.5);

    // Review rating multiplier (0.5-5 scale, separate from Plex ratings)
    const reviewRating = item.tmdbId ? reviewRatings.get(String(item.tmdbId)) : null;

    // Plex star rating (0–10). A Diskovarr review is synced into the user's Plex
    // rating, so when an item is reviewed we neutralize starMult and let reviewMult
    // be the single authority — otherwise the same rating would be counted twice.
    const starRating = userRatings.get(entry.rating_key) || 0;
    const starMult   = reviewRating != null ? 1.0
                      : starRating >= 9 ? 2.5
                      : starRating >= 7 ? 2.0
                      : starRating >= 5 ? 1.5
                      : starRating > 0  ? 0.4  // rated poorly → down-weight
                      : 1.0;

    const reviewMult = reviewRating == null ? 1.0
      : reviewRating >= 5.0 ? 3.0
      : reviewRating >= 4.5 ? 2.5
      : reviewRating >= 4.0 ? 2.0
      : reviewRating >= 3.5 ? 1.5
      : reviewRating >= 3.0 ? 1.2
      : reviewRating >= 2.5 ? 1.0
      : reviewRating >= 2.0 ? 0.8
      : reviewRating >= 1.5 ? 0.6
      : reviewRating >= 1.0 ? 0.4
      : 0.3; // 0.5

    const epMult     = entry.media_type === 'show'
                      ? (() => {
                          const watched = entry.episodeCount || 1;
                          const total   = item.leafCount || null;
                          // If we know the total and user watched ≥90% → full signal
                          if (total && watched / total >= 0.9) return 2.0;
                          return Math.min(2.0, 1 + Math.log10(watched));
                        })()
                      : 1.0;

    const weight = recency * completion * rewatch * starMult * reviewMult * epMult;
    const isHighlyRated = starRating >= 8 || (reviewRating != null && reviewRating >= 4.0);
    const trigger = { title: item.title, weight, isHighlyRated };

    // Build review-based preference signals
    if (reviewRating != null) {
      const reviewSignal = reviewRating >= 2.5 ? 'positive' : 'negative';
      const absWeight = Math.abs(reviewRating - 2.5) * 2; // 0 to 5 scale
      const targetGenres = reviewSignal === 'positive' ? reviewPositiveGenres : reviewNegativeGenres;
      const targetDirectors = reviewSignal === 'positive' ? reviewPositiveDirectors : reviewNegativeDirectors;
      const targetActors = reviewSignal === 'positive' ? reviewPositiveActors : reviewNegativeActors;
      for (const g of item.genres) targetGenres.set(g, (targetGenres.get(g) || 0) + absWeight);
      for (const d of item.directors) targetDirectors.set(d, (targetDirectors.get(d) || 0) + absWeight * 2);
      for (const a of item.cast) targetActors.set(a, (targetActors.get(a) || 0) + absWeight);
    }

    // Genre — spread across all matching genres
    for (const g of item.genres) {
      genreWeights.set(g, (genreWeights.get(g) || 0) + weight);
    }

    // Affinity distributions (normalized category names, raw weights)
    totalWatchWeight += weight;
    distinctWatched.add(entry.rating_key);
    const normGenres = affinity.normalizedGenreSet(item.genres);
    for (const g of normGenres) {
      normGenreWatchWeights.set(g, (normGenreWatchWeights.get(g) || 0) + weight);
    }
    const entryKeywords = keywordMap.get(entry.rating_key);
    if (entryKeywords) {
      totalKeywordWatchWeight += weight;
      distinctKeywordItems.add(entry.rating_key);
      for (const k of affinity.normalizedKeywordSet(entryKeywords)) {
        normKeywordWatchWeights.set(k, (normKeywordWatchWeights.get(k) || 0) + weight);
      }
    }

    // Director — higher per-item weight since it's a precise signal
    for (const d of item.directors) {
      const w = (directorWeights.get(d) || 0) + weight * 2.0;
      directorWeights.set(d, w);
      const ex = directorTriggers.get(d);
      if (!ex || trigger.weight > ex.weight) directorTriggers.set(d, trigger);
    }

    // Actor — plus per-actor genre context for context-aware actor scoring
    for (const a of item.cast) {
      const w = (actorWeights.get(a) || 0) + weight;
      actorWeights.set(a, w);
      const ex = actorTriggers.get(a);
      if (!ex || trigger.weight > ex.weight) actorTriggers.set(a, trigger);
      let ctx = actorGenreRaw.get(a);
      if (!ctx) { ctx = new Map(); actorGenreRaw.set(a, ctx); }
      for (const g of normGenres) ctx.set(g, (ctx.get(g) || 0) + weight);
      actorTotalRaw.set(a, (actorTotalRaw.get(a) || 0) + weight);
      let itemSet = actorItemSets.get(a);
      if (!itemSet) { itemSet = new Set(); actorItemSets.set(a, itemSet); }
      itemSet.add(entry.rating_key);
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

  // Quiz loved-titles count as virtual watches: their genres/keywords/cast
  // nudge the raw distributions so a cold-ish user's loves shape affinity too.
  for (const { details } of tasteTitleDetails) {
    const w = C.TASTE_LOVE_TITLE_SEED_WEIGHT;
    totalWatchWeight += w;
    for (const g of details.genres || []) {
      genreWeights.set(g, (genreWeights.get(g) || 0) + w);
    }
    for (const g of affinity.normalizedGenreSet(details.genres)) {
      normGenreWatchWeights.set(g, (normGenreWatchWeights.get(g) || 0) + w);
    }
    if (details.keywords?.length) {
      totalKeywordWatchWeight += w;
      for (const k of affinity.normalizedKeywordSet(details.keywords)) {
        normKeywordWatchWeights.set(k, (normKeywordWatchWeights.get(k) || 0) + w);
      }
    }
    for (const a of (details.cast || []).slice(0, 5)) {
      actorWeights.set(a, (actorWeights.get(a) || 0) + w);
    }
    for (const d of details.directors || []) {
      directorWeights.set(d, (directorWeights.get(d) || 0) + w * 2.0);
    }
  }

  // Actor context shares: fraction of each actor's watched weight per genre.
  const actorGenreCtx = new Map();
  for (const [actor, ctx] of actorGenreRaw) {
    const total = actorTotalRaw.get(actor) || 1;
    const shares = new Map();
    for (const [g, w] of ctx) shares.set(g, w / total);
    actorGenreCtx.set(actor, shares);
  }
  const actorItemCount = new Map();
  for (const [actor, set] of actorItemSets) actorItemCount.set(actor, set.size);

  const profile = {
    genreWeights:      normalizeMap(genreWeights),
    directorWeights:   normalizeMap(directorWeights),
    actorWeights:      normalizeMap(actorWeights),
    studioWeights:     normalizeMap(studioWeights),
    decadeWeights:     normalizeMap(decadeWeights),
    keywordWeights:    normalizeMap(keywordWeights),
    keywordIdWeights,
    collectionWeights: normalizeMap(collectionWeights),
    tmdbSimilarMap,
    plexRelatedMap,
    interestSimilarMap,
    interestPlexRelatedMap,
    dismissalProfile,
    directorTriggers,
    actorTriggers,
    studioTriggers,
    reviewProfile: reviewRatings.size > 0 ? {
      positiveGenres: normalizeMap(reviewPositiveGenres),
      positiveDirectors: normalizeMap(reviewPositiveDirectors),
      positiveActors: normalizeMap(reviewPositiveActors),
      negativeGenres: normalizeMap(reviewNegativeGenres),
      negativeDirectors: normalizeMap(reviewNegativeDirectors),
      negativeActors: normalizeMap(reviewNegativeActors),
    } : null,
    // Signed-affinity inputs (see recommend/affinity.js)
    normGenreWatchWeights,
    normKeywordWatchWeights,
    totalWatchWeight,
    totalKeywordWatchWeight,
    watchedItemCount: distinctWatched.size,
    keywordItemCount: distinctKeywordItems.size,
    actorGenreCtx,
    actorItemCount,
    dismissCategoryCounts,
    socialLovedMap,
  };

  // Enabled monitors' genre criteria act as weak explicit interests.
  try {
    for (const monitor of db.getMonitors(userId)) {
      if (!monitor.enabled) continue;
      for (const crit of db.getCriteria(monitor.id)) {
        if (crit.type !== 'genre' || !crit.entityName) continue;
        profile.genreWeights.set(crit.entityName,
          Math.max(profile.genreWeights.get(crit.entityName) || 0, C.MONITOR_GENRE_WEIGHT));
      }
    }
  } catch { /* monitors are optional */ }

  return taste ? tasteProfile.applyTastePriors(profile, taste) : profile;
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
          keywordWeights, collectionWeights, tmdbSimilarMap, plexRelatedMap,
          interestSimilarMap, interestPlexRelatedMap, dismissalProfile, reviewProfile,
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
        const reason = entry.fromRec
          ? `${entry.sourceTitle} watchers liked`
          : `Similar to ${entry.sourceTitle}`;
        signals.push({ pts: similarPts, reason, type: 'similar' });
      }
    }
  }

  // ── Plex /related (max 30pts) ────────────────────────────────────────────
  // Library items returned by Plex's own /related hubs for items the user has watched.
  // Labelled "[sourceTitle] watchers liked" since Plex curates these as related picks.
  let plexRelatedPts = 0;
  if (plexRelatedMap) {
    const entry = plexRelatedMap.get(item.ratingKey);
    if (entry) {
      plexRelatedPts = Math.min(entry.weight * 7, 30);
      if (plexRelatedPts > 3) {
        signals.push({ pts: plexRelatedPts, reason: `${entry.sourceTitle} watchers liked`, type: 'similar' });
      }
    }
  }

  // ── Interest signals (watchlist + request seeds, max 14pts) ─────────────
  // Items TMDB recommends based on things the user has watchlisted or requested.
  // Intentionally lighter than watch-history signals (user hasn't seen these yet)
  // — enough to surface relevant results but won't crowd out director/actor/etc.
  let interestSimilarPts = 0;
  if (interestSimilarMap && numericTmdbId) {
    const entry = interestSimilarMap.get(numericTmdbId);
    if (entry) {
      interestSimilarPts = 14;
      const reason = entry.fromSearch
        ? `Because you searched for ${entry.sourceTitle}`
        : `Because you're interested in ${entry.sourceTitle}`;
      signals.push({ pts: interestSimilarPts, reason, type: 'similar' });
    }
  }

  // Plex /related for watchlisted items — library items Plex considers related
  // to something the user has explicitly added to their watchlist.
  let interestPlexRelatedPts = 0;
  if (interestPlexRelatedMap && !interestSimilarPts) {
    const entry = interestPlexRelatedMap.get(item.ratingKey);
    if (entry) {
      interestPlexRelatedPts = 11;
      signals.push({ pts: interestPlexRelatedPts, reason: `Because you're interested in ${entry.sourceTitle}`, type: 'similar' });
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
  // Each matching cast member contributes w*15, scaled by genre context:
  // an actor the user only watches in dramas earns a fraction of their points
  // on an action flick (see affinity.actorContextScale).
  let actPts = 0, topActor = null, actTrigger = null;
  for (const a of item.cast.slice(0, 10)) {
    const w = actorWeights.get(a) || 0;
    if (w > 0.1) {  // require actor to be a meaningful pattern, not a one-off
      const scale = affinity.actorContextScale(a, item.genres, profile.actorGenreCtx, profile.actorItemCount);
      actPts += w * 15 * scale;
      if (!topActor || w > (actorWeights.get(topActor) || 0)) {
        topActor = a;
        actTrigger = actorTriggers.get(a);
      }
    }
  }
  actPts = Math.min(actPts, 35);
  if (actPts > 3) {
    const isTastePick = profile.tastePeople?.has(topActor);
    const reason = isTastePick ? `One of your favorites: ${topActor}`
      : (actTrigger?.isHighlyRated) ? `Because you loved ${actTrigger.title}`
      : `Starring ${topActor}`;
    signals.push({ pts: actPts, reason, type: isTastePick ? 'taste' : 'actor' });
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

  // ── Release recency bonus ────────────────────────────────────────────────
  let recentReleasePts = 0;
  if (item.year) {
    const age = new Date().getFullYear() - item.year;
    if (age <= 1) {
      recentReleasePts = 5;
      signals.push({ pts: 5, reason: 'Recently released', type: 'recent_release' });
    } else if (age <= 2) {
      recentReleasePts = 3;
      signals.push({ pts: 3, reason: null, type: 'recent_release' });
    } else if (age <= 3) {
      recentReleasePts = 1;
      signals.push({ pts: 1, reason: null, type: 'recent_release' });
    }
  }

  // ── Social: loved by people you follow (max 12pts) ───────────────────────
  let socialPts = 0;
  if (profile.socialLovedMap?.size && numericTmdbId) {
    const mt = item.type === 'movie' ? 'movie' : 'tv';
    const lovers = profile.socialLovedMap.get(`${numericTmdbId}:${mt}`);
    if (lovers?.length) {
      socialPts = Math.min(C.SOCIAL_PTS_PER_LOVER * lovers.length, C.SOCIAL_PTS_CAP);
      signals.push({ pts: socialPts, reason: `Loved by ${lovers[0]}`, type: 'social' });
    }
  }

  // ── Dismissal penalty (max -20pts) ───────────────────────────────────────
  // Down-rank content whose genres/directors/actors match patterns from dismissed items.
  // This doesn't exclude the item — it just lowers its score relative to others.
  let dismissPenalty = 0;
  if (dismissalProfile) {
    const { genreWeights: dgw, directorWeights: ddw, actorWeights: daw } = dismissalProfile;
    for (const g of item.genres)           dismissPenalty += (dgw.get(g) || 0) * 2;
    for (const d of item.directors)        dismissPenalty += (ddw.get(d) || 0) * 3;
    for (const a of item.cast.slice(0, 5)) dismissPenalty += (daw.get(a) || 0) * 2;
    dismissPenalty = Math.min(dismissPenalty, C.DISMISS_PENALTY_CAP);
  }

  // ── Review penalty/bonus (max -5 / +5) ───────────────────────────────────
  // Content matching patterns from poorly-rated reviews gets penalized.
  // Content matching patterns from highly-rated reviews gets a small bonus.
  let reviewPenalty = 0;
  let reviewBonus = 0;
  if (reviewProfile) {
    for (const g of item.genres) {
      reviewPenalty += (reviewProfile.negativeGenres.get(g) || 0) * 1.5;
      reviewBonus += (reviewProfile.positiveGenres.get(g) || 0) * 1.5;
    }
    for (const d of item.directors) {
      reviewPenalty += (reviewProfile.negativeDirectors.get(d) || 0) * 2;
      reviewBonus += (reviewProfile.positiveDirectors.get(d) || 0) * 2;
    }
    for (const a of item.cast.slice(0, 5)) {
      reviewPenalty += (reviewProfile.negativeActors.get(a) || 0) * 1;
      reviewBonus += (reviewProfile.positiveActors.get(a) || 0) * 1;
    }
    reviewPenalty = Math.min(reviewPenalty, 5);
    reviewBonus = Math.min(reviewBonus, 5);
  }

  // ── Multiplicative dampener ──────────────────────────────────────────────
  // Signed negative affinities (avoided genres/keywords) suppress the whole
  // positive sum — no amount of actor points overrides an avoided category.
  const enrichKeywordsForDamp = tmdbEnrich?.keywords || [];
  const { M, matched: dampMatched } = affinity.itemDampener(item.genres, enrichKeywordsForDamp, profile.affinity);

  const positiveSum = similarPts + plexRelatedPts + interestSimilarPts + interestPlexRelatedPts +
                      dirPts + actPts + kwPts + collectionPts + genrePts + studioPts + decadePts +
                      recentReleasePts + socialPts;
  const score = positiveSum * M + ratingBonus + newBonus + reviewBonus - dismissPenalty - reviewPenalty;

  const breakdown = {
    similarPts, plexRelatedPts, interestSimilarPts, interestPlexRelatedPts,
    dirPts, actPts, kwPts, collectionPts, genrePts, studioPts, decadePts,
    recentReleasePts, socialPts, ratingBonus, newBonus, reviewBonus,
    dismissPenalty, reviewPenalty,
    dampener: M < 0.85 ? { M, categories: dampMatched } : undefined,
    M,
  };

  // Sort signals: specific signals (director/actor/studio/rating) always before genre,
  // so "Because you like Comedy" never crowds out "Directed by X" or "Starring Y"
  const hasSpecific = signals.some(s => s.type !== 'genre' && s.pts > 2);
  signals.sort((a, b) => {
    const ra = SIGNAL_TYPE_RANK[a.type] ?? 50;
    const rb = SIGNAL_TYPE_RANK[b.type] ?? 50;
    if (hasSpecific && ra !== rb) return ra - rb;
    return b.pts - a.pts;
  });
  const reasons = signals.map(s => s.reason).filter(r => r && r.trim()).slice(0, 3);

  return { ...item, score, reasons, breakdown, _primarySignal: signals[0]?.type };
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

// `sourceFilter` scopes results to one media server ('plex' | 'jellyfin').
// Pools are built and cached over the union of both libraries; filtering
// happens at sample time so the nav toggle doesn't force a rebuild.
async function getRecommendations(userId, userToken, sourceFilter = null) {
  const userIdStr = String(userId);
  const cached = recCache.get(userIdStr);

  let pools;
  if (cached && cached.pools && Date.now() - cached.builtAt < REC_CACHE_TTL) {
    // Pools already built — just re-sample (fast, no Plex/Tautulli calls)
    pools = cached.pools;
  } else {
    const jellyfinService = require('./jellyfin');
    // Fetch library + watched keys in parallel (library from DB/cache, watched from DB).
    // Plex fetches degrade to empty on failure so Jellyfin-only deployments still work;
    // Jellyfin-identity users have no Plex token, so their watched set comes from the DB
    // (kept fresh by the 15-min Jellyfin user sync).
    const isJellyfinUser = String(userId).startsWith('jf_');
    const [plexMovies, plexTv, watchedKeys, dismissedKeys] = await Promise.all([
      plexService.getLibraryItems(getMoviesSection()).catch(() => []),
      plexService.getLibraryItems(getTvSection()).catch(() => []),
      (isJellyfinUser || !userToken)
        ? Promise.resolve(db.getWatchedKeysFromDb(userId))
        : plexService.getWatchedKeys(userId, userToken).catch(() => db.getWatchedKeysFromDb(userId)),
      Promise.resolve(db.getDismissals(userId)),
    ]);
    const jfItems = jellyfinService.isEnabled() ? db.getLibraryItemsBySource('jellyfin') : [];
    const movies = [...plexMovies, ...jfItems.filter(i => i.type === 'movie')];
    const tv = [...plexTv, ...jfItems.filter(i => i.type === 'show')];

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

    // Signed affinity: user's watch distribution vs. this library's baseline.
    // Computed once per pool build; scoreItem reads profile.affinity.
    if (profile) {
      const baselineItems = [...movies, ...tv].map(i => ({
        genres: i.genres,
        keywords: tmdbEnrichMap.get(i.ratingKey)?.keywords || [],
      }));
      profile.affinity = affinity.computeAffinities(profile, affinity.buildCategoryBaseline(baselineItems));
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
  const bySource = (items) => sourceFilter
    ? items.filter(i => (i.source || 'plex') === sourceFilter)
    : items;
  const topPicksPoolFiltered = bySource(pools.topPicks);
  const result = {
    topPicks: partialShuffle(topPicksPoolFiltered, Math.min(72, topPicksPoolFiltered.length)),
    movies:   tieredSample(bySource(pools.movies),  60),
    tvShows:  tieredSample(bySource(pools.tvShows), 60),
    anime:    tieredSample(bySource(pools.anime),   60),
  };

  const watchlistKeys = new Set(db.getWatchlistFromDb(userIdStr));
  const watchedKeys = db.getWatchedKeysFromDb(userIdStr);
  return attachItemStatus(result, watchlistKeys, watchedKeys);
}

function attachItemStatus(result, watchlistKeys, watchedKeys) {
  function markItems(items) {
    return items.map(item => ({
      ...item,
      isInWatchlist: watchlistKeys.has(item.ratingKey),
      isWatched: watchedKeys.has(item.ratingKey),
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

/**
 * Pre-warm recommendation caches for all known users.
 * Called after each library sync so the first page load is instant.
 * Uses DB-cached watched data (no user token needed).
 */
async function warmAllUserCaches() {
  const usersWithTokens = db.getAllKnownUsersWithTokens();
  const allUsers = db.getKnownUsers();
  if (!allUsers.length) return;
  let warmed = 0;
  let skipped = 0;
  for (const { user_id, plex_token } of usersWithTokens) {
    const key = String(user_id);
    const existing = recCache.get(key);
    if (existing && (Date.now() - existing.builtAt) < REC_CACHE_TTL) { skipped++; continue; }
    try {
      await getRecommendations(key, plex_token);
      warmed++;
    } catch (err) {
      logger.debug(`warmAllUserCaches: skip user ${key} — ${err.message}`);
    }
  }
  // Standalone Jellyfin identities have no Plex token but warm fine — their
  // history and watched state are already mirrored into the DB.
  try {
    for (const u of db.getJellyfinUsers()) {
      if (u.linked_user_id) continue; // linked users warm under their Plex id above
      const key = String(u.user_id);
      const existing = recCache.get(key);
      if (existing && (Date.now() - existing.builtAt) < REC_CACHE_TTL) { skipped++; continue; }
      try {
        await getRecommendations(key, null);
        warmed++;
      } catch (err) {
        logger.debug(`warmAllUserCaches: skip jellyfin user ${key} — ${err.message}`);
      }
    }
  } catch { /* jellyfin helpers unavailable — nothing to warm */ }
  const usersWithoutTokens = allUsers.length - usersWithTokens.length;
  if (usersWithoutTokens > 0) {
    logger.info(`Rec pre-warm: ${warmed} warmed, ${skipped} already fresh, ${usersWithoutTokens} users without stored tokens (${allUsers.length} total)`);
  } else {
    logger.info(`Rec pre-warm: ${warmed} warmed, ${skipped} already fresh (${allUsers.length} total users)`);
  }
}

module.exports = {
  getRecommendations, invalidateUserCache, invalidateAllCaches, warmAllUserCaches,
  // Exported for use by discoverRecommender
  buildPreferenceProfile, partialShuffle, tieredSample,
  // Exported for tests and the rec-debug script
  scoreItem, scoreFallback,
};
