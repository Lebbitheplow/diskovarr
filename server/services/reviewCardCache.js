/**
 * Lazy, on-disk cache for generated review share cards.
 *
 * Cards are only ever rendered the first time a review is actually shared (a crawler
 * or the share modal hits the image route) — never pre-generated — so we don't waste
 * CPU or disk on reviews nobody shares. The filename embeds the review's `updated_at`,
 * so an edited review naturally misses its old file; we also delete stale files on
 * edit/delete (invalidate) and sweep anything old on a timer to bound disk use.
 *
 * Mirrors the warm/invalidate spirit of reviewFeed.js, but file-backed since the
 * payloads are large binaries rather than rows.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_DIR = path.join(__dirname, '../data/og-cache');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // sweep files untouched for 30 days

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function fileFor(id, updatedAt, variant) {
  return path.join(CACHE_DIR, `${id}-${updatedAt}-${variant}.png`);
}

// Coalesce concurrent renders of the same card (crawler bursts) into one job.
const inFlight = new Map();

/**
 * Return a cached PNG buffer for (id, updatedAt, variant), rendering+caching on miss.
 * @param renderFn async () => Buffer — invoked only on a cache miss.
 */
async function getOrCreate(id, updatedAt, variant, renderFn) {
  ensureDir();
  const file = fileFor(id, updatedAt, variant);
  try {
    if (fs.existsSync(file)) {
      fs.utimes(file, new Date(), new Date(), () => {}); // touch for LRU-ish sweep
      return fs.readFileSync(file);
    }
  } catch { /* fall through to render */ }

  if (inFlight.has(file)) return inFlight.get(file);
  const job = (async () => {
    const png = await renderFn();
    try {
      // A new updated_at means a new filename; clear the review's older variants.
      invalidate(id, variant);
      fs.writeFileSync(file, png);
    } catch (err) {
      logger.debug(`reviewCardCache write failed — ${err.message}`);
    }
    return png;
  })().finally(() => inFlight.delete(file));
  inFlight.set(file, job);
  return job;
}

/** Delete cached files for a review (all variants, or one variant if given). */
function invalidate(id, variant = null) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const prefix = `${id}-`;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.startsWith(prefix)) continue;
      if (variant && !f.endsWith(`-${variant}.png`)) continue;
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
    }
  } catch (err) {
    logger.debug(`reviewCardCache invalidate failed — ${err.message}`);
  }
}

/** Delete cards untouched for longer than MAX_AGE_MS. Scheduled from server startup. */
function sweepJob() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const now = Date.now();
    let removed = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) { fs.unlinkSync(p); removed++; }
      } catch {}
    }
    if (removed) logger.info(`reviewCardCache swept ${removed} stale card(s)`);
  } catch (err) {
    logger.debug(`reviewCardCache sweep failed — ${err.message}`);
  }
}

module.exports = { getOrCreate, invalidate, sweepJob };
