// Taste-quiz integration for the preference profile.
//
// expandTaste/applyTastePriors are pure (unit-testable). Functions that hit
// the DB or TMDB require their dependencies lazily so importing this module
// never opens the database.

const C = require('./constants');
const { MOODS } = require('./tasteConstants');
const { normalizeGenre, normalizeKeyword } = require('./affinity');

/**
 * Expand raw user_taste rows (+ optional profile-page favorites) into flat
 * love/avoid sets. Mood rows are expanded via tasteConstants.
 *
 * rows: [{ kind, sentiment, entity_id, entity_name, media_type }]
 * Returns {
 *   loveGenres, avoidGenres, loveKeywords, avoidKeywords: Set(normalized),
 *   lovePeople: string[], loveTitles: [{ tmdbId, mediaType, title }],
 * }
 */
function expandTaste(rows, favoriteGenres = []) {
  const out = {
    loveGenres: new Set(), avoidGenres: new Set(),
    loveKeywords: new Set(), avoidKeywords: new Set(),
    lovePeople: [], loveTitles: [],
  };
  const addGenre = (name, sentiment) => {
    for (const n of normalizeGenre(name)) {
      (sentiment === 'avoid' ? out.avoidGenres : out.loveGenres).add(n);
    }
  };
  const addKeyword = (name, sentiment) => {
    const n = normalizeKeyword(name);
    if (n) (sentiment === 'avoid' ? out.avoidKeywords : out.loveKeywords).add(n);
  };

  for (const row of rows || []) {
    switch (row.kind) {
      case 'genre': addGenre(row.entity_name, row.sentiment); break;
      case 'keyword': addKeyword(row.entity_name, row.sentiment); break;
      case 'person':
        if (row.sentiment === 'love' && row.entity_name) out.lovePeople.push(row.entity_name);
        break;
      case 'title':
        if (row.sentiment === 'love' && row.entity_id) {
          out.loveTitles.push({
            tmdbId: Number(row.entity_id),
            mediaType: row.media_type === 'tv' ? 'tv' : 'movie',
            title: row.entity_name,
          });
        }
        break;
      case 'mood': {
        const mood = MOODS.find(m => m.id === row.entity_id || m.id === row.entity_name);
        if (!mood) break;
        for (const g of mood.genres || []) addGenre(g, mood.sentiment);
        for (const k of mood.keywords || []) addKeyword(k, mood.sentiment);
        break;
      }
    }
  }
  // Profile-page favorite genres act as weak loves (handled separately in
  // applyTastePriors via FAVORITE_GENRE_WEIGHT, so keep them distinct).
  out.favoriteGenres = new Set();
  for (const g of favoriteGenres || []) for (const n of normalizeGenre(g)) out.favoriteGenres.add(n);
  // Avoid beats love if the same category somehow lands in both.
  for (const g of out.avoidGenres) out.loveGenres.delete(g);
  for (const k of out.avoidKeywords) out.loveKeywords.delete(k);
  return out;
}

/**
 * Apply quiz priors to a built (post-normalization) preference profile.
 * Mutates the profile: raises weight floors for loved entities and attaches
 * tasteLove/tasteAvoid for computeAffinities. Genre floors are applied on the
 * ORIGINAL (display-cased) map keys where one matches, plus normalized keys so
 * TMDB candidates match too.
 */
function applyTastePriors(profile, taste) {
  if (!profile || !taste) return profile;

  const floorByNormalized = (map, normalizedNames, floor) => {
    if (!map) return;
    const matched = new Set();
    for (const [key, val] of map) {
      const norms = normalizeGenre(key);
      if (norms.some(n => normalizedNames.has(n))) {
        map.set(key, Math.max(val, floor));
        for (const n of norms) matched.add(n);
      }
    }
    for (const n of normalizedNames) if (!matched.has(n)) map.set(n, floor);
  };

  floorByNormalized(profile.genreWeights, taste.loveGenres, C.TASTE_LOVE_GENRE_WEIGHT);
  if (taste.favoriteGenres?.size) {
    floorByNormalized(profile.genreWeights, taste.favoriteGenres, C.FAVORITE_GENRE_WEIGHT);
  }

  for (const person of taste.lovePeople) {
    if (profile.actorWeights) {
      profile.actorWeights.set(person, Math.max(profile.actorWeights.get(person) || 0, C.TASTE_LOVE_PERSON_WEIGHT));
    }
    if (profile.directorWeights) {
      profile.directorWeights.set(person, Math.max(profile.directorWeights.get(person) || 0, C.TASTE_LOVE_PERSON_WEIGHT));
    }
  }

  for (const k of taste.loveKeywords) {
    if (profile.keywordWeights) {
      profile.keywordWeights.set(k, Math.max(profile.keywordWeights.get(k) || 0, C.TASTE_LOVE_GENRE_WEIGHT));
    }
  }

  profile.tasteLove = { genres: taste.loveGenres, keywords: taste.loveKeywords };
  profile.tasteAvoid = { genres: taste.avoidGenres, keywords: taste.avoidKeywords };
  profile.tastePeople = new Set(taste.lovePeople);
  return profile;
}

