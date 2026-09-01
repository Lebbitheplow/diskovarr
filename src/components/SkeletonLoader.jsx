import React from 'react'

// Mirrors the card's shape: one 2:3 shimmer filling the tile, with the title
// lines floated over its foot where the real info panel sits.
export default function SkeletonLoader({ count = 6, rows = 1 }) {
  return (
    <div
      className="card-grid skeleton-grid"
      style={rows === 2
        ? { gridTemplateRows: 'repeat(2, auto)', gridAutoFlow: 'column', gridAutoColumns: '172px' }
        : {}
      }
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card card-skeleton">
          <div className="skeleton-poster shimmer" />
          <div className="skeleton-info">
            <div className="skeleton-line shimmer" style={{ width: '80%' }} />
            <div className="skeleton-line shimmer" style={{ width: '50%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
