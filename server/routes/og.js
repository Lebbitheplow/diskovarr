/**
 * Public (unauthenticated) Open Graph image routes for review share cards.
 * Mounted at /og before the SPA catch-all so social crawlers — which have no Plex
 * session — can fetch the generated card. Private reviews 404; spoiler handling and
 * branding live in the card renderer. Images are lazily generated and disk-cached.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getShareData } = require('../services/reviewShare');
const { renderPng } = require('../services/reviewCard');
const { withRenderSlot } = require('../services/cardKit');
const cache = require('../services/reviewCardCache');
const logger = require('../services/logger');

// Public and unauthenticated, so budgeted: a per-IP request rate (crawlers
// fetch a card once; the share modal a handful), plus cardKit's global render
// concurrency for cache misses.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests',
}));

const CACHE_OK = 'public, max-age=604800';

// Set the long-lived caching headers only once the card is actually served,
// so a busy/failed render isn't cached by crawlers or CDNs for a week.
async function sendCard(res, etag, label, render) {
  try {
    const png = await render();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', CACHE_OK);
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    if (err.code === 'RENDER_BUSY') {
      res.setHeader('Retry-After', '5');
      return res.status(503).send('Card renderer busy, try again shortly');
    }
    logger.debug(`og card render failed (${label}) — ${err.message}`);
    res.status(500).send('Failed to render card');
  }
}

function notModified(req, res, etag) {
  if (req.headers['if-none-match'] !== etag) return false;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', CACHE_OK);
  res.status(304).end();
  return true;
}

async function serveCard(req, res, variant) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('Bad request');

  const data = getShareData(id);
  if (!data || data.isPrivate) return res.status(404).send('Not found');

  const updatedAt = data.review.updated_at || 0;
  const etag = `"r${id}-${updatedAt}-${variant}"`;
  if (notModified(req, res, etag)) return;

  await sendCard(res, etag, `review ${id}, ${variant}`, () =>
    cache.getOrCreate(id, updatedAt, variant, () => withRenderSlot(() => renderPng(data.cardData, variant))));
}

// Express 5 dropped inline regex constraints on params; serveCard validates id.
router.get('/review/:id.png', (req, res) => serveCard(req, res, 'og'));
router.get('/review/:id/square.png', (req, res) => serveCard(req, res, 'square'));
router.get('/review/:id/full.png', (req, res) => serveCard(req, res, 'full'));

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
  if (!/^[0-9a-f]{16}$/.test(String(slug))) return res.status(404).send('Not found');
  if (!WRAPPED_CATEGORIES.has(category)) return res.status(400).send('Bad request');

  const data = wrappedStats.getWrappedBySlug(slug);
  if (!data) return res.status(404).send('Not found');

  const etag = `"w${slug}-${data.computedAt}-${category}-${variant}"`;
  if (notModified(req, res, etag)) return;

  await sendCard(res, etag, `wrapped ${slug}/${category}, ${variant}`, () => cache.getOrCreate(
    `wrapped-${slug}-${category}`, data.computedAt, variant,
    () => withRenderSlot(() => wrappedCard.renderPng(data, category, variant))
  ));
}

router.get('/wrapped/:slug/:category.png', (req, res) => serveWrappedCard(req, res, 'og'));
router.get('/wrapped/:slug/:category/square.png', (req, res) => serveWrappedCard(req, res, 'square'));

module.exports = router;
