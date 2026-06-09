/**
 * Public (unauthenticated) review reads. Mounted at /api/public BEFORE the main
 * authenticated /api router so shared review links work for logged-out recipients
 * and search crawlers. Only public, non-private reviews are exposed; spoiler text is
 * withheld. No per-viewer state (reactions/follows) — that needs a session.
 */
const express = require('express');
const router = express.Router();
const { getShareData, getConfiguredPublicUrl, canShareExternally } = require('../services/reviewShare');

// Share configuration for the client: the canonical link base + whether the
// instance is reachable enough for social-network sharing (crawler-dependent).
router.get('/share-config', (req, res) => {
  res.json({ baseUrl: getConfiguredPublicUrl(), external: canShareExternally() });
});

router.get('/review/:id', (req, res) => {
  const data = getShareData(req.params.id);
  if (!data || data.isPrivate) return res.status(404).json({ error: 'Review not found' });
  const r = data.review;
  res.json({
    id: r.id,
    title: r.title,
    year: r.year,
    mediaType: r.media_type,
    tmdbId: r.tmdb_id,
    username: data.cardData.username,
    rating: r.rating,
    spoiler: !!r.spoiler,
    rewatch: !!r.rewatch,
    // Never expose spoiler text on the public page.
    reviewText: r.spoiler ? '' : (r.review_text || ''),
    createdAt: r.created_at,
    watchedDate: r.watched_date,
  });
});

module.exports = router;
