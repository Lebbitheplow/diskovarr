const db = require('../db/database');
const logger = require('./logger');

// Cache of the most-recent public review feed rows. These rows are user-independent:
// reaction_count / comment_count are denormalized columns on `reviews`, so the cached
// base rows are identical for every viewer. The per-request route overlays the three
// user-specific flags (isOwn / isFollowing / hasReacted) on top of these rows.
//
// Mirrors the recommender.js Map+TTL+warm+invalidate pattern (here a single object,
// since the global feed is one shared dataset rather than per-user).
let feedCache = null; // { rows: [...], total: number, builtAt: number }
const FEED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — refreshed by the background job
const FEED_CACHE_SIZE = 200;          // cache the N most-recent public reviews

function isFresh() {
  return feedCache && (Date.now() - feedCache.builtAt) < FEED_CACHE_TTL;
}

/**
 * (Re)build the global public-feed cache from the DB. Safe to call repeatedly; used
 * both by the startup/interval warm job and lazily on a cache miss.
 */
function warmFeedCache() {
  const rows = db.getPublicReviews(FEED_CACHE_SIZE, 0, null);
  const total = db.getPublicReviewsCount(null);
  feedCache = { rows, total, builtAt: Date.now() };
  return feedCache;
}

/**
 * Serve a page of the global (non-followed-only) feed from cache.
 * Returns { rows, total } when the requested slice falls within the cached window,
 * or null when the caller should fall back to a live DB query (deep pagination past
 * the cached window — rare on a home server).
 */
function getGlobalFeedPage(limit, offset) {
  if (!isFresh()) warmFeedCache();
  // Slice exceeds what we cache → let the caller query the DB directly.
  if (offset + limit > feedCache.rows.length && offset + limit <= feedCache.total) {
    return null;
  }
  return {
    rows: feedCache.rows.slice(offset, offset + limit),
    total: feedCache.total,
  };
}

/**
 * Drop the cache so the next read rebuilds it. Called whenever something that affects
 * the public feed changes: a review created/updated/deleted, a comment or reaction
 * added/removed (counts), or a user's review_privacy toggled.
 */
function invalidateFeedCache() {
  feedCache = null;
}

function warmFeedCacheJob() {
  try {
    const { total } = warmFeedCache();
    logger.info(`Review feed cache warmed: ${feedCache.rows.length} rows cached (${total} total public reviews)`);
  } catch (err) {
    logger.debug(`warmFeedCacheJob failed — ${err.message}`);
  }
}

module.exports = {
  warmFeedCache, warmFeedCacheJob, getGlobalFeedPage, invalidateFeedCache,
  FEED_CACHE_TTL,
};
