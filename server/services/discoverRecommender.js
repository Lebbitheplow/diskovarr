const plexService = require('./plex');
const tautulliService = require('./tautulli');
const tmdbService = require('./tmdb');
const { buildPreferenceProfile, partialShuffle, tieredSample } = require('./recommender');
const db = require('../db/database');

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const CANDIDATES_TTL = 8 * 60 * 60 * 1000; // 8 hours for shared candidate pool
const POOL_SIZES = { topPicks: 300, movies: 400, tvShows: 300, anime: 150 };

function makePoolKey(region, language, showMature) {
  return `${region || ''}:${language || ''}:${showMature ? '1' : '0'}`;
}

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
          keywordWeights, collectionWeights, tmdbSimilarMap, interestSimilarMap, dismissalProfile,
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
        const reason = entry.fromRec
          ? `${entry.sourceTitle} watchers liked`
          : `Similar to ${entry.sourceTitle}`;
        signals.push({ pts: similarPts, reason, type: 'similar' });
      }
    }
  }

  // ── Interest signals (watchlist + request seeds, max 14pts) ─────────────
  // Lighter than watch-history signals — user hasn't seen the source yet.
  let interestSimilarPts = 0;
  if (interestSimilarMap && item.tmdbId) {
    const entry = interestSimilarMap.get(Number(item.tmdbId));
    if (entry) {
      interestSimilarPts = 14;
      signals.push({ pts: interestSimilarPts, reason: `Because you're interested in ${entry.sourceTitle}`, type: 'similar' });
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

  // ── Dismissal penalty (max -20pts) ───────────────────────────────────────
  let dismissPenalty = 0;
  if (dismissalProfile) {
    const { genreWeights: dgw, directorWeights: ddw, actorWeights: daw } = dismissalProfile;
    for (const g of (item.genres || []))           dismissPenalty += (dgw.get(g) || 0) * 2;
    for (const d of (item.directors || []))        dismissPenalty += (ddw.get(d) || 0) * 3;
    for (const a of (item.cast || []).slice(0, 5)) dismissPenalty += (daw.get(a) || 0) * 2;
    dismissPenalty = Math.min(dismissPenalty, 8);
  }

  const score = similarPts + interestSimilarPts + dirPts + actPts + kwPts + collectionPts + genrePts + studioPts + decadePts + ratingBonus - dismissPenalty;

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
  // user_watched is the union of Plex + Tautulli + onDeck — more complete than Tautulli alone
  const dbWatchedKeys = db.getWatchedKeysFromDb(userId);

  // Count watches per rating key from Tautulli (has recency + frequency data)
  const counts = new Map();
  const latestAt = new Map();
  for (const e of history) {
    counts.set(e.rating_key, (counts.get(e.rating_key) || 0) + 1);
    const cur = latestAt.get(e.rating_key) || 0;
    if (e.watched_at > cur) latestAt.set(e.rating_key, e.watched_at);
  }

  // Union: user_watched captures items Tautulli may have missed
  // This catches pre-Tautulli watches, items manually marked as watched in Plex, etc.
  const allKeys = new Set([...counts.keys(), ...dbWatchedKeys]);
  if (!allKeys.size) return { topMovieIds: [], topTvIds: [] };

  // Score: Tautulli-known items get count + recency bonus; db-only items get base score of 1
  const now = Math.floor(Date.now() / 1000);
  const scored = [...allKeys].map(key => {
    const count = counts.get(key);
    if (count) {
      const agedays = (now - (latestAt.get(key) || 0)) / 86400;
      const recency = agedays < 30 ? 3 : agedays < 90 ? 2 : agedays < 365 ? 1 : 0;
      return { key, score: count + recency };
    }
    return { key, score: 1 };
  }).sort((a, b) => b.score - a.score);

  // Look up TMDB IDs from library DB; also keep top ratingKeys for Plex /related seeding
  const topMovieIds = [], topTvIds = [], topMovieKeys = [], topTvKeys = [];
  for (const { key } of scored) {
    if (topMovieIds.length >= 35 && topTvIds.length >= 25) break;
    const item = db.getLibraryItemByKey(key);
    if (!item?.tmdbId) continue;
    if (item.type === 'movie' && topMovieIds.length < 35) {
      topMovieIds.push(item.tmdbId);
      topMovieKeys.push(key);
    } else if (item.type === 'show' && topTvIds.length < 25) {
      topTvIds.push(item.tmdbId);
      topTvKeys.push(key);
    }
  }

  return { topMovieIds, topTvIds, topMovieKeys, topTvKeys };
}

/**
 * Fetch and enrich the shared set of TMDB candidates for a given pref combo.
 * Covers genre discovery + trending + anime — parts identical for all users
 * with the same region/language/mature settings.
 * Per-user parts (TMDB recs from watch history, person/keyword candidates)
 * are still fetched inside buildDiscoverPools.
 *
 * Calls getItemDetails on all collected IDs to pre-populate tmdb_cache and
 * stores full enriched item objects in discover_candidates_cache (8hr TTL).
 * Returns Array<enrichedItem> — ready for scoring, no re-fetch needed.
 */
async function fetchSharedCandidates(opts = {}) {
  const poolKey = makePoolKey(opts.region, opts.language, opts.includeAdult);
  const cached = db.getDiscoverCandidates(poolKey);
  if (cached && Date.now() - cached.updatedAt < CANDIDATES_TTL) {
    console.log(`[discoverRec] Shared candidates cache hit for key "${poolKey}" (${cached.items.length} items)`);
    return cached.items;
  }

  console.log(`[discoverRec] Building shared candidates for key "${poolKey}"...`);
  const seen = new Map(); // key -> { tmdbId, mediaType }

  function addId(tmdbId, mediaType) {
    if (!tmdbId) return;
    const mt = mediaType === 'tv' || mediaType === 'show' ? 'tv' : 'movie';
    seen.set(`${tmdbId}:${mt}`, { tmdbId, mediaType: mt });
  }

  // Genre discovery — ALL genres in the maps (not just user's top genres)
  // so the shared pool covers any user regardless of their preferences.
  const popularPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ratedPages = [1, 2, 3, 4, 5];

  const genrePromises = [
    ...Object.values(tmdbService.MOVIE_GENRE_MAP).flatMap(ids => [
      ...popularPages.map(p => tmdbService.discoverByGenreIds('movie', ids, p, 'popularity.desc', opts).then(recs => recs.forEach(r => addId(r.tmdbId, 'movie')))),
      ...ratedPages.map(p => tmdbService.discoverByGenreIds('movie', ids, p, 'vote_average.desc', opts).then(recs => recs.forEach(r => addId(r.tmdbId, 'movie')))),
    ]),
    ...Object.values(tmdbService.TV_GENRE_MAP).flatMap(ids => [
      ...popularPages.map(p => tmdbService.discoverByGenreIds('tv', ids, p, 'popularity.desc', opts).then(recs => recs.forEach(r => addId(r.tmdbId, 'tv')))),
      ...ratedPages.map(p => tmdbService.discoverByGenreIds('tv', ids, p, 'vote_average.desc', opts).then(recs => recs.forEach(r => addId(r.tmdbId, 'tv')))),
    ]),
  ];

  // Trending (global — no region, only mature flag matters)
  const trendingPromises = [
    ...[1, 2, 3, 4, 5].map(p => tmdbService.getTrending('movie', p, { includeAdult: opts.includeAdult }).then(recs => recs.forEach(r => addId(r.tmdbId, 'movie')))),
    ...[1, 2, 3, 4, 5].map(p => tmdbService.getTrending('tv', p, { includeAdult: opts.includeAdult }).then(recs => recs.forEach(r => addId(r.tmdbId, 'tv')))),
  ];

  // Anime — always JP origin, no regional filter
  const animePromise = Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(p => tmdbService.discoverAnime(p)))
    .then(pages => pages.flat().forEach(r => addId(r.tmdbId, 'tv')));

  await Promise.all([...genrePromises, ...trendingPromises, animePromise]);

  const idList = [...seen.values()];
  console.log(`[discoverRec] Fetching details for ${idList.length} shared candidates (key "${poolKey}")...`);

  // Enrich all candidates — populates tmdb_cache so per-user builds are instant DB hits.
  // Only delay between batches when items are actually uncached (real API calls).
  const today = new Date().toISOString().slice(0, 10);
  const enriched = [];
  const BATCH = 15;
  for (let i = 0; i < idList.length; i += BATCH) {
    const batch = idList.slice(i, i + BATCH);
    // Check which items are already in tmdb_cache before fetching
    const hadUncached = batch.some(({ tmdbId, mediaType }) => !db.getTmdbCache(tmdbId, mediaType));
    const results = await Promise.all(batch.map(({ tmdbId, mediaType }) =>
      tmdbService.getItemDetails(tmdbId, mediaType)
    ));
    for (const item of results) {
      if (!item) continue;
      if (item.releaseDate && item.releaseDate > today) continue;
      enriched.push(item);
    }
    // Only rate-limit delay when we actually made API calls
    if (hadUncached && i + BATCH < idList.length) {
      await new Promise(r => setTimeout(r, 80));
    }
  }

  console.log(`[discoverRec] Shared candidates enriched: ${enriched.length} items for key "${poolKey}"`);
  db.setDiscoverCandidates(poolKey, enriched);
  return enriched;
}

