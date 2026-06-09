/**
 * Shared helpers for public review sharing: resolve a review into card data +
 * privacy state, and build spoiler/privacy-safe Open Graph meta tags. Used by both
 * the OG image routes (routes/og.js) and the meta-injection middleware (server.js).
 *
 * These read the DB directly and are intentionally NOT behind auth — crawlers and
 * social fetchers have no session. Privacy and spoilers are enforced here so nothing
 * leaks through a public image or preview.
 */
const db = require('./../db/database');

// Admin-configured external URL (Settings → app_public_url), trailing slash trimmed.
function getConfiguredPublicUrl() {
  return (db.getSetting('app_public_url', '') || '').trim().replace(/\/+$/, '');
}

// Mirror of the host check in routes/api.js — a URL reachable only on a LAN/loopback
// can't be crawled by social platforms, so external sharing isn't viable.
function isInternalUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') ||
      h.startsWith('10.') || h.startsWith('172.16.') || h.endsWith('.local') || h.includes('internal');
  } catch {
    return true;
  }
}

// True when a public URL is configured AND it's externally reachable.
function canShareExternally() {
  const u = getConfiguredPublicUrl();
  return !!u && !isInternalUrl(u);
}

function getShareData(id) {
  const reviewId = Number(id);
  if (!Number.isInteger(reviewId)) return null;
  const review = db.getReviewById(reviewId);
  if (!review) return null;

  const prefs = db.getUserPreferences(review.user_id) || {};
  const isPrivate = prefs.review_privacy === 'private';

  const ku = db.prepare('SELECT username, thumb FROM known_users WHERE user_id = ?').get(review.user_id);
  const lib = review.tmdb_id != null
    ? db.getLibraryItemByTmdbId(review.tmdb_id)
    : (review.rating_key ? db.getLibraryItemByKey(review.rating_key) : null);
  const posterPath = lib?.thumb || lib?.art || lib?.posterUrl || null;

  return {
    review,
    isPrivate,
    cardData: {
      username: ku?.username || review.user_id,
      avatar: ku?.thumb || null,
      title: review.title,
      year: review.year,
      rating: review.rating,
      reviewText: review.review_text,
      spoiler: !!review.spoiler,
      dateTs: review.watched_date || review.created_at,
      posterPath,
    },
  };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

const DEFAULT_DESC = 'Personalized Plex recommendations based on your watch history.';

/**
 * Build the <meta> block for a review share page. Falls back to default Diskovarr
 * tags for missing/private reviews (never leaks private content). Spoiler reviews
 * get a neutral description.
 */
function buildOgTags(data, appUrl, id) {
  let title = 'Diskovarr';
  let description = DEFAULT_DESC;
  let image = `${appUrl}/diskovarr-logo.png`;
  let card = 'summary';
  const url = `${appUrl}/review/${id}`;

  if (data && !data.isPrivate) {
    const r = data.review;
    const name = data.cardData.username;
    const yr = r.year ? ` (${r.year})` : '';
    title = `${r.title}${yr} — ${r.rating}★ reviewed by ${name}`;
    description = r.spoiler
      ? 'This review contains spoilers.'
      : (truncate((r.review_text || '').replace(/\s+/g, ' '), 180) || `${r.rating}/5 stars on Diskovarr`);
    image = `${appUrl}/og/review/${id}.png`;
    card = 'summary_large_image';
  }

  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const i = escapeHtml(image);
  const u = escapeHtml(url);
  return [
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Diskovarr">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${i}">`,
    `<meta property="og:url" content="${u}">`,
    `<meta name="twitter:card" content="${card}">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
  ].join('\n  ');
}

module.exports = { getShareData, buildOgTags, escapeHtml, getConfiguredPublicUrl, canShareExternally };
