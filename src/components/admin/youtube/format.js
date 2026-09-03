// Formatting helpers shared by the YouTube (Tuberr) admin components.
// Timestamps arrive in mixed shapes (epoch seconds, epoch ms, ISO) depending
// on which Tuberr table they come from — normalise to ms once here.

export function toMs(ts) {
  if (ts == null || ts === '' || ts === 0) return null
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts
  const n = Number(ts)
  if (!Number.isNaN(n) && String(ts).trim() !== '') return n < 1e12 ? n * 1000 : n
  const d = Date.parse(ts)
  return Number.isNaN(d) ? null : d
}

export function fmtAgo(ts) {
  const ms = toMs(ts)
  if (!ms) return 'never'
  const diffMin = Math.floor((Date.now() - ms) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`
  return `${Math.floor(diffMin / 1440)}d ago`
}

export function fmtDateTime(ts) {
  const ms = toMs(ts)
  if (!ms) return '—'
  try { return new Date(ms).toLocaleString() } catch { return '—' }
}

export function fmtBytes(bytes) {
  const b = Number(bytes)
  if (!Number.isFinite(b) || b <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = b
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function fmtSpeed(bytesPerSec) {
  const b = Number(bytesPerSec)
  if (!Number.isFinite(b) || b <= 0) return ''
  return `${fmtBytes(b)}/s`
}

export function fmtEta(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0 || s > 86400 * 30) return ''
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function fmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1000) return `${Math.round(n)}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`
}

// Rows carry JSON columns as strings (`playlist_ids`, `candidates_json`).
export function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export const MAPPING_STATES = ['active', 'paused', 'unavailable']

export const STATE_COLORS = {
  active: '#4ade80',
  paused: '#f59e0b',
  unavailable: '#94a3b8',
}

export function mappingState(row) {
  const s = String(row?.state || 'active').toLowerCase()
  return MAPPING_STATES.includes(s) ? s : 'active'
}

// Accepts playlist URLs or bare ids, one per line / comma / whitespace.
export function extractPlaylistIds(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || '').split(/[\n,\s]+/)) {
    const token = raw.trim()
    if (!token) continue
    const m = /[?&]list=([\w-]+)/.exec(token)
    const id = m ? m[1] : (/^[\w-]{10,}$/.test(token) ? token : null)
    if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}

export const pillStyle = (color) => ({
  fontSize: '0.72rem', fontWeight: 600, color,
  border: `1px solid ${color}`, borderRadius: 10, padding: '1px 8px',
  whiteSpace: 'nowrap',
})
