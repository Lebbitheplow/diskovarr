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

module.exports = router;
