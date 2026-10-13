/**
 * Shared toolkit for server-side satori share cards (review cards, wrapped cards).
 *
 * satori turns a flexbox VDOM tree into SVG (handling text wrapping/layout), then
 * @resvg/resvg-js rasterizes that SVG to a PNG. Both are pure JS / prebuilt binaries,
 * so this needs no native build step.
 */
const fs = require('fs');
const path = require('path');
const satori = require('satori').default || require('satori');
const { Resvg } = require('@resvg/resvg-js');
const db = require('../db/database');
const plexService = require('./plex');
const posterUpstream = require('./posterUpstream');
const { fetchImage } = require('./imageFetch');

// ── Fonts (loaded once) ──────────────────────────────────────────────────────
const FONT_DIR = path.join(__dirname, '../assets/fonts');
const FONTS = [
  { name: 'Inter', weight: 400, style: 'normal', data: fs.readFileSync(path.join(FONT_DIR, 'Inter-Regular.ttf')) },
  { name: 'Inter', weight: 600, style: 'normal', data: fs.readFileSync(path.join(FONT_DIR, 'Inter-SemiBold.ttf')) },
];

const COLORS = {
  bg: '#0d0e12',
  card: '#16181f',
  border: '#262a35',
  text: '#f3f4f6',
  textDim: '#9aa0ad',
  textMuted: '#6b7280',
};

function accentHex() {
  const c = (db.getThemeColor && db.getThemeColor()) || 'e5a00d';
  return c.startsWith('#') ? c : `#${c}`;
}

// ── Image inlining ─────────────────────────────────────────────────────────────
// satori can't fetch remote images itself; every <img> src must be a data URI.
// Plex/Jellyfin art paths go through the poster proxy's allowlist and are
// fetched pre-shrunk (posters draw at ≤300 logical px, rasterized at 2×);
// http(s) URLs and plex.tv avatars are fetched directly. Every fetch is
// time- and byte-bounded. Returns null on any failure so the caller can fall
// back to a placeholder.
const CARD_IMAGE_WIDTH = 720;
const CARD_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function fetchAsDataUri(src) {
  if (!src || typeof src !== 'string') return null;
  try {
    let url;
    const headers = {};
    let crossOriginRedirects = false;
    if (src.startsWith('http://') || src.startsWith('https://')) {
      url = src;
      crossOriginRedirects = true; // no credentials ride along (avatar CDNs redirect)
    } else if (src.startsWith('/api/jellyfin/avatar/')) {
      // Jellyfin user avatars — resolve the proxy path back to the origin
      const jellyfin = require('./jellyfin');
      if (!jellyfin.isEnabled()) return null;
      const m = src.match(/^\/api\/jellyfin\/avatar\/([A-Za-z0-9-]+)(?:\?tag=([A-Za-z0-9]+))?/);
      if (!m) return null;
      url = `${jellyfin.getJellyfinUrl()}/Users/${m[1]}/Images/Primary${m[2] ? `?tag=${m[2]}` : ''}`;
    } else {
      const kind = posterUpstream.posterKind(src);
      if (kind === 'plex') {
        url = posterUpstream.upstreamUrl(src, {
          width: CARD_IMAGE_WIDTH, plexUrl: plexService.getPlexUrl(), plexToken: plexService.getPlexToken(),
        });
      } else if (kind === 'jellyfin') {
        const jellyfin = require('./jellyfin');
        if (!jellyfin.isEnabled()) return null;
        url = posterUpstream.upstreamUrl(src, { width: CARD_IMAGE_WIDTH, jellyfinUrl: jellyfin.getJellyfinUrl() });
        headers['X-Emby-Token'] = jellyfin.getJellyfinKey();
      }
      if (!url) return null;
    }
    const { contentType, body } = await fetchImage(url, {
      headers, timeoutMs: 8000, maxBytes: CARD_IMAGE_MAX_BYTES, crossOriginRedirects,
    });
    return `data:${contentType};base64,${body.toString('base64')}`;
  } catch {
    return null;
  }
}

function truncate(s, n) {
  if (!s) return '';
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

// Tiny helpers to keep the VDOM readable without JSX in a CommonJS module.
// For <img>, pass the data URI as the 4th arg; satori reads it from props.src.
const el = (type, style, children, src) => ({
  type,
  props: type === 'img' ? { style, src } : { style, children },
});
const txt = (style, t) => el('div', style, t);

// Diskovarr magnifier-over-bars logo as an inline SVG data URI.
function brandLogoUri(accent, size = 30) {
  return `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><rect x="0.5" y="17.5" width="13" height="1.5" rx="0.4" fill="${accent}"/><rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="${accent}"/><rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="${accent}"/><rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="${accent}"/><circle cx="15" cy="9" r="5" stroke="${accent}" stroke-width="2" fill="none"/><line x1="18.5" y1="12.5" x2="22" y2="16" stroke="${accent}" stroke-width="2.5" stroke-linecap="round"/></svg>`
  ).toString('base64')}`;
}

/**
 * Rasterize a satori VDOM tree to a PNG buffer.
 * Renders at 2× the logical size so text stays crisp after platforms downscale.
 * Omit `height` to let satori size the card to its content; `maxHeight` then
 * caps it (anything taller is re-laid-out on a canvas of that height, which
 * clips the overflow) so a pathological card can't become a huge bitmap.
 */
async function rasterize(tree, width, height, { maxHeight } = {}) {
  let svg = await satori(tree, { width, height, fonts: FONTS });
  if (height === undefined && maxHeight) {
    const h = Number(/^<svg[^>]*?\sheight="([\d.]+)"/.exec(svg)?.[1]);
    if (!(h <= maxHeight)) svg = await satori(tree, { width, height: maxHeight, fonts: FONTS });
  }
  return new Resvg(svg, { fitTo: { mode: 'width', value: width * 2 } }).render().asPng();
}

// ── Render budget ──────────────────────────────────────────────────────────────
// Rendering is CPU-heavy (resvg blocks the event loop) and buffers large
// bitmaps, and the share routes are public. Cold renders therefore run at most
// RENDER_CONCURRENCY at a time with a bounded wait queue; beyond that callers
// get a RENDER_BUSY error (the route answers 503) instead of piling up.
const RENDER_CONCURRENCY = 2;
const RENDER_QUEUE_MAX = 16;
let activeRenders = 0;
const renderWaiters = [];

function acquireRenderSlot() {
  if (activeRenders < RENDER_CONCURRENCY) {
    activeRenders++;
    return Promise.resolve();
  }
  if (renderWaiters.length >= RENDER_QUEUE_MAX) {
    const err = new Error('Share card renderer is busy');
    err.code = 'RENDER_BUSY';
    return Promise.reject(err);
  }
  return new Promise(resolve => renderWaiters.push(resolve));
}

function releaseRenderSlot() {
  const next = renderWaiters.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else activeRenders--;
}

async function withRenderSlot(fn) {
  await acquireRenderSlot();
  try {
    return await fn();
  } finally {
    releaseRenderSlot();
  }
}

const renderLoad = () => ({ active: activeRenders, queued: renderWaiters.length });

module.exports = {
  FONTS, COLORS, accentHex, fetchAsDataUri, truncate, el, txt, brandLogoUri, rasterize,
  withRenderSlot, renderLoad, RENDER_CONCURRENCY, RENDER_QUEUE_MAX,
};
