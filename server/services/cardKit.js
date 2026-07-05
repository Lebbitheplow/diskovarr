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
// Plex thumb paths (/library/...) need the server's Plex token; http(s) URLs and
// plex.tv avatars are fetched directly. Returns null on any failure so the caller
// can fall back to a placeholder.
async function fetchAsDataUri(src) {
  if (!src) return null;
  try {
    let url;
    if (src.startsWith('http://') || src.startsWith('https://')) {
      url = src;
    } else if (src.startsWith('/library/')) {
      url = `${plexService.getPlexUrl()}${src}?X-Plex-Token=${plexService.getPlexToken()}`;
    } else {
      return null;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
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
 */
async function rasterize(tree, width, height) {
  const svg = await satori(tree, { width, height, fonts: FONTS });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width * 2 } }).render().asPng();
}

module.exports = { FONTS, COLORS, accentHex, fetchAsDataUri, truncate, el, txt, brandLogoUri, rasterize };
