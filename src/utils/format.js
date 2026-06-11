// Relative "x mins/hours/days ago" from a unix-seconds timestamp.
export function timeAgo(ts) {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 3600) {
    const m = Math.max(1, Math.floor(diff / 60))
    return m + ' min' + (m === 1 ? '' : 's') + ' ago'
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    return h + ' hour' + (h === 1 ? '' : 's') + ' ago'
  }
  const d = Math.floor(diff / 86400)
  return d + ' day' + (d === 1 ? '' : 's') + ' ago'
}

// "Jun 11, 2026" from a YYYY-MM-DD date string.
export function formatReleaseDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d)) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