async function buildDiscoverPools(userId, userToken) {
  // Read user's stored preferences for pool selection
  const prefs = db.getUserPreferences(userId);
  const discoverOpts = {
    region: prefs.region || null,
    language: prefs.language || null,
    includeAdult: !!prefs.show_mature,
  };

  const [movies, tv, watchedKeys] = await Promise.all([
    plexService.getLibraryItems(db.getSetting('plex_movies_section', null) || process.env.PLEX_MOVIES_SECTION_ID || '1'),
    plexService.getLibraryItems(db.getSetting('plex_tv_section', null) || process.env.PLEX_TV_SECTION_ID || '2'),
    plexService.getWatchedKeys(userId, userToken),
  ]);

  const libraryMap = new Map([...movies, ...tv].map(i => [i.ratingKey, i]));
  const [profile, { topMovieIds, topTvIds, topMovieKeys, topTvKeys }] = await Promise.all([
    buildPreferenceProfile(userId, libraryMap),
    getTopWatchedTmdbIds(userId),
  ]);

  // Library TMDB IDs to exclude from results
  const libraryTmdbIds = db.getLibraryTmdbIds();
  // Title+year fallback for when TMDB IDs aren't populated yet
  const libraryTitleYears = db.getLibraryTitleYearSet();
  // Previously requested items (global — any user requesting marks it for all)
  const requestedIds = db.getAllRequestedTmdbIds();

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
    // Requested items are NOT excluded — they appear as candidates with isRequested flag
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
  const movieRecPromises = topMovieIds.slice(0, 35).flatMap((id, i) => {
    const pages = i < 10 ? [1, 2, 3, 4, 5] : i < 25 ? [1, 2, 3] : [1, 2];
    return pages.map(p => tmdbService.getRecommendations(id, 'movie', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))));
  });
  const movieSimPromises = topMovieIds.slice(0, 25).flatMap((id, i) => {
    const pages = i < 15 ? [1, 2] : [1];
    return pages.map(p => tmdbService.getSimilar(id, 'movie', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))));
  });

  // 2. TMDB recommendations + similar for user's top watched shows
  const tvRecPromises = topTvIds.slice(0, 25).flatMap((id, i) => {
    const pages = i < 10 ? [1, 2, 3, 4] : i < 20 ? [1, 2, 3] : [1, 2];
    return pages.map(p => tmdbService.getRecommendations(id, 'tv', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))));
  });
  const tvSimPromises = topTvIds.slice(0, 20).flatMap((id, i) => {
    const pages = i < 12 ? [1, 2] : [1];
    return pages.map(p => tmdbService.getSimilar(id, 'tv', p).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))));
  });

  // 3. Plex /related seeds — uses same.director and same.actor hubs from the user's top watched
  // items to find second-hop library items, then pulls TMDB recommendations from those too.
  // Capped at top 8 movies + 5 shows to avoid excessive API calls.
  const plexRelatedPromise = (async () => {
    const relatedSeeds = new Set();
    const relatedKeys = [...topMovieKeys.slice(0, 8), ...topTvKeys.slice(0, 5)];
    const hubs = await Promise.all(relatedKeys.map(k => plexService.getRelated(k)));
    for (const itemHubs of hubs) {
      for (const hub of itemHubs) {
        if (!hub.context.includes('same.director') && !hub.context.includes('same.actor')) continue;
        for (const relItem of hub.items) {
          if (!relItem.ratingKey) continue;
          const libItem = db.getLibraryItemByKey(relItem.ratingKey);
          if (libItem?.tmdbId) relatedSeeds.add(`${libItem.tmdbId}:${libItem.type === 'movie' ? 'movie' : 'tv'}`);
        }
      }
    }
    const relatedPromises = [...relatedSeeds].flatMap(seed => {
      const [tmdbId, mt] = seed.split(':');
      return [
        tmdbService.getRecommendations(Number(tmdbId), mt, 1).then(recs => recs.forEach(r => addCandidate(r.tmdbId, mt, r.title, r.year))),
        tmdbService.getRecommendations(Number(tmdbId), mt, 2).then(recs => recs.forEach(r => addCandidate(r.tmdbId, mt, r.title, r.year))),
      ];
    });
    await Promise.all(relatedPromises);
    console.log(`[discoverRec] Plex /related added ${relatedSeeds.size} second-hop seeds for user ${userId}`);
  })();

  // 4. Shared candidates (genre discovery + trending + anime) — fetched once per
  //    region+language+mature combo and reused across all users with matching prefs.
  //    Returns pre-enriched items — no getItemDetails call needed for these.
  let sharedEnrichedItems = [];
  const sharedCandidatesPromise = fetchSharedCandidates(discoverOpts).then(items => {
    sharedEnrichedItems = items;
    // Register in candidateSet for deduplication (per-user candidates won't re-add)
    for (const item of items) {
      if (!item?.tmdbId) continue;
      const mt = item.mediaType === 'tv' || item.mediaType === 'show' ? 'tv' : 'movie';
      candidateSet.set(`${item.tmdbId}:${mt}`, { tmdbId: item.tmdbId, mediaType: mt });
    }
    console.log(`[discoverRec] Loaded ${items.length} pre-enriched shared candidates for user ${userId}`);
  });

  // 3b. Interest seeds: TMDB recs for watchlisted items + recent requests
  // Items the user has explicitly shown interest in act as additional seed sources.
  // Uses the interestSimilarMap built in buildPreferenceProfile (already cached).
  if (profile?.interestSimilarMap?.size) {
    for (const [tmdbId, entry] of profile.interestSimilarMap) {
      addCandidate(tmdbId, entry.mediaType || 'movie', null, null);
    }
    console.log(`[discoverRec] Added ${profile.interestSimilarMap.size} interest-seeded candidates for user ${userId}`);
  }

  // 5. Person-based candidates: top 20 actors + top 12 directors (movie + TV)
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
      tmdbService.discoverByKeywordId('movie', id, 1, discoverOpts).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))),
      tmdbService.discoverByKeywordId('movie', id, 2, discoverOpts).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))),
      tmdbService.discoverByKeywordId('movie', id, 3, discoverOpts).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'movie', r.title, r.year))),
      tmdbService.discoverByKeywordId('tv', id, 1, discoverOpts).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))),
      tmdbService.discoverByKeywordId('tv', id, 2, discoverOpts).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))),
      tmdbService.discoverByKeywordId('tv', id, 3, discoverOpts).then(recs => recs.forEach(r => addCandidate(r.tmdbId, 'tv', r.title, r.year))),
    ]);
  }

  await Promise.all([...movieRecPromises, ...movieSimPromises, ...tvRecPromises, ...tvSimPromises, sharedCandidatesPromise, ...personPromises, ...keywordPromises, plexRelatedPromise]);

  // ── Fetch details for all candidates ────────────────────────────────────
  // Shared candidates are pre-enriched — only fetch details for per-user candidates.
  const sharedKeys = new Set(sharedEnrichedItems.map(i => `${i.tmdbId}:${i.mediaType}`));
  const perUserCandidates = [...candidateSet.values()].filter(
    c => !sharedKeys.has(`${c.tmdbId}:${c.mediaType}`)
  );
  console.log(`[discoverRec] Fetching details for ${perUserCandidates.length} per-user candidates (${sharedEnrichedItems.length} shared pre-enriched) for user ${userId}`);

  const today = new Date().toISOString().slice(0, 10);

  // Filter pre-enriched shared items against this user's library/requests
  const detailedItems = sharedEnrichedItems.filter(item => {
    if (!item) return false;
    if (isAlreadyHave(item.tmdbId, item.mediaType, item.title, item.year)) return false;
    if (item.releaseDate && item.releaseDate > today) return false;
    return true;
  });

  // Fetch per-user candidates — only delay when actual API calls are made
  const BATCH = 15;
  for (let i = 0; i < perUserCandidates.length; i += BATCH) {
    const batch = perUserCandidates.slice(i, i + BATCH);
    const hadUncached = batch.some(({ tmdbId, mediaType }) => !db.getTmdbCache(tmdbId, mediaType));
    const batchResults = await Promise.all(batch.map(({ tmdbId, mediaType }) =>
      tmdbService.getItemDetails(tmdbId, mediaType)
    ));
    detailedItems.push(...batchResults.filter(item => {
      if (!item) return false;
      if (isAlreadyHave(item.tmdbId, item.mediaType, item.title, item.year)) return false;
      if (item.releaseDate && item.releaseDate > today) return false;
      return true;
    }));
    if (hadUncached && i + BATCH < perUserCandidates.length) {
      await new Promise(r => setTimeout(r, 80));
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
  // Safety valve: if the build hangs for 30+ minutes, unlock so the next request can retry
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.warn(`[discover] Build timed out for user ${userIdStr}, clearing in-progress flag`);
    rebuildInProgress.delete(userIdStr);
  }, 10 * 60 * 1000);
  buildDiscoverPools(userId, userToken)
    .then(pools => {
      if (!timedOut) clearTimeout(timeout);
      const builtAt = Date.now();
      discoverCache.set(userIdStr, { pools, builtAt });
      db.setDiscoverPool(userIdStr, pools, builtAt);
      console.log(`[discover] Pool rebuilt for user ${userIdStr}`);
    })
    .catch(err => {
      if (!timedOut) clearTimeout(timeout);
      console.error(`[discover] Background rebuild failed for ${userIdStr}:`, err.message);
    })
    .finally(() => { if (!timedOut) rebuildInProgress.delete(userIdStr); });
}

