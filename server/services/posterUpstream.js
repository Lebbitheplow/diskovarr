// Builds the upstream URL for /api/poster. Media servers hand out full-size
// art (Plex posters are commonly 1000×1500 to 2000×3000), which the browser
// then decodes at full size for a card a couple of hundred pixels wide. When
// the client asks for a width, the image is resized upstream instead: Plex
// through its photo transcoder, Jellyfin through maxWidth.

// Requested widths snap up to one of these so a handful of cached variants
// serve every caller, and a client can't make the server transcode at
// arbitrary sizes.
const WIDTHS = [120, 240, 360, 540, 720, 1080, 1280, 1920];

function snapWidth(raw) {
  const w = parseInt(raw, 10);
  if (!Number.isFinite(w) || w <= 0) return null;
  return WIDTHS.find(s => s >= w) || null; // above the largest: original size
}

// ── Path validation ───────────────────────────────────────────────────────────
// The proxy fetches with the server's Plex token, so only the image endpoints
// the app actually stores are allowed — everything else (/library/sections,
// /identity, /:/prefs, scans, media parts) is refused. Paths are decoded until
// stable first, so %2e%2e or a double-encoded '?' is judged by what the media
// server would see, and the upstream URL is rebuilt from the parsed pieces
// rather than passed through.

const MAX_PATH_LENGTH = 1024;
// /library/metadata/<id>/thumb[/<ts>] etc. — items, seasons, episodes, and
// /library/metadata/<id>/thumb for grouped history rows.
const PLEX_METADATA_IMAGE = /^\/library\/metadata\/\d{1,12}\/(?:thumb|art|banner|clearLogo|squareArt)(?:\/\d{1,12})?$/;
const PLEX_COLLECTION_IMAGE = /^\/library\/collections\/\d{1,12}\/(?:composite|thumb|art)(?:\/\d{1,12})?$/;
const JELLYFIN_IMAGE = /^\/Items\/[A-Za-z0-9-]{1,64}\/Images\/(?:Primary|Art|Backdrop|Banner|Logo|Thumb|Disc|Box|Screenshot|Menu|Chapter|BoxRear|Profile)(?:\/\d{1,3})?$/;
const DIGITS = /^\d{1,5}$/;

function fullyDecode(raw) {
  let s = raw;
  for (let i = 0; i < 4; i++) {
    let next;
    try { next = decodeURIComponent(s); } catch { return null; }
    if (next === s) return s;
    s = next;
  }
  return null; // still changing after several rounds — not a real stored path
}

// "a=1&b=2" → Map, or null on duplicates/empty/odd pieces. Values are already
// decoded (fullyDecode ran over the whole path).
function parseQuery(qs) {
  const out = new Map();
  for (const part of qs.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const k = part.slice(0, eq);
    if (out.has(k)) return null;
    out.set(k, part.slice(eq + 1));
  }
  return out;
}

function parsePlexLibraryPath(path, query) {
  if (PLEX_METADATA_IMAGE.test(path) && query == null) return { kind: 'plex', path, query: '' };
  if (PLEX_COLLECTION_IMAGE.test(path)) {
    // Collection composites may carry their own canvas size
    if (query == null) return { kind: 'plex', path, query: '' };
    const q = parseQuery(query);
    if (!q || [...q].some(([k, v]) => !['width', 'height'].includes(k) || !DIGITS.test(v))) return null;
    return { kind: 'plex', path, query: [...q].map(([k, v]) => `${k}=${v}`).join('&') };
  }
  return null;
}

/**
 * Parse a stored poster path into { kind: 'plex'|'jellyfin', path, query,
 * tag?, width? }, or null when it isn't one of the known image shapes.
 */
function parsePosterPath(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH_LENGTH) return null;
  const s = fullyDecode(raw);
  // Anything outside printable ASCII (control chars, spaces, backslashes, '#')
  // never appears in a stored image path
  if (!s || !/^[\x21-\x7e]+$/.test(s) || /[\\#]/.test(s)) return null;
  const qAt = s.indexOf('?');
  const path = qAt === -1 ? s : s.slice(0, qAt);
  const query = qAt === -1 ? null : s.slice(qAt + 1);

  if (path.startsWith('/library/')) return parsePlexLibraryPath(path, query);

  if (path === '/photo/:/transcode' && query != null) {
    // A Plex transcode URL: keep only its size hint and the inner library path
    const q = parseQuery(query);
    if (!q || !q.has('url')) return null;
    for (const [k, v] of q) {
      if (k === 'url') continue;
      if (!['width', 'height', 'minSize', 'upscale'].includes(k) || !DIGITS.test(v)) return null;
    }
    const inner = q.get('url');
    const innerQ = inner.indexOf('?');
    const parsed = parsePlexLibraryPath(innerQ === -1 ? inner : inner.slice(0, innerQ), innerQ === -1 ? null : inner.slice(innerQ + 1));
    if (!parsed) return null;
    return { ...parsed, width: q.has('width') ? Number(q.get('width')) : null };
  }

  if (JELLYFIN_IMAGE.test(path)) {
    if (query == null) return { kind: 'jellyfin', path, query: '', tag: null };
    const m = /^tag=([A-Za-z0-9]{1,64})$/.exec(query);
    return m ? { kind: 'jellyfin', path, query: '', tag: m[1] } : null;
  }
  return null;
}

// 'plex' | 'jellyfin' for an allowed image path, else null.
function posterKind(posterPath) {
  return parsePosterPath(posterPath)?.kind || null;
}

// The built URL must stay on the configured server and hit the expected path.
function onServer(url, base, expectedPath) {
  try {
    const u = new URL(url);
    return u.origin === new URL(base).origin && u.pathname.endsWith(expectedPath) ? url : null;
  } catch {
    return null;
  }
}

function upstreamUrl(posterPath, { width, plexUrl, plexToken, jellyfinUrl }) {
  const p = parsePosterPath(posterPath);
  if (!p) return null;
  const w = snapWidth(width) || snapWidth(p.width);
  if (p.kind === 'jellyfin') {
    const qs = new URLSearchParams();
    if (p.tag) qs.set('tag', p.tag);
    if (w) { qs.set('maxWidth', String(w)); qs.set('quality', '85'); }
    const q = qs.toString();
    return onServer(`${jellyfinUrl}${p.path}${q ? `?${q}` : ''}`, jellyfinUrl, p.path);
  }
  const token = encodeURIComponent(plexToken || '');
  const full = p.query ? `${p.path}?${p.query}` : p.path;
  if (!w) return onServer(`${plexUrl}${full}${p.query ? '&' : '?'}X-Plex-Token=${token}`, plexUrl, p.path);
  // The height bound is generous so the width always wins (posters are 2:3,
  // backdrops 16:9); upscale=0 keeps small originals at their own size.
  return onServer(`${plexUrl}/photo/:/transcode?width=${w}&height=${w * 4}&upscale=0`
    + `&url=${encodeURIComponent(full)}&X-Plex-Token=${token}`, plexUrl, '/photo/:/transcode');
}

module.exports = { WIDTHS, snapWidth, parsePosterPath, posterKind, upstreamUrl };
