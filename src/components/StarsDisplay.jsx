import React from 'react'

/**
 * Renders a 0–5 star rating graphically. Half (and any fractional) ratings are
 * shown by clipping a filled star layer over a muted outline layer — so 4.5 shows
 * four full stars plus the left half of the fifth, rather than a "½" glyph.
 */
export default function StarsDisplay({ rating, size = '1rem', showValue = true }) {
  if (!rating || rating <= 0) return null
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100))
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: size }}
      role="img"
      aria-label={`${rating} out of 5 stars`}
    >
      <span style={{ position: 'relative', display: 'inline-block', lineHeight: 1, fontWeight: 600, whiteSpace: 'nowrap' }} aria-hidden="true">
        <span style={{ color: 'var(--border-hover)' }}>★★★★★</span>
        <span style={{ position: 'absolute', top: 0, left: 0, overflow: 'hidden', width: `${pct}%`, color: 'var(--accent)' }}>★★★★★</span>
      </span>
      {showValue && (
        <span aria-hidden="true" style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '0.7em' }}>
          {rating.toFixed(1)}
        </span>
      )}
    </span>
  )
}