/**
 * Build trending sections (movies + TV) from TMDB's weekly trending endpoint.
 * Results are filtered to items not in the library, not dismissed, and not
 * already requested.  Fetches 3 pages (up to 60 candidates each); details come
 * from the TMDB DB cache populated during pool building, so this is fast after
 * the first pool build.
 */
async function buildTrendingSections(requestedIds, dismissedIds, libraryTmdbIds, libraryTitleYears, mature) {
  function normTitle(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }
  function isInLibrary(tmdbId, mediaType, title, year) {
    if (libraryTmdbIds.has(String(tmdbId))) return true;
    // Do NOT filter by requestedIds — requested items show in trending with a badge
    const norm = normTitle(title);
    if (libraryTitleYears.has(norm + '|' + (year || ''))) return true;
    if (year) {
      if (libraryTitleYears.has(norm + '|' + (year - 1))) return true;
      if (libraryTitleYears.has(norm + '|' + (year + 1))) return true;
    }
    return false;
  }

  // Fetch 3 pages per type (60 candidates). tmdbFetch caches page results in-process.
  const trendingOpts = { includeAdult: mature };
  const [moviePages, tvPages] = await Promise.all([
    Promise.all([1, 2, 3].map(p => tmdbService.getTrending('movie', p, trendingOpts))),
    Promise.all([1, 2, 3].map(p => tmdbService.getTrending('tv', p, trendingOpts))),
  ]);

  async function enrichAndFilter(candidates, mediaType) {
    // Pre-filter using lightweight data before fetching full details
    const preFiltered = candidates
      .filter(c => !isInLibrary(c.tmdbId, mediaType, c.title, c.year))
      .filter(c => !dismissedIds.has(`${c.tmdbId}:${mediaType}`));

    // Fetch details in parallel — mostly hits DB cache after first pool build
    const details = await Promise.all(
      preFiltered.map(c => tmdbService.getItemDetails(c.tmdbId, mediaType))
    );

    return details
      .filter(item => item && !isInLibrary(item.tmdbId, item.mediaType, item.title, item.year))
      // Adult content is already excluded at query time via include_adult=false/true on getTrending.
      // Applying our broader computed adult flag (which includes TV-MA/R-rated mainstream shows)
      // here would remove too many popular titles from trending.
      .filter(item => !item.isAnime)
      .slice(0, 50)
      .map(item => ({
        ...item,
        isRequested: requestedIds.has(`${item.tmdbId}:${item.mediaType}`),
        reasons: [],
      }));
  }

  const [trendingMovies, trendingTV] = await Promise.all([
    enrichAndFilter(moviePages.flat(), 'movie'),
    enrichAndFilter(tvPages.flat(), 'tv'),
  ]);

  return { trendingMovies, trendingTV };
}

