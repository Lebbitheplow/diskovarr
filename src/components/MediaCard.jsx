import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { posterUrl as makePosterSrc, posterSrcSet, posterCandidates, CARD_SIZES } from '../utils/media'

export default function MediaCard({
  item, onOpenModal, onToggleWatchlist, onDismiss, variant = 'home',
  isInWatchlist = false, isWatched = false
}) {
  const { t } = useTranslation()
  const { title, year, audienceRating, contentRating, thumb, posterUrl, ratingKey, reasons } = item
  // A poster that fails to load steps to the next candidate. The failure count
  // is keyed by the candidate list, so new art for this card starts over from
  // the top instead of staying stuck on the placeholder.
  const candidates = posterCandidates(thumb, posterUrl)
  const candidatesKey = candidates.join('\n')
  const [failed, setFailed] = useState({ key: candidatesKey, count: 0 })
  const failedCount = failed.key === candidatesKey ? failed.count : 0
  const posterPath = candidates[failedCount] || null

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

  const posterSrc = posterPath ? makePosterSrc(posterPath, 360) : null

  // The poster button, the action overlay and the info panel are siblings
  // stacked over the card rather than nested. Nesting the action buttons inside
  // the poster button (as this did previously) is invalid HTML — the info panel
  // is pointer-events:none so clicks still fall through to the poster button.
  return (
    <div className="card" data-rating-key={ratingKey} data-adult={contentRating && ['r','tv-ma','nc-17','x','nr'].includes(contentRating.toLowerCase()) ? 'true' : undefined}>
      <button className="card-poster-link" onClick={handleOpenModal} aria-label={title}>
        {posterSrc ? (
          <img
            // A fresh element per source, so a late error from the old one
            // can't knock out its replacement
            key={posterPath}
            className="card-poster"
            src={posterSrc}
            srcSet={posterSrcSet(posterPath)}
            sizes={CARD_SIZES}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed({ key: candidatesKey, count: failedCount + 1 })}
          />
        ) : (
          <div className="card-poster-placeholder">
            <span>{title?.charAt(0) || '?'}</span>
          </div>
        )}
      </button>

      {isWatched && (
        <div className="card-watched-badge" title={t('Watched')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
      {variant === 'explore' && item.badgeNotInLibrary && !item.badgeRequested && (
        <div className="badge-not-in-library">{t('Not in Library')}</div>
      )}
      {variant === 'explore' && item.badgeRequested && (
        <div className="badge-not-in-library badge-requested">{t('Requested')}</div>
      )}

      <div className="card-overlay">
        <div className="card-overlay-actions">
          <button
            className={`btn-icon btn-watchlist ${isInWatchlist ? 'in-watchlist' : ''}`}
            onClick={handleToggleWatchlist}
          >
            {isInWatchlist ? '✓ ' + t('In Watchlist') : '+ ' + t('Watchlist')}
          </button>
          {variant === 'home' && (
            <button className="btn-icon btn-dismiss" onClick={handleDismiss} title={t("Don't show this again")}>✕</button>
          )}
          {variant === 'explore' && onDismiss && !item.badgeRequested && (
            <button className="btn-icon btn-dismiss" onClick={handleDismiss} title={t('Dismiss')}>✕</button>
          )}
        </div>
      </div>

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
