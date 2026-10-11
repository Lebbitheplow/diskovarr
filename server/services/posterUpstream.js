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

// Only Plex /library/ or Jellyfin /Items/<id>/Images/ paths with no traversal
// segments — blocks SSRF to other hosts and stops '..' from reaching
// non-media endpoints with a server token.
function posterKind(posterPath) {
  if (typeof posterPath !== 'string' || posterPath.split('/').includes('..')) return null;
  if (posterPath.startsWith('/library/')) return 'plex';
  if (/^\/Items\/[A-Za-z0-9-]+\/Images\//.test(posterPath)) return 'jellyfin';
  return null;
}

function upstreamUrl(posterPath, { width, plexUrl, plexToken, jellyfinUrl }) {
  const kind = posterKind(posterPath);
  if (!kind) return null;
  const w = snapWidth(width);
  if (kind === 'jellyfin') {
    if (!w) return `${jellyfinUrl}${posterPath}`;
    const sep = posterPath.includes('?') ? '&' : '?';
    return `${jellyfinUrl}${posterPath}${sep}maxWidth=${w}&quality=85`;
  }
  const token = encodeURIComponent(plexToken || '');
  if (!w) return `${plexUrl}${posterPath}?X-Plex-Token=${token}`;
  // The height bound is generous so the width always wins (posters are 2:3,
  // backdrops 16:9); upscale=0 keeps small originals at their own size.
  return `${plexUrl}/photo/:/transcode?width=${w}&height=${w * 4}&upscale=0`
    + `&url=${encodeURIComponent(posterPath)}&X-Plex-Token=${token}`;
}

module.exports = { WIDTHS, snapWidth, posterKind, upstreamUrl };
