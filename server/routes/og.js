/**
 * Public (unauthenticated) Open Graph image routes for review share cards.
 * Mounted at /og before the SPA catch-all so social crawlers — which have no Plex
 * session — can fetch the generated card. Private reviews 404; spoiler handling and
 * branding live in the card renderer. Images are lazily generated and disk-cached.
 */
const express = require('express');
const router = express.Router();
const { getShareData } = require('../services/reviewShare');
const { renderPng } = require('../services/reviewCard');
const cache = require('../services/reviewCardCache');
const logger = require('../services/logger');

async function serveCard(req, res, variant) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('Bad request');

  const data = getShareData(id);
  if (!data || data.isPrivate) return res.status(404).send('Not found');

  const updatedAt = data.review.updated_at || 0;
  const etag = `"r${id}-${updatedAt}-${variant}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=604800');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  try {
    const png = await cache.getOrCreate(id, updatedAt, variant, () => renderPng(data.cardData, variant));
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    logger.debug(`og card render failed (review ${id}, ${variant}) — ${err.message}`);
    res.status(500).send('Failed to render card');
  }
}

router.get('/review/:id(\\d+).png', (req, res) => serveCard(req, res, 'og'));
router.get('/review/:id(\\d+)/square.png', (req, res) => serveCard(req, res, 'square'));

// ── Wrapped stat cards ─────────────────────────────────────────────────────────
// Also public (the share flow needs crawler/no-session access), but unlike review
// cards these carry personal stats, so they're gated by an unguessable per-user
// share slug (64-bit capability) instead of an enumerable id. Sharing the link is
// sharing the image — that's the point; regenerating the slug revokes it.
const wrappedStats = require('../services/wrappedStats');
const wrappedCard = require('../services/wrappedCard');
const WRAPPED_CATEGORIES = new Set(wrappedCard.CATEGORIES);

async function serveWrappedCard(req, res, variant) {
  const { slug, category } = req.params;
  if (!WRAPPED_CATEGORIES.has(category)) return res.status(400).send('Bad request');

  const data = wrappedStats.getWrappedBySlug(slug);
  if (!data) return res.status(404).send('Not found');

  const etag = `"w${slug}-${data.computedAt}-${category}-${variant}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=604800');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  try {
    const png = await cache.getOrCreate(
      `wrapped-${slug}-${category}`, data.computedAt, variant,
      () => wrappedCard.renderPng(data, category, variant)
    );
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    logger.debug(`og wrapped card render failed (${slug}/${category}, ${variant}) — ${err.message}`);
    res.status(500).send('Failed to render card');
  }
}

router.get('/wrapped/:slug([0-9a-f]{16})/:category.png', (req, res) => serveWrappedCard(req, res, 'og'));
router.get('/wrapped/:slug([0-9a-f]{16})/:category/square.png', (req, res) => serveWrappedCard(req, res, 'square'));

module.exports = router;
