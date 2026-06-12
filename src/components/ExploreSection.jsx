import React, { memo } from 'react'
import { useTranslation } from 'react-i18next'
import Carousel from './Carousel'
import { posterUrl } from '../utils/media'
import { formatReleaseDate } from '../utils/format'

// Memoized so opening a modal or toggling page-level state in Explore doesn't
// re-render every carousel; only the section whose props changed re-renders,
// and within it only the card whose `inWatchlist` flipped.
const ExploreCard = memo(function ExploreCard({
  item, inWatchlist, upcoming,
  onOpenModal, onToggleWatchlist, onNotify, onRequest, onDismiss,
}) {
  const { t } = useTranslation()
  const isFutureRelease = item.releaseDate && item.releaseDate > new Date().toISOString().slice(0, 10)
  return (
    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => onOpenModal(item)}>
      <button className="card-poster-link" onClick={() => onOpenModal(item)} type="button">
        {item.posterUrl && <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />}
        <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
        {(upcoming || isFutureRelease)
          ? <span className={'badge-upcoming-card' + (item.badgeRequested ? ' badge-requested' : '')}>{item.badgeRequested ? t('Requested') : t('Coming Soon')}</span>
          : <span className={'badge-not-in-library' + (item.badgeRequested ? ' badge-requested' : '')}>{item.badgeRequested ? t('Requested') : t('Not in Library')}</span>}
        <div className="card-overlay">
          <div className="card-overlay-actions">
            {item.ratingKey && (
              <button
                className={'btn-icon btn-watchlist' + (inWatchlist ? ' in-watchlist' : '')}
                onClick={(e) => { e.stopPropagation(); onToggleWatchlist(item) }}
              >
                {inWatchlist ? '✓ ' + t('In Watchlist') : '+ ' + t('Watchlist')}
              </button>
            )}
            {!item.ratingKey && (
              <button
                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? onNotify(item) : onRequest(item)) }}
                disabled={item.isMyRequest}
              >
                {item.isMyRequest ? t('Requested') + ' ✓' : (item.isRequested ? t('Notify Me') : t('Request'))}
              </button>
            )}
            {!item.badgeRequested && (
              <button className="btn-icon btn-dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(item) }}>✕</button>
            )}
          </div>
        </div>
      </button>
      <div className="card-info">
        <div className="card-title">{item.title}</div>
        <div className="card-meta">
          {upcoming
            ? item.releaseDate && <span className="card-year">{formatReleaseDate(item.releaseDate)}</span>
            : item.year && <span className="card-year">{item.year}</span>}
          {item.voteAverage && <span className="card-rating">★ {item.voteAverage.toFixed(1)}</span>}
        </div>
        {!upcoming && item.reasons && item.reasons.length > 0 && (
          <div className="card-reasons">
            {item.reasons.slice(0, 2).map((r, i) => (
              <span key={i} className="reason-tag"><span className="reason-tag-text">{r}</span></span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

function ExploreSection({
  id, title, badge, badgeClass, items, upcoming = false, watchlistCache,
  onOpenModal, onToggleWatchlist, onNotify, onRequest, onDismiss,
}) {
  const { t } = useTranslation()
  if (!items || items.length === 0) return null
  return (
    <section className="section" id={id}>
      <div className="section-header">
        <h2 className="section-title">{t(title)}</h2>
        {badge && <span className={'section-badge' + (badgeClass ? ' ' + badgeClass : '')}>{t(badge)}</span>}
      </div>
      <Carousel>
        {items.map(item => (
          <ExploreCard
            key={item.tmdbId + item.mediaType}
            item={item}
            inWatchlist={!!(item.ratingKey && watchlistCache[item.ratingKey])}
            upcoming={upcoming}
            onOpenModal={onOpenModal}
            onToggleWatchlist={onToggleWatchlist}
            onNotify={onNotify}
            onRequest={onRequest}
            onDismiss={onDismiss}
          />
        ))}
      </Carousel>
    </section>
  )
}

export default memo(ExploreSection)
