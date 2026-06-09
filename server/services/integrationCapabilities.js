const INTEGRATION_CAPABILITIES = {
  tmdb: {
    name: 'TMDB',
    authType: 'per_user_session',
    ratingScale: { min: 0.5, max: 10.0, step: 0.5 },
    supportsRating: true,
    supportsReviewText: false,
    supportsWatchDate: false,
    supportedMediaTypes: ['movie', 'tv'],
  },
};

function normalizeRatingToTmdb(starRating) {
  const raw = starRating * 2;
  return Math.round(raw * 2) / 2;
}

function mapReviewToTmdb(review) {
  return {
    mediaType: review.media_type || review.mediaType,
    tmdbId: review.tmdb_id || review.tmdbId,
    value: normalizeRatingToTmdb(review.rating),
  };
}

function getCapability(name) {
  return INTEGRATION_CAPABILITIES[name.toLowerCase()] || null;
}

function listCapabilities() {
  return Object.entries(INTEGRATION_CAPABILITIES).map(([key, val]) => ({
    key,
    ...val,
  }));
}

module.exports = {
  INTEGRATION_CAPABILITIES,
  normalizeRatingToTmdb,
  mapReviewToTmdb,
  getCapability,
  listCapabilities,
};
