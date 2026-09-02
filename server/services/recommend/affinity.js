// Signed category affinity + multiplicative dampener.
//
// The additive scorers reward everything a user likes (actors, directors,
// similar-title graphs) but had no way to express "this user avoids superhero
// movies" — actor points alone could carry a disliked category to the top.
// This module learns a signed affinity per genre/keyword by comparing the
// user's watch distribution against the candidate pool being scored, then
// converts strong negatives into a score *multiplier* so no amount of additive
// points can override an avoided category.
//
// Pure functions only — no db/network access — so the math is unit-testable.

const C = require('./constants');

// Plex and TMDB disagree on some genre names; TMDB TV also uses combined
// genres ("Sci-Fi & Fantasy"). Normalize to lowercase component names so a
// user profile built from Plex genres matches TMDB candidates and vice versa.
const GENRE_ALIASES = {
  'sci-fi': 'science fiction',
  'science-fiction': 'science fiction',
  'action/adventure': 'action',
  'kids': 'family',
  'children': 'family',
};

function normalizeGenre(name) {
  if (!name) return [];
  return String(name)
    .toLowerCase()
    .split('&')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => GENRE_ALIASES[part] || part);
}

function normalizeKeyword(name) {
  return String(name || '').toLowerCase().trim();
}

// Expand an item's genre list into a deduplicated set of normalized components.
function normalizedGenreSet(genres) {
  const out = new Set();
  for (const g of genres || []) for (const n of normalizeGenre(g)) out.add(n);
  return out;
}

function normalizedKeywordSet(keywords) {
  const out = new Set();
  for (const k of keywords || []) {
    const n = normalizeKeyword(k);
    if (n) out.add(n);
  }
  return out;
}

/**
 * Count how often each normalized genre/keyword appears in the candidate
 * universe. `items` need only `genres` and (optionally) `keywords` arrays.
 * Returns { genres: Map(name → fraction), keywords: Map(name → fraction), count }.
 */
