import React, { useState, useCallback } from 'react'

export default function MediaCard({
  item, onOpenModal, onToggleWatchlist, onDismiss, variant = 'home',
  isInWatchlist = false, isWatched = false
}) {
  const [imgError, setImgError] = useState(false)
  const { title, year, audienceRating, contentRating, thumb, posterUrl, ratingKey, reasons, mediaType } = item
  const posterPath = thumb || posterUrl

  function makePosterSrc(path) {
    if (!path) return null
    if (path.startsWith('http://') || path.startsWith('https://')) return path
    return `/api/poster?path=${encodeURIComponent(path)}`
  }

  const handleOpenModal = useCallback(() => {
    if (onOpenModal) onOpenModal(item)
  }, [onOpenModal, item])

  const handleToggleWatchlist = useCallback((e) => {
    e.stopPropagation()
    if (onToggleWatchlist) onToggleWatchlist(item)
  }, [onToggleWatchlist, item])

  const handleDismiss = useCallback((e) => {
    e.stopPropagation()
    if (onDismiss) onDismiss(item)
  }, [onDismiss, item])

  const posterSrc = posterPath && !imgError ? makePosterSrc(posterPath) : null

  return (
    <div className="card" data-rating-key={ratingKey} data-adult={contentRating && ['r','tv-ma','nc-17','x','nr'].includes(contentRating.toLowerCase()) ? 'true' : undefined}>
      <button className="card-poster-link" onClick={handleOpenModal} aria-label={title}>
        {posterSrc ? (
          <img
            className="card-poster"
            src={posterSrc}
            alt={title}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="card-poster-placeholder">
            <span>{title?.charAt(0) || '?'}</span>
          </div>
        )}
        {isWatched && (
          <div className="card-watched-badge" title="Watched">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )}
        {variant === 'explore' && item.badgeNotInLibrary && !item.badgeRequested && (
          <div className="badge-not-in-library">Not in Library</div>
        )}
        {variant === 'explore' && item.badgeRequested && (
          <div className="badge-not-in-library badge-requested">Requested</div>
        )}
        <div className="card-overlay">
          <div className="card-overlay-actions">
            <button
              className={`btn-icon btn-watchlist ${isInWatchlist ? 'in-watchlist' : ''}`}
              onClick={handleToggleWatchlist}
            >
              {isInWatchlist ? '✓ In Watchlist' : '+ Watchlist'}
            </button>
            {variant === 'home' && (
              <button className="btn-icon btn-dismiss" onClick={handleDismiss} title="Don't show this again">✕</button>
            )}
            {variant === 'explore' && onDismiss && !item.badgeRequested && (
              <button className="btn-icon btn-dismiss" onClick={handleDismiss} title="Dismiss">✕</button>
            )}
          </div>
        </div>
      </button>
      <div className="card-info">
        <div className="card-title">{title}</div>
        <div className="card-meta">
          {year && <span className="card-year">{year}</span>}
          {audienceRating && audienceRating > 0 && (
            <span className="card-rating">★ {Number(audienceRating).toFixed(1)}</span>
          )}
        </div>
        {reasons && reasons.length > 0 && (
          <div className="card-reasons">
            {reasons.filter(r => r && r.trim()).slice(0, 2).map((r, i) => (
              <span key={i} className="reason-tag">
                <span className="reason-tag-text">{r}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