/** Load + expand the user's taste rows and profile-page favorite genres. */
function loadTaste(userId) {
  const db = require('../../db/database');
  const rows = db.getUserTaste(String(userId));
  let favoriteGenres = [];
  try { favoriteGenres = db.getUserProfile(String(userId))?.favoriteGenres || []; } catch { /* profile optional */ }
  if (!rows.length && !favoriteGenres.length) return null;
  return expandTaste(rows, favoriteGenres);
}

/**
 * Build a taste-only preference profile for users with no watch history
 * (cold start). Shape-compatible with buildPreferenceProfile's return value.
 * Fetches recommendations/similar for loved titles so tmdbSimilarMap has seeds.
 */
async function buildTasteOnlyProfile(taste) {
  const tmdbService = require('../tmdb');
  const empty = () => new Map();
  const profile = {
    genreWeights: empty(), directorWeights: empty(), actorWeights: empty(),
    studioWeights: empty(), decadeWeights: empty(), keywordWeights: empty(),
    keywordIdWeights: empty(), collectionWeights: empty(),
    tmdbSimilarMap: empty(), plexRelatedMap: empty(),
    interestSimilarMap: empty(), interestPlexRelatedMap: empty(),
    dismissalProfile: { genreWeights: empty(), directorWeights: empty(), actorWeights: empty() },
    directorTriggers: empty(), actorTriggers: empty(), studioTriggers: empty(),
    reviewProfile: null,
    normGenreWatchWeights: empty(), normKeywordWatchWeights: empty(),
    totalWatchWeight: 0, totalKeywordWatchWeight: 0,
    watchedItemCount: 0, keywordItemCount: 0,
    actorGenreCtx: empty(), actorItemCount: empty(),
    dismissCategoryCounts: { genres: empty(), keywords: empty() },
    socialLovedMap: empty(),
    isTasteOnly: true,
  };

  await Promise.all(taste.loveTitles.map(async ({ tmdbId, mediaType, title }) => {
    const [recs, similar, details] = await Promise.all([
      tmdbService.getRecommendations(tmdbId, mediaType).catch(() => []),
      tmdbService.getSimilar(tmdbId, mediaType).catch(() => []),
      tmdbService.getItemDetails(tmdbId, mediaType).catch(() => null),
    ]);
    const recSet = new Set(recs.map(r => Number(r.tmdbId)));
    for (const r of [...recs, ...similar]) {
      const rid = Number(r.tmdbId);
      const existing = profile.tmdbSimilarMap.get(rid);
      if (existing) existing.weight += C.TASTE_LOVE_TITLE_SEED_WEIGHT;
      else profile.tmdbSimilarMap.set(rid, {
        weight: C.TASTE_LOVE_TITLE_SEED_WEIGHT, sourceTitle: title,
        fromRec: recSet.has(rid), _bestWeight: C.TASTE_LOVE_TITLE_SEED_WEIGHT,
      });
    }
    if (details) {
      for (const g of details.genres || []) {
        profile.genreWeights.set(g, Math.max(profile.genreWeights.get(g) || 0, 0.5));
      }
      for (const kw of details.keywords || []) {
        const n = normalizeKeyword(kw);
        profile.keywordWeights.set(n, Math.max(profile.keywordWeights.get(n) || 0, 0.4));
      }
      for (const a of (details.cast || []).slice(0, 5)) {
        profile.actorWeights.set(a, Math.max(profile.actorWeights.get(a) || 0, 0.4));
      }
      for (const d of details.directors || []) {
        profile.directorWeights.set(d, Math.max(profile.directorWeights.get(d) || 0, 0.5));
      }
    }
  }));

  return applyTastePriors(profile, taste);
}

module.exports = { expandTaste, applyTastePriors, loadTaste, buildTasteOnlyProfile };
