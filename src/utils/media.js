// Builds a same-origin proxy URL for a Plex poster path so the browser never
// needs the Plex token; absolute URLs (TMDB CDN) pass through unchanged.
export function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}
