// Single tuning surface for the recommendation engine.
//
// Tuning workflow (never touch the live DB):
//   1. mkdir -p /tmp/diskovarr-scratch && cp server/data/diskovarr.db /tmp/diskovarr-scratch/
//   2. DISKOVARR_DATA_DIR=/tmp/diskovarr-scratch node scripts/rec-debug.cjs --user <id> --json > baseline.json
//   3. Tweak a constant below, re-run, diff the top-30.

module.exports = {
  // ── Signed affinity (affinity.js) ─────────────────────────────────────────
  // a_c = clamp(log2((u_c + ALPHA) / (b_c + ALPHA)), -CLAMP, +CLAMP)
  AFFINITY_ALPHA: 0.02,          // smoothing so empty categories don't blow up
  AFFINITY_CLAMP: 3,             // |a| ceiling
  MIN_WATCHED_ITEMS: 20,         // below this, no negative affinities (cold user)
  MIN_GENRE_BASELINE: 0.03,      // genre must appear in ≥3% of candidates to go negative
  MIN_KEYWORD_BASELINE: 0.01,    // keywords are sparser — ≥1%
  DISMISS_AFFINITY_STEP: 0.5,    // each dismissed item with category c pushes a_c down…
  DISMISS_AFFINITY_MAX: 1.5,     // …by at most this much total
  TASTE_LOVE_AFFINITY_FLOOR: 0.8,   // quiz "love" ⇒ a_c at least this
  TASTE_AVOID_AFFINITY_CAP: -2.5,   // quiz "avoid" ⇒ a_c at most this

  // ── Multiplicative dampener ───────────────────────────────────────────────
  // damp(a) = 1 for a ≥ DAMP_START; else 1 - DAMP_SLOPE * (-a - DAMP_START)
  // a=-1 → 0.86, -2 → 0.58, -3 → 0.30 with the defaults.
  DAMP_START: -0.5,
  DAMP_SLOPE: 0.28,
  DAMP_FLOOR: 0.25,              // item multiplier M never drops below this…
  DAMP_FLOOR_HARD: 0.10,         // …unless a quiz-avoided category matched

  // ── Actor context scaling ─────────────────────────────────────────────────
  // scale = clamp(ACTOR_CTX_BASE + ACTOR_CTX_RANGE × genre-overlap, base, 1)
  ACTOR_CTX_BASE: 0.35,
  ACTOR_CTX_RANGE: 0.65,
  ACTOR_CTX_MIN_ITEMS: 2,        // skip scaling when we've seen the actor < 2 times

  // ── Additive scoring caps (mirrored in both scorers) ──────────────────────
  DISMISS_PENALTY_CAP: 20,

  // ── Taste quiz priors (tasteProfile.js) ───────────────────────────────────
  TASTE_LOVE_GENRE_WEIGHT: 0.6,     // normalized-map floor for loved genres
  TASTE_LOVE_PERSON_WEIGHT: 0.7,    // floor for loved actors/directors
  TASTE_LOVE_TITLE_SEED_WEIGHT: 2.5,// tmdbSimilarMap weight + virtual-watch weight
  FAVORITE_GENRE_WEIGHT: 0.4,       // profile-page favorite_genres (weak love)
  FAVORITE_MEDIA_SEED_WEIGHT: 1.5,  // profile-page favorite_media seed weight
  MONITOR_GENRE_WEIGHT: 0.3,        // genre criteria on enabled monitors

  // ── Social signal ─────────────────────────────────────────────────────────
  SOCIAL_PTS_PER_LOVER: 8,
  SOCIAL_PTS_CAP: 12,
  SOCIAL_REVIEW_MIN_RATING: 4,      // followee review stars (0.5–5) counted as "loved"
  SOCIAL_REVIEW_MAX_AGE_DAYS: 180,

  // ── Search-history signal ─────────────────────────────────────────────────
  SEARCH_CLICK_MAX_AGE_DAYS: 30,
  SEARCH_CLICK_SEEDS: 5,            // max interest seeds from search clicks

  // TV franchise proxy (title-prefix collections for TV, which TMDB lacks).
  // Off by default — enable to let "Star Trek: X" shows share collection points.
  TV_FRANCHISE_PROXY: false,
  TV_FRANCHISE_CAP: 20,
};
