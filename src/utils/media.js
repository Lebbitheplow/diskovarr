// TMDB's CDN sizes, smallest first. Server-built TMDB URLs already carry one.
const TMDB_WIDTHS = [92, 154, 185, 342, 500, 780, 1280]
const TMDB_SIZE = /\/t\/p\/(w\d+|original)\//

// Never upsizes: the URL the server chose is the most this call will fetch.
function tmdbSized(url, width) {
  const m = url.match(TMDB_SIZE)
  if (!m) return url
  const current = m[1] === 'original' ? Infinity : parseInt(m[1].slice(1), 10)
  const fit = TMDB_WIDTHS.find(w => w >= width) || Infinity
  if (fit >= current) return url
  return url.replace(TMDB_SIZE, `/t/p/w${fit}/`)
}

/**
 * Builds a same-origin proxy URL for a Plex/Jellyfin poster path so the
 * browser never needs the server token; absolute URLs (TMDB CDN, avatars)
 * pass through. `width` is the largest number of image pixels the slot can
 * show (CSS width × device pixel ratio): proxied art is resized upstream, and
 * TMDB URLs step down to a smaller CDN size. Omit it for the original.
 */
export function posterUrl(path, width) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return width && path.includes('image.tmdb.org') ? tmdbSized(path, width) : path
  }
  return '/api/poster?path=' + encodeURIComponent(path) + (width ? '&w=' + width : '')
}

// Candidate widths for card posters. Cards are ~120-200 CSS px wide, so these
// cover 1x desktop up to 3x phones.
const CARD_WIDTHS = [240, 360, 540]

// Card slots: phone grids run two columns, everything else is near 180px
export const CARD_SIZES = '(max-width: 600px) 45vw, 180px'

/**
 * srcset for a card poster, or undefined where there's nothing to choose
 * between (TMDB URLs are already card-sized).
 */
export function posterSrcSet(path) {
  if (!path || path.startsWith('http://') || path.startsWith('https://')) return undefined
  return CARD_WIDTHS.map(w => `${posterUrl(path, w)} ${w}w`).join(', ')
}

/**
 * Poster paths to try in order, blanks and repeats dropped. A card steps to
 * the next one when an image fails to load (media-server art first, then the
 * CDN copy) and shows its letter placeholder once they've all failed.
 */
export function posterCandidates(...paths) {
  return [...new Set(paths.filter(p => typeof p === 'string' && p))]
}