async function getDiscoverRecommendations(userId, userToken, { mature, hideRequested = false } = {}) {
  // Use stored preference as authoritative source; runtime param can override for post-filter
  const prefs = db.getUserPreferences(userId);
  if (mature === undefined) mature = !!prefs.show_mature;
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
    // No cache at all — kick off background build and signal client to poll
    console.log(`[discover] No cache for user ${userIdStr}, building in background...`);
    scheduleRebuild(userId, userToken);
    return { status: 'building' };
  }

  // Sample fresh results from pools on every call
  const requestedIds = db.getAllRequestedTmdbIds();       // global: any user's request
  const userRequestedIds = db.getRequestedTmdbIds(userId); // this user's own requests
  const dismissedIds = db.getExploreDismissedIds(userId);

  function filterAndMark(items) {
    return items
      .filter(item => !dismissedIds.has(`${item.tmdbId}:${item.mediaType}`))
      .filter(item => mature || !item.adult)
      .filter(item => !hideRequested || !requestedIds.has(`${item.tmdbId}:${item.mediaType}`))
      .map(item => ({
        ...item,
        isRequested: requestedIds.has(`${item.tmdbId}:${item.mediaType}`),
        isMyRequest: userRequestedIds.has(`${item.tmdbId}:${item.mediaType}`),
      }));
  }

  // Trending sections run in parallel with the pool sampling — they use
  // the shared TMDB DB cache so they're fast after the first pool build.
  const libraryTmdbIds = db.getLibraryTmdbIds();
  const libraryTitleYears = db.getLibraryTitleYearSet();

  const [trendingResult] = await Promise.all([
    buildTrendingSections(requestedIds, dismissedIds, libraryTmdbIds, libraryTitleYears, mature),
  ]);

  function markTrending(items) {
    return items
      .filter(item => !hideRequested || !requestedIds.has(`${item.tmdbId}:${item.mediaType}`))
      .map(item => ({
        ...item,
        isMyRequest: userRequestedIds.has(`${item.tmdbId}:${item.mediaType}`),
      }));
  }

  return {
    topPicks: filterAndMark(partialShuffle(pools.topPicks, Math.min(72, pools.topPicks.length))),
    movies: filterAndMark(tieredSample(pools.movies, 60)),
    tvShows: filterAndMark(tieredSample(pools.tvShows, 60)),
    anime: filterAndMark(tieredSample(pools.anime, 60)),
    trendingMovies: markTrending(trendingResult.trendingMovies),
    trendingTV: markTrending(trendingResult.trendingTV),
  };
}

