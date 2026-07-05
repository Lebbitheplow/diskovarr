// Formatting helpers + constants for the Wrapped sections (kept separate from
// shared.jsx so component files only export components — fast-refresh rule).

export const hoursOf = (s) => Math.round((s || 0) / 3600)
export const fmtInt = (n) => (n || 0).toLocaleString()
export const fmtHM = (s) => {
  const h = Math.floor((s || 0) / 3600)
  const m = Math.round(((s || 0) % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}
export const fmtHourLabel = (h) => (h == null ? '' : `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`)
export const fmtDayLong = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Plex /library/ thumbs go through the token-hiding poster proxy; absolute
// URLs (plex.tv avatars, Tautulli user thumbs) are safe to use directly.
export const posterSrc = (thumb) => {
  if (!thumb) return null
  if (/^https?:\/\//i.test(thumb)) return thumb
  if (thumb.startsWith('/library/')) return `/api/poster?path=${encodeURIComponent(thumb)}`
  return null
}
