import React from 'react'

// Mirrors the card's shape: one 2:3 shimmer filling the tile, with the title
// lines floated over its foot where the real info panel sits.
//
// Born revealed: a placeholder has nothing to make an entrance with, and the
// shelf reveal gate (hooks/useShellMotion) would otherwise hold it hidden.
// The two-row shelf sits in a .carousel-wrap so it takes the carousel's own
// track (card width, gaps, padding) and the real shelf replaces it without
// the page shifting.
//
// `bare` returns only the cards, for a caller that already has a grid open.
export default function SkeletonLoader({ count = 6, rows = 1, bare = false }) {
  const cards = Array.from({ length: count }).map((_, i) => (
    <div key={i} className="card card-skeleton">
      <div className="skeleton-poster shimmer" />
      <div className="skeleton-info">
        <div className="skeleton-line shimmer" style={{ width: '80%' }} />
        <div className="skeleton-line shimmer" style={{ width: '50%' }} />
      </div>
    </div>
  ))
  if (bare) return cards
  const grid = <div className="card-grid skeleton-grid is-revealed">{cards}</div>
  return rows === 2 ? <div className="carousel-wrap">{grid}</div> : grid
}