/**
 * Refresh shared TMDB candidate pools for every unique pref combo in the DB.
 * Called by the 6-hour background job in server.js.
 * Force-refreshes stale pools; skips ones that are still fresh.
 */
async function refreshSharedCandidatePools() {
  const combos = db.getAllUserPrefsForDiscover();
  console.log(`[discoverRec] refreshSharedCandidatePools: ${combos.length} pref combo(s)`);
  for (const { region, language, show_mature } of combos) {
    const opts = { region, language, includeAdult: !!show_mature };
    const poolKey = makePoolKey(region, language, show_mature);
    const cached = db.getDiscoverCandidates(poolKey);
    if (cached && Date.now() - cached.updatedAt < CANDIDATES_TTL) {
      console.log(`[discoverRec] Shared pool "${poolKey}" is fresh, skipping`);
      continue;
    }
    try {
      await fetchSharedCandidates(opts);
    } catch (err) {
      console.warn(`[discoverRec] refreshSharedCandidatePools failed for "${poolKey}":`, err.message);
    }
  }
}

/**
 * Re-score shared candidates for every known user and update their discover_pool_cache.
 * Mirrors recommender.warmAllUserCaches() — called by the 28-min background job in server.js.
 */
async function warmAllUserDiscoverCaches() {
  const userIds = db.getKnownUserIds();
  if (!userIds.length) return;
  console.log(`[discoverRec] warmAllUserDiscoverCaches: ${userIds.length} user(s)`);
  // Get a representative admin token for Plex API calls (needed for watchedKeys)
  const plexAdminToken = plexService.getAdminToken ? plexService.getAdminToken() : null;
  for (const userId of userIds) {
    try {
      const userToken = plexAdminToken; // use admin token as fallback; per-user token not available here
      const pools = await buildDiscoverPools(userId, userToken);
      const builtAt = Date.now();
      discoverCache.set(String(userId), { pools, builtAt });
      db.setDiscoverPool(String(userId), pools, builtAt);
    } catch (err) {
      console.warn(`[discoverRec] warmAllUserDiscoverCaches failed for user ${userId}:`, err.message);
    }
  }
}

module.exports = {
  getDiscoverRecommendations,
  invalidateUserCache,
  invalidateAllCaches,
  scheduleRebuild,
  refreshSharedCandidatePools,
  warmAllUserDiscoverCaches,
};