function buildCategoryBaseline(items) {
  const genreCounts = new Map();
  const keywordCounts = new Map();
  let count = 0;
  let kwCount = 0;
  for (const item of items) {
    if (!item) continue;
    count++;
    for (const g of normalizedGenreSet(item.genres)) {
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
    const kws = normalizedKeywordSet(item.keywords);
    if (kws.size) kwCount++;
    for (const k of kws) keywordCounts.set(k, (keywordCounts.get(k) || 0) + 1);
  }
  const genres = new Map();
  for (const [g, n] of genreCounts) genres.set(g, n / Math.max(1, count));
  const keywords = new Map();
  for (const [k, n] of keywordCounts) keywords.set(k, n / Math.max(1, kwCount || count));
  return { genres, keywords, count };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function signedAffinity(userShare, baseShare) {
  return clamp(
    Math.log2((userShare + C.AFFINITY_ALPHA) / (baseShare + C.AFFINITY_ALPHA)),
    -C.AFFINITY_CLAMP, C.AFFINITY_CLAMP,
  );
}

/**
 * Compute signed genre + keyword affinities for a user against a candidate
 * baseline.
 *
 * profile fields consumed (all optional — missing data degrades to neutral):
 *   normGenreWatchWeights   Map(normalized genre → summed watch weight)
 *   normKeywordWatchWeights Map(normalized keyword → summed watch weight)
 *   totalWatchWeight        Σ item weights behind normGenreWatchWeights
 *   totalKeywordWatchWeight Σ item weights for items that had keyword data
 *   watchedItemCount        distinct watched items
 *   keywordItemCount        distinct watched items with keyword data
 *   dismissCategoryCounts   { genres: Map(name→count), keywords: Map(name→count) }
 *   tasteLove / tasteAvoid  { genres: Set, keywords: Set } from the quiz
 *
 * Returns { genres: Map(name→a), keywords: Map(name→a),
 *           hardGenres: Set, hardKeywords: Set }.
 */
function computeAffinities(profile, baseline) {
  const genres = new Map();
  const keywords = new Map();
  const hardGenres = new Set(profile.tasteAvoid?.genres || []);
  const hardKeywords = new Set(profile.tasteAvoid?.keywords || []);
  const loveGenres = profile.tasteLove?.genres || new Set();
  const loveKeywords = profile.tasteLove?.keywords || new Set();

  const totalW = profile.totalWatchWeight || 0;
  const totalKwW = profile.totalKeywordWatchWeight || 0;
  const enoughHistory = (profile.watchedItemCount || 0) >= C.MIN_WATCHED_ITEMS;
  const enoughKwHistory = (profile.keywordItemCount || 0) >= C.MIN_WATCHED_ITEMS;

  const dismissGenres = profile.dismissCategoryCounts?.genres || new Map();
  const dismissKeywords = profile.dismissCategoryCounts?.keywords || new Map();

  function finalize(a, name, dismissCount, isLoved, isAvoided) {
    if (dismissCount) {
      a = clamp(a - Math.min(C.DISMISS_AFFINITY_MAX, C.DISMISS_AFFINITY_STEP * dismissCount),
        -C.AFFINITY_CLAMP, C.AFFINITY_CLAMP);
    }
    if (isLoved) a = Math.max(a, C.TASTE_LOVE_AFFINITY_FLOOR);
    if (isAvoided) a = Math.min(a, C.TASTE_AVOID_AFFINITY_CAP);
    return a;
  }

  // Genres: negative affinity only with enough history AND a common-enough
  // category (avoiding a rare genre is uninformative).
  for (const [g, base] of baseline.genres) {
    const share = totalW > 0 ? (profile.normGenreWatchWeights?.get(g) || 0) / totalW : 0;
    let a = signedAffinity(share, base);
    if ((!enoughHistory || base < C.MIN_GENRE_BASELINE) && a < 0) a = 0;
    a = finalize(a, g, dismissGenres.get(g), loveGenres.has(g), hardGenres.has(g));
    if (a !== 0) genres.set(g, a);
  }
  // Loved/avoided genres absent from the baseline still get an entry so the
  // dampener + affinity boost apply if such an item appears later.
  for (const g of loveGenres) if (!genres.has(g)) genres.set(g, C.TASTE_LOVE_AFFINITY_FLOOR);
  for (const g of hardGenres) if (!genres.has(g) || genres.get(g) > C.TASTE_AVOID_AFFINITY_CAP) genres.set(g, C.TASTE_AVOID_AFFINITY_CAP);

  for (const [k, base] of baseline.keywords) {
    const share = totalKwW > 0 ? (profile.normKeywordWatchWeights?.get(k) || 0) / totalKwW : 0;
    let a = signedAffinity(share, base);
    if ((!enoughKwHistory || base < C.MIN_KEYWORD_BASELINE) && a < 0) a = 0;
    a = finalize(a, k, dismissKeywords.get(k), loveKeywords.has(k), hardKeywords.has(k));
    if (a !== 0) keywords.set(k, a);
  }
  for (const k of loveKeywords) if (!keywords.has(k)) keywords.set(k, C.TASTE_LOVE_AFFINITY_FLOOR);
  for (const k of hardKeywords) if (!keywords.has(k) || keywords.get(k) > C.TASTE_AVOID_AFFINITY_CAP) keywords.set(k, C.TASTE_AVOID_AFFINITY_CAP);

  return { genres, keywords, hardGenres, hardKeywords };
}

function damp(a) {
  if (a >= C.DAMP_START) return 1;
  return 1 - C.DAMP_SLOPE * (-a - (-C.DAMP_START)); // -C.DAMP_START = 0.5
}

/**
 * Multiplicative dampener for one item. Only negative affinities dampen —
 * positive ones already earn additive points elsewhere.
 * Returns { M, matched: [{ name, kind, a, damp }] } (matched only when < 1).
 */
function itemDampener(genres, keywords, affinities) {
  if (!affinities) return { M: 1, matched: [] };
  let M = 1;
  let hardHit = false;
  const matched = [];
  for (const g of normalizedGenreSet(genres)) {
    const a = affinities.genres.get(g);
    if (a === undefined || a >= C.DAMP_START) continue;
    const d = damp(a);
    M *= d;
    if (affinities.hardGenres.has(g)) hardHit = true;
    matched.push({ name: g, kind: 'genre', a: round2(a), damp: round2(d) });
  }
  for (const k of normalizedKeywordSet(keywords)) {
    const a = affinities.keywords.get(k);
    if (a === undefined || a >= C.DAMP_START) continue;
    const d = damp(a);
    M *= d;
    if (affinities.hardKeywords.has(k)) hardHit = true;
    matched.push({ name: k, kind: 'keyword', a: round2(a), damp: round2(d) });
  }
  M = Math.max(hardHit ? C.DAMP_FLOOR_HARD : C.DAMP_FLOOR, M);
  return { M: round2(M) === 1 ? 1 : M, matched };
}

/**
 * Scale an actor's contribution by how well the candidate's genres overlap
 * the genres the user actually watched that actor in. An actor loved in
 * dramas contributes little to a superhero movie.
 *
 * actorGenreCtx: Map(actor → Map(normalized genre → share of actor's weight))
 * actorItemCount: Map(actor → distinct watched items)
 */
function actorContextScale(actor, itemGenres, actorGenreCtx, actorItemCount) {
  if (!actorGenreCtx) return 1;
  const ctx = actorGenreCtx.get(actor);
  if (!ctx) return 1;
  if ((actorItemCount?.get(actor) || 0) < C.ACTOR_CTX_MIN_ITEMS) return 1;
  let overlap = 0;
  for (const g of normalizedGenreSet(itemGenres)) overlap += ctx.get(g) || 0;
  return clamp(C.ACTOR_CTX_BASE + C.ACTOR_CTX_RANGE * overlap, C.ACTOR_CTX_BASE, 1);
}

function round2(v) { return Math.round(v * 100) / 100; }

module.exports = {
  normalizeGenre, normalizeKeyword, normalizedGenreSet, normalizedKeywordSet,
  buildCategoryBaseline, computeAffinities, itemDampener, actorContextScale,
  signedAffinity, damp,
};
